let currentToken = localStorage.getItem('token') || '';
let currentUser = null;
let userAccounts = [];

function getHeaders(idempotencyKey) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (currentToken) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}

function generateKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function refreshKeys() {
  const depKey = document.getElementById('depositIdempotencyKey');
  const withKey = document.getElementById('withdrawIdempotencyKey');
  const trfKey = document.getElementById('transferIdempotencyKey');
  if (depKey) depKey.value = generateKey('dep');
  if (withKey) withKey.value = generateKey('with');
  if (trfKey) trfKey.value = generateKey('trf');
}

function showAlert(message, type = 'error') {
  const box = document.getElementById('alertBox');
  box.className = `alert alert-${type}`;
  box.textContent = message;
  box.style.display = 'block';
  setTimeout(() => {
    box.style.display = 'none';
  }, 5000);
}

function formatCents(cents) {
  const num = Number(cents) / 100;
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

async function quickLogin(email, password) {
  document.getElementById('loginEmail').value = email;
  document.getElementById('loginPassword').value = password;
  await handleLogin(email, password);
}

async function handleLogin(email, password) {
  try {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error?.message || 'Login failed');
    }

    currentToken = data.data.token;
    currentUser = data.data.user;
    localStorage.setItem('token', currentToken);
    updateAuthState();
    showAlert(`Welcome back, ${currentUser.email}!`, 'success');
    await loadAccounts();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

function updateAuthState() {
  const authSection = document.getElementById('authSection');
  const dashboardSection = document.getElementById('dashboardSection');
  const userInfo = document.getElementById('userInfo');
  const logoutBtn = document.getElementById('logoutBtn');
  const auditSection = document.getElementById('auditSection');

  if (currentUser) {
    authSection.style.display = 'none';
    dashboardSection.style.display = 'block';
    userInfo.style.display = 'inline-block';
    logoutBtn.style.display = 'inline-block';

    const roleClass =
      currentUser.role === 'ADMIN'
        ? 'badge-admin'
        : currentUser.role === 'AUDITOR'
        ? 'badge-auditor'
        : 'badge-holder';
    userInfo.innerHTML = `${currentUser.email} <span class="badge ${roleClass}">${currentUser.role}</span>`;

    if (currentUser.role === 'ADMIN' || currentUser.role === 'AUDITOR') {
      auditSection.style.display = 'block';
    } else {
      auditSection.style.display = 'none';
    }
  } else {
    authSection.style.display = 'block';
    dashboardSection.style.display = 'none';
    userInfo.style.display = 'none';
    logoutBtn.style.display = 'none';
    auditSection.style.display = 'none';
  }
}

async function loadAccounts() {
  if (!currentToken) return;

  try {
    const res = await fetch('/api/v1/accounts', {
      headers: getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to load accounts');

    userAccounts = data.data;
    renderAccounts(userAccounts);
    populateSelects(userAccounts);
    refreshKeys();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

function renderAccounts(accounts) {
  const tbody = document.getElementById('accountsBody');
  tbody.innerHTML = '';

  if (accounts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No accounts found.</td></tr>';
    return;
  }

  accounts.forEach((acc) => {
    const tr = document.createElement('tr');
    const balanceNum = Number(acc.balance);
    const balanceClass = balanceNum >= 0 ? 'amount-positive' : 'amount-negative';
    const statusClass = `badge-${acc.status.toLowerCase()}`;

    tr.innerHTML = `
      <td><strong>${acc.account_number}</strong><br><small style="color:var(--text-muted);">${acc.id}</small></td>
      <td>${acc.name}</td>
      <td>${acc.type}</td>
      <td><span class="badge ${statusClass}">${acc.status}</span></td>
      <td class="amount ${balanceClass}">${formatCents(acc.balance)}</td>
      <td>${acc.allow_overdraft ? formatCents(acc.overdraft_limit) : 'No'}</td>
      <td>
        <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" onclick="selectAccountForStatement('${acc.id}')">View Statement</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function populateSelects(accounts) {
  const depositSelect = document.getElementById('depositAccountSelect');
  const withdrawSelect = document.getElementById('withdrawAccountSelect');
  const transferSourceSelect = document.getElementById('transferSourceSelect');
  const statementSelect = document.getElementById('statementAccountSelect');

  const options = accounts.map((a) => `<option value="${a.id}">${a.account_number} - ${a.name} (${formatCents(a.balance)})</option>`).join('');

  if (depositSelect) depositSelect.innerHTML = options;
  if (withdrawSelect) withdrawSelect.innerHTML = options;
  if (transferSourceSelect) transferSourceSelect.innerHTML = options;
  if (statementSelect) {
    statementSelect.innerHTML = `<option value="">Select Account...</option>` + options;
  }
}

function selectAccountForStatement(id) {
  const statementSelect = document.getElementById('statementAccountSelect');
  if (statementSelect) {
    statementSelect.value = id;
    loadStatement();
  }
}

async function loadStatement() {
  const statementSelect = document.getElementById('statementAccountSelect');
  const accountId = statementSelect.value;
  if (!accountId) return;

  try {
    const res = await fetch(`/api/v1/accounts/${accountId}/statement`, {
      headers: getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to load statement');

    renderStatement(data.data.items);
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

function renderStatement(items) {
  const tbody = document.getElementById('statementBody');
  tbody.innerHTML = '';

  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No transactions or attempts found for this account.</td></tr>';
    return;
  }

  items.forEach((item) => {
    const tr = document.createElement('tr');
    const isSuccess = item.outcome === 'SUCCESS';
    const outcomeBadge = isSuccess
      ? '<span class="badge badge-active">SUCCESS</span>'
      : '<span class="badge badge-admin">REFUSED</span>';

    const directionBadge = item.direction
      ? `<span class="badge ${item.direction === 'CREDIT' ? 'badge-active' : 'badge-admin'}">${item.direction}</span>`
      : '-';

    const runningBal = item.runningBalance ? formatCents(item.runningBalance) : '-';
    const dateFormatted = new Date(item.timestamp).toLocaleString();

    tr.innerHTML = `
      <td>${dateFormatted}</td>
      <td>${item.entryType}</td>
      <td>${item.action} ${directionBadge}</td>
      <td class="amount">${formatCents(item.amount)}</td>
      <td class="amount">${runningBal}</td>
      <td>${outcomeBadge}</td>
      <td>${item.description || item.reasonCode || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Deposit handler
document.getElementById('depositForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const accountId = document.getElementById('depositAccountSelect').value;
  const amountVal = parseFloat(document.getElementById('depositAmount').value);
  const amountCents = Math.round(amountVal * 100);
  const description = document.getElementById('depositDescription').value;
  const key = document.getElementById('depositIdempotencyKey').value;

  try {
    const res = await fetch(`/api/v1/accounts/${accountId}/deposit`, {
      method: 'POST',
      headers: getHeaders(key),
      body: JSON.stringify({ amount: amountCents, description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Deposit failed');

    showAlert('Deposit posted successfully!', 'success');
    document.getElementById('depositAmount').value = '';
    await loadAccounts();
    loadStatement();
  } catch (err) {
    showAlert(err.message, 'error');
  }
});

// Withdraw handler
document.getElementById('withdrawForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const accountId = document.getElementById('withdrawAccountSelect').value;
  const amountVal = parseFloat(document.getElementById('withdrawAmount').value);
  const amountCents = Math.round(amountVal * 100);
  const description = document.getElementById('withdrawDescription').value;
  const key = document.getElementById('withdrawIdempotencyKey').value;

  try {
    const res = await fetch(`/api/v1/accounts/${accountId}/withdraw`, {
      method: 'POST',
      headers: getHeaders(key),
      body: JSON.stringify({ amount: amountCents, description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Withdrawal failed');

    showAlert('Withdrawal posted successfully!', 'success');
    document.getElementById('withdrawAmount').value = '';
    await loadAccounts();
    loadStatement();
  } catch (err) {
    showAlert(err.message, 'error');
  }
});

// Transfer handler
document.getElementById('transferForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const sourceAccountId = document.getElementById('transferSourceSelect').value;
  const destinationAccountId = document.getElementById('transferDestId').value.trim();
  const amountVal = parseFloat(document.getElementById('transferAmount').value);
  const amountCents = Math.round(amountVal * 100);
  const description = document.getElementById('transferDescription').value;
  const key = document.getElementById('transferIdempotencyKey').value;

  try {
    const res = await fetch(`/api/v1/transfers`, {
      method: 'POST',
      headers: getHeaders(key),
      body: JSON.stringify({
        source_account_id: sourceAccountId,
        destination_account_id: destinationAccountId,
        amount: amountCents,
        description,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Transfer failed');

    showAlert('Transfer executed successfully!', 'success');
    document.getElementById('transferAmount').value = '';
    document.getElementById('transferDestId').value = '';
    await loadAccounts();
    loadStatement();
  } catch (err) {
    showAlert(err.message, 'error');
  }
});

// Audit Actions
async function verifyChain() {
  const box = document.getElementById('auditResultBox');
  try {
    const res = await fetch('/api/v1/audit/verify-chain', { headers: getHeaders() });
    const data = await res.json();
    box.style.display = 'block';
    if (data.data.valid) {
      box.className = 'alert alert-success';
      box.innerHTML = `<strong>Hash Chain Verified Valid!</strong> Total entries audited: ${data.data.totalEntries}. Latest hash: <code>${data.data.lastHash}</code>`;
    } else {
      box.className = 'alert alert-error';
      box.innerHTML = `<strong>Tampering Detected!</strong> Broken at Entry ID ${data.data.brokenAtId}. Reason: ${data.data.reason}`;
    }
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function runReconciliation() {
  const box = document.getElementById('auditResultBox');
  try {
    const res = await fetch('/api/v1/audit/reconcile', { headers: getHeaders() });
    const data = await res.json();
    box.style.display = 'block';
    if (data.data.reconciled) {
      box.className = 'alert alert-success';
      box.innerHTML = `<strong>Reconciliation Success!</strong> All ${data.data.accountsChecked} account balances equal sum of ledger entries. Global system sum: <strong>$0.00</strong> (Strictly Conserved).`;
    } else {
      box.className = 'alert alert-error';
      box.innerHTML = `<strong>Reconciliation Discrepancy!</strong> Global sum: ${data.data.globalSum}. Discrepant accounts: ${data.data.discrepancies.length}`;
    }
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

// Initial Boot
document.getElementById('loginForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  handleLogin(
    document.getElementById('loginEmail').value,
    document.getElementById('loginPassword').value
  );
});

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  currentToken = '';
  currentUser = null;
  localStorage.removeItem('token');
  updateAuthState();
  showAlert('Logged out successfully', 'info');
});

// Auto-check existing session
if (currentToken) {
  fetch('/api/v1/auth/me', { headers: getHeaders() })
    .then((r) => r.json())
    .then((d) => {
      if (d.success) {
        currentUser = d.data;
        updateAuthState();
        loadAccounts();
      } else {
        currentToken = '';
        localStorage.removeItem('token');
        updateAuthState();
      }
    })
    .catch(() => {
      updateAuthState();
    });
} else {
  updateAuthState();
}
