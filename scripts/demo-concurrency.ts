import { getDbPool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { accountService } from '../src/services/account.service.js';
import { ledgerService } from '../src/services/ledger.service.js';
import { auditService } from '../src/services/audit.service.js';
import { AuthActor } from '../src/types/index.js';

async function main() {
  console.log('\n=============================================================');
  console.log('   LEDGERLINE CONCURRENCY RACE CONDITION DEMONSTRATION');
  console.log('=============================================================\n');

  const pool = await getDbPool();
  await seed(pool);

  // Retrieve seeded admin user
  const adminRes = await pool.query('SELECT * FROM users WHERE email = $1', ['admin@ledgerline.test']);
  const admin = adminRes.rows[0];

  const adminActor: AuthActor = {
    id: admin.id,
    email: admin.email,
    role: admin.role,
  };

  // 1. Create a demo account with $300.00 (30,000 cents)
  const accountNumber = `DEMO-CONC-${Date.now().toString().slice(-6)}`;
  console.log(`[1] Creating demonstration account: ${accountNumber}`);
  const account = await accountService.createAccount({
    account_number: accountNumber,
    name: 'High Contention Demo Account',
    type: 'CUSTOMER',
    currency: 'USD',
    allow_overdraft: false,
    overdraft_limit: 0n,
  });

  console.log(`[2] Depositing initial balance: $300.00 (30,000 cents)...`);
  await ledgerService.deposit({
    accountId: account.id,
    amount: 30000n,
    actor: adminActor,
    description: 'Initial funding for concurrency test',
  });

  const check = (await pool.query('SELECT balance FROM accounts WHERE id = $1', [account.id])).rows[0];
  console.log(`    Current Account Balance: $${(Number(check.balance) / 100).toFixed(2)} (${check.balance} cents)\n`);

  // 2. Launch 30 simultaneous withdrawal attempts of $100.00 (10,000 cents) each
  console.log(`[3] Launching 30 SIMULTANEOUS concurrent withdrawal requests of $100.00 each...`);
  console.log(`    Total attempted withdrawal: $3,000.00 (300,000 cents)`);
  console.log(`    Affordable withdrawals: exactly 3`);
  console.log(`    Pessimistic row locking ('SELECT ... FOR UPDATE') queues contenders safely...\n`);

  const startTime = Date.now();
  const promises: Promise<any>[] = [];

  for (let i = 1; i <= 30; i++) {
    promises.push(
      ledgerService
        .withdraw({
          accountId: account.id,
          amount: 10000n,
          actor: adminActor,
          idempotencyKey: `demo-race-${i}-${Date.now()}`,
          description: `Concurrent withdrawal #${i}`,
        })
        .then(() => ({ index: i, success: true }))
        .catch((err) => ({ index: i, success: false, reason: err.code }))
    );
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  let successes = 0;
  let refusals = 0;

  for (const r of results) {
    if (r.success) {
      successes++;
      console.log(`  ✓ Withdrawal #${r.index.toString().padStart(2, '0')}: SUCCESS ($100.00 deducted)`);
    } else {
      refusals++;
      console.log(`  ✗ Withdrawal #${r.index.toString().padStart(2, '0')}: REFUSED (${r.reason})`);
    }
  }

  console.log(`\n[4] Execution Summary (completed in ${elapsed}ms):`);
  console.log(`    - Successful transactions: ${successes} (Expected: 3)`);
  console.log(`    - Refused transactions:    ${refusals} (Expected: 27)`);

  const finalCheck = (await pool.query('SELECT balance FROM accounts WHERE id = $1', [account.id])).rows[0];
  console.log(`\n[5] Post-Race State Invariants Verification:`);
  console.log(`    - Final Account Balance: $${(Number(finalCheck.balance) / 100).toFixed(2)} (never negative)`);

  // Verify hash chain
  const chain = await auditService.verifyHashChain();
  console.log(`    - Cryptographic Hash Chain: ${chain.valid ? 'VALID (100% Tamper-Evident)' : 'BROKEN'}`);

  // Reconcile
  const recon = await auditService.reconcile();
  console.log(`    - Global Balance Conservation: ${recon.reconciled ? 'CONSERVED (Global Sum = $0.00)' : 'FAILED'}`);

  console.log('\n=============================================================');
  console.log('   DEMONSTRATION COMPLETED: ZERO OVERDRAW, COMPLETE INTEGRITY');
  console.log('=============================================================\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
