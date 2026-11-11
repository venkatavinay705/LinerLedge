# LedgerLine Production Deployment Guide

This guide details step-by-step instructions for deploying LedgerLine to production platforms (such as Render, Railway, or Fly.io) backed by managed PostgreSQL 15+.

---

## 1. Prerequisites

- A cloud platform account (e.g. [Render](https://render.com), [Railway](https://railway.app), or [Fly.io](https://fly.io))
- A managed PostgreSQL instance (version 15 or higher)
- A secure 32+ character string for `JWT_SECRET`

---

## 2. Environment Variables

Configure the following environment variables in your deployment dashboard:

| Variable | Required | Description | Example |
|---|---|---|---|
| `NODE_ENV` | Yes | Application environment | `production` |
| `PORT` | Yes | HTTP listening port (assigned by host) | `3000` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/ledgerline` |
| `JWT_SECRET` | Yes | Cryptographic secret for signing tokens | `min-32-char-random-secret-key-prod` |
| `JWT_EXPIRES_IN` | No | JWT lifespan | `1h` |
| `LOG_LEVEL` | No | Structured log level (`info`, `warn`, `error`) | `info` |
| `RATE_LIMIT_LOGIN_MAX` | No | Maximum login attempts per window | `5` |
| `RATE_LIMIT_API_MAX` | No | Maximum API requests per minute | `100` |
| `CORS_ORIGIN` | No | Permitted CORS origins | `*` or `https://your-frontend.com` |

---

## 3. Deploying to Render (Recommended)

### Step 1: Provision Managed PostgreSQL
1. Log in to the [Render Dashboard](https://dashboard.render.com).
2. Click **New +** $\rightarrow$ **PostgreSQL**.
3. Set Database Name to `ledgerline-db` and select **PostgreSQL 16**.
4. Once provisioned, copy the **Internal Database URL** (or External URL if deploying across providers).

### Step 2: Deploy Web Service via Docker
1. In Render Dashboard, click **New +** $\rightarrow$ **Web Service**.
2. Connect your LedgerLine GitHub repository.
3. Select **Docker** as the Environment runtime.
4. Set Instance Type (e.g. Free or Starter).
5. Add the Environment Variables:
   - `DATABASE_URL`: *<Paste Internal DB URL>*
   - `JWT_SECRET`: *<Generate 64-char random string>*
   - `NODE_ENV`: `production`
6. Set the Health Check Path to `/health`.
7. Click **Create Web Service**.

### Step 3: Running Migrations and Initial Seed
Render executes the Docker container's entrypoint, which automatically runs pending migrations during bootstrap. Alternatively, to manually migrate and seed from the Render Shell:
```bash
# In the Render Web Shell console:
npm run migrate
npm run seed
```

---

## 4. Deploying to Railway

1. Install Railway CLI or use [Railway Dashboard](https://railway.app).
2. Create a new project and add a **PostgreSQL** database service.
3. Add a service from your GitHub repository. Railway automatically detects `Dockerfile`.
4. Under Variables for the app service, reference the database:
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET`: `${{secret}}`
   - `NODE_ENV`: `production`
5. Railway boots the container and connects to PostgreSQL.

---

## 5. Health Check & Verification

Once deployed, verify the system health check endpoint:
```bash
curl -X GET https://<your-app-domain>/health
```

Expected HTTP `200 OK` response:
```json
{
  "status": "healthy",
  "timestamp": "2026-11-11T14:30:00.000Z",
  "uptimeSeconds": 45,
  "database": "connected",
  "engine": "postgresql-remote"
}
```

Verify interactive API documentation:
```
https://<your-app-domain>/docs
```

Verify web dashboard interface:
```
https://<your-app-domain>/
```
