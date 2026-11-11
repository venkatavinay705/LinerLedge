import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://ledger:ledgerpass@localhost:5432/ledgerline',
  jwtSecret: process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-long-ledgerline',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  rateLimit: {
    loginWindowMs: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS || '60000', 10),
    loginMax: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '5', 10),
    apiWindowMs: parseInt(process.env.RATE_LIMIT_API_WINDOW_MS || '60000', 10),
    apiMax: parseInt(process.env.RATE_LIMIT_API_MAX || '100', 10),
  },
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
