import { getDbPool, IDatabasePool } from './pool.js';
import { runMigrations } from './migrate.js';
import { authService } from '../services/auth.service.js';
import { accountService } from '../services/account.service.js';
import { ledgerService } from '../services/ledger.service.js';
import { logger } from '../utils/logger.js';
import { AuthActor } from '../types/index.js';

export async function seed(dbPool?: IDatabasePool): Promise<void> {
  const pool = dbPool || (await getDbPool());
  logger.info('Starting LedgerLine database seeding...');

  // 1. Ensure migrations are up to date
  await runMigrations(pool);

  // 2. Create Seed Users
  const usersToSeed = [
    { email: 'admin@ledgerline.test', password: 'AdminPassword123!', role: 'ADMIN' as const },
    { email: 'alice@ledgerline.test', password: 'AlicePassword123!', role: 'ACCOUNT_HOLDER' as const },
    { email: 'bob@ledgerline.test', password: 'BobPassword123!', role: 'ACCOUNT_HOLDER' as const },
    { email: 'auditor@ledgerline.test', password: 'AuditorPassword123!', role: 'AUDITOR' as const },
  ];

  const seededUsers = new Map<string, any>();

  for (const u of usersToSeed) {
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [u.email]);
    if (existing.rows[0]) {
      seededUsers.set(u.email, existing.rows[0]);
      logger.info({ email: u.email }, 'User already exists');
    } else {
      const created = await authService.createUser(u);
      seededUsers.set(u.email, created);
      logger.info({ email: u.email, role: u.role }, 'Created seed user');
    }
  }

  const admin = seededUsers.get('admin@ledgerline.test');
  const alice = seededUsers.get('alice@ledgerline.test');
  const bob = seededUsers.get('bob@ledgerline.test');

  const adminActor: AuthActor = {
    id: admin.id,
    email: admin.email,
    role: admin.role,
  };

  // 3. Create CASH_VAULT system account if not already created
  const vaultCheck = await pool.query('SELECT * FROM accounts WHERE account_number = $1', ['CASH_VAULT']);
  if (!vaultCheck.rows[0]) {
    await pool.query(
      `INSERT INTO accounts (account_number, name, type, status, currency, balance, allow_overdraft, overdraft_limit)
       VALUES ('CASH_VAULT', 'System Cash Reserve Vault', 'SYSTEM', 'ACTIVE', 'USD', 0, true, 9223372036854775807);`
    );
    logger.info('Created CASH_VAULT system account');
  }

  // 4. Create Alice Customer Account
  let aliceAcc = (
    await pool.query('SELECT * FROM accounts WHERE account_number = $1', ['ACC-ALICE-001'])
  ).rows[0];

  if (!aliceAcc) {
    aliceAcc = await accountService.createAccount({
      account_number: 'ACC-ALICE-001',
      name: "Alice's Primary Checking",
      type: 'CUSTOMER',
      currency: 'USD',
      allow_overdraft: false,
      overdraft_limit: 0n,
    });
    logger.info({ accountNumber: aliceAcc.account_number }, 'Created Alice customer account');

    // Assign permissions to Alice
    await accountService.setPermissions(
      aliceAcc.id,
      alice.id,
      ['VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT'],
      admin.id
    );
    logger.info('Assigned full permissions to Alice on ACC-ALICE-001');

    // Create starting balance via REAL DEPOSIT transaction (not direct balance insert!)
    await ledgerService.deposit({
      accountId: aliceAcc.id,
      amount: 500000n, // $5,000.00
      actor: adminActor,
      idempotencyKey: 'seed-alice-initial-deposit-5000',
      description: 'Initial seed deposit for Alice checking',
    });
    logger.info('Funded Alice account with $5,000.00 via verified double-entry deposit');
  }

  // 5. Create Bob Customer Account (with $1,000.00 overdraft limit)
  let bobAcc = (
    await pool.query('SELECT * FROM accounts WHERE account_number = $1', ['ACC-BOB-001'])
  ).rows[0];

  if (!bobAcc) {
    bobAcc = await accountService.createAccount({
      account_number: 'ACC-BOB-001',
      name: "Bob's Business Account",
      type: 'CUSTOMER',
      currency: 'USD',
      allow_overdraft: true,
      overdraft_limit: 100000n, // $1,000.00 overdraft protection
    });
    logger.info({ accountNumber: bobAcc.account_number }, 'Created Bob customer account');

    // Assign permissions to Bob
    await accountService.setPermissions(
      bobAcc.id,
      bob.id,
      ['VIEW', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT'],
      admin.id
    );
    logger.info('Assigned full permissions to Bob on ACC-BOB-001');

    // Notice: Alice is intentionally NOT granted permission on Bob's account for authorization testing!

    // Create starting balance via REAL DEPOSIT transaction
    await ledgerService.deposit({
      accountId: bobAcc.id,
      amount: 250000n, // $2,500.00
      actor: adminActor,
      idempotencyKey: 'seed-bob-initial-deposit-2500',
      description: 'Initial seed deposit for Bob business account',
    });
    logger.info('Funded Bob account with $2,500.00 via verified double-entry deposit');
  }

  logger.info('Database seeding completed successfully!');
}

// Support running directly via `tsx src/db/seed.ts`
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  (async () => {
    try {
      await seed();
      process.exit(0);
    } catch (err) {
      logger.error({ error: err }, 'Seeding failed');
      process.exit(1);
    }
  })();
}
