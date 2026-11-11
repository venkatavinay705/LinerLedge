# LedgerLine 5-Minute Demonstration Walkthrough Script

This script provides a step-by-step walkthrough for demonstrating LedgerLine's core financial capabilities, concurrency protection, idempotency replay, multi-tiered RBAC, and tamper-evident audit features.

---

## Prerequisites & Setup

1. Start the server:
   ```bash
   npm run dev
   # or with docker: docker-compose up
   ```
2. In a second terminal, ensure initial demo data is seeded:
   ```bash
   npm run seed
   ```
3. Open your browser to the web interface:
   ```
   http://localhost:3000/
   ```
   *(Or access Swagger UI at `http://localhost:3000/docs`)*

---

## 1. Minute 1: Authentication & Role-Based Access Control (RBAC)

1. **Sign in as Alice (`ACCOUNT_HOLDER`)**:
   - Click the **Alice Demo** quick-login button (`alice@ledgerline.test` / `AlicePassword123!`) and click **Sign In**.
   - Notice that Alice can only see her own account (`ACC-ALICE-001`) with her funded balance (\$5,000.00).
   - Alice does **not** see Bob's account or system accounts.
   - The Auditor & Admin control panel is hidden.
2. **Sign in as Bob (`ACCOUNT_HOLDER`)**:
   - Click **Logout**, then click **Bob Demo** (`bob@ledgerline.test` / `BobPassword123!`).
   - Notice Bob sees his business account (`ACC-BOB-001`) with \$2,500.00 balance and \$1,000.00 overdraft limit.
3. **Sign in as Auditor (`AUDITOR`)**:
   - Click **Logout**, then click **Auditor Demo** (`auditor@ledgerline.test` / `AuditorPassword123!`).
   - Notice Auditor can view **all accounts** across the bank (Alice, Bob, and Cash Vault).
   - Auditor panel is visible with **Verify Hash Chain** and **Reconcile Balances**.

---

## 2. Minute 2: Verified Money Movement (Deposit & Transfer)

1. Log back in as **Alice**.
2. **Deposit Funds**:
   - In the **Deposit Funds** card, enter Amount: `250.00` and Description: `Client consulting fee`.
   - Click **Post Deposit**.
   - Notice Alice's balance instantly increases by \$250.00 to \$5,250.00.
3. **Peer-to-Peer Transfer to Bob**:
   - In the **Transfer Funds** card:
     - Source Account: Alice's Checking
     - Destination Account ID: Open a new tab or copy Bob's Account UUID from `ACC-BOB-001`
     - Amount: `150.00`
     - Description: `Reimbursement for software licenses`
   - Click **Execute Transfer**.
   - Notice Alice's balance updates to \$5,100.00.
4. **Inspect Statement**:
   - In the **Account Statement** card, select Alice's account and click **Fetch Statement**.
   - View the posted double-entry records with timestamps, transaction directions (`DEBIT`/`CREDIT`), and running balances.

---

## 3. Minute 3: Concurrency Race Condition Demonstration

Showcase how LedgerLine's pessimistic row-level locking handles high-contention withdrawal races:
1. In your terminal, run the dedicated concurrency demo script:
   ```bash
   npm run demo:concurrency
   ```
2. **What the script demonstrates**:
   - Automatically provisions a test account funded with exactly **\$300.00**.
   - Fires **30 simultaneous concurrent withdrawal requests of \$100.00 each** in parallel (`Promise.all`).
   - Total withdrawal attempted: \$3,000.00.
   - **Result in terminal output**:
     - Exactly **3 withdrawals succeed** (\$100.00 each, deducting \$300.00).
     - Exactly **27 withdrawals are safely refused** with `INSUFFICIENT_FUNDS`.
     - Final balance is verified as **\$0.00** (never negative).
     - Cryptographic hash chain is verified as **100% VALID**.
     - Global conservation is verified as **CONSERVED (\$0.00)**.

---

## 4. Minute 4: Idempotency Replay & Adversarial Denial

1. **Idempotency Replay Demo**:
   - Open your terminal and send a deposit curl command with an explicit `Idempotency-Key`:
     ```bash
     curl -i -X POST http://localhost:3000/api/v1/accounts/<ALICE_ACCOUNT_ID>/deposit \
       -H "Authorization: Bearer <ALICE_TOKEN>" \
       -H "Idempotency-Key: demo-key-999" \
       -H "Content-Type: application/json" \
       -d '{"amount": 5000, "description": "Idempotent payment"}'
     ```
   - Notice HTTP status `201 Created` with transaction ID.
   - **Immediately repeat the exact same command**:
     ```bash
     curl -i -X POST http://localhost:3000/api/v1/accounts/<ALICE_ACCOUNT_ID>/deposit \
       -H "Authorization: Bearer <ALICE_TOKEN>" \
       -H "Idempotency-Key: demo-key-999" \
       -H "Content-Type: application/json" \
       -d '{"amount": 5000, "description": "Idempotent payment"}'
     ```
   - Notice HTTP header **`Idempotent-Replay: true`** returned!
   - The exact original transaction response is returned, and zero duplicate ledger entries were created.
2. **Payload Mismatch Rejection**:
   - Send the same `Idempotency-Key` with a modified amount (`6000`):
     ```bash
     curl -i -X POST http://localhost:3000/api/v1/accounts/<ALICE_ACCOUNT_ID>/deposit \
       -H "Authorization: Bearer <ALICE_TOKEN>" \
       -H "Idempotency-Key: demo-key-999" \
       -H "Content-Type: application/json" \
       -d '{"amount": 6000}'
     ```
   - Notice HTTP **`422 Unprocessable Entity`** with error code `IDEMPOTENCY_CONFLICT`.
3. **Auditor Write Prohibition**:
   - In web UI or terminal, sign in as Auditor and attempt to deposit or withdraw.
   - Notice HTTP **`403 Forbidden`**: "Auditor role is strictly read-only; mutation operations are prohibited".

---

## 5. Minute 5: Audit Verification & Tamper Detection

1. Log into web UI as **Auditor** or **Admin**.
2. **Verify Cryptographic Hash Chain**:
   - Click the **Verify Hash Chain** button.
   - Notice the green alert:
     `Hash Chain Verified Valid! Total entries audited: 48. Latest hash: 7d4a9...`
3. **Reconcile System Balances**:
   - Click the **Reconcile Balances** button.
   - Notice the green alert:
     `Reconciliation Success! All account balances equal sum of ledger entries. Global system sum: $0.00 (Strictly Conserved).`
4. **Audit Attempts Log**:
   - In terminal, query refused attempts:
     ```bash
     curl -X GET "http://localhost:3000/api/v1/audit/attempts?outcome=REFUSED" \
       -H "Authorization: Bearer <AUDITOR_TOKEN>"
     ```
   - View the recorded audit logs showing actor ID, timestamp, IP, and reason codes (`INSUFFICIENT_FUNDS`, `FORBIDDEN`).
