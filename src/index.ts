import { app } from './app.js';
import { config } from './config/index.js';
import { getDbPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
  try {
    logger.info('Starting LedgerLine server initialization...');

    // 1. Initialize database pool
    const pool = await getDbPool();

    // 2. Automatically execute pending migrations
    logger.info('Checking and running database migrations...');
    await runMigrations(pool);

    // 3. Auto-seed if database is empty
    const usersCountRes = await pool.query<{ count: string | number }>(
      'SELECT COUNT(*) AS count FROM users'
    );
    const usersCount = Number(usersCountRes.rows[0]?.count ?? 0);
    if (usersCount === 0) {
      logger.info('No users detected. Automatically seeding initial demo data...');
      await seed(pool);
      logger.info('Initial demo data seeded successfully.');
    }

    // 4. Start Express server
    const server = app.listen(config.port, () => {
      logger.info(
        { port: config.port, env: config.nodeEnv },
        `🚀 LedgerLine API service running on http://localhost:${config.port}`
      );
      logger.info(`📖 API Documentation available at http://localhost:${config.port}/docs`);
    });

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received termination signal, shutting down gracefully...');
      server.close(async () => {
        logger.info('HTTP server closed');
        await pool.end();
        logger.info('Database pool drained');
        process.exit(0);
      });

      // Force shutdown after 10s timeout
      setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ error: err }, 'Fatal error during server bootstrap');
    process.exit(1);
  }
}

bootstrap();
