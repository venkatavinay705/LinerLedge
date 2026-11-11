import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initTestContext, TestContext } from './setup.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { auditService } from '../src/services/audit.service.js';
import { accountService } from '../src/services/account.service.js';
import { getDbPool, resetDbPool } from '../src/db/pool.js';

describe('Concurrency & Race Condition Test Suite', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext();
  }, 30000);

  afterAll(async () => {
    await resetDbPool();
  });

  it('handles 50 simultaneous withdrawals from limited balance: exactly affordable succeed, balance never negative', async () => {
    // 1. Create a dedicated account with 50,000 cents ($500.00)
    const limitedAcc = await accountService.createAccount({
      account_number: `ACC-RACE-WITHDRAW-${Date.now()}`,
      name: 'Race Withdrawal Test',
      type: 'CUSTOMER',
      currency: 'USD',
      allow_overdraft: false,
      overdraft_limit: 0n,
    });

    await ledgerService.deposit({
      accountId: limitedAcc.id,
      amount: 50000n, // $500.00
      actor: ctx.adminActor,
      description: 'Seed race withdrawal account',
    });

    // 2. Launch 50 simultaneous concurrent withdrawal attempts of 10,000 cents ($100.00) each
    // Only 5 can possibly succeed; 45 must be rejected
    const withdrawalAmount = 10000n;
    const concurrentCount = 50;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < concurrentCount; i++) {
      promises.push(
        ledgerService.withdraw({
          accountId: limitedAcc.id,
          amount: withdrawalAmount,
          actor: ctx.adminActor,
          idempotencyKey: `concurrent-withdraw-${i}-${Date.now()}`,
          description: `Concurrent withdrawal #${i}`,
        })
      );
    }

    const results = await Promise.allSettled(promises);

    let successes = 0;
    let failures = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        successes++;
      } else {
        failures++;
        expect(r.reason?.code).toBe('INSUFFICIENT_FUNDS');
      }
    }

    // Exactly 5 affordable withdrawals succeeded
    expect(successes).toBe(5);
    expect(failures).toBe(45);

    // Final balance must be exactly 0 cents, never negative
    const pool = await getDbPool();
    const finalAcc = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [limitedAcc.id])
    ).rows[0];
    expect(finalAcc.balance.toString()).toBe('0');

    // Global conservation invariant holds
    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  }, 30000);

  it('executes concurrent opposite-direction transfers (A->B and B->A) without deadlocks', async () => {
    // 1. Create two accounts with 50,000 cents each
    const accA = await accountService.createAccount({
      account_number: `ACC-DEADLOCK-A-${Date.now()}`,
      name: 'Deadlock Test Account A',
      type: 'CUSTOMER',
      currency: 'USD',
      allow_overdraft: false,
      overdraft_limit: 0n,
    });

    const accB = await accountService.createAccount({
      account_number: `ACC-DEADLOCK-B-${Date.now()}`,
      name: 'Deadlock Test Account B',
      type: 'CUSTOMER',
      currency: 'USD',
      allow_overdraft: false,
      overdraft_limit: 0n,
    });

    await ledgerService.deposit({
      accountId: accA.id,
      amount: 50000n,
      actor: ctx.adminActor,
    });
    await ledgerService.deposit({
      accountId: accB.id,
      amount: 50000n,
      actor: ctx.adminActor,
    });

    // 2. Launch 20 concurrent transfers: 10 from A->B, 10 from B->A simultaneously
    const transferAmount = 1000n; // 1,000 cents each
    const transferPromises: Promise<any>[] = [];

    for (let i = 0; i < 10; i++) {
      // A -> B
      transferPromises.push(
        ledgerService.transfer({
          sourceAccountId: accA.id,
          destinationAccountId: accB.id,
          amount: transferAmount,
          actor: ctx.adminActor,
          idempotencyKey: `transfer-ab-${i}-${Date.now()}`,
        })
      );
      // B -> A (opposite direction)
      transferPromises.push(
        ledgerService.transfer({
          sourceAccountId: accB.id,
          destinationAccountId: accA.id,
          amount: transferAmount,
          actor: ctx.adminActor,
          idempotencyKey: `transfer-ba-${i}-${Date.now()}`,
        })
      );
    }

    // All must complete successfully without any deadlock error
    const results = await Promise.all(transferPromises);
    expect(results.length).toBe(20);

    // Balances must be exactly unchanged: 50,000 - 10,000 + 10,000 = 50,000
    const pool = await getDbPool();
    const finalA = (await pool.query('SELECT balance FROM accounts WHERE id = $1', [accA.id]))
      .rows[0].balance;
    const finalB = (await pool.query('SELECT balance FROM accounts WHERE id = $1', [accB.id]))
      .rows[0].balance;

    expect(finalA.toString()).toBe('50000');
    expect(finalB.toString()).toBe('50000');

    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  }, 30000);

  it('processes many concurrent deposits into a single account with exact final balance', async () => {
    const depositAcc = await accountService.createAccount({
      account_number: `ACC-CONCURRENT-DEP-${Date.now()}`,
      name: 'Concurrent Deposit Account',
      type: 'CUSTOMER',
      currency: 'USD',
    });

    const depositCount = 30;
    const depositAmount = 2500n; // $25.00 each
    const promises: Promise<any>[] = [];

    for (let i = 0; i < depositCount; i++) {
      promises.push(
        ledgerService.deposit({
          accountId: depositAcc.id,
          amount: depositAmount,
          actor: ctx.adminActor,
          idempotencyKey: `concurrent-dep-${i}-${Date.now()}`,
        })
      );
    }

    await Promise.all(promises);

    const pool = await getDbPool();
    const finalAcc = (
      await pool.query('SELECT balance FROM accounts WHERE id = $1', [depositAcc.id])
    ).rows[0];

    const expectedBalance = (depositCount * 2500).toString();
    expect(finalAcc.balance.toString()).toBe(expectedBalance);

    const recon = await auditService.reconcile();
    expect(recon.reconciled).toBe(true);
    expect(recon.globalSum).toBe('0');
  }, 30000);
});
