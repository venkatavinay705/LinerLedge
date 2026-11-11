# LedgerLine

> **A secure, concurrency-safe, tamper-evident double-entry financial ledger system.**  
> Built with Node.js 20, TypeScript (strict mode), Express, and PostgreSQL 15+.

---

## 1. Overview

LedgerLine is an enterprise-grade financial ledger engineered for mission-critical money movement. It prioritizes the **mathematical correctness of money handling** above all else:

- **Strict Double-Entry Bookkeeping**: Every transaction creates balanced credit and debit legs; global money is strictly conserved ($\sum \text{Balances} = 0$).
- **Integer Minor Units**: Money is exclusively handled as integer cents (`BIGINT`). Floating-point arithmetic is completely prohibited.
- **Pessimistic Concurrency Safety**: Row-level locking (`SELECT ... FOR UPDATE`) with deterministic lexicographical ordering guarantees zero deadlocks and prevents negative balance races under high contention.
- **Append-Only Immutability**: Enforced via PostgreSQL kernel triggers that raise exceptions on any `UPDATE`, `DELETE`, or `TRUNCATE` operations on financial tables.
- **Cryptographic Hash Chaining**: Every ledger entry contains a SHA-256 hash linking to the previous entry, providing end-to-end tamper evidence.
- **Actor-Scoped Idempotency**: Built-in request payload hashing ensures safe network retries and prevents double charges.
- **Multi-Tiered RBAC & IDOR Defense**: Strict server-side role enforcement (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`) with an isolated refusal audit log.

---

## 2. System Architecture

```mermaid
flowchart TD
    Client["Client / Web UI / API Consumer"] -->|HTTPS + JWT + Idempotency-Key| App["Express API Service (Node.js 20 TS)"]

    subgraph Security_Middleware ["Middleware & Defense"]
        Helmet["Helmet Security Headers"]
        RateLimit["Rate Limiter (Brute Force / DDoS)"]
        AuthMid["JWT Auth & Server-Side RBAC"]
        ValMid["Zod Input Validation (Integer Cents)"]
        IdempMid["Idempotency Engine (SHA-256 Fingerprinting)"]
    end

    App --> Helmet --> RateLimit --> AuthMid --> ValMid --> IdempMid

    subgraph Core_Services ["Domain Services"]
        LedgerSvc["Ledger Service (Pessimistic Locking & Balances)"]
        AuditSvc["Audit Service (Hash Chain & Reconciliation)"]
        AccountSvc["Account Service (Permissions & Statements)"]
        AuthSvc["Auth Service (Bcrypt & JWT)"]
    end

    IdempMid --> LedgerSvc
    IdempMid --> AuditSvc
    IdempMid --> AccountSvc
    IdempMid --> AuthSvc

    subgraph Database_Tier ["PostgreSQL 15+ Database Engine"]
        RowLock["Row Locks (SELECT ... FOR UPDATE ORDER BY id ASC)"]
        TrgImmutable["Append-Only Triggers (Reject UPDATE/DELETE)"]
        TrgBalanced["Deferred Balancing Constraint Trigger (Commit Check)"]
        CheckConstraints["CHECK (balance >= -overdraft_limit)"]
        HashChain["Cryptographic SHA-256 Hash Chained Ledger"]
        AuditAttempts["Isolated Transaction Attempts Audit Log"]
    end

    LedgerSvc --> RowLock
    RowLock --> CheckConstraints
    CheckConstraints --> TrgImmutable
    TrgImmutable --> TrgBalanced
    TrgBalanced --> HashChain
    AuditSvc --> HashChain
    LedgerSvc --> AuditAttempts
```

---

## 3. Seeded Demo Credentials

Run `npm run seed` to provision these demonstration accounts:

| Email | Password | Role | Description |
|---|---|---|---|
| `admin@ledgerline.test` | `AdminPassword123!` | `ADMIN` | Universal management, account creation, overdraft configuration. |
| `alice@ledgerline.test` | `AlicePassword123!` | `ACCOUNT_HOLDER` | Holds checking account `ACC-ALICE-001` (Funded with \$5,000.00). |
| `bob@ledgerline.test` | `BobPassword123!` | `ACCOUNT_HOLDER` | Holds business account `ACC-BOB-001` (Funded with \$2,500.00, \$1,000.00 overdraft). |
| `auditor@ledgerline.test` | `AuditorPassword123!` | `AUDITOR` | Strictly read-only access to all accounts, ledger entries, and audit logs. |

*Note: Alice has no permissions on Bob's account to demonstrate IDOR denial (returns 404/403).*

---

## 4. Quick Start & Setup

### 4.1 Local Development (with Docker Compose)
```bash
# 1. Clone repository and install dependencies
npm install

# 2. Boot PostgreSQL 16 container
docker-compose up -d postgres

# 3. Run database migrations
npm run migrate

# 4. Seed demo users and accounts with verified starting deposits
npm run seed

# 5. Start development server
npm run dev
```

### 4.2 Local Development (Embedded PostgreSQL WASM - Zero External DB Required)
If you do not have Docker or local PostgreSQL running, LedgerLine automatically boots an embedded PostgreSQL 18 WASM engine (`@electric-sql/pglite`):
```bash
npm install
npm run migrate
npm run seed
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) for the UI or [http://localhost:3000/docs](http://localhost:3000/docs) for Swagger docs.

---

## 5. Command Reference

| Command | Description |
|---|---|
| `npm run dev` | Start development server with live reload (`tsx watch`) |
| `npm run build` | Compile TypeScript into production JavaScript (`dist/`) |
| `npm start` | Run compiled production server |
| `npm run migrate` | Execute pending raw SQL migrations in `src/db/migrations/` |
| `npm run seed` | Seed demo users, accounts, and initial deposits |
| `npm run demo:concurrency` | **Interactive CLI Demo**: 30 simultaneous withdrawals against limited balance |
| `npm test` | Run complete automated test suite (27 tests across 5 suites) |
| `npm run lint` | Run TypeScript strict type-checker (`tsc --noEmit`) |

---

## 6. Environment Variables

Create a `.env` file based on `.env.example`:

```ini
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Database connection URL (PostgreSQL 15+)
DATABASE_URL=postgresql://ledger:ledgerpass@localhost:5432/ledgerline

# JWT Authentication
JWT_SECRET=super-secret-jwt-key-min-32-chars-long-ledgerline
JWT_EXPIRES_IN=1h

# Rate Limiting
RATE_LIMIT_LOGIN_WINDOW_MS=60000
RATE_LIMIT_LOGIN_MAX=5
RATE_LIMIT_API_WINDOW_MS=60000
RATE_LIMIT_API_MAX=100

# CORS
CORS_ORIGIN=*
```

---

## 7. Automated Test Suite Highlights

The test suite runs 27 automated tests against real PostgreSQL:
1. **Integrity (`tests/integrity.test.ts`)**: Debits == Credits, global conservation ($= 0$) after 50 randomized operations, overdraft enforcement, and mid-transfer failure atomicity.
2. **Concurrency (`tests/concurrency.test.ts`)**: 50 simultaneous withdrawals from one account where only affordable succeed; concurrent opposite-direction transfers ($A \rightarrow B$ and $B \rightarrow A$) with zero deadlocks.
3. **Idempotency (`tests/idempotency.test.ts`)**: Sequential and parallel replay of identical keys returning stored response with `Idempotent-Replay: true`; payload modification rejection with 422.
4. **Security (`tests/security.test.ts`)**: IDOR 404 prevention, Auditor 403 write rejection, token expiry/tampering, database triggers preventing UPDATE/DELETE on ledger entries, and deliberate hash chain tamper detection.

---

## 8. Documentation Index

- [Database Architecture & Triggers](docs/DATABASE.md)
- [API Reference & Curl Examples](docs/API.md)
- [Deployment Guide (Render / Railway / Fly.io)](docs/DEPLOYMENT.md)
- [Threat Model (STRIDE)](THREATS.md)
- [Architecture Design Writeup](docs/WRITEUP.md)
- [5-Minute Demonstration Script](docs/DEMO_SCRIPT.md)
- [Prompt Engineering Development Log](PROMPTS.md)
