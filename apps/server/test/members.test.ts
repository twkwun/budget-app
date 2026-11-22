import { afterEach, describe, expect, it } from 'vitest';
import type { CreatedInvite, InviteCheck, InviteInfo, Me, MemberInfo } from '@budget/shared';
import { ADMIN, MEMBER, startTestApp } from './support/client.ts';
import { invite } from './support/invite.ts';

const DAY = 24 * 60 * 60_000;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const code = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

async function setup() {
  const t = await startTestApp();
  close = () => t.app.close();
  const admin = t.client();
  await admin.post('/api/setup', ADMIN);
  await admin.patch('/api/me', { lockTimeoutSeconds: null });
  return { ...t, admin };
}

async function createInvite(t: Awaited<ReturnType<typeof setup>>) {
  const res = await t.admin.post('/api/invites', {});
  expect(res.statusCode).toBe(201);
  const body = res.json<CreatedInvite>();
  return { ...body, token: body.url.split('/invite/')[1]! };
}

describe('invites', () => {
  it('creates a single-use link the invitee uses to join as a member', async () => {
    const t = await setup();
    const { url, token, invite: info } = await createInvite(t);
    expect(url).toMatch(/^http:\/\/localhost:5173\/invite\/[\w-]{43}$/);
    expect(info).toMatchObject({ role: 'member', status: 'pending', createdBy: '관리자' });
    expect(Date.parse(info.expiresAt) - t.clock.now()).toBe(7 * DAY);

    const guest = t.client('10.2.0.1');
    expect((await guest.get(`/api/invite/${token}`)).json<InviteCheck>().valid).toBe(true);
    const accepted = await guest.post(`/api/invite/${token}/accept`, MEMBER);
    expect(accepted.statusCode).toBe(201);
    const body = accepted.json<{ user: Me; recoveryCode: string }>();
    expect(body.user).toMatchObject({ loginName: 'member', role: 'member' });
    expect(body.recoveryCode).toMatch(/^[0-9A-Z-]{19}$/);
    expect((await guest.get('/api/me')).statusCode).toBe(200);

    const reuse = await t.client('10.2.0.2').post(`/api/invite/${token}/accept`, {
      ...MEMBER,
      loginName: 'second',
    });
    expect(reuse.statusCode).toBe(410);
    expect(code(reuse)).toBe('invite_invalid');
    expect((await guest.get(`/api/invite/${token}`)).json<InviteCheck>().valid).toBe(false);

    const list = (await t.admin.get('/api/invites')).json<InviteInfo[]>();
    expect(list[0]).toMatchObject({ status: 'used', usedBy: '구성원' });
  });

  it('rejects expired, revoked and unknown invites and taken login names', async () => {
    const t = await setup();
    const expiring = await createInvite(t);
    const revoked = await createInvite(t);
    expect((await t.admin.delete(`/api/invites/${revoked.invite.id}`)).statusCode).toBe(204);
    expect((await t.admin.delete(`/api/invites/${revoked.invite.id}`)).statusCode).toBe(404);
    const guest = t.client('10.2.1.1');
    expect(code(await guest.post(`/api/invite/${revoked.token}/accept`, MEMBER))).toBe(
      'invite_invalid',
    );
    expect(code(await guest.post(`/api/invite/${'x'.repeat(43)}/accept`, MEMBER))).toBe(
      'invite_invalid',
    );

    const taken = await guest.post(`/api/invite/${expiring.token}/accept`, {
      ...MEMBER,
      loginName: 'admin',
    });
    expect(taken.statusCode).toBe(409);
    expect(code(taken)).toBe('login_name_taken');

    t.clock.advance(7 * DAY + 1);
    expect(code(await guest.post(`/api/invite/${expiring.token}/accept`, MEMBER))).toBe(
      'invite_invalid',
    );
    const statuses = (await t.admin.get('/api/invites')).json<InviteInfo[]>().map((i) => i.status);
    expect(statuses.sort()).toEqual(['expired', 'revoked']);
  });

  it('is admin-only', async () => {
    const t = await setup();
    const member = await invite(t, t.admin);
    for (const [method, url] of [
      ['GET', '/api/invites'],
      ['POST', '/api/invites'],
      ['PATCH', '/api/members/1'],
      ['DELETE', '/api/invites/1'],
    ] as const) {
      const res = await member.request(
        method,
        url,
        method === 'GET' ? undefined : { role: 'member' },
      );
      expect(res.statusCode, url).toBe(403);
      expect(code(res), url).toBe('forbidden');
    }
    // Members can see who is in the family.
    expect((await member.get('/api/members')).json<MemberInfo[]>()).toHaveLength(2);
  });
});

describe('member management', () => {
  it('disables a member (ending their sessions) and re-enables them', async () => {
    const t = await setup();
    const member = await invite(t, t.admin);
    const id = (await member.get('/api/me')).json<Me>().id;

    const res = await t.admin.patch(`/api/members/${id}`, { disabled: true });
    expect(res.json()).toEqual({ id, role: 'member', disabled: true });
    expect((await member.get('/api/me')).statusCode).toBe(401);
    const login = () =>
      t.client('10.3.0.1').post('/api/auth/login/password', {
        loginName: MEMBER.loginName,
        password: MEMBER.password,
      });
    expect((await login()).statusCode).toBe(401);

    await t.admin.patch(`/api/members/${id}`, { disabled: false });
    expect((await login()).statusCode).toBe(200);
  });

  it('never demotes or disables the last active admin', async () => {
    const t = await setup();
    const adminId = (await t.admin.get('/api/me')).json<Me>().id;
    const member = await invite(t, t.admin);
    const memberId = (await member.get('/api/me')).json<Me>().id;

    for (const body of [{ role: 'member' }, { disabled: true }]) {
      const res = await t.admin.patch(`/api/members/${adminId}`, body);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('last_admin');
    }
    // A disabled admin does not count as active.
    await t.admin.patch(`/api/members/${memberId}`, { role: 'admin', disabled: true });
    expect(code(await t.admin.patch(`/api/members/${adminId}`, { role: 'member' }))).toBe(
      'last_admin',
    );

    await t.admin.patch(`/api/members/${memberId}`, { disabled: false });
    expect((await t.admin.patch(`/api/members/${adminId}`, { role: 'member' })).statusCode).toBe(
      200,
    );
    expect((await t.admin.get('/api/me')).json<Me>().role).toBe('member');
    expect((await t.admin.post('/api/invites', {})).statusCode).toBe(403);
  });

  it('validates input', async () => {
    const t = await setup();
    expect((await t.admin.patch('/api/members/999', { role: 'member' })).statusCode).toBe(404);
    expect((await t.admin.patch('/api/members/1', { role: 'owner' })).statusCode).toBe(400);
    expect((await t.admin.patch('/api/members/abc', { role: 'member' })).statusCode).toBe(400);
  });
});
