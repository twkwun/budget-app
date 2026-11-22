import { expect } from 'vitest';
import type { CreatedInvite } from '@budget/shared';
import { MEMBER, type TestClient } from './client.ts';

/** Admin creates an invite, a fresh client accepts it; returns the signed-in member client. */
export async function invite(
  t: { client: (ip?: string) => TestClient },
  admin: TestClient,
  account: typeof MEMBER = MEMBER,
): Promise<TestClient> {
  const created = await admin.post('/api/invites', {});
  expect(created.statusCode).toBe(201);
  const token = created.json<CreatedInvite>().url.split('/invite/')[1];
  const member = t.client(
    `10.9.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`,
  );
  const res = await member.post(`/api/invite/${token}/accept`, account);
  expect(res.statusCode).toBe(201);
  return member;
}
