import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState, PasskeyInfo, SignedIn } from '@budget/shared';
import { passkeys } from '../src/db/schema.ts';
import { SoftAuthenticator } from './support/authenticator.ts';
import { ADMIN, ORIGIN, startTestApp, type TestClient } from './support/client.ts';

const MIN = 60_000;
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
  const authenticator = new SoftAuthenticator({ origin: ORIGIN });
  return { ...t, admin, authenticator };
}

async function register(client: TestClient, authenticator: SoftAuthenticator, deviceName?: string) {
  const opt = await client.post('/api/me/passkeys/options');
  expect(opt.statusCode).toBe(200);
  const { challengeId, options } = opt.json<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>();
  return client.post('/api/me/passkeys', {
    challengeId,
    deviceName,
    response: authenticator.register(options),
  });
}

async function loginOptions(client: TestClient) {
  return (await client.post('/api/auth/login/passkey/options')).json<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>();
}

describe('passkey registration', () => {
  it('registers a discoverable, user-verified passkey bound to PUBLIC_ORIGIN', async () => {
    const t = await setup();
    const opt = (await t.admin.post('/api/me/passkeys/options')).json<{
      options: PublicKeyCredentialCreationOptionsJSON;
    }>().options;
    expect(opt.rp).toEqual({ id: 'localhost', name: '가계부' });
    expect(opt.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(opt.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
    expect(opt.attestation).toBe('none');

    const res = await register(t.admin, t.authenticator, '아이폰');
    expect(res.statusCode).toBe(201);
    expect(res.json<PasskeyInfo>()).toMatchObject({ deviceName: '아이폰', backedUp: true });
    const list = (await t.admin.get('/api/me/passkeys')).json<PasskeyInfo[]>();
    expect(list).toHaveLength(1);

    // A second registration excludes the existing credential.
    const again = (await t.admin.post('/api/me/passkeys/options')).json<{
      options: PublicKeyCredentialCreationOptionsJSON;
    }>().options;
    expect(again.excludeCredentials?.map((c) => c.id)).toEqual([list[0]!.id]);
  });

  it('rejects reused, expired and foreign-origin registration responses', async () => {
    const t = await setup();
    const { challengeId, options } = (await t.admin.post('/api/me/passkeys/options')).json<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>();
    const wrongOrigin = await t.admin.post('/api/me/passkeys', {
      challengeId,
      response: t.authenticator.register(options, 'https://evil.example.com'),
    });
    expect(wrongOrigin.statusCode).toBe(400);
    // The challenge was consumed by the failed attempt.
    const replay = await t.admin.post('/api/me/passkeys', {
      challengeId,
      response: t.authenticator.register(options),
    });
    expect(replay.statusCode).toBe(410);
    expect(code(replay)).toBe('challenge_invalid');

    const fresh = (await t.admin.post('/api/me/passkeys/options')).json<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>();
    // Six idle minutes: the 5-minute app lock and the 5-minute challenge TTL both pass.
    t.clock.advance(6 * MIN);
    const expired = await t.admin.post('/api/me/passkeys', {
      challengeId: fresh.challengeId,
      response: t.authenticator.register(fresh.options),
    });
    expect(expired.statusCode).toBe(423); // the lock is checked first
    await t.admin.post('/api/auth/verify/password', { password: ADMIN.password });
    const afterUnlock = await t.admin.post('/api/me/passkeys', {
      challengeId: fresh.challengeId,
      response: t.authenticator.register(fresh.options),
    });
    expect(afterUnlock.statusCode).toBe(410);
    expect(code(afterUnlock)).toBe('challenge_invalid');
  });
});

describe('passkey sign-in', () => {
  it('signs in without a username using a discoverable credential', async () => {
    const t = await setup();
    await register(t.admin, t.authenticator);
    const phone = t.client('10.1.0.1');
    const { challengeId, options } = await loginOptions(phone);
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    const res = await phone.post('/api/auth/login/passkey/verify', {
      challengeId,
      response: t.authenticator.authenticate(options),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SignedIn>().user.loginName).toBe('admin');
    expect((await phone.get('/api/me')).statusCode).toBe(200);
    const [row] = t.db.select().from(passkeys).all();
    expect(row!.counter).toBe(1);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('rejects replayed and expired challenges', async () => {
    const t = await setup();
    await register(t.admin, t.authenticator);
    const c = t.client('10.1.0.2');
    const first = await loginOptions(c);
    const response = t.authenticator.authenticate(first.options);
    expect(
      (await c.post('/api/auth/login/passkey/verify', { challengeId: first.challengeId, response }))
        .statusCode,
    ).toBe(200);
    const replay = await t.client('10.1.0.3').post('/api/auth/login/passkey/verify', {
      challengeId: first.challengeId,
      response,
    });
    expect(replay.statusCode).toBe(410);

    const second = await loginOptions(c);
    t.clock.advance(5 * MIN + 1);
    const expired = await c.post('/api/auth/login/passkey/verify', {
      challengeId: second.challengeId,
      response: t.authenticator.authenticate(second.options),
    });
    expect(expired.statusCode).toBe(410);
    expect(code(expired)).toBe('challenge_invalid');
  });

  it('rejects a signature counter that goes backwards', async () => {
    const t = await setup();
    await register(t.admin, t.authenticator);
    const c = t.client('10.1.0.4');
    for (let i = 0; i < 2; i += 1) {
      const o = await loginOptions(c);
      const ok = await c.post('/api/auth/login/passkey/verify', {
        challengeId: o.challengeId,
        response: t.authenticator.authenticate(o.options),
      });
      expect(ok.statusCode).toBe(200);
    }
    t.authenticator.rewindCounter();
    const o = await loginOptions(c);
    const cloned = await c.post('/api/auth/login/passkey/verify', {
      challengeId: o.challengeId,
      response: t.authenticator.authenticate(o.options),
    });
    expect(cloned.statusCode).toBe(401);
  });

  it('rejects assertions for another origin, without user verification, or unknown credentials', async () => {
    const t = await setup();
    await register(t.admin, t.authenticator);
    const c = t.client('10.1.0.5');
    let o = await loginOptions(c);
    const foreign = t.authenticator.authenticate(o.options, { origin: 'https://evil.example.com' });
    expect(
      (
        await c.post('/api/auth/login/passkey/verify', {
          challengeId: o.challengeId,
          response: foreign,
        })
      ).statusCode,
    ).toBe(401);

    t.authenticator.userVerified = false;
    o = await loginOptions(c);
    const noUv = t.authenticator.authenticate(o.options);
    expect(
      (
        await c.post('/api/auth/login/passkey/verify', {
          challengeId: o.challengeId,
          response: noUv,
        })
      ).statusCode,
    ).toBe(401);

    t.authenticator.userVerified = true;
    const stranger = new SoftAuthenticator({ origin: ORIGIN });
    stranger.register({
      ...(await t.admin.post('/api/me/passkeys/options')).json<{
        options: PublicKeyCredentialCreationOptionsJSON;
      }>().options,
    });
    o = await loginOptions(c);
    const unknown = stranger.authenticate(o.options);
    expect(
      (
        await c.post('/api/auth/login/passkey/verify', {
          challengeId: o.challengeId,
          response: unknown,
        })
      ).statusCode,
    ).toBe(401);
    expect((await c.get('/api/auth/session')).json<AuthState>().authenticated).toBe(false);
  });
});

describe('passkey unlock and management', () => {
  it('unlocks a locked session with a passkey bound to that session', async () => {
    const t = await setup();
    await register(t.admin, t.authenticator);
    await t.admin.post('/api/auth/lock');
    expect((await t.admin.get('/api/me')).statusCode).toBe(423);
    const opt = (await t.admin.post('/api/auth/verify/passkey/options')).json<{
      challengeId: string;
      options: PublicKeyCredentialRequestOptionsJSON;
    }>();
    expect(opt.options.allowCredentials).toHaveLength(1);
    // A login challenge cannot be used to unlock.
    const loginChallenge = await loginOptions(t.client('10.1.0.6'));
    const mixed = await t.admin.post('/api/auth/verify/passkey', {
      challengeId: loginChallenge.challengeId,
      response: t.authenticator.authenticate(loginChallenge.options),
    });
    expect(mixed.statusCode).toBe(410);
    const ok = await t.admin.post('/api/auth/verify/passkey', {
      challengeId: opt.challengeId,
      response: t.authenticator.authenticate(opt.options),
    });
    expect(ok.statusCode).toBe(204);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
  });

  it('renames and deletes (with re-auth), never touching other users’ passkeys', async () => {
    const t = await setup();
    const created = (await register(t.admin, t.authenticator)).json<PasskeyInfo>();
    const id = encodeURIComponent(created.id);
    const renamed = await t.admin.patch(`/api/me/passkeys/${id}`, { deviceName: '맥북' });
    expect(renamed.json<PasskeyInfo>().deviceName).toBe('맥북');
    expect((await t.admin.patch(`/api/me/passkeys/${id}`, { deviceName: '' })).statusCode).toBe(
      400,
    );

    // Another user (created directly) cannot see or delete it.
    const { invite } = await import('./support/invite.ts');
    const member = await invite(t, t.admin);
    expect((await member.delete(`/api/me/passkeys/${id}`)).statusCode).toBe(404);
    expect((await member.patch(`/api/me/passkeys/${id}`, { deviceName: 'x' })).statusCode).toBe(
      404,
    );

    t.clock.advance(4 * MIN);
    await t.admin.get('/api/me');
    t.clock.advance(2 * MIN); // last verification is now 6 minutes old
    const needsReauth = await t.admin.delete(`/api/me/passkeys/${id}`);
    expect(code(needsReauth)).toBe('reauth_required');
    await t.admin.post('/api/auth/verify/password', { password: ADMIN.password });
    expect((await t.admin.delete(`/api/me/passkeys/${id}`)).statusCode).toBe(204);
    expect((await t.admin.get('/api/me/passkeys')).json()).toEqual([]);
  });
});
