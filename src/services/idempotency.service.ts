import { getDbPool, IDatabasePool, IDatabaseClient } from '../db/pool.js';
import { IdempotencyRecord, AuthActor } from '../types/index.js';
import { IdempotencyConflictError } from '../utils/errors.js';
import { computeRequestHash } from '../utils/crypto.js';
import { auditService } from './audit.service.js';
import { logger } from '../utils/logger.js';

export interface IdempotencyCheckResult {
  isReplay: boolean;
  statusCode: number;
  body: any;
  transactionId?: string | null;
}

export class IdempotencyService {
  constructor(private pool?: IDatabasePool) {}

  private async getPool(): Promise<IDatabasePool> {
    if (!this.pool) {
      this.pool = await getDbPool();
    }
    return this.pool;
  }

  /**
   * Checks if an idempotency key exists for an actor.
   * If existing with same hash, returns cached response.
   * If existing with different hash, throws IdempotencyConflictError.
   * If not existing, returns null.
   */
  async checkKey(
    actorId: string,
    key: string,
    requestHash: string,
    client?: IDatabaseClient
  ): Promise<IdempotencyCheckResult | null> {
    const db = client || (await this.getPool());

    const res = await db.query<IdempotencyRecord>(
      `SELECT * FROM idempotency_keys WHERE actor_id = $1 AND key = $2`,
      [actorId, key]
    );

    const existing = res.rows[0];
    if (!existing) {
      return null;
    }

    // Verify hash match
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyConflictError(
        'Idempotency key was previously used with a different request payload'
      );
    }

    return {
      isReplay: true,
      statusCode: existing.response_status,
      body: existing.response_body,
      transactionId: existing.transaction_id,
    };
  }

  /**
   * Saves the response for an idempotency key.
   */
  async recordKey(
    actorId: string,
    key: string,
    requestHash: string,
    statusCode: number,
    responseBody: any,
    transactionId: string | null = null,
    client?: IDatabaseClient
  ): Promise<void> {
    const db = client || (await this.getPool());

    try {
      await db.query(
        `INSERT INTO idempotency_keys (
          actor_id, key, request_hash, response_status, response_body, transaction_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (actor_id, key) DO UPDATE 
        SET response_status = EXCLUDED.response_status,
            response_body = EXCLUDED.response_body,
            transaction_id = EXCLUDED.transaction_id;`,
        [actorId, key, requestHash, statusCode, JSON.stringify(responseBody), transactionId]
      );
    } catch (err) {
      logger.error({ error: err, actorId, key }, 'Failed to record idempotency key');
      throw err;
    }
  }

  /**
   * Executes an action with idempotency protection.
   * If replay, logs REPLAYED audit attempt and returns cached response.
   */
  async executeIdempotent<T>(params: {
    actor: AuthActor;
    key: string;
    method: string;
    path: string;
    body: any;
    ip?: string;
    actionName: string;
    sourceAccountId?: string;
    destinationAccountId?: string;
    amount?: bigint;
    execute: () => Promise<{ statusCode: number; body: T; transactionId?: string | null }>;
  }): Promise<{ isReplay: boolean; statusCode: number; body: T; transactionId?: string | null }> {
    const requestHash = computeRequestHash(params.method, params.path, params.body);

    // 1. Check existing record
    const cached = await this.checkKey(params.actor.id, params.key, requestHash);
    if (cached) {
      // Record REPLAYED attempt in audit log
      await auditService
        .logAttempt({
          actorId: params.actor.id,
          actorRole: params.actor.role,
          action: params.actionName,
          sourceAccountId: params.sourceAccountId,
          destinationAccountId: params.destinationAccountId,
          amount: params.amount,
          idempotencyKey: params.key,
          outcome: 'REPLAYED',
          transactionId: cached.transactionId,
          ip: params.ip,
        })
        .catch((e) => logger.warn({ error: e }, 'Failed to log replay attempt'));

      return cached;
    }

    // 2. Execute business logic
    const result = await params.execute();

    // 3. Record in idempotency_keys
    await this.recordKey(
      params.actor.id,
      params.key,
      requestHash,
      result.statusCode,
      result.body,
      result.transactionId || null
    );

    return {
      isReplay: false,
      statusCode: result.statusCode,
      body: result.body,
      transactionId: result.transactionId,
    };
  }
}

export const idempotencyService = new IdempotencyService();
