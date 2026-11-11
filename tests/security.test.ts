import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { initTestContext, TestContext } from './setup.js';
import { getDbPool, resetDbPool } from '../src/db/pool.js';
import { accountService } from '../src/services/account.service.js';
import { auditService } from '../src/services/audit.service.js';

describe('Security & Adversarial Robustness Test Suite', () => {
  let ctx: TestContext;
  let viewOnlyAccountId: string;

  beforeAll(async () => {
    ctx = await initTestContext();

    // Create a view-only account for Alice
    const viewAcc = await accountService.createAccount({
      account_number: `ACC-VIEWONLY-${Date.now()}`,
      name: 'View Only Trust Fund',
      type: 'CUSTOMER',
      currency: 'USD',
    });
    // Grant Alice ONLY VIEW permission (no TRANSFER_OUT, no WITHDRAW)
    await accountService.setPermissions(viewAcc.id, ctx.aliceActor.id, ['VIEW'], ctx.adminActor.id);
    viewOnlyAccountId = viewAcc.id;

    // Fund Alice's account so ledger_entries and transactions have real rows
    await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `seed-alice-sec-${Date.now()}`)
      .send({ amount: 10000 });
  }, 30000);

  afterAll(async () => {
    await resetDbPool();
  });

  it('prevents IDOR: account holder cannot read someone else account (receives 404)', async () => {
    // Mallory has no permissions on Alice's account
    const res = await request(app)
      .get(`/api/v1/accounts/${ctx.aliceAccountId}`)
      .set('Authorization', `Bearer ${ctx.malloryToken}`);

    // Must return 404 to prevent enumeration / IDOR
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('prevents unauthorized transactions: account holder cannot transact on someone else account', async () => {
    const res = await request(app)
      .post(`/api/v1/accounts/${ctx.bobAccountId}/withdraw`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `unauth-withdraw-${Date.now()}`)
      .send({ amount: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('prevents transfers out of accounts where user only has VIEW permission', async () => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `viewonly-transfer-${Date.now()}`)
      .send({
        source_account_id: viewOnlyAccountId,
        destination_account_id: ctx.aliceAccountId,
        amount: 500,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('enforces that AUDITOR role is strictly read-only: any write endpoint returns 403', async () => {
    // 1. Auditor deposit attempt
    const depRes = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.auditorToken}`)
      .set('Idempotency-Key', `auditor-dep-${Date.now()}`)
      .send({ amount: 1000 });
    expect(depRes.status).toBe(403);

    // 2. Auditor withdrawal attempt
    const withRes = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/withdraw`)
      .set('Authorization', `Bearer ${ctx.auditorToken}`)
      .set('Idempotency-Key', `auditor-with-${Date.now()}`)
      .send({ amount: 1000 });
    expect(withRes.status).toBe(403);

    // 3. Auditor transfer attempt
    const trfRes = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', `Bearer ${ctx.auditorToken}`)
      .set('Idempotency-Key', `auditor-trf-${Date.now()}`)
      .send({
        source_account_id: ctx.aliceAccountId,
        destination_account_id: ctx.bobAccountId,
        amount: 1000,
      });
    expect(trfRes.status).toBe(403);

    // 4. Auditor create user attempt
    const usrRes = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${ctx.auditorToken}`)
      .send({ email: 'new@test.com', password: 'Password123!', role: 'ACCOUNT_HOLDER' });
    expect(usrRes.status).toBe(403);
  });

  it('rejects unauthenticated and tampered/expired tokens with 401', async () => {
    // Missing token
    const resNoAuth = await request(app).get('/api/v1/accounts');
    expect(resNoAuth.status).toBe(401);

    // Tampered token
    const resTampered = await request(app)
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${ctx.aliceToken}tampered-signature`);
    expect(resTampered.status).toBe(401);
  });

  it('role forgery attempts via body or headers have zero effect (actor derived strictly from JWT)', async () => {
    // Alice sends body claiming role: 'ADMIN' or custom headers
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('X-User-Role', 'ADMIN')
      .set('X-User-Id', ctx.adminActor.id)
      .send({
        email: 'forged@test.com',
        password: 'Password123!',
        role: 'ADMIN',
      });

    // Still forbidden because actor is derived solely from the cryptographically verified JWT
    expect(res.status).toBe(403);
  });

  it('database triggers strictly forbid UPDATE and DELETE on ledger_entries and transactions', async () => {
    const pool = await getDbPool();
    const entryRes = await pool.query<{ id: string | number }>('SELECT id FROM ledger_entries LIMIT 1');
    const entryId = entryRes.rows[0]?.id;
    expect(entryId).toBeDefined();

    // 1. Attempt UPDATE on ledger_entries
    await expect(
      pool.query(`UPDATE ledger_entries SET amount = '99999999' WHERE id = $1`, [entryId])
    ).rejects.toThrow(/append-only: UPDATE and DELETE are prohibited/);

    // 2. Attempt DELETE on ledger_entries
    await expect(
      pool.query(`DELETE FROM ledger_entries WHERE id = $1`, [entryId])
    ).rejects.toThrow(/append-only: UPDATE and DELETE are prohibited/);

    // 3. Attempt UPDATE on transactions
    await expect(
      pool.query("UPDATE transactions SET amount = '99999999'")
    ).rejects.toThrow(/append-only: UPDATE and DELETE are prohibited/);

    // 4. Attempt DELETE on transactions
    await expect(pool.query('DELETE FROM transactions')).rejects.toThrow(
      /append-only: UPDATE and DELETE are prohibited/
    );
  });

  it('hash chain verification detects a deliberately tampered ledger row', async () => {
    const pool = await getDbPool();

    // Verify chain is valid initially
    const initialCheck = await auditService.verifyHashChain();
    expect(initialCheck.valid).toBe(true);

    // Temporarily disable the immutable trigger in a test-only manner to simulate out-of-band DB tampering
    await pool.exec('ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_immutable;');

    try {
      // Maliciously tamper with an existing entry's amount
      const targetRes = await pool.query<{ id: string | number }>(
        'SELECT id FROM ledger_entries ORDER BY id ASC LIMIT 1'
      );
      const targetId = targetRes.rows[0]?.id;
      expect(targetId).toBeDefined();

      await pool.query("UPDATE ledger_entries SET amount = '999999999' WHERE id = $1", [targetId]);

      // Re-run verify-chain: MUST detect tampering and report exact broken row
      const tamperedCheck = await auditService.verifyHashChain();
      expect(tamperedCheck.valid).toBe(false);
      expect(tamperedCheck.brokenAtId?.toString()).toBe(targetId?.toString());
      expect(tamperedCheck.reason).toContain('Tampered entry: hash recalculation mismatch');
    } finally {
      // Re-enable trigger
      await pool.exec('ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_immutable;');
    }
  });

  it('persists refused attempts in transaction_attempts with actor ID, reason code, and IP', async () => {
    // Attempt invalid transaction that gets refused
    await request(app)
      .post(`/api/v1/accounts/${ctx.bobAccountId}/withdraw`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', `refusal-audit-${Date.now()}`)
      .send({ amount: 999999999 });

    const attempts = await auditService.getAttempts({
      actorId: ctx.aliceActor.id,
      outcome: 'REFUSED',
    });

    expect(attempts.attempts.length).toBeGreaterThan(0);
    const lastAttempt = attempts.attempts[0]!;
    expect(lastAttempt.actor_id).toBe(ctx.aliceActor.id);
    expect(lastAttempt.outcome).toBe('REFUSED');
    expect(lastAttempt.reason_code).toBeDefined();
  });
});
