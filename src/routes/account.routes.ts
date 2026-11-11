import { Router } from 'express';
import { accountService } from '../services/account.service.js';
import { ledgerService } from '../services/ledger.service.js';
import { idempotencyService } from '../services/idempotency.service.js';
import {
  authenticate,
  requireRole,
  blockAuditorWrites,
  requireAccountPermission,
} from '../middlewares/auth.middleware.js';
import { validateBody, validateQuery } from '../middlewares/validation.middleware.js';
import {
  createAccountSchema,
  updateAccountStatusSchema,
  setPermissionsSchema,
  depositWithdrawSchema,
  paginationQuerySchema,
} from './validators.js';
import { AppError } from '../utils/errors.js';

export const accountRouter = Router();

accountRouter.use(authenticate);

// 1. List accounts permitted to the actor
accountRouter.get('/', async (req, res, next) => {
  try {
    const accounts = await accountService.getPermittedAccounts(req.actor!);
    res.json({
      success: true,
      data: accounts,
    });
  } catch (err) {
    next(err);
  }
});

// 2. Create account (ADMIN only)
accountRouter.post(
  '/',
  blockAuditorWrites,
  requireRole('ADMIN'),
  validateBody(createAccountSchema),
  async (req, res, next) => {
    try {
      const account = await accountService.createAccount(req.body);
      res.status(201).json({
        success: true,
        data: account,
      });
    } catch (err) {
      next(err);
    }
  }
);

// 3. Get single account by ID (Permitted or Admin/Auditor)
accountRouter.get('/:id', async (req, res, next) => {
  try {
    const account = await accountService.getAccountById(req.params.id!, req.actor!);
    res.json({
      success: true,
      data: account,
    });
  } catch (err) {
    next(err);
  }
});

// 4. Update account status (ADMIN only)
accountRouter.patch(
  '/:id/status',
  blockAuditorWrites,
  requireRole('ADMIN'),
  validateBody(updateAccountStatusSchema),
  async (req, res, next) => {
    try {
      const updated = await accountService.updateAccountStatus(req.params.id!, req.body.status);
      res.json({
        success: true,
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

// 5. Set account permissions (ADMIN only)
accountRouter.put(
  '/:id/permissions',
  blockAuditorWrites,
  requireRole('ADMIN'),
  validateBody(setPermissionsSchema),
  async (req, res, next) => {
    try {
      await accountService.setPermissions(
        req.params.id!,
        req.body.user_id,
        req.body.permissions,
        req.actor!.id
      );
      res.json({
        success: true,
        message: 'Permissions updated successfully',
      });
    } catch (err) {
      next(err);
    }
  }
);

// 6. Account Statement with ledger entries & refused attempts
accountRouter.get(
  '/:id/statement',
  validateQuery(paginationQuerySchema),
  async (req, res, next) => {
    try {
      const result = await accountService.getStatement(req.params.id!, req.actor!, req.query as any);
      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// 7. Deposit into account
accountRouter.post(
  '/:id/deposit',
  blockAuditorWrites,
  requireAccountPermission('DEPOSIT', (req) => req.params.id!),
  validateBody(depositWithdrawSchema),
  async (req, res, next) => {
    try {
      const idempotencyKey = req.header('Idempotency-Key');
      if (!idempotencyKey) {
        throw new AppError('Idempotency-Key header is required for deposit operations', 400, 'IDEMPOTENCY_KEY_REQUIRED');
      }

      const accountId = req.params.id!;
      const result = await idempotencyService.executeIdempotent({
        actor: req.actor!,
        key: idempotencyKey,
        method: req.method,
        path: req.originalUrl || req.path,
        body: req.body,
        ip: req.ip,
        actionName: 'DEPOSIT',
        destinationAccountId: accountId,
        amount: req.body.amount,
        execute: async () => {
          const txRes = await ledgerService.deposit({
            accountId,
            amount: req.body.amount,
            actor: req.actor!,
            idempotencyKey,
            description: req.body.description,
            ip: req.ip,
          });
          return {
            statusCode: 201,
            body: { success: true, data: txRes },
            transactionId: txRes.transaction.id,
          };
        },
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }
);

// 8. Withdraw from account
accountRouter.post(
  '/:id/withdraw',
  blockAuditorWrites,
  requireAccountPermission('WITHDRAW', (req) => req.params.id!),
  validateBody(depositWithdrawSchema),
  async (req, res, next) => {
    try {
      const idempotencyKey = req.header('Idempotency-Key');
      if (!idempotencyKey) {
        throw new AppError('Idempotency-Key header is required for withdrawal operations', 400, 'IDEMPOTENCY_KEY_REQUIRED');
      }

      const accountId = req.params.id!;
      const result = await idempotencyService.executeIdempotent({
        actor: req.actor!,
        key: idempotencyKey,
        method: req.method,
        path: req.originalUrl || req.path,
        body: req.body,
        ip: req.ip,
        actionName: 'WITHDRAWAL',
        sourceAccountId: accountId,
        amount: req.body.amount,
        execute: async () => {
          const txRes = await ledgerService.withdraw({
            accountId,
            amount: req.body.amount,
            actor: req.actor!,
            idempotencyKey,
            description: req.body.description,
            ip: req.ip,
          });
          return {
            statusCode: 201,
            body: { success: true, data: txRes },
            transactionId: txRes.transaction.id,
          };
        },
      });

      if (result.isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }
      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  }
);
