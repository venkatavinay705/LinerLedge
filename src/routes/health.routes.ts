import { Router } from 'express';
import { getDbPool } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    const pool = await getDbPool();
    const dbRes = await pool.query('SELECT 1 AS alive');
    const dbHealthy = dbRes.rows[0]?.alive === 1;

    res.json({
      status: dbHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbHealthy ? 'connected' : 'disconnected',
      engine: pool.isEmbedded() ? 'pglite-embedded-wasm' : 'postgresql-remote',
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message,
    });
  }
});
