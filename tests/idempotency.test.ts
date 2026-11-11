import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { initTestContext, TestContext } from './setup.js';
import { resetDbPool, getDbPool } from '../src/db/pool.js';
import { auditService } from '../src/services/audit.service.js';

describe('Idempotency Protocol & Replay Test Suite', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext();
  }, 30000);

  afterAll(async () => {
    await resetDbPool();
  });

  it('replaying the same key sequentially returns the identical original response with replay header and creates no new ledger entries', async () => {
    const key = `seq-key-${Date.now()}`;
    const payload = { amount: 15000, description: 'Sequential Idempotent Deposit' };

    const pool = await getDbPool();
    const ledgerCountBefore = (
      await pool.query('SELECT COUNT(*) AS count FROM ledger_entries')
    ).rows[0].count;

    // First request
    const res1 = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res1.status).toBe(201);
    expect(res1.body.success).toBe(true);
    expect(res1.header['idempotent-replay']).toBeUndefined();
    const originalTxId = res1.body.data.transaction.id;

    const ledgerCountAfterFirst = (
      await pool.query('SELECT COUNT(*) AS count FROM ledger_entries')
    ).rows[0].count;
    // Exactly 2 new entries created (Vault debit, Alice credit)
    expect(Number(ledgerCountAfterFirst)).toBe(Number(ledgerCountBefore) + 2);

    // Replay 1
    const res2 = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.header['idempotent-replay']).toBe('true');
    expect(res2.body.data.transaction.id).toBe(originalTxId);

    // Replay 2
    const res3 = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(res3.status).toBe(201);
    expect(res3.header['idempotent-replay']).toBe('true');
    expect(res3.body.data.transaction.id).toBe(originalTxId);

    // Assert that ledger entries count did NOT increase
    const ledgerCountFinal = (
      await pool.query('SELECT COUNT(*) AS count FROM ledger_entries')
    ).rows[0].count;
    expect(Number(ledgerCountFinal)).toBe(Number(ledgerCountAfterFirst));

    // Audit attempts should contain the initial SUCCESS and REPLAYED entries
    const attempts = await auditService.getAttempts({ actorId: ctx.aliceActor.id });
    const replays = attempts.attempts.filter((a) => a.outcome === 'REPLAYED' && a.idempotency_key === key);
    expect(replays.length).toBe(2);
  });

  it('replaying the same key with a different payload is strictly rejected with 422 Unprocessable Entity', async () => {
    const key = `conflict-key-${Date.now()}`;

    // First request with amount 5000
    const res1 = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send({ amount: 5000, description: 'First amount' });

    expect(res1.status).toBe(201);

    // Second request with SAME key but DIFFERENT payload (amount 6000)
    const res2 = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', key)
      .send({ amount: 6000, description: 'Tampered amount' });

    expect(res2.status).toBe(422);
    expect(res2.body.success).toBe(false);
    expect(res2.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('scopes idempotency keys per actor: different actors using the same key string do not collide', async () => {
    const sharedKeyString = `shared-key-string-${Date.now()}`;

    // Alice uses key
    const resAlice = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .set('Idempotency-Key', sharedKeyString)
      .send({ amount: 1000 });

    expect(resAlice.status).toBe(201);

    // Bob uses the EXACT SAME key string on his own account
    const resBob = await request(app)
      .post(`/api/v1/accounts/${ctx.bobAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.bobToken}`)
      .set('Idempotency-Key', sharedKeyString)
      .send({ amount: 2000 });

    expect(resBob.status).toBe(201);
    expect(resBob.body.data.transaction.amount.toString()).toBe('2000');
    expect(resBob.header['idempotent-replay']).toBeUndefined();
  });

  it('rejects money-movement requests lacking the Idempotency-Key header', async () => {
    const res = await request(app)
      .post(`/api/v1/accounts/${ctx.aliceAccountId}/deposit`)
      .set('Authorization', `Bearer ${ctx.aliceToken}`)
      .send({ amount: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
