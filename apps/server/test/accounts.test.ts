import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo } from '@budget/shared';
import { addAccount, code, ledgerSetup } from './support/ledger.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await ledgerSetup();
  close = () => t.app.close();
  return t;
}

describe('accounts', () => {
  it('creates accounts owned by the creator', async () => {
    const t = await setup();
    const card = await addAccount(t.member, {
      name: '신한카드',
      issuer: 'shinhan',
      last4: '1234',
      billingDay: 14,
    });
    expect(card).toMatchObject({
      ownerUserId: t.memberId,
      ownerName: '구성원',
      canEdit: true,
      archived: false,
    });
    const cash = await addAccount(t.member, { kind: 'cash', name: '현금', billingDay: 5 });
    expect(cash.billingDay).toBeNull(); // only cards have a payment day
    for (const bad of [
      { last4: '12a4' },
      { last4: '12345' },
      { billingDay: 32 },
      { issuer: 'nope' },
      { name: '' },
      { kind: 'loan' },
    ]) {
      expect(
        (await t.member.post('/api/accounts', { kind: 'card', name: 'x', ...bad })).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    }
  });

  it('lets only the owner or an admin edit and archive; only admins change owners', async () => {
    const t = await setup();
    const adminCard = await addAccount(t.admin, { name: '관리자카드' });
    const memberCard = await addAccount(t.member, { name: '구성원카드' });

    const list = (await t.member.get('/api/accounts')).json<AccountInfo[]>();
    expect(list.find((a) => a.id === adminCard.id)?.canEdit).toBe(false);
    const denied = await t.member.patch(`/api/accounts/${adminCard.id}`, { name: 'x' });
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('forbidden');
    expect(
      (await t.member.patch(`/api/accounts/${memberCard.id}`, { ownerUserId: t.adminId }))
        .statusCode,
    ).toBe(403);
    expect(
      (await t.member.post('/api/accounts', { kind: 'card', name: 'x', ownerUserId: t.adminId }))
        .statusCode,
    ).toBe(403);

    const archived = (
      await t.member.patch(`/api/accounts/${memberCard.id}`, { archived: true })
    ).json<AccountInfo>();
    expect(archived.archived).toBe(true);
    const moved = (
      await t.admin.patch(`/api/accounts/${memberCard.id}`, {
        ownerUserId: t.adminId,
        primaryUserId: t.memberId,
        archived: false,
      })
    ).json<AccountInfo>();
    expect(moved).toMatchObject({
      ownerUserId: t.adminId,
      primaryUserId: t.memberId,
      primaryUserName: '구성원',
      archived: false,
    });
    expect(
      (await t.admin.patch(`/api/accounts/${memberCard.id}`, { primaryUserId: 999 })).statusCode,
    ).toBe(400);
  });

  it('reorders for everyone and rejects unknown ids', async () => {
    const t = await setup();
    const a = await addAccount(t.admin, { name: 'A' });
    const b = await addAccount(t.member, { name: 'B' });
    const res = await t.member.put('/api/accounts/order', { ids: [b.id, a.id] });
    expect(res.json<AccountInfo[]>().map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await t.member.put('/api/accounts/order', { ids: [b.id, 999] })).statusCode).toBe(400);
  });
});
