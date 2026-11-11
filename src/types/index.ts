export type UserRole = 'ADMIN' | 'ACCOUNT_HOLDER' | 'AUDITOR';

export type AccountType = 'CUSTOMER' | 'SYSTEM';
export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type PermissionType = 'VIEW' | 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER_OUT';

export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER';
export type TransactionStatus = 'POSTED';
export type EntryDirection = 'DEBIT' | 'CREDIT';

export type AttemptOutcome = 'SUCCESS' | 'REFUSED' | 'FAILED' | 'REPLAYED';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  created_at: Date;
}

export interface Account {
  id: string;
  account_number: string;
  name: string;
  type: AccountType;
  status: AccountStatus;
  currency: string;
  balance: string; // BIGINT serialized as string from pg
  allow_overdraft: boolean;
  overdraft_limit: string;
  created_at: Date;
}

export interface AccountPermission {
  id: string;
  account_id: string;
  user_id: string;
  permission: PermissionType;
  granted_by: string | null;
  created_at: Date;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: string;
  currency: string;
  initiated_by: string;
  idempotency_key: string | null;
  description: string | null;
  created_at: Date;
}

export interface LedgerEntry {
  id: string | number;
  transaction_id: string;
  account_id: string;
  direction: EntryDirection;
  amount: string;
  balance_after: string;
  created_at: Date;
  prev_hash: string;
  entry_hash: string;
}

export interface TransactionAttempt {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  source_account_id: string | null;
  destination_account_id: string | null;
  amount: string | null;
  idempotency_key: string | null;
  outcome: AttemptOutcome;
  reason_code: string | null;
  transaction_id: string | null;
  ip: string | null;
  created_at: Date;
}

export interface IdempotencyRecord {
  actor_id: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: Record<string, any>;
  transaction_id: string | null;
  created_at: Date;
}

export interface AuthActor {
  id: string;
  email: string;
  role: UserRole;
}
