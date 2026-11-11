import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import { config } from './config/index.js';
import { apiLimiter } from './middlewares/rate-limit.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { authRouter } from './routes/auth.routes.js';
import { userRouter } from './routes/user.routes.js';
import { accountRouter } from './routes/account.routes.js';
import { transferRouter } from './routes/transfer.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { healthRouter } from './routes/health.routes.js';
import { NotFoundError } from './utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

// Security Headers & CORS
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    exposedHeaders: ['Idempotent-Replay'],
  })
);

// Body Parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// General Rate Limiting
app.use('/api', apiLimiter);

// Health Check
app.use('/', healthRouter);

// Static Web Frontend
const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));
app.get('/app', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// Versioned API Routes (/api/v1)
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/accounts', accountRouter);
app.use('/api/v1/transfers', transferRouter);
app.use('/api/v1/audit', auditRouter);

// Swagger / OpenAPI documentation served at /docs
try {
  const openApiPath = path.resolve(__dirname, '../openapi.yaml');
  if (fs.existsSync(openApiPath)) {
    const openApiYaml = fs.readFileSync(openApiPath, 'utf-8');
    const swaggerDoc = yaml.parse(openApiYaml);
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));
  }
} catch (e) {
  // Documentation optional in development if yaml not yet rendered
}

// Fallback 404 Handler
app.use((req, _res, next) => {
  next(new NotFoundError(`Endpoint not found: ${req.method} ${req.originalUrl}`));
});

// Centralized Error Handling Middleware
app.use(errorHandler);
