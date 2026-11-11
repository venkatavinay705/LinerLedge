import { Router } from 'express';
import { auditService } from '../services/audit.service.js';
import { getDbPool } from '../db/pool.js';
import { authenticate, requireRole } from '../middlewares/auth.middleware.js';
import { LedgerEntry } from '../types/index.js';

export const auditRouter = Router();

auditRouter.use(authenticate);
auditRouter.use(requireRole('ADMIN', 'AUDITOR'));

// 1. Audit attempts log
auditRouter.get('/attempts', async (req, res, next) => {
  try {
    const { page, limit, actor_id, account_id, outcome } = req.query as any;
    const result = await auditService.getAttempts({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      actorId: actor_id,
      accountId: account_id,
      outcome,
    });
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// 2. Query ledger entries
auditRouter.get('/ledger', async (req, res, next) => {
  try {
    const pool = await getDbPool();
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt((req.query.limit as string) || '50', 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.account_id) {
      params.push(req.query.account_id);
      conditions.push(`account_id = $${params.length}`);
    }

    if (req.query.transaction_id) {
      params.push(req.query.transaction_id);
      conditions.push(`transaction_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ledger_entries ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const entriesRes = await pool.query<LedgerEntry>(
      `SELECT * FROM ledger_entries ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: {
        entries: entriesRes.rows,
        total,
        page,
        limit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 3. Cryptographic hash chain verification
auditRouter.get('/verify-chain', async (_req, res, next) => {
  try {
    const result = await auditService.verifyHashChain();
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// 4. Global balance reconciliation
auditRouter.get('/reconcile', async (_req, res, next) => {
  try {
    const result = await auditService.reconcile();
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});
