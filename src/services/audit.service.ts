import { getDbPool, IDatabasePool } from '../db/pool.js';
import { AttemptOutcome, TransactionAttempt, LedgerEntry, Account } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { computeEntryHash, GENESIS_HASH } from '../utils/crypto.js';

export interface LogAttemptParams {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  sourceAccountId?: string | null;
  destinationAccountId?: string | null;
  amount?: bigint | number | string | null;
  idempotencyKey?: string | null;
  outcome: AttemptOutcome;
  reasonCode?: string | null;
  transactionId?: string | null;
  ip?: string | null;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  brokenAtId: string | number | null;
  reason?: string;
  details?: Record<string, any>;
  lastHash?: string;
}

export interface ReconciliationResult {
  reconciled: boolean;
  accountsChecked: number;
  globalSum: string;
  discrepancies: Array<{
    accountId: string;
    accountNumber: string;
    accountName: string;
    storedBalance: string;
    ledgerSum: string;
    difference: string;
  }>;
}

export class AuditService {
  constructor(private pool?: IDatabasePool) {}

  private async getPool(): Promise<IDatabasePool> {
    if (!this.pool) {
      this.pool = await getDbPool();
    }
    return this.pool;
  }

  /**
   * Records a transaction attempt in an ISOLATED database transaction.
   * This guarantees that even when the main financial transaction rolls back,
   * the attempt record is preserved.
   */
  async logAttempt(params: LogAttemptParams): Promise<TransactionAttempt> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      const sql = `
        INSERT INTO transaction_attempts (
          actor_id, actor_role, action, source_account_id, destination_account_id,
          amount, idempotency_key, outcome, reason_code, transaction_id, ip
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *;
      `;
      const amountStr = params.amount !== null && params.amount !== undefined ? params.amount.toString() : null;
      const res = await client.query<TransactionAttempt>(sql, [
        params.actorId || null,
        params.actorRole || null,
        params.action,
        params.sourceAccountId || null,
        params.destinationAccountId || null,
        amountStr,
        params.idempotencyKey || null,
        params.outcome,
        params.reasonCode || null,
        params.transactionId || null,
        params.ip || null,
      ]);

      const logged = res.rows[0];
      if (!logged) {
        throw new Error('Failed to insert transaction attempt');
      }
      return logged;
    } catch (err) {
      logger.error({ error: err, params }, 'Failed to record transaction attempt in audit log');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Queries audit attempts with pagination and optional filters.
   */
  async getAttempts(options: {
    page?: number;
    limit?: number;
    actorId?: string;
    accountId?: string;
    outcome?: AttemptOutcome;
  }): Promise<{ attempts: TransactionAttempt[]; total: number; page: number; limit: number }> {
    const pool = await this.getPool();
    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];

    if (options.actorId) {
      params.push(options.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }

    if (options.accountId) {
      params.push(options.accountId);
      conditions.push(`(source_account_id = $${params.length} OR destination_account_id = $${params.length})`);
    }

    if (options.outcome) {
      params.push(options.outcome);
      conditions.push(`outcome = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM transaction_attempts ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const querySql = `
      SELECT * FROM transaction_attempts
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const res = await pool.query<TransactionAttempt>(querySql, [...params, limit, offset]);

    return {
      attempts: res.rows,
      total,
      page,
      limit,
    };
  }

  /**
   * Verifies the tamper-evident hash chain of all ledger entries.
   * Scans all entries sequentially by ID, verifies linkage and SHA-256 hash.
   */
  async verifyHashChain(): Promise<ChainVerificationResult> {
    const pool = await this.getPool();
    const res = await pool.query<LedgerEntry>(
      'SELECT * FROM ledger_entries ORDER BY id ASC'
    );
    const entries = res.rows;

    if (entries.length === 0) {
      return {
        valid: true,
        totalEntries: 0,
        brokenAtId: null,
        lastHash: GENESIS_HASH,
      };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // 1. Check prev_hash linkage
      if (entry.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenAtId: entry.id,
          reason: 'Broken chain linkage: prev_hash does not match previous entry hash',
          details: {
            entryId: entry.id,
            expectedPrevHash,
            actualPrevHash: entry.prev_hash,
          },
        };
      }

      // 2. Recompute SHA-256 hash of this entry
      const recomputedHash = computeEntryHash({
        id: entry.id,
        transactionId: entry.transaction_id,
        accountId: entry.account_id,
        direction: entry.direction,
        amount: entry.amount,
        balanceAfter: entry.balance_after,
        createdAt: entry.created_at,
        prevHash: entry.prev_hash,
      });

      if (recomputedHash !== entry.entry_hash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenAtId: entry.id,
          reason: 'Tampered entry: hash recalculation mismatch',
          details: {
            entryId: entry.id,
            storedHash: entry.entry_hash,
            recomputedHash,
          },
        };
      }

      expectedPrevHash = entry.entry_hash;
    }

    return {
      valid: true,
      totalEntries: entries.length,
      brokenAtId: null,
      lastHash: expectedPrevHash,
    };
  }

  /**
   * Reconciles all account balances against the ledger entries.
   * Verifies:
   * 1. Each account balance == sum(credits) - sum(debits)
   * 2. Global sum of all balances (including system accounts) == 0
   */
  async reconcile(): Promise<ReconciliationResult> {
    const pool = await this.getPool();

    // 1. Fetch all accounts
    const accountsRes = await pool.query<Account>('SELECT * FROM accounts ORDER BY account_number ASC');
    const accounts = accountsRes.rows;

    // 2. Calculate sum of ledger entries per account
    // Credit is +amount, Debit is -amount
    const sumsRes = await pool.query<{
      account_id: string;
      ledger_balance: string;
    }>(`
      SELECT 
        account_id,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS ledger_balance
      FROM ledger_entries
      GROUP BY account_id
    `);

    const ledgerSums = new Map<string, bigint>();
    for (const r of sumsRes.rows) {
      ledgerSums.set(r.account_id, BigInt(r.ledger_balance));
    }

    const discrepancies: ReconciliationResult['discrepancies'] = [];
    let globalSum = 0n;

    for (const acc of accounts) {
      const storedBalance = BigInt(acc.balance);
      const computedLedgerBalance = ledgerSums.get(acc.id) ?? 0n;
      globalSum += storedBalance;

      if (storedBalance !== computedLedgerBalance) {
        discrepancies.push({
          accountId: acc.id,
          accountNumber: acc.account_number,
          accountName: acc.name,
          storedBalance: storedBalance.toString(),
          ledgerSum: computedLedgerBalance.toString(),
          difference: (storedBalance - computedLedgerBalance).toString(),
        });
      }
    }

    return {
      reconciled: discrepancies.length === 0 && globalSum === 0n,
      accountsChecked: accounts.length,
      globalSum: globalSum.toString(),
      discrepancies,
    };
  }
}

export const auditService = new AuditService();
