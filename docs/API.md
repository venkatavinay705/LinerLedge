# LedgerLine API Reference & Integration Guide

The LedgerLine API is a versioned REST service under `/api/v1` implementing strict authentication, role-based authorization, request idempotency, and double-entry transaction processing.

Interactive OpenAPI documentation is available via Swagger UI at `/docs`.

---

## 1. Authentication & Security Headers

All protected endpoints require a valid JWT Bearer token:
```http
Authorization: Bearer <access_token>
```

### Idempotency-Key Header
All POST money-movement endpoints (`/accounts/:id/deposit`, `/accounts/:id/withdraw`, `/transfers`) **strictly require** the `Idempotency-Key` header:
```http
Idempotency-Key: <unique_client_generated_key>
```
- Keys are scoped per authenticated user (`actor_id`).
- When an identical key is sent with the identical payload, the original response is replayed with HTTP header:
  `Idempotent-Replay: true`
- If an identical key is reused with a different request payload, the API rejects the request with HTTP `422 Unprocessable Entity` (`IDEMPOTENCY_CONFLICT`).

---

## 2. API Endpoints

### 2.1 Health Check
#### `GET /health`
Returns system status, database engine, and uptime.
```bash
curl -X GET http://localhost:3000/health
```

### 2.2 Authentication
#### `POST /api/v1/auth/login`
Authenticates user credentials and returns a short-lived access token.
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@ledgerline.test",
    "password": "AlicePassword123!"
  }'
```

#### `GET /api/v1/auth/me`
Retrieves actor profile and assigned role.
```bash
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

---

### 2.3 Accounts Management

#### `GET /api/v1/accounts`
Retrieves permitted accounts for the authenticated actor. (Admins and Auditors view all accounts; Account Holders view accounts where granted `VIEW`).
```bash
curl -X GET http://localhost:3000/api/v1/accounts \
  -H "Authorization: Bearer <TOKEN>"
```

#### `POST /api/v1/accounts` (ADMIN only)
Creates a new customer or system account.
```bash
curl -X POST http://localhost:3000/api/v1/accounts \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "account_number": "ACC-CUSTOM-001",
    "name": "Corporate Operating Fund",
    "type": "CUSTOMER",
    "currency": "USD",
    "allow_overdraft": true,
    "overdraft_limit": 500000
  }'
```

#### `PATCH /api/v1/accounts/:id/status` (ADMIN only)
Updates account status (`ACTIVE`, `FROZEN`, or `CLOSED`).
```bash
curl -X PATCH http://localhost:3000/api/v1/accounts/<ACCOUNT_ID>/status \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status": "FROZEN"}'
```

#### `PUT /api/v1/accounts/:id/permissions` (ADMIN only)
Grants granular permissions to a user (`VIEW`, `DEPOSIT`, `WITHDRAW`, `TRANSFER_OUT`).
```bash
curl -X PUT http://localhost:3000/api/v1/accounts/<ACCOUNT_ID>/permissions \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<USER_ID>",
    "permissions": ["VIEW", "DEPOSIT", "TRANSFER_OUT"]
  }'
```

#### `GET /api/v1/accounts/:id/statement`
Fetches detailed ledger statement including posted entries and refused/failed attempts.
```bash
curl -X GET "http://localhost:3000/api/v1/accounts/<ACCOUNT_ID>/statement?page=1&limit=25" \
  -H "Authorization: Bearer <TOKEN>"
```

---

### 2.4 Money Movement Operations

#### `POST /api/v1/accounts/:id/deposit`
Executes verified deposit. Counterparty: debit `CASH_VAULT`, credit customer account.
```bash
curl -X POST http://localhost:3000/api/v1/accounts/<ACCOUNT_ID>/deposit \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: deposit-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 10000,
    "description": "Salary check deposit"
  }'
```

#### `POST /api/v1/accounts/:id/withdraw`
Executes verified withdrawal. Counterparty: debit customer account, credit `CASH_VAULT`.
```bash
curl -X POST http://localhost:3000/api/v1/accounts/<ACCOUNT_ID>/withdraw \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: withdraw-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 2500,
    "description": "ATM cash withdrawal"
  }'
```

#### `POST /api/v1/transfers`
Executes atomic peer-to-peer transfer between two accounts with deterministic row locking.
```bash
curl -X POST http://localhost:3000/api/v1/transfers \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: transfer-key-001" \
  -H "Content-Type: application/json" \
  -d '{
    "source_account_id": "<SOURCE_ACCOUNT_UUID>",
    "destination_account_id": "<DESTINATION_ACCOUNT_UUID>",
    "amount": 5000,
    "description": "Invoice payment"
  }'
```

---

### 2.5 Audit & Verification Endpoints (ADMIN & AUDITOR only)

#### `GET /api/v1/audit/attempts`
Queries transaction attempt audit log (successful, refused, and replayed events).
```bash
curl -X GET "http://localhost:3000/api/v1/audit/attempts?outcome=REFUSED" \
  -H "Authorization: Bearer <AUDITOR_TOKEN>"
```

#### `GET /api/v1/audit/ledger`
Queries raw append-only ledger entries.
```bash
curl -X GET "http://localhost:3000/api/v1/audit/ledger?page=1&limit=50" \
  -H "Authorization: Bearer <AUDITOR_TOKEN>"
```

#### `GET /api/v1/audit/verify-chain`
Re-hashes the entire cryptographic SHA-256 chain and checks for breaks or row tampering.
```bash
curl -X GET http://localhost:3000/api/v1/audit/verify-chain \
  -H "Authorization: Bearer <AUDITOR_TOKEN>"
```
**Sample Response:**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "totalEntries": 42,
    "brokenAtId": null,
    "lastHash": "a958e0a1b6cb46f7c191a82bc..."
  }
}
```

#### `GET /api/v1/audit/reconcile`
Verifies that all account balances match the sum of ledger entries and that global system sum equals 0.
```bash
curl -X GET http://localhost:3000/api/v1/audit/reconcile \
  -H "Authorization: Bearer <AUDITOR_TOKEN>"
```
**Sample Response:**
```json
{
  "success": true,
  "data": {
    "reconciled": true,
    "accountsChecked": 5,
    "globalSum": "0",
    "discrepancies": []
  }
}
```

---

## 3. Standard Error Formats

All error responses return consistent JSON structures:
```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient funds in source account. Required: 10000, Available: 4000",
    "details": null
  }
}
```

| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Request body or query parameters failed Zod schema validation |
| `400` | `INSUFFICIENT_FUNDS` | Balance would drop below zero or permitted overdraft limit |
| `400` | `ACCOUNT_FROZEN` | Account status is FROZEN; transactions are blocked |
| `400` | `ACCOUNT_CLOSED` | Account status is CLOSED; transactions are prohibited |
| `400` | `SELF_TRANSFER_PROHIBITED` | Source and destination account IDs are identical |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | Missing required `Idempotency-Key` header |
| `401` | `UNAUTHORIZED` | Invalid credentials, missing token, or expired token |
| `403` | `FORBIDDEN` | Role lacks authorization or Auditor attempted write |
| `404` | `NOT_FOUND` | Account not found or unauthorized (IDOR prevention) |
| `409` | `DUPLICATE_RESOURCE` | Unique constraint violation (e.g. email or account number) |
| `422` | `IDEMPOTENCY_CONFLICT` | Idempotency key reused with different payload |
| `429` | `ACCOUNT_LOCKED` | Account locked due to repeated failed login attempts |
| `429` | `RATE_LIMIT_EXCEEDED` | Request rate limit exceeded |
