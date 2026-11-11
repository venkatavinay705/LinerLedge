-- LedgerLine Migration 001: Initial Schema
-- Enforces double-entry financial ledger invariants, constraints, and audit logs


-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Accounts Table
-- Money is strictly BIGINT cents (integer minor units). Never floats.
CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number VARCHAR(64) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('CUSTOMER', 'SYSTEM')),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    balance BIGINT NOT NULL DEFAULT 0,
    allow_overdraft BOOLEAN NOT NULL DEFAULT false,
    overdraft_limit BIGINT NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_account_balance_overdraft CHECK (balance >= -overdraft_limit),
    CONSTRAINT chk_account_balance_positive CHECK (allow_overdraft OR balance >= 0)
);

-- Account Permissions Table
-- Maps users to accounts with granular permissions (VIEW, DEPOSIT, WITHDRAW, TRANSFER_OUT)
CREATE TABLE IF NOT EXISTS account_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(32) NOT NULL CHECK (permission IN ('VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT')),
    granted_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_account_user_permission UNIQUE (account_id, user_id, permission)
);

-- Transactions Table
-- Represents business events (DEPOSIT, WITHDRAWAL, TRANSFER)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(32) NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER')),
    status VARCHAR(32) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    initiated_by UUID NOT NULL REFERENCES users(id),
    idempotency_key VARCHAR(255),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ledger Entries Table
-- Strictly append-only, cryptographic hash chained double-entry records
CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    transaction_id UUID NOT NULL REFERENCES transactions(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prev_hash VARCHAR(64) NOT NULL,
    entry_hash VARCHAR(64) NOT NULL
);

-- Indexes for fast ledger lookups and statement generation
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id_created_at ON ledger_entries(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_initiated_by ON transactions(initiated_by);

-- Transaction Attempts Audit Log
-- Logs every attempt (SUCCESS, REFUSED, FAILED, REPLAYED)
-- Must persist even if the main transaction rolls back
CREATE TABLE IF NOT EXISTS transaction_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES users(id),
    actor_role VARCHAR(50),
    action VARCHAR(50) NOT NULL,
    source_account_id UUID REFERENCES accounts(id),
    destination_account_id UUID REFERENCES accounts(id),
    amount BIGINT,
    idempotency_key VARCHAR(255),
    outcome VARCHAR(32) NOT NULL CHECK (outcome IN ('SUCCESS', 'REFUSED', 'FAILED', 'REPLAYED')),
    reason_code VARCHAR(64),
    transaction_id UUID REFERENCES transactions(id),
    ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attempts_source_account ON transaction_attempts(source_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_actor_id ON transaction_attempts(actor_id, created_at);

-- Idempotency Keys Table
-- Resolves races between concurrent duplicates and returns cached responses
CREATE TABLE IF NOT EXISTS idempotency_keys (
    actor_id UUID NOT NULL REFERENCES users(id),
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL,
    transaction_id UUID REFERENCES transactions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, key)
);
