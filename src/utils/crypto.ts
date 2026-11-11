import crypto from 'crypto';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface LedgerHashPayload {
  id: string | number;
  transactionId: string;
  accountId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string | number | bigint;
  balanceAfter: string | number | bigint;
  createdAt: string | Date;
  prevHash: string;
}

export function computeEntryHash(payload: LedgerHashPayload): string {
  const createdAtIso =
    payload.createdAt instanceof Date
      ? payload.createdAt.toISOString()
      : new Date(payload.createdAt).toISOString();

  const data = [
    payload.prevHash,
    payload.id.toString(),
    payload.transactionId,
    payload.accountId,
    payload.direction,
    payload.amount.toString(),
    payload.balanceAfter.toString(),
    createdAtIso,
  ].join(':');

  return crypto.createHash('sha256').update(data).digest('hex');
}

export function computeRequestHash(method: string, path: string, body: unknown): string {
  // Normalize body to deterministic JSON
  const normalizedBody = body ? JSON.stringify(body, Object.keys(body as object).sort()) : '';
  const data = `${method.toUpperCase()}:${path}:${normalizedBody}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}
