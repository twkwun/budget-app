import { expect } from 'vitest';
import type { AccountInfo, CategoryTree, Me, TransactionInfo } from '@budget/shared';
import { ADMIN, MEMBER, startTestApp, type TestClient } from './client.ts';
import { invite } from './invite.ts';

/** Admin + member signed in, lock disabled, with category ids by name. */
export async function ledgerSetup() {
  const t = await startTestApp();
  const admin = t.client();
  await admin.post('/api/setup', ADMIN);
  await admin.patch('/api/me', { lockTimeoutSeconds: null });
  const member = await invite(t, admin, MEMBER);
  await member.patch('/api/me', { lockTimeoutSeconds: null });
  const adminId = (await admin.get('/api/me')).json<Me>().id;
  const memberId = (await member.get('/api/me')).json<Me>().id;
  const tree = (await admin.get('/api/categories')).json<CategoryTree>();
  const cat = (path: string): number => {
    const [top, child] = path.split('/');
    const all = [...tree.expense, ...tree.income];
    const parent = all.find((c) => c.name === top);
    const node = child ? parent?.children.find((c) => c.name === child) : parent;
    if (!node) throw new Error(`no category ${path}`);
    return node.id;
  };
  return { ...t, admin, member, adminId, memberId, cat };
}

export async function addTx(
  client: TestClient,
  body: Record<string, unknown>,
): Promise<TransactionInfo> {
  const res = await client.post('/api/transactions', { type: 'expense', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<TransactionInfo>();
}

export async function addAccount(
  client: TestClient,
  body: Record<string, unknown> = {},
): Promise<AccountInfo> {
  const res = await client.post('/api/accounts', { kind: 'card', name: '테스트카드', ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<AccountInfo>();
}

export const code = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;
