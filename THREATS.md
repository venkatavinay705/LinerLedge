# LedgerLine Threat Model & Security Analysis (STRIDE)

This document provides a comprehensive security review of LedgerLine using the **STRIDE** methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege), mapping each threat to its architectural mitigation, code implementation, and automated test coverage.

---

## 1. Threat Mitigation Matrix

| Threat Category (STRIDE) | Threat Description | Architectural Mitigation | Where Implemented | Automated Test Coverage |
|---|---|---|---|---|
| **Tampering / Repudiation** | **Double Spend / Balance Manipulation**: Concurrent requests exploit race conditions to spend the same balance twice. | Pessimistic row-level locking (`SELECT ... FOR UPDATE`) with re-check of funds after acquiring locks. DB check constraints (`chk_account_balance_positive`). | `src/services/ledger.service.ts` & `src/db/migrations/001_initial_schema.sql` | `tests/concurrency.test.ts` (50 concurrent withdrawals race) & `tests/integrity.test.ts` |
| **Repudiation / Spoofing** | **Request Replay Attacks**: Network hiccups or malicious actors replaying a payment request to repeat a charge. | Mandatory `Idempotency-Key` header. Payloads are SHA-256 hashed and cached inside the DB transaction. Cached original responses returned on replay. Mismatched payload returns 422. | `src/services/idempotency.service.ts` & `src/routes/account.routes.ts` | `tests/idempotency.test.ts` (sequential and parallel replays, conflict check) |
| **Information Disclosure** | **Insecure Direct Object Reference (IDOR)**: An account holder accesses another user's balance or statement by guessing the account UUID. | Server-side permission check against `account_permissions`. Consistently returns `404 Not Found` for unauthorized accounts to prevent enumeration. | `src/services/account.service.ts` (`getAccountById`) | `tests/security.test.ts` (`prevents IDOR: account holder cannot read someone else account`) |
| **Elevation of Privilege** | **Role Forgery / Privilege Escalation**: Client sends forged `role: 'ADMIN'` or `X-User-Role` headers in body/headers. | Actor identity and role are strictly derived from the cryptographically verified JWT signature (`authService.verifyToken`). Client-sent role parameters are discarded. | `src/middlewares/auth.middleware.ts` (`authenticate`) | `tests/security.test.ts` (`role forgery attempts via body or headers have zero effect`) |
| **Elevation of Privilege** | **Auditor Write Tampering**: An auditor account attempts to mutate account balances, create users, or execute money movements. | Global middleware `blockAuditorWrites` intercepts all mutating HTTP verbs (`POST`, `PUT`, `PATCH`, `DELETE`) for the `AUDITOR` role and returns `403 Forbidden`. | `src/middlewares/auth.middleware.ts` (`blockAuditorWrites`) | `tests/security.test.ts` (`enforces that AUDITOR role is strictly read-only: any write endpoint returns 403`) |
| **Tampering** | **Ledger Manipulation / Row Deletion**: Rogue insider or compromised SQL connection updates or deletes ledger entries or transactions. | PostgreSQL database triggers execute `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` on `ledger_entries`, `transactions`, and `transaction_attempts`, raising exceptions. | `src/db/migrations/002_triggers.sql` | `tests/security.test.ts` (`database triggers strictly forbid UPDATE and DELETE on ledger_entries`) |
| **Tampering** | **Silent Database Tampering**: Direct database storage modification bypassing triggers or hardware-level row corruption. | Cryptographic SHA-256 hash chaining where each entry hashes the previous entry's hash. Automated endpoint `/api/v1/audit/verify-chain` recomputes the chain. | `src/services/audit.service.ts` (`verifyHashChain`) | `tests/security.test.ts` (`hash chain verification detects a deliberately tampered ledger row`) |
| **Tampering** | **SQL Injection (SQLi)**: Attacker injects arbitrary SQL syntax via input fields to exfiltrate or alter records. | Exclusive use of parameterized queries (`$1, $2, ...`) via `node-postgres`. Complete ban on string concatenation for SQL query construction. Input validation via Zod. | All queries in `src/services/*.ts` and `src/db/*.ts` | Covered across all integration and unit test suites |
| **Denial of Service** | **Deadlock on Concurrent Transfers**: Simultaneous opposite transfers ($A \rightarrow B$ and $B \rightarrow A$) cause circular lock waits in PostgreSQL. | Deterministic lexicographical lock ordering: account IDs are sorted ascending before acquiring row locks (`ORDER BY id ASC FOR UPDATE`). Circular wait condition is impossible. | `src/services/ledger.service.ts` (`transfer`) | `tests/concurrency.test.ts` (`concurrent opposite-direction transfers without deadlocks`) |
| **Denial of Service / Brute Force** | **Credential Stuffing / Password Brute Force**: Attacker automates repeated login attempts against user accounts. | Stricter IP and email rate limiting (`express-rate-limit`) on `/auth/login`. In-memory account lockout tracker after 5 consecutive failed login attempts. | `src/middlewares/rate-limit.middleware.ts` & `src/services/auth.service.ts` | `tests/security.test.ts` & rate limiting middlewares |
| **Information Disclosure / Tampering** | **Token Theft / Forgery**: Man-in-the-middle or expired tokens used to access API. | Short-lived JWT access tokens (`1h`), HMAC SHA-256 signature verification against high-entropy secret, Helmet security headers, CORS origin allow-listing. | `src/services/auth.service.ts` & `src/app.ts` | `tests/security.test.ts` (`rejects unauthenticated and tampered/expired tokens`) |
| **Repudiation** | **Unrecorded Failed/Refused Transaction Attempts**: System fails silently without audit trace when unauthorized or fraudulent actions occur. | Append-only `transaction_attempts` audit table. Refusals and failures are recorded in an isolated database transaction, ensuring they persist even if the main transaction aborts. | `src/services/audit.service.ts` (`logAttempt`) | `tests/security.test.ts` (`persists refused attempts in transaction_attempts with actor ID, reason code, and IP`) |

---

## 2. Residual Risks & Security Architecture Recommendations

While LedgerLine implements defense-in-depth across the application and database tiers, the following residual risks should be addressed in production deployments:

1. **Database Superuser Trigger Bypass**:
   - *Risk*: A PostgreSQL superuser (`postgres`) has administrative privileges to execute `ALTER TABLE ... DISABLE TRIGGER ALL`.
   - *Mitigation*: Run the web application using a restricted database user role (e.g. `ledger_app`) that has `REVOKE UPDATE, DELETE ON ledger_entries, transactions FROM ledger_app;` and lacks `SUPERUSER` or `REPLICATION` attributes.

2. **In-Memory Lockout in Clustered Environments**:
   - *Risk*: The account lockout tracker currently maintains failed attempt counts in process memory. If scaled horizontally across multiple instances behind a load balancer, lockout counts are partitioned across nodes.
   - *Mitigation*: In multi-node production clusters, back the rate limiter and lockout tracker with Redis (`ioredis` + `rate-limit-redis`).

3. **External Genesis Hash Anchor**:
   - *Risk*: If an attacker gains full control of the database and rewrites the entire table from genesis with a new valid chain, internal chain verification alone cannot distinguish the fork.
   - *Mitigation*: Periodically anchor the latest `entry_hash` to a secondary external ledger, immutable blob storage (AWS S3 Object Lock), or external timestamp authority (e.g., RFC 3161).
