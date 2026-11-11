# LedgerLine Architecture & Technical Design Writeup

LedgerLine is a secure, concurrency-safe, tamper-evident double-entry financial ledger engineered for mission-critical money movement. This document details the architectural decisions, concurrency mechanics, accounting invariants, trade-offs, and future improvements.

---

## 1. Core Architectural & Design Decisions

### 1.1 Money Representation: Integer Minor Units (`BIGINT` Cents)
- **The Problem with Floating-Point**: IEEE 754 floating-point numbers (`FLOAT`, `DOUBLE`, JavaScript `Number`) cannot represent fractional base-10 decimals precisely due to binary mantissa representation (e.g., `0.1 + 0.2 = 0.30000000000000004`). In financial systems, fractional rounding drift accumulates over millions of operations, introducing systemic balance discrepancies and breaking double-entry conservation laws.
- **The LedgerLine Decision**: All currency values are strictly stored as **integer minor units** (`BIGINT` cents). For example, \$100.00 is represented as `10000n`. In JavaScript/TypeScript, amounts are parsed directly into native `bigint` primitives using Zod validation. In PostgreSQL, amounts are stored as `BIGINT`, supported by `CHECK (amount > 0)`. Fractions of a cent cannot exist within the domain model.

---

### 1.2 Concurrency Control: Pessimistic Row Locking vs. Serializable Isolation
When processing high-volume financial transactions (e.g., flash sales, payroll runs, or high-contention withdrawal races), multiple concurrent transactions contend for the same account row.

| Dimension | `SERIALIZABLE` Isolation | `READ COMMITTED` with `SELECT ... FOR UPDATE` (LedgerLine) |
|---|---|---|
| **Mechanism** | Optimistic concurrency control detecting read/write dependencies at commit time. | Pessimistic row-level locking queuing concurrent transactions directly at the database lock manager. |
| **High Contention Behavior** | Commits abort with PostgreSQL error `40001 serialization_failure`. Requires complex client-side exponential backoff retry loops. Under 50 concurrent requests on one account, up to 90% of requests abort repeatedly, thrashing CPU and database IO. | Contending transactions wait cleanly in the PostgreSQL lock queue. As each transaction completes and commits in milliseconds, the next transaction immediately acquires the row lock without any retry storms. |
| **Deadlock Avoidance** | Cannot prevent deadlocks deterministically; detects deadlocks post-facto and aborts one transaction. | Completely eliminates deadlocks during multi-account transfers by acquiring locks in strictly ascending lexicographical order (`ORDER BY id ASC FOR UPDATE`). |
| **Final Recommendation** | Excellent for low-contention analytical workloads. | **Optimal for high-throughput, high-contention financial ledgers.** |

LedgerLine chooses `READ COMMITTED` paired with explicit `SELECT ... FOR UPDATE`:
1. **Deterministic Lock Ordering**: When transferring between Account $A$ and Account $B$, the system sorts their UUIDs and acquires locks in ascending order. Because all concurrent processes acquire locks in the exact same global order, circular wait graphs are mathematically impossible.
2. **Post-Lock State Re-evaluation**: Once the row lock is held, the transaction re-evaluates the account status (`status === 'ACTIVE'`) and verifies that `balance - amount >= (allow_overdraft ? -overdraft_limit : 0)`. The check-then-act pattern is completely safe because no other session can modify the row while the lock is held.

---

### 1.3 System Accounts & Double-Entry Accounting Invariants
Double-entry bookkeeping mandates that money is never created or destroyed out of thin air; every financial event represents a transfer between two accounts where:
$$\sum \text{Debits} == \sum \text{Credits}$$

1. **The Counterparty Problem**: When a customer deposits or withdraws cash, there must be a valid counterparty account to balance the customer's ledger entry.
2. **System Account Model (`CASH_VAULT`)**:
   - LedgerLine introduces system accounts representing internal bank assets/reserves.
   - For deposits, physical cash enters the bank: `CASH_VAULT` is debited (-amount), and the customer deposit liability is credited (+amount).
   - For withdrawals, cash leaves the vault: customer account is debited (-amount), and `CASH_VAULT` is credited (+amount).
3. **Global System Conservation**:
   Because every transaction produces equal debit and credit legs, the global sum of all balances across all accounts in the entire system is strictly conserved:
   $$\sum_{a \in \text{All Accounts}} \text{balance}(a) = 0$$
   This invariant is verified by the `/api/v1/audit/reconcile` endpoint.

---

### 1.4 Tamper-Evident SHA-256 Hash Chaining
While PostgreSQL access controls and append-only triggers protect ledger entries from normal application-layer modification, cryptographic hash chaining provides **independent mathematical proof of ledger integrity**:
$$\text{entry\_hash} = \text{SHA256}(\text{prev\_hash} \parallel \text{id} \parallel \text{transaction\_id} \parallel \text{account\_id} \parallel \text{direction} \parallel \text{amount} \parallel \text{balance\_after} \parallel \text{created\_at})$$

- **Append-Only Trigger Compatibility**: Because PostgreSQL triggers reject any `UPDATE` on `ledger_entries`, `entry_hash` cannot be calculated after insert. LedgerLine pre-fetches the next primary key sequence value (`SELECT nextval('ledger_entries_id_seq')`), computes the SHA-256 hash in memory, and writes the complete immutable entry in a single atomic `INSERT`.
- **Tamper Detection**: If a malicious database administrator or attacker alters a balance or deletes a row, the recomputed SHA-256 hash of that row and all subsequent rows will not match `prev_hash`. The `/api/v1/audit/verify-chain` endpoint traverses the chain and immediately identifies the exact tampered entry.

---

### 1.5 Idempotency Architecture
Network failures, client retries, and mobile timeouts frequently cause identical payment requests to be delivered multiple times.
1. **Header Requirement**: Clients provide a unique `Idempotency-Key` header with every mutating financial request.
2. **Fingerprint Verification**: The system computes a canonical SHA-256 hash of `method:path:body`.
3. **Atomic Execution**: Inside the database transaction, `idempotency_keys` is queried for `(actor_id, key)`.
   - If the key exists with an identical hash: the transaction returns the original cached response with HTTP header `Idempotent-Replay: true`. An audit attempt is recorded with outcome `REPLAYED`.
   - If the key exists with a different hash: the request is rejected with `422 Unprocessable Entity` (`IDEMPOTENCY_CONFLICT`), preventing parameter mutation attacks.
   - If the key is new: the transaction executes and records the response status and body in `idempotency_keys` before committing.

---

## 2. Trade-Offs & Limitations

1. **Single-Currency Engine**:
   - *Current Implementation*: Accounts operate in integer minor units of USD.
   - *Trade-off*: Multi-currency transfers between USD, EUR, and GBP are rejected at the service level (`CURRENCY_MISMATCH`) to avoid introducing foreign exchange (FX) slippage, rounding errors, and currency conversion rate volatility into the core ledger.
2. **Single Primary Database Bottleneck**:
   - *Current Implementation*: ACID transactions and row locks require a single write-primary PostgreSQL instance.
   - *Trade-off*: Maximum write throughput on a single hot account is bounded by database disk I/O and lock acquisition time (~5,000–10,000 TPS on modern NVMe hardware). Sharding accounts or partitioning ledgers across regions would require distributed consensus (e.g. 2PC / CockroachDB), sacrificing local transactional simplicity.
3. **Linear Hash Chain Serialization**:
   - *Current Implementation*: Ledger entries link in a single global linear hash chain.
   - *Trade-off*: Fetching the latest entry's hash requires reading the most recent global entry. In extreme multi-tenant scale, per-account or per-tenant hash trees (Merkle Trees) could be used to parallelize hashing.

---

## 3. Future Work

1. **Merkle Tree Proofs & External Anchoring**:
   - Aggregate hourly or daily ledger entry hashes into a Merkle Tree root.
   - Anchor the Merkle root to a public blockchain or immutable object storage (AWS S3 Object Lock with legal hold) for non-repudiation against internal database superusers.
2. **Automated End-of-Day Settlement Engine**:
   - Scheduled cron jobs generating balance snapshots and rolling trial balance sheets.
   - Automated archival of historical statements into compressed partitioned tables.
3. **Multi-Currency FX Gateway**:
   - Multi-leg currency transfers utilizing an intermediate system FX clearing account (e.g. Source Account $\rightarrow$ FX Clearing Account $\rightarrow$ Destination Account) with fixed quote locks.
