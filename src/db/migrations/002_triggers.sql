-- LedgerLine Migration 002: Triggers & Integrity Constraints

-- 1. Append-Only Enforcers for ledger_entries
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is strictly append-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_modification();

DROP TRIGGER IF EXISTS trg_ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_no_truncate
BEFORE TRUNCATE ON ledger_entries
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_ledger_modification();

-- 2. Append-Only Enforcers for transactions
CREATE OR REPLACE FUNCTION prevent_transaction_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'transactions is strictly append-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transactions_immutable ON transactions;
CREATE TRIGGER trg_transactions_immutable
BEFORE UPDATE OR DELETE ON transactions
FOR EACH ROW
EXECUTE FUNCTION prevent_transaction_modification();

DROP TRIGGER IF EXISTS trg_transactions_no_truncate ON transactions;
CREATE TRIGGER trg_transactions_no_truncate
BEFORE TRUNCATE ON transactions
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_transaction_modification();

-- 3. Append-Only Enforcers for transaction_attempts
CREATE OR REPLACE FUNCTION prevent_attempt_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'transaction_attempts is strictly append-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attempts_immutable ON transaction_attempts;
CREATE TRIGGER trg_attempts_immutable
BEFORE UPDATE OR DELETE ON transaction_attempts
FOR EACH ROW
EXECUTE FUNCTION prevent_attempt_modification();

DROP TRIGGER IF EXISTS trg_attempts_no_truncate ON transaction_attempts;
CREATE TRIGGER trg_attempts_no_truncate
BEFORE TRUNCATE ON transaction_attempts
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_attempt_modification();

-- 4. DB-Level Deferred Constraint Trigger for Double-Entry Balancing
-- Verifies that at transaction commit, sum(debits) == sum(credits) for every transaction
CREATE OR REPLACE FUNCTION verify_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE
    v_imbalance BIGINT;
    v_debit_sum BIGINT;
    v_credit_sum BIGINT;
BEGIN
    SELECT 
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)
    INTO v_debit_sum, v_credit_sum
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id;

    v_imbalance := v_debit_sum - v_credit_sum;

    IF v_imbalance <> 0 THEN
        RAISE EXCEPTION 'Double-entry balance mismatch for transaction %: debits (%) != credits (%) [difference %]',
            NEW.transaction_id, v_debit_sum, v_credit_sum, v_imbalance;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_entries_balanced
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION verify_transaction_balanced();
