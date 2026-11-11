import { getDbPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { authService } from '../src/services/auth.service.js';
import { accountService } from '../src/services/account.service.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { AuthActor } from '../src/types/index.js';

export interface TestContext {
  adminActor: AuthActor;
  adminToken: string;
  aliceActor: AuthActor;
  aliceToken: string;
  bobActor: AuthActor;
  bobToken: string;
  auditorActor: AuthActor;
  auditorToken: string;
  malloryActor: AuthActor; // Untrusted user with no account permissions
  malloryToken: string;
  aliceAccountId: string;
  bobAccountId: string;
}

export async function initTestContext(): Promise<TestContext> {
  process.env.USE_PGLITE = 'true';
  const pool = await getDbPool();
  await runMigrations(pool);

  // Clear data for fresh test run
  await pool.exec(`
    TRUNCATE users, accounts, account_permissions, transactions, ledger_entries, transaction_attempts, idempotency_keys CASCADE;
  `).catch(async () => {
    // If truncate trigger blocks TRUNCATE, delete via disabled trigger or clean delete
    await pool.exec(`
      ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_immutable;
      ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_no_truncate;
      ALTER TABLE transactions DISABLE TRIGGER trg_transactions_immutable;
      ALTER TABLE transactions DISABLE TRIGGER trg_transactions_no_truncate;
      ALTER TABLE transaction_attempts DISABLE TRIGGER trg_attempts_immutable;
      ALTER TABLE transaction_attempts DISABLE TRIGGER trg_attempts_no_truncate;

      DELETE FROM ledger_entries;
      DELETE FROM transactions;
      DELETE FROM transaction_attempts;
      DELETE FROM idempotency_keys;
      DELETE FROM account_permissions;
      DELETE FROM accounts;
      DELETE FROM users;

      ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_immutable;
      ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_no_truncate;
      ALTER TABLE transactions ENABLE TRIGGER trg_transactions_immutable;
      ALTER TABLE transactions ENABLE TRIGGER trg_transactions_no_truncate;
      ALTER TABLE transaction_attempts ENABLE TRIGGER trg_attempts_immutable;
      ALTER TABLE transaction_attempts ENABLE TRIGGER trg_attempts_no_truncate;
    `).catch(() => {});
  });

  // 1. Create Test Users
  const adminUser = await authService.createUser({
    email: 'admin.test@ledgerline.test',
    password: 'AdminPassword123!',
    role: 'ADMIN',
  });
  const adminActor: AuthActor = { id: adminUser.id, email: adminUser.email, role: 'ADMIN' };
  const adminToken = authService.generateToken(adminActor);

  const aliceUser = await authService.createUser({
    email: 'alice.test@ledgerline.test',
    password: 'AlicePassword123!',
    role: 'ACCOUNT_HOLDER',
  });
  const aliceActor: AuthActor = { id: aliceUser.id, email: aliceUser.email, role: 'ACCOUNT_HOLDER' };
  const aliceToken = authService.generateToken(aliceActor);

  const bobUser = await authService.createUser({
    email: 'bob.test@ledgerline.test',
    password: 'BobPassword123!',
    role: 'ACCOUNT_HOLDER',
  });
  const bobActor: AuthActor = { id: bobUser.id, email: bobUser.email, role: 'ACCOUNT_HOLDER' };
  const bobToken = authService.generateToken(bobActor);

  const auditorUser = await authService.createUser({
    email: 'auditor.test@ledgerline.test',
    password: 'AuditorPassword123!',
    role: 'AUDITOR',
  });
  const auditorActor: AuthActor = { id: auditorUser.id, email: auditorUser.email, role: 'AUDITOR' };
  const auditorToken = authService.generateToken(auditorActor);

  const malloryUser = await authService.createUser({
    email: 'mallory.test@ledgerline.test',
    password: 'MalloryPassword123!',
    role: 'ACCOUNT_HOLDER',
  });
  const malloryActor: AuthActor = { id: malloryUser.id, email: malloryUser.email, role: 'ACCOUNT_HOLDER' };
  const malloryToken = authService.generateToken(malloryActor);

  // 2. Ensure CASH_VAULT exists
  await pool.query(
    `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
     VALUES ('CASH_VAULT', 'System Cash Vault', 'SYSTEM', 'ACTIVE', 'USD', 0, true, 9223372036854775807)
     ON CONFLICT (account_number) DO NOTHING;`
  );

  // 3. Create Alice's Account
  const aliceAcc = await accountService.createAccount({
    account_number: `ACC-ALICE-${Date.now()}`,
    name: "Alice Test Checking",
    type: 'CUSTOMER',
    currency: 'USD',
    allow_overdraft: false,
    overdraft_limit: 0n,
  });
  await accountService.setPermissions(aliceAcc.id, aliceUser.id, ['VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT'], adminUser.id);

  // 4. Create Bob's Account (with 10,000 cents overdraft limit)
  const bobAcc = await accountService.createAccount({
    account_number: `ACC-BOB-${Date.now()}`,
    name: "Bob Test Account",
    type: 'CUSTOMER',
    currency: 'USD',
    allow_overdraft: true,
    overdraft_limit: 10000n, // $100 overdraft
  });
  await accountService.setPermissions(bobAcc.id, bobUser.id, ['VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT'], adminUser.id);

  return {
    adminActor,
    adminToken,
    aliceActor,
    aliceToken,
    bobActor,
    bobToken,
    auditorActor,
    auditorToken,
    malloryActor,
    malloryToken,
    aliceAccountId: aliceAcc.id,
    bobAccountId: bobAcc.id,
  };
}
