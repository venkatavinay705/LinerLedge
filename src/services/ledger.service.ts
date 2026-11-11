import { getDbPool, IDatabasePool, IDatabaseClient } from '../db/pool.js';
import {
  Account,
  Transaction,
  LedgerEntry,
  AuthActor,
  EntryDirection,
} from '../types/index.js';
import {
  InsufficientFundsError,
  AccountFrozenError,
  AccountClosedError,
  SelfTransferError,
  NotFoundError,
  AppError,
} from '../utils/errors.js';
import { computeEntryHash, GENESIS_HASH } from '../utils/crypto.js';
import { auditService } from './audit.service.js';
import { logger } from '../utils/logger.js';

export interface TransferParams {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: bigint;
  actor: AuthActor;
  idempotencyKey?: string;
  description?: string;
  ip?: string;
}

export interface DepositWithdrawParams {
  accountId: string;
  amount: bigint;
  actor: AuthActor;
  idempotencyKey?: string;
  description?: string;
  ip?: string;
}

export interface TransactionExecutionResult {
  transaction: Transaction;
  entries: LedgerEntry[];
  sourceAccount?: Account;
  destinationAccount?: Account;
}

export class LedgerService {
  constructor(private pool?: IDatabasePool) {}

  private async getPool(): Promise<IDatabasePool> {
    if (!this.pool) {
      this.pool = await getDbPool();
    }
    return this.pool;
  }

  private async getOrCreateCashVault(client: IDatabaseClient): Promise<Account> {
    const res = await client.query<Account>(
      `SELECT * FROM accounts WHERE type = 'SYSTEM' AND account_number = 'CASH_VAULT' LIMIT 1 FOR UPDATE`
    );

    if (res.rows[0]) {
      return res.rows[0];
    }

    const insertRes = await client.query<Account>(
      `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
       VALUES ('CASH_VAULT', 'System Cash Vault', 'SYSTEM', 'ACTIVE', 'USD', 0, true, 9223372036854775807)
       ON CONFLICT (account_number) DO UPDATE SET name = EXCLUDED.name
       RETURNING *;`
    );
    return insertRes.rows[0]!;
  }

  private async getLatestEntryHash(client: IDatabaseClient): Promise<string> {
    const res = await client.query<{ entry_hash: string }>(
      `SELECT entry_hash FROM ledger_entries ORDER BY id DESC LIMIT 1`
    );
    return res.rows[0]?.entry_hash || GENESIS_HASH;
  }

  private async insertLedgerEntry(
    client: IDatabaseClient,
    params: {
      transactionId: string;
      accountId: string;
      direction: EntryDirection;
      amount: bigint;
      balanceAfter: bigint;
      prevHash: string;
      createdAt: Date;
    }
  ): Promise<LedgerEntry> {
    const seqRes = await client.query<{ id: string | number }>(
      `SELECT nextval('ledger_entries_id_seq') AS id;`
    );
    const nextId = seqRes.rows[0]!.id;

    const entryHash = computeEntryHash({
      id: nextId,
      transactionId: params.transactionId,
      accountId: params.accountId,
      direction: params.direction,
      amount: params.amount,
      balanceAfter: params.balanceAfter,
      createdAt: params.createdAt,
      prevHash: params.prevHash,
    });

    const insertSql = `
      INSERT INTO ledger_entries (
        id, transaction_id, account_id, direction, amount, balance_after, created_at, prev_hash, entry_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    const res = await client.query<LedgerEntry>(insertSql, [
      nextId,
      params.transactionId,
      params.accountId,
      params.direction,
      params.amount.toString(),
      params.balanceAfter.toString(),
      params.createdAt,
      params.prevHash,
      entryHash,
    ]);

    return res.rows[0]!;
  }

  private assertAccountActive(account: Account): void {
    if (account.status === 'FROZEN') {
      throw new AccountFrozenError(`Account ${account.account_number} is frozen`);
    }
    if (account.status === 'CLOSED') {
      throw new AccountClosedError(`Account ${account.account_number} is closed`);
    }
  }

  async deposit(params: DepositWithdrawParams): Promise<TransactionExecutionResult> {
    if (params.amount <= 0n) {
      throw new AppError('Deposit amount must be strictly positive', 400, 'VALIDATION_ERROR');
    }

    const pool = await this.getPool();
    const client = await pool.connect();

    let transactionRecord: Transaction | null = null;
    let vaultEntry: LedgerEntry | null = null;
    let customerEntry: LedgerEntry | null = null;
    let updatedCustomerAcc: Account | null = null;
    let executionError: any = null;

    try {
      await client.query('BEGIN');

      const vault = await this.getOrCreateCashVault(client);
      const [firstId, secondId] = [vault.id, params.accountId].sort();

      const lockRes = await client.query<Account>(
        `SELECT * FROM accounts WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE`,
        [firstId, secondId]
      );

      const customerAcc = lockRes.rows.find((a) => a.id === params.accountId);
      const vaultAcc = lockRes.rows.find((a) => a.id === vault.id);

      if (!customerAcc) {
        throw new NotFoundError(`Account not found: ${params.accountId}`);
      }
      if (!vaultAcc) {
        throw new NotFoundError('System Cash Vault account not found');
      }

      this.assertAccountActive(customerAcc);
      this.assertAccountActive(vaultAcc);

      const newCustomerBalance = BigInt(customerAcc.balance) + params.amount;
      const newVaultBalance = BigInt(vaultAcc.balance) - params.amount;

      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newCustomerBalance.toString(),
        customerAcc.id,
      ]);
      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newVaultBalance.toString(),
        vaultAcc.id,
      ]);

      const now = new Date();
      const txRes = await client.query<Transaction>(
        `INSERT INTO transactions (type, status, amount, currency, initiated_by, idempotency_key, description, created_at)
         VALUES ('DEPOSIT', 'POSTED', $1, $2, $3, $4, $5, $6)
         RETURNING *;`,
        [
          params.amount.toString(),
          customerAcc.currency,
          params.actor.id,
          params.idempotencyKey || null,
          params.description || 'Deposit to account',
          now,
        ]
      );
      transactionRecord = txRes.rows[0]!;

      const prevHash = await this.getLatestEntryHash(client);
      vaultEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: vaultAcc.id,
        direction: 'DEBIT',
        amount: params.amount,
        balanceAfter: newVaultBalance,
        prevHash,
        createdAt: now,
      });

      customerEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: customerAcc.id,
        direction: 'CREDIT',
        amount: params.amount,
        balanceAfter: newCustomerBalance,
        prevHash: vaultEntry.entry_hash,
        createdAt: now,
      });

      await client.query('COMMIT');
      updatedCustomerAcc = { ...customerAcc, balance: newCustomerBalance.toString() };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      executionError = err;
    } finally {
      client.release();
    }

    if (executionError) {
      await auditService
        .logAttempt({
          actorId: params.actor.id,
          actorRole: params.actor.role,
          action: 'DEPOSIT',
          destinationAccountId: params.accountId,
          amount: params.amount,
          idempotencyKey: params.idempotencyKey,
          outcome: 'REFUSED',
          reasonCode: executionError.code || 'UNKNOWN_ERROR',
          ip: params.ip,
        })
        .catch((e) => logger.warn({ error: e }, 'Failed to log deposit refusal'));
      throw executionError;
    }

    await auditService.logAttempt({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: 'DEPOSIT',
      destinationAccountId: updatedCustomerAcc!.id,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      outcome: 'SUCCESS',
      transactionId: transactionRecord!.id,
      ip: params.ip,
    });

    return {
      transaction: transactionRecord!,
      entries: [vaultEntry!, customerEntry!],
      destinationAccount: updatedCustomerAcc!,
    };
  }

  async withdraw(params: DepositWithdrawParams): Promise<TransactionExecutionResult> {
    if (params.amount <= 0n) {
      throw new AppError('Withdrawal amount must be strictly positive', 400, 'VALIDATION_ERROR');
    }

    const pool = await this.getPool();
    const client = await pool.connect();

    let transactionRecord: Transaction | null = null;
    let customerEntry: LedgerEntry | null = null;
    let vaultEntry: LedgerEntry | null = null;
    let updatedCustomerAcc: Account | null = null;
    let executionError: any = null;

    try {
      await client.query('BEGIN');

      const vault = await this.getOrCreateCashVault(client);
      const [firstId, secondId] = [vault.id, params.accountId].sort();

      const lockRes = await client.query<Account>(
        `SELECT * FROM accounts WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE`,
        [firstId, secondId]
      );

      const customerAcc = lockRes.rows.find((a) => a.id === params.accountId);
      const vaultAcc = lockRes.rows.find((a) => a.id === vault.id);

      if (!customerAcc) {
        throw new NotFoundError(`Account not found: ${params.accountId}`);
      }
      if (!vaultAcc) {
        throw new NotFoundError('System Cash Vault account not found');
      }

      this.assertAccountActive(customerAcc);
      this.assertAccountActive(vaultAcc);

      const newCustomerBalance = BigInt(customerAcc.balance) - params.amount;
      const minAllowedBalance = customerAcc.allow_overdraft
        ? -BigInt(customerAcc.overdraft_limit)
        : 0n;

      if (newCustomerBalance < minAllowedBalance) {
        throw new InsufficientFundsError(
          `Insufficient funds in account ${customerAcc.account_number}. Required: ${params.amount}, Available: ${
            BigInt(customerAcc.balance) - minAllowedBalance
          }`
        );
      }

      const newVaultBalance = BigInt(vaultAcc.balance) + params.amount;

      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newCustomerBalance.toString(),
        customerAcc.id,
      ]);
      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newVaultBalance.toString(),
        vaultAcc.id,
      ]);

      const now = new Date();
      const txRes = await client.query<Transaction>(
        `INSERT INTO transactions (type, status, amount, currency, initiated_by, idempotency_key, description, created_at)
         VALUES ('WITHDRAWAL', 'POSTED', $1, $2, $3, $4, $5, $6)
         RETURNING *;`,
        [
          params.amount.toString(),
          customerAcc.currency,
          params.actor.id,
          params.idempotencyKey || null,
          params.description || 'Withdrawal from account',
          now,
        ]
      );
      transactionRecord = txRes.rows[0]!;

      const prevHash = await this.getLatestEntryHash(client);
      customerEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: customerAcc.id,
        direction: 'DEBIT',
        amount: params.amount,
        balanceAfter: newCustomerBalance,
        prevHash,
        createdAt: now,
      });

      vaultEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: vaultAcc.id,
        direction: 'CREDIT',
        amount: params.amount,
        balanceAfter: newVaultBalance,
        prevHash: customerEntry.entry_hash,
        createdAt: now,
      });

      await client.query('COMMIT');
      updatedCustomerAcc = { ...customerAcc, balance: newCustomerBalance.toString() };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      executionError = err;
    } finally {
      client.release();
    }

    if (executionError) {
      await auditService
        .logAttempt({
          actorId: params.actor.id,
          actorRole: params.actor.role,
          action: 'WITHDRAWAL',
          sourceAccountId: params.accountId,
          amount: params.amount,
          idempotencyKey: params.idempotencyKey,
          outcome: 'REFUSED',
          reasonCode: executionError.code || 'UNKNOWN_ERROR',
          ip: params.ip,
        })
        .catch((e) => logger.warn({ error: e }, 'Failed to log withdrawal refusal'));
      throw executionError;
    }

    await auditService.logAttempt({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: 'WITHDRAWAL',
      sourceAccountId: updatedCustomerAcc!.id,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      outcome: 'SUCCESS',
      transactionId: transactionRecord!.id,
      ip: params.ip,
    });

    return {
      transaction: transactionRecord!,
      entries: [customerEntry!, vaultEntry!],
      sourceAccount: updatedCustomerAcc!,
    };
  }

  async transfer(params: TransferParams): Promise<TransactionExecutionResult> {
    if (params.amount <= 0n) {
      throw new AppError('Transfer amount must be strictly positive', 400, 'VALIDATION_ERROR');
    }

    if (params.sourceAccountId === params.destinationAccountId) {
      throw new SelfTransferError('Cannot transfer to the same account');
    }

    const pool = await this.getPool();
    const client = await pool.connect();

    let transactionRecord: Transaction | null = null;
    let sourceEntry: LedgerEntry | null = null;
    let destEntry: LedgerEntry | null = null;
    let updatedSourceAcc: Account | null = null;
    let updatedDestAcc: Account | null = null;
    let executionError: any = null;

    try {
      await client.query('BEGIN');

      const [firstId, secondId] = [params.sourceAccountId, params.destinationAccountId].sort();

      const lockRes = await client.query<Account>(
        `SELECT * FROM accounts WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE`,
        [firstId, secondId]
      );

      const sourceAcc = lockRes.rows.find((a) => a.id === params.sourceAccountId);
      const destAcc = lockRes.rows.find((a) => a.id === params.destinationAccountId);

      if (!sourceAcc) {
        throw new NotFoundError(`Source account not found: ${params.sourceAccountId}`);
      }
      if (!destAcc) {
        throw new NotFoundError(`Destination account not found: ${params.destinationAccountId}`);
      }

      this.assertAccountActive(sourceAcc);
      this.assertAccountActive(destAcc);

      if (sourceAcc.currency !== destAcc.currency) {
        throw new AppError(
          `Currency mismatch: ${sourceAcc.currency} vs ${destAcc.currency}`,
          400,
          'CURRENCY_MISMATCH'
        );
      }

      const newSourceBalance = BigInt(sourceAcc.balance) - params.amount;
      const minAllowedBalance = sourceAcc.allow_overdraft
        ? -BigInt(sourceAcc.overdraft_limit)
        : 0n;

      if (newSourceBalance < minAllowedBalance) {
        throw new InsufficientFundsError(
          `Insufficient funds in source account ${sourceAcc.account_number}. Required: ${params.amount}, Available: ${
            BigInt(sourceAcc.balance) - minAllowedBalance
          }`
        );
      }

      const newDestBalance = BigInt(destAcc.balance) + params.amount;

      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newSourceBalance.toString(),
        sourceAcc.id,
      ]);
      await client.query(`UPDATE accounts SET balance = $1 WHERE id = $2`, [
        newDestBalance.toString(),
        destAcc.id,
      ]);

      const now = new Date();
      const txRes = await client.query<Transaction>(
        `INSERT INTO transactions (type, status, amount, currency, initiated_by, idempotency_key, description, created_at)
         VALUES ('TRANSFER', 'POSTED', $1, $2, $3, $4, $5, $6)
         RETURNING *;`,
        [
          params.amount.toString(),
          sourceAcc.currency,
          params.actor.id,
          params.idempotencyKey || null,
          params.description || 'Account transfer',
          now,
        ]
      );
      transactionRecord = txRes.rows[0]!;

      const prevHash = await this.getLatestEntryHash(client);
      sourceEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: sourceAcc.id,
        direction: 'DEBIT',
        amount: params.amount,
        balanceAfter: newSourceBalance,
        prevHash,
        createdAt: now,
      });

      destEntry = await this.insertLedgerEntry(client, {
        transactionId: transactionRecord.id,
        accountId: destAcc.id,
        direction: 'CREDIT',
        amount: params.amount,
        balanceAfter: newDestBalance,
        prevHash: sourceEntry.entry_hash,
        createdAt: now,
      });

      await client.query('COMMIT');
      updatedSourceAcc = { ...sourceAcc, balance: newSourceBalance.toString() };
      updatedDestAcc = { ...destAcc, balance: newDestBalance.toString() };
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      executionError = err;
    } finally {
      client.release();
    }

    if (executionError) {
      await auditService
        .logAttempt({
          actorId: params.actor.id,
          actorRole: params.actor.role,
          action: 'TRANSFER',
          sourceAccountId: params.sourceAccountId,
          destinationAccountId: params.destinationAccountId,
          amount: params.amount,
          idempotencyKey: params.idempotencyKey,
          outcome: 'REFUSED',
          reasonCode: executionError.code || 'UNKNOWN_ERROR',
          ip: params.ip,
        })
        .catch((e) => logger.warn({ error: e }, 'Failed to log transfer refusal'));
      throw executionError;
    }

    await auditService.logAttempt({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: 'TRANSFER',
      sourceAccountId: updatedSourceAcc!.id,
      destinationAccountId: updatedDestAcc!.id,
      amount: params.amount,
      idempotencyKey: params.idempotencyKey,
      outcome: 'SUCCESS',
      transactionId: transactionRecord!.id,
      ip: params.ip,
    });

    return {
      transaction: transactionRecord!,
      entries: [sourceEntry!, destEntry!],
      sourceAccount: updatedSourceAcc!,
      destinationAccount: updatedDestAcc!,
    };
  }
}

export const ledgerService = new LedgerService();
