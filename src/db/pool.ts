import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseClient {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  release(): void;
}

export interface IDatabasePool {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  connect(): Promise<IDatabaseClient>;
  end(): Promise<void>;
  isEmbedded(): boolean;
}

class PgClientWrapper implements IDatabaseClient {
  constructor(private client: pg.PoolClient) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const res = await this.client.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  release(): void {
    this.client.release();
  }
}

class PgPoolWrapper implements IDatabasePool {
  constructor(private pool: pg.Pool) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async connect(): Promise<IDatabaseClient> {
    const client = await this.pool.connect();
    return new PgClientWrapper(client);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  isEmbedded(): boolean {
    return false;
  }
}

class PGliteClientWrapper implements IDatabaseClient {
  constructor(private pglite: PGlite, private releaseCallback?: () => void) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const res = await this.pglite.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pglite.exec(sql);
  }

  release(): void {
    if (this.releaseCallback) {
      this.releaseCallback();
    }
  }
}

class PGlitePoolWrapper implements IDatabasePool {
  private pglite: PGlite;
  private queue: Promise<void> = Promise.resolve();

  constructor(pglite?: PGlite) {
    this.pglite = pglite || new PGlite();
  }

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const res = await this.pglite.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pglite.exec(sql);
  }

  async connect(): Promise<IDatabaseClient> {
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousQueue = this.queue;
    this.queue = this.queue.then(() => lockAcquired);

    await previousQueue;

    let released = false;
    return new PGliteClientWrapper(this.pglite, () => {
      if (!released) {
        released = true;
        releaseLock();
      }
    });
  }

  async end(): Promise<void> {
    await this.pglite.close();
  }

  isEmbedded(): boolean {
    return true;
  }
}

let activePool: IDatabasePool | null = null;

export async function getDbPool(): Promise<IDatabasePool> {
  if (activePool) {
    return activePool;
  }

  if (process.env.USE_PGLITE === 'true') {
    logger.info('Initializing embedded PGlite database (PostgreSQL 18 WASM)');
    activePool = new PGlitePoolWrapper();
    return activePool;
  }

  try {
    const testPool = new pg.Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 1500,
      idleTimeoutMillis: 10000,
    });
    const client = await testPool.connect();
    client.release();
    logger.info({ url: config.databaseUrl }, 'Connected to external PostgreSQL server');
    activePool = new PgPoolWrapper(testPool);
    return activePool;
  } catch (err: any) {
    logger.warn(
      { error: err.message },
      'External PostgreSQL not reachable; falling back to embedded PGlite (PostgreSQL WASM)'
    );
    activePool = new PGlitePoolWrapper();
    return activePool;
  }
}

export function setDbPool(pool: IDatabasePool): void {
  activePool = pool;
}

export async function resetDbPool(): Promise<void> {
  if (activePool) {
    await activePool.end();
    activePool = null;
  }
}
