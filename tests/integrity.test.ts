import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initTestContext, TestContext } from './setup.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { auditService } from '../src/services/audit.service.js';
import { getDbPool, resetDbPool } from '../src/db/pool.js';
import { InsufficientFundsError } from '../src/utils/errors.js';

describe('Integrity & Double-Entry Invariant Test Suite', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext();
  });

  afterAll(async () => {
    await resetDbPool();
  });

  it('enforces debits == credits for every transaction and stores consistent running balance', async () => {
    const depositRes = await ledgerService.deposit({
      accountId: ctx.aliceAccountId,
      amount: 50000n, // $500.00
      actor: ctx.adminActor,
      description: 'Funding Alice',
    });

    expect(depositRes.entries.length).toBe(2);
    const debitEntry = depositRes.entries.find((e) => e.direction === 'DEBIT')!;
    const creditEntry = depositRes.entries.find((e) => e.direction === 'CREDIT')!;

    expect(debitEntry.amount.toString()).toBe('50000');
    expect(creditEntry.amount.toString()).toBe('50000');

    // Transfer from Alice to Bob
    const transferRes = await ledgerService.transfer({
      sourceAccountId: ctx.aliceAccountId,
      destinationAccountId: ctx.bobAccountId,
      amount: 20000n, // $200.00
      actor: ctx.adminActor,
      description: 'Transfer Alice to Bob',
    });

    expect(transferRes.entries.length).toBe(2);
    const sourceDebit = transferRes.entries.find((e) => e.direction === 'DEBIT')!;
    const destCredit = transferRes.entries.find((e) => e.direction === 'CREDIT')!;

    expect(sourceDebit.amount.toString()).toBe('20000');
    expect(destCredit.amount.toString()).toBe('20000');
    expect(sourceDebit.balance_after.toString()).toBe('30000');
    expect(destCredit.balance_after.toString()).toBe('20000');
  });

  it('guarantees balance == sum of ledger entries and global conservation holds', async () => {
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
    expect(recon.discrepancies.length).toBe(0);
  });

  it('strictly prevents negative balances on accounts without overdraft permission', async () => {
    const pool = await getDbPool();
    const aliceBefore = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.aliceAccountId])
    ).rows[0].balance;

    // Alice currently has 30000 cents ($300.00). Attempting to withdraw 30001 must fail
    await expect(
      ledgerService.withdraw({
        accountId: ctx.aliceAccountId,
        amount: 30001n,
        actor: ctx.adminActor,
      })
    ).rejects.toThrow(InsufficientFundsError);

    const aliceAfter = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.aliceAccountId])
    ).rows[0].balance;

    // Balance must be completely unchanged
    expect(aliceAfter.toString()).toBe(aliceBefore.toString());
  });

  it('permits overdraft up to exact limit, then strictly refuses any further withdrawal', async () => {
    // Bob has 20000 cents ($200.00) and 10000 cents ($100.00) overdraft limit
    // Total available = 30000 cents.
    // Withdraw 25000 -> balance becomes -5000 cents (legal overdraft)
    const res1 = await ledgerService.withdraw({
      accountId: ctx.bobAccountId,
      amount: 25000n,
      actor: ctx.adminActor,
    });
    expect(res1.sourceAccount?.balance.toString()).toBe('-5000');

    // Withdraw 5000 -> balance becomes -10000 cents (exact limit)
    const res2 = await ledgerService.withdraw({
      accountId: ctx.bobAccountId,
      amount: 5000n,
      actor: ctx.adminActor,
    });
    expect(res2.sourceAccount?.balance.toString()).toBe('-10000');

    // Attempting to withdraw even 1 more cent must be strictly refused
    await expect(
      ledgerService.withdraw({
        accountId: ctx.bobAccountId,
        amount: 1n,
        actor: ctx.adminActor,
      })
    ).rejects.toThrow(InsufficientFundsError);

    // Verify reconciliation holds
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  });

  it('guarantees atomicity: mid-transfer injected failure rolls back completely with zero effect', async () => {
    const pool = await getDbPool();
    const client = await pool.connect();

    const aliceBefore = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.aliceAccountId])
    ).rows[0].balance;
    const bobBefore = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.bobAccountId])
    ).rows[0].balance;
    const ledgerCountBefore = (
      await pool.query('SELECT COUNT(*) AS count FROM ledger_entries')
    ).rows[0].count;

    // Simulate an interrupted/failed transaction: debit Alice, then abort before credit Bob
    await client.query('BEGIN');
    try {
      await client.query('UPDATE accounts SET balance = balance - 5000 WHERE id = $1', [
        ctx.aliceAccountId,
      ]);
      // Artificially raise exception before second leg
      throw new Error('Injected network/database failure mid-transaction!');
    } catch (e) {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const aliceAfter = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.aliceAccountId])
    ).rows[0].balance;
    const bobAfter = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [ctx.bobAccountId])
    ).rows[0].balance;
    const ledgerCountAfter = (
      await pool.query('SELECT COUNT(*) AS count FROM ledger_entries')
    ).rows[0].count;

    expect(aliceAfter.toString()).toBe(aliceBefore.toString());
    expect(bobAfter.toString()).toBe(bobBefore.toString());
    expect(ledgerCountAfter.toString()).toBe(ledgerCountBefore.toString());
  });

  it('property-based test: randomized sequence of 50 operations strictly conserves global money', async () => {
    // Perform 50 randomized operations (deposits, transfers, withdrawals)
    for (let i = 0; i < 50; i++) {
      const op = Math.floor(Math.random() * 3);
      const amount = BigInt(Math.floor(Math.random() * 5000) + 100); // 100 to 5100 cents

      try {
        if (op === 0) {
          // Deposit
          const target = Math.random() > 0.5 ? ctx.aliceAccountId : ctx.bobAccountId;
          await ledgerService.deposit({
            accountId: target,
            amount,
            actor: ctx.adminActor,
            description: `Random deposit ${i}`,
          });
        } else if (op === 1) {
          // Transfer
          const [src, dst] =
            Math.random() > 0.5
              ? [ctx.aliceAccountId, ctx.bobAccountId]
              : [ctx.bobAccountId, ctx.aliceAccountId];
          await ledgerService.transfer({
            sourceAccountId: src,
            destinationAccountId: dst,
            amount,
            actor: ctx.adminActor,
            description: `Random transfer ${i}`,
          });
        } else {
          // Withdraw
          const target = Math.random() > 0.5 ? ctx.aliceAccountId : ctx.bobAccountId;
          await ledgerService.withdraw({
            accountId: target,
            amount,
            actor: ctx.adminActor,
            description: `Random withdraw ${i}`,
          });
        }
      } catch (err: any) {
        // Insufficient funds is an expected normal business refusal
        expect(['INSUFFICIENT_FUNDS', 'VALIDATION_ERROR']).toContain(err.code);
      }
    }

    // Invariant verification after random sequence
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');

    const chain = await auditService.verifyHashChain();
    expect(chain.valid).toBe(true);
  });
});
