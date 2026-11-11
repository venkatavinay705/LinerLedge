import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service.js';
import { accountService } from '../services/account.service.js';
import { auditService } from '../services/audit.service.js';
import { AuthActor, UserRole, PermissionType } from '../types/index.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';

// Extend Express Request interface to include authenticated actor
declare global {
  namespace Express {
    interface Request {
      actor?: AuthActor;
    }
  }
}

/**
 * Extracts and verifies JWT bearer token from Authorization header.
 * Attaches the verified actor strictly to req.actor.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    throw new UnauthorizedError('Authentication token is required');
  }

  try {
    const actor = authService.verifyToken(token);
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Requires the authenticated actor to possess one of the allowed roles.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor) {
      return next(new UnauthorizedError('Authentication required'));
    }

    if (!allowedRoles.includes(req.actor.role)) {
      return next(
        new ForbiddenError(
          `Access denied: role ${req.actor.role} is not authorized for this resource`
        )
      );
    }

    next();
  };
}

/**
 * Enforces that AUDITOR role is strictly read-only.
 * Any write request (POST, PUT, PATCH, DELETE) by an AUDITOR receives 403 Forbidden.
 */
export function blockAuditorWrites(req: Request, _res: Response, next: NextFunction): void {
  if (req.actor?.role === 'AUDITOR' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next(new ForbiddenError('Auditor role is strictly read-only; mutation operations are prohibited'));
  }
  next();
}

/**
 * Enforces granular account permission for ACCOUNT_HOLDER role.
 * ADMIN has universal permission. AUDITOR is blocked on writes by blockAuditorWrites.
 */
export function requireAccountPermission(
  permission: PermissionType,
  getAccountId: (req: Request) => string
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.actor) {
        throw new UnauthorizedError('Authentication required');
      }

      // ADMIN bypasses account-level permission checks
      if (req.actor.role === 'ADMIN') {
        return next();
      }

      // AUDITOR cannot perform actions requiring DEPOSIT, WITHDRAW, TRANSFER_OUT
      if (req.actor.role === 'AUDITOR') {
        if (permission === 'VIEW') {
          return next();
        }
        throw new ForbiddenError('Auditors cannot execute transactions');
      }

      const accountId = getAccountId(req);
      if (!accountId) {
        throw new ForbiddenError('Account ID could not be determined');
      }

      const hasPerm = await accountService.hasPermission(accountId, req.actor.id, permission);
      if (!hasPerm) {
        await auditService
          .logAttempt({
            actorId: req.actor.id,
            actorRole: req.actor.role,
            action: req.method,
            sourceAccountId: accountId,
            idempotencyKey: req.header('Idempotency-Key') || null,
            outcome: 'REFUSED',
            reasonCode: 'FORBIDDEN',
            ip: req.ip,
          })
          .catch(() => {});

        throw new ForbiddenError(
          `Actor does not possess ${permission} permission on account ${accountId}`
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
