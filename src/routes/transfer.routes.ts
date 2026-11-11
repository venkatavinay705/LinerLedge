import { Router } from 'express';
import { ledgerService } from '../services/ledger.service.js';
import { idempotencyService } from '../services/idempotency.service.js';
import {
  authenticate,
  blockAuditorWrites,
  requireAccountPermission,
} from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/validation.middleware.js';
import { transferSchema } from './validators.js';
import { AppError } from '../utils/errors.js';

export const transferRouter = Router();

transferRouter.use(authenticate);
transferRouter.use(blockAuditorWrites);

transferRouter.post(
  '/',
  validateBody(transferSchema),
  requireAccountPermission('TRANSFER_OUT', (req) => req.body.source_account_id),
  async (req, res, next) => {
    try {
      const idempotencyKey = req.header('Idempotency-Key');
      if (!idempotencyKey) {
        throw new AppError(
          'Idempotency-Key header is required for transfer operations',
          400,
          'IDEMPOTENCY_KEY_REQUIRED'
        );
      }

      const { source_account_id, destination_account_id, amount, description } = req.body;

      const result = await idempotencyService.executeIdempotent({
        actor: req.actor!,
        key: idempotencyKey,
        method: req.method,
        path: req.originalUrl || req.path,
        body: req.body,
        ip: req.ip,
        actionName: 'TRANSFER',
        sourceAccountId: source_account_id,
        destinationAccountId: destination_account_id,
        amount,
        execute: async () => {
          const txRes = await ledgerService.transfer({
            sourceAccountId: source_account_id,
            destinationAccountId: destination_account_id,
            amount,
            actor: req.actor!,
            idempotencyKey,
            description,
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
