# LedgerLine Prompt Engineering & Architecture Development Log

This document records the prompt iterations, engineering goals, model outputs, and verification steps taken during the design, development, and testing of the LedgerLine system.

---

### Entry 1
- **Date**: 2026-11-11
- **Goal**: Design double-entry PostgreSQL schema with kernel-level append-only immutability and commit-time double-entry balancing triggers.
- **Prompt**:
  > "Design an explicit SQL migration for a double-entry ledger in PostgreSQL 15+. Include tables for users, accounts, account_permissions, transactions, ledger_entries, transaction_attempts, and idempotency_keys. Add triggers that strictly raise exceptions on UPDATE, DELETE, or TRUNCATE for ledger_entries and transactions. Add a deferred constraint trigger that enforces sum(debits) == sum(credits) at transaction commit."
- **Result**:
  Produced `001_initial_schema.sql` and `002_triggers.sql`. Defined `CHECK (balance >= -overdraft_limit)` and `CHECK (allow_overdraft OR balance >= 0)` on accounts. Implemented `prevent_ledger_modification()` trigger function and `trg_ledger_entries_balanced` deferred constraint trigger.
- **What I Changed / Verified**:
  - Removed redundant `CREATE EXTENSION "pgcrypto"` since `gen_random_uuid()` is native to PostgreSQL 13+.
  - Verified with `npx tsx src/db/migrate.ts` that both migrations execute cleanly inside transactional blocks.
  - Verified that attempts to mutate `ledger_entries` throw `append-only: UPDATE and DELETE are prohibited`.

---

### Entry 2 (Integrity / Concurrency)
- **Date**: 2026-11-11
- **Goal**: Implement deadlock-free atomic money transfers and prevent race conditions / negative balances under high concurrent contention.
- **Prompt**:
  > "Implement the transfer, deposit, and withdraw methods in LedgerService. How do we guarantee that opposite-direction transfers between Alice and Bob never deadlock, and that 50 simultaneous withdrawals against limited balance never overdraw the account? Detail the row locking and balance re-check logic."
- **Result**:
  Engineered `LedgerService` with `READ COMMITTED` isolation and explicit pessimistic row locks:
  1. Transfer accounts are locked in strictly ascending lexicographical order (`[firstId, secondId].sort()`) using `SELECT * FROM accounts WHERE id IN ($1, $2) ORDER BY id ASC FOR UPDATE`.
  2. Balances and `ACTIVE` statuses are re-evaluated strictly **after** holding the lock.
  3. Pre-computed sequence IDs via `nextval('ledger_entries_id_seq')` allow entries to be inserted with their cryptographic hashes in a single append-only INSERT.
- **What I Changed / Verified**:
  - Implemented `tests/concurrency.test.ts` launching 50 concurrent withdrawals against an account holding \$500.00. Verified that exactly 5 succeed and 45 fail with `INSUFFICIENT_FUNDS`, leaving a final balance of exactly \$0.00.
  - Simulated 20 simultaneous opposite-direction transfers ($A \rightarrow B$ and $B \rightarrow A$) and verified zero deadlocks occurred.

---

### Entry 3 (Idempotency)
- **Date**: 2026-11-11
- **Goal**: Build an actor-scoped idempotency service with SHA-256 payload fingerprinting and replay caching.
- **Prompt**:
  > "Design the idempotency protocol for LedgerLine. How do we ensure that replaying the same key returns the exact original response without creating duplicate ledger entries, while catching key reuse with modified payloads? How are keys scoped?"
- **Result**:
  Implemented `IdempotencyService` and `computeRequestHash`:
  1. Requests compute `SHA256(method + ":" + path + ":" + canonicalJson(body))`.
  2. Look up `(actor_id, key)`: if identical hash exists, returns cached HTTP status and body with header `Idempotent-Replay: true`. If hash differs, throws `422 Unprocessable Entity` (`IDEMPOTENCY_CONFLICT`).
  3. Business execution stores results in `idempotency_keys` with unique `(actor_id, key)` constraint.
- **What I Changed / Verified**:
  - Enhanced JSON serialization in `computeRequestHash` and `recordKey` with custom replacer to prevent BigInt serialization exceptions (`TypeError: Do not know how to serialize a BigInt`).
  - Authored `tests/idempotency.test.ts` verifying sequential replays return `Idempotent-Replay: true` without increasing ledger entries count, and payload mutations receive 422.

---

### Entry 4 (Cryptographic Auditability)
- **Date**: 2026-11-11
- **Goal**: Implement cryptographic SHA-256 hash chaining on all ledger entries and build an endpoint to detect arbitrary row tampering.
- **Prompt**:
  > "How can we structure a tamper-evident cryptographic hash chain across ledger entries in PostgreSQL? What fields must be included in the entry_hash, and how do we verify the chain end to end?"
- **Result**:
  Formulated `computeEntryHash`:
  $$\text{entry\_hash} = \text{SHA256}(\text{prev\_hash} \parallel \text{id} \parallel \text{transaction\_id} \parallel \text{account\_id} \parallel \text{direction} \parallel \text{amount} \parallel \text{balance\_after} \parallel \text{created\_at\_iso})$$
  Built `AuditService.verifyHashChain()` which traverses entries ordered by ID, verifies each link, and flags any broken pointers or re-hash mismatches.
- **What I Changed / Verified**:
  - In `tests/security.test.ts`, temporarily disabled the immutable trigger to maliciously mutate an entry's amount from 10000 to 999999999.
  - Invoked `verifyHashChain()` and verified that it correctly reported `valid: false`, specified the exact broken row ID, and diagnosed `Tampered entry: hash recalculation mismatch`.

---

### Entry 5 (Security & RBAC)
- **Date**: 2026-11-11
- **Goal**: Implement server-side RBAC, prevent IDOR, enforce read-only Auditor constraints, and persist transaction refusal records even when financial transactions abort.
- **Prompt**:
  > "Define the RBAC architecture for ADMIN, ACCOUNT_HOLDER, and AUDITOR. How do we ensure that an auditor can never write, account holders can never touch unpermitted accounts (IDOR prevention), and that refused transactions persist even when the database transaction rolls back?"
- **Result**:
  1. Developed `auth.middleware.ts` with `blockAuditorWrites` (rejects `POST`, `PUT`, `PATCH`, `DELETE` for Auditor with 403) and `requireAccountPermission`.
  2. Isolated Audit Persistence: In `LedgerService`, when an operation fails or rolls back, `auditService.logAttempt` is executed in a dedicated, separate connection/transaction after rollback, guaranteeing refusal logs are never lost.
  3. IDOR Prevention: In `AccountService.getAccountById`, unauthorized account requests return `404 Not Found` rather than 403 to prevent enumeration.
- **What I Changed / Verified**:
  - Tested Auditor attempts to deposit, withdraw, transfer, and create users; verified all return `403 Forbidden`.
  - Tested unauthorized access attempts by an untrusted user; verified `404 Not Found`.
  - Verified that refused transactions appear in `transaction_attempts` and on the account statement.
