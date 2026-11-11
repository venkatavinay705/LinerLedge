import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // 1. Custom Application Domain Errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // 2. Postgres Check Constraint Violations
  if (err.code === '23514') {
    res.status(400).json({
      success: false,
      error: {
        code: 'INSUFFICIENT_FUNDS',
        message: 'Transaction rejected: balance cannot fall below permitted overdraft limit',
        details: err.constraint,
      },
    });
    return;
  }

  // 3. Postgres Unique Constraint Violations
  if (err.code === '23505') {
    res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: 'A resource with these unique attributes already exists',
        details: err.detail,
      },
    });
    return;
  }

  // 4. Postgres Custom Trigger Exceptions
  if (err.code === 'P0001') {
    res.status(400).json({
      success: false,
      error: {
        code: 'LEDGER_CONSTRAINT_VIOLATION',
        message: err.message,
      },
    });
    return;
  }

  // 5. Unexpected Internal Server Errors
  logger.error({ error: err?.message || String(err), stack: err?.stack }, 'Unhandled server error');
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err?.message || 'An unexpected internal error occurred. Please contact system support.',
    },
  });
}
