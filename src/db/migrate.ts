import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDbPool, IDatabasePool } from './pool.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(dbPool?: IDatabasePool): Promise<void> {
  const pool = dbPool || (await getDbPool());
  const client = await pool.connect();

  try {
    // 1. Ensure migrations tracking table exists
    await client.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Read executed migrations
    const executedRes = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY id ASC'
    );
    const executed = new Set(executedRes.rows.map((r) => r.name));

    // 3. Find migration files
    let migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      const srcMigrationsDir = path.resolve(__dirname, '../../src/db/migrations');
      if (fs.existsSync(srcMigrationsDir)) {
        migrationsDir = srcMigrationsDir;
      }
    }
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (executed.has(file)) {
        continue;
      }

      logger.info({ migration: file }, 'Executing database migration');
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      // Execute migration inside a transaction
      await client.query('BEGIN');
      try {
        await client.exec(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'Migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ migration: file, error: err }, 'Migration failed and was rolled back');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// Support running directly via `tsx src/db/migrate.ts`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      await runMigrations();
      logger.info('All migrations completed successfully');
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, 'Migration process exited with error');
      process.exit(1);
    }
  })();
}
