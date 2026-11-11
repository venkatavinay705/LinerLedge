import { getDbPool, IDatabasePool } from '../db/pool.js';
import {
  Account,
  AccountStatus,
  AccountType,
  AuthActor,
  PermissionType,
} from '../types/index.js';
import { NotFoundError } from '../utils/errors.js';

export interface CreateAccountData {
  account_number: string;
  name: string;
  type?: AccountType;
  currency?: string;
  allow_overdraft?: boolean;
  overdraft_limit?: bigint;
}

export interface StatementItem {
  id: string | number;
  entryType: 'POSTED_ENTRY' | 'REFUSED_ATTEMPT';
  transactionId?: string | null;
  action: string;
  direction?: 'DEBIT' | 'CREDIT';
  amount: string;
  runningBalance?: string | null;
  actorId?: string | null;
  outcome?: string;
  reasonCode?: string | null;
  timestamp: Date;
  description?: string | null;
}

export class AccountService {
  constructor(private pool?: IDatabasePool) {}

  private async getPool(): Promise<IDatabasePool> {
    if (!this.pool) {
      this.pool = await getDbPool();
    }
    return this.pool;
  }

  async createAccount(data: CreateAccountData): Promise<Account> {
    const pool = await this.getPool();
    const type = data.type || 'CUSTOMER';
    const currency = (data.currency || 'USD').toUpperCase();
    const allowOverdraft = data.allow_overdraft || false;
    const overdraftLimit = (data.overdraft_limit || 0n).toString();

    const res = await pool.query<Account>(
      `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
       VALUES ($1, $2, $3, 'ACTIVE', $4, 0, $5, $6)
       RETURNING *;`,
      [data.account_number.trim(), data.name.trim(), type, currency, allowOverdraft, overdraftLimit]
    );

    return res.rows[0]!;
  }

  async updateAccountStatus(accountId: string, status: AccountStatus): Promise<Account> {
    const pool = await this.getPool();
    const res = await pool.query<Account>(
      `UPDATE accounts SET status = $1 WHERE id = $2 RETURNING *;`,
      [status, accountId]
    );

    const updated = res.rows[0];
    if (!updated) {
      throw new NotFoundError(`Account not found: ${accountId}`);
    }
    return updated;
  }

  async setPermissions(
    accountId: string,
    userId: string,
    permissions: PermissionType[],
    grantedBy: string
  ): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify account and user exist
      const acc = await client.query('SELECT id FROM accounts WHERE id = $1', [accountId]);
      if (!acc.rows[0]) throw new NotFoundError('Account not found');

      const usr = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!usr.rows[0]) throw new NotFoundError('User not found');

      // Remove existing permissions for this user on this account
      await client.query(
        'DELETE FROM account_permissions WHERE account_id = $1 AND user_id = $2',
        [accountId, userId]
      );

      // Insert new permissions
      for (const perm of permissions) {
        await client.query(
          `INSERT INTO account_permissions (account_id, user_id, permission, granted_by)
           VALUES ($1, $2, $3, $4);`,
          [accountId, userId, perm, grantedBy]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async hasPermission(accountId: string, userId: string, permission: PermissionType): Promise<boolean> {
    const pool = await this.getPool();
    const res = await pool.query(
      `SELECT 1 FROM account_permissions 
       WHERE account_id = $1 AND user_id = $2 AND permission = $3 LIMIT 1;`,
      [accountId, userId, permission]
    );
    return res.rows.length > 0;
  }

  async getPermittedAccounts(actor: AuthActor): Promise<Account[]> {
    const pool = await this.getPool();

    // Admins and Auditors can view all accounts
    if (actor.role === 'ADMIN' || actor.role === 'AUDITOR') {
      const res = await pool.query<Account>('SELECT * FROM accounts ORDER BY account_number ASC');
      return res.rows;
    }

    // Account holders only see accounts where they hold VIEW permission
    const sql = `
      SELECT DISTINCT a.*
      FROM accounts a
      JOIN account_permissions ap ON a.id = ap.account_id
      WHERE ap.user_id = $1 AND ap.permission = 'VIEW'
      ORDER BY a.account_number ASC;
    `;
    const res = await pool.query<Account>(sql, [actor.id]);
    return res.rows;
  }

  async getAccountById(accountId: string, actor: AuthActor): Promise<Account> {
    const pool = await this.getPool();
    const res = await pool.query<Account>('SELECT * FROM accounts WHERE id = $1', [accountId]);
    const account = res.rows[0];

    // Consistent 404 to prevent IDOR / account enumeration
    if (!account) {
      throw new NotFoundError('Account not found');
    }

    if (actor.role !== 'ADMIN' && actor.role !== 'AUDITOR') {
      const permitted = await this.hasPermission(accountId, actor.id, 'VIEW');
      if (!permitted) {
        throw new NotFoundError('Account not found');
      }
    }

    return account;
  }

  async getStatement(
    accountId: string,
    actor: AuthActor,
    options: { from?: string; to?: string; page?: number; limit?: number }
  ): Promise<{
    account: Account;
    items: StatementItem[];
    page: number;
    limit: number;
    total: number;
  }> {
    const account = await this.getAccountById(accountId, actor);
    const pool = await this.getPool();

    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 50));
    const offset = (page - 1) * limit;

    // 1. Fetch posted ledger entries and refused attempts for this account
    const allParams: any[] = [accountId];
    let filter1 = '';
    let filter2 = '';
    if (options.from) {
      allParams.push(new Date(options.from));
      const pIdx = allParams.length;
      filter1 += ` AND le.created_at >= $${pIdx}`;
      filter2 += ` AND created_at >= $${pIdx}`;
    }
    if (options.to) {
      allParams.push(new Date(options.to));
      const pIdx = allParams.length;
      filter1 += ` AND le.created_at <= $${pIdx}`;
      filter2 += ` AND created_at <= $${pIdx}`;
    }

    const cleanUnion = `
      WITH combined AS (
        SELECT 
          le.id::text,
          'POSTED_ENTRY' AS entry_type,
          le.transaction_id::text,
          t.type AS action,
          le.direction,
          le.amount::text,
          le.balance_after::text AS running_balance,
          t.initiated_by::text AS actor_id,
          'SUCCESS' AS outcome,
          NULL::text AS reason_code,
          le.created_at AS timestamp,
          t.description
        FROM ledger_entries le
        JOIN transactions t ON le.transaction_id = t.id
        WHERE le.account_id = $1 ${filter1}

        UNION ALL

        SELECT 
          id::text,
          'REFUSED_ATTEMPT' AS entry_type,
          transaction_id::text,
          action,
          NULL::text AS direction,
          amount::text,
          NULL::text AS running_balance,
          actor_id::text,
          outcome,
          reason_code,
          created_at AS timestamp,
          reason_code AS description
        FROM transaction_attempts
        WHERE (source_account_id = $1 OR destination_account_id = $1)
          AND outcome IN ('REFUSED', 'FAILED')
          ${filter2}
      )
      SELECT * FROM combined
      ORDER BY timestamp DESC
      LIMIT $${allParams.length + 1} OFFSET $${allParams.length + 2};
    `;

    const cleanCount = `
      WITH combined AS (
        SELECT le.id FROM ledger_entries le WHERE le.account_id = $1 ${filter1}
        UNION ALL
        SELECT id FROM transaction_attempts
        WHERE (source_account_id = $1 OR destination_account_id = $1)
          AND outcome IN ('REFUSED', 'FAILED')
          ${filter2}
      )
      SELECT COUNT(*) AS count FROM combined;
    `;

    const countRes = await pool.query<{ count: string }>(cleanCount, allParams);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const rowsRes = await pool.query(cleanUnion, [...allParams, limit, offset]);

    const items: StatementItem[] = rowsRes.rows.map((r: any) => ({
      id: r.id,
      entryType: r.entry_type,
      transactionId: r.transaction_id,
      action: r.action,
      direction: r.direction,
      amount: r.amount || '0',
      runningBalance: r.running_balance,
      actorId: r.actor_id,
      outcome: r.outcome,
      reasonCode: r.reason_code,
      timestamp: r.timestamp,
      description: r.description,
    }));

    return {
      account,
      items,
      page,
      limit,
      total,
    };
  }
}

export const accountService = new AccountService();
