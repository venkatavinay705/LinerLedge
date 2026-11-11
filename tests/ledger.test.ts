import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDbPool, resetDbPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { auditService } from '../src/services/audit.service.js';
import { AuthActor } from '../src/types/index.js';

describe('Milestone 2: Ledger Service & Core Financial Invariants', () => {
  const adminActor: AuthActor = {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@ledgerline.test',
    role: 'ADMIN',
  };

  let accountAId: string;
  let accountBId: string;

  beforeAll(async () => {
    process.env.USE_PGLITE = 'true';
    const pool = await getDbPool();
    await runMigrations(pool);

    // Seed test user
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, 'hash', 'ADMIN')
       ON CONFLICT (email) DO NOTHING;`,
      [adminActor.id, adminActor.email]
    );

    // Create test accounts
    const accA = await pool.query(
      `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
       VALUES ('ACC-TEST-A', 'Alice Test', 'CUSTOMER', 'ACTIVE', 'USD', 0, false, 0)
       RETURNING id;`
    );
    accountAId = accA.rows[0].id;

    const accB = await pool.query(
      `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
       VALUES ('ACC-TEST-B', 'Bob Test', 'CUSTOMER', 'ACTIVE', 'USD', 0, true, 5000)
       RETURNING id;`
    );
    accountBId = accB.rows[0].id;
  });

  afterAll(async () => {
    await resetDbPool();
  });

  it('executes a deposit creating balanced double-entry records in hash chain', async () => {
    const res = await ledgerService.deposit({
      accountId: accountAId,
      amount: 10000n, // $100.00
      actor: adminActor,
      description: 'Initial deposit Alice',
    });

    expect(res.transaction.amount.toString()).toBe('10000');
    expect(res.entries.length).toBe(2);
    expect(res.entries[0]!.direction).toBe('DEBIT'); // CASH_VAULT
    expect(res.entries[1]!.direction).toBe('CREDIT'); // Alice
    expect(res.destinationAccount?.balance.toString()).toBe('10000');

    // Verify hash chain
    const chain = await auditService.verifyHashChain();
    expect(chain.valid).toBe(true);
    expect(chain.totalEntries).toBeGreaterThanOrEqual(2);

    // Verify reconciliation
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  });

  it('executes a transfer from Alice to Bob with exact balance updates', async () => {
    const res = await ledgerService.transfer({
      sourceAccountId: accountAId,
      destinationAccountId: accountBId,
      amount: 4000n, // $40.00
      actor: adminActor,
      description: 'Transfer Alice to Bob',
    });

    expect(res.transaction.amount.toString()).toBe('4000');
    expect(res.sourceAccount?.balance.toString()).toBe('6000');
    expect(res.destinationAccount?.balance.toString()).toBe('4000');

    const chain = await auditService.verifyHashChain();
    expect(chain.valid).toBe(true);

    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  });

  it('rejects withdrawal exceeding balance for non-overdraft account and logs refusal', async () => {
    await expect(
      ledgerService.withdraw({
        accountId: accountAId,
        amount: 10000n, // Alice has 6000
        actor: adminActor,
      })
    ).rejects.toThrow('Insufficient funds');

    // Balance must be untouched
    const pool = await getDbPool();
    const acc = await pool.query('SELECT balance FROM accounts WHERE id = $1', [accountAId]);
    expect(acc.rows[0].balance.toString()).toBe('6000');

    // Refusal must be recorded in transaction_attempts
    const attempts = await auditService.getAttempts({ accountId: accountAId, outcome: 'REFUSED' });
    expect(attempts.attempts.length).toBeGreaterThan(0);
    expect(attempts.attempts[0]?.reason_code).toBe('INSUFFICIENT_FUNDS');
  });

  it('allows withdrawal within overdraft limit for account with allow_overdraft=true', async () => {
    // Bob has 4000 balance and 5000 overdraft limit (can go down to -5000)
    // Withdraw 7000 => Bob balance becomes -3000
    const res = await ledgerService.withdraw({
      accountId: accountBId,
      amount: 7000n,
      actor: adminActor,
    });

    expect(res.sourceAccount?.balance).toBe('-3000');

    // Global conservation must still hold (= 0)
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  });

  it('prevents self-transfer', async () => {
    await expect(
      ledgerService.transfer({
        sourceAccountId: accountAId,
        destinationAccountId: accountAId,
        amount: 1000n,
        actor: adminActor,
      })
    ).rejects.toThrow('Cannot transfer to the same account');
  });
});
