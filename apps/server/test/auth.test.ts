import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState, Me, SessionInfo } from '@budget/shared';
import { sessions, users } from '../src/db/schema.ts';
import { ADMIN, ORIGIN, startTestApp, type TestClient } from './support/client.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(env: Record<string, string> = {}) {
  const t = await startTestApp(env);
  close = () => t.app.close();
  const admin = t.client();
  const res = await admin.post('/api/setup', ADMIN);
  expect(res.statusCode).toBe(201);
  return { ...t, admin, recoveryCode: res.json<{ recoveryCode: string }>().recoveryCode };
}

const code = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

async function login(client: TestClient, password = ADMIN.password, loginName = ADMIN.loginName) {
  return client.post('/api/auth/login/password', { loginName, password });
}

describe('first-run setup', () => {
  it('reports setup required, creates the first admin once, then closes', async () => {
    const t = await startTestApp();
    close = () => t.app.close();
    const c = t.client();
    expect((await c.get('/api/auth/session')).json<AuthState>()).toMatchObject({
      setupRequired: true,
      authenticated: false,
    });

    const bad = await c.post('/api/setup', { ...ADMIN, loginName: 'A B' });
    expect(bad.statusCode).toBe(400);
    expect(code(bad)).toBe('validation_error');
    expect((await c.post('/api/setup', { ...ADMIN, password: 'short' })).statusCode).toBe(400);

    const res = await c.post('/api/setup', { ...ADMIN, loginName: '  Admin ' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ user: Me; recoveryCode: string }>();
    expect(body.user).toMatchObject({ loginName: 'admin', role: 'admin', lockTimeoutSeconds: 300 });
    expect(body.recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    const stored = t.db.select().from(users).get()!;
    expect(stored.passwordHash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$/);
    expect(stored.recoveryCodeHash).not.toContain(body.recoveryCode);

    expect((await c.get('/api/auth/session')).json<AuthState>()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      locked: false,
    });
    const again = await t.client('10.0.0.9').post('/api/setup', { ...ADMIN, loginName: 'other' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('setup_closed');
  });
});

describe('access control defaults', () => {
  it('protects every API route except the public ones', async () => {
    const t = await setup();
    const anon = t.client('10.0.0.2');
    expect((await anon.get('/api/health')).statusCode).toBe(200);
    expect((await anon.get('/api/auth/session')).statusCode).toBe(200);
    for (const url of ['/api/me', '/api/me/sessions', '/api/me/passkeys', '/api/members']) {
      const res = await anon.get(url);
      expect(res.statusCode, url).toBe(401);
      expect(code(res)).toBe('unauthenticated');
    }
  });

  it('only the intended routes are public, and every other route answers 401 anonymously', async () => {
    const t = await setup();
    const publicRoutes = t.routeAccess
      .filter((r) => r.auth === 'public')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(publicRoutes).toEqual([
      'GET /api/auth/session',
      'GET /api/health',
      'GET /api/invite/:token',
      'POST /api/auth/login/passkey/options',
      'POST /api/auth/login/passkey/verify',
      'POST /api/auth/login/password',
      'POST /api/auth/logout',
      'POST /api/auth/recovery',
      'POST /api/invite/:token/accept',
      'POST /api/setup',
    ]);
    const anon = t.client('10.0.0.4');
    for (const route of t.routeAccess.filter((r) => r.auth !== 'public')) {
      const url = route.url.replace(/:(\w+)/g, '1');
      const res = await anon.request(
        route.method as 'GET',
        url,
        route.method === 'GET' ? undefined : {},
      );
      expect(res.statusCode, `${route.method} ${url}`).toBe(401);
    }
    expect(t.routeAccess.length).toBeGreaterThan(publicRoutes.length + 10);
  });

  it('rejects state-changing requests without the expected Origin', async () => {
    const t = await setup();
    t.admin.origin = null;
    const missing = await t.admin.patch('/api/me', { displayName: 'x' });
    expect(missing.statusCode).toBe(403);
    expect(code(missing)).toBe('invalid_origin');
    t.admin.origin = 'https://evil.example.com';
    expect(code(await t.admin.post('/api/auth/logout'))).toBe('invalid_origin');
    expect(code(await login(t.client('10.0.0.3').withOrigin('http://localhost:3000')))).toBe(
      'invalid_origin',
    );
    t.admin.origin = ORIGIN;
    expect((await t.admin.patch('/api/me', { displayName: '새 이름' })).statusCode).toBe(200);
  });
});

describe('session cookie', () => {
  it('uses a host-only HttpOnly SameSite=Strict cookie over http://localhost', async () => {
    const t = await startTestApp();
    close = () => t.app.close();
    const res = await t.client().post('/api/setup', ADMIN);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^budget_session=[\w-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('Domain');
  });

  it('uses __Host- and Secure when PUBLIC_ORIGIN is https', async () => {
    const t = await startTestApp({ PUBLIC_ORIGIN: 'https://budget.example-tailnet.ts.net' });
    close = () => t.app.close();
    const c = t.client();
    c.origin = 'https://budget.example-tailnet.ts.net';
    const res = await c.post('/api/setup', ADMIN);
    expect(String(res.headers['set-cookie'])).toMatch(/^__Host-budget_session=.*; Secure$/);
  });

  it('stores only a hash of the token', async () => {
    const t = await setup();
    const row = t.db.select().from(sessions).get()!;
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('password login and lockout', () => {
  it('signs in and out', async () => {
    const t = await setup();
    const c = t.client('10.0.0.5');
    const res = await login(c);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: Me }>().user.loginName).toBe('admin');
    expect((await c.get('/api/me')).statusCode).toBe(200);
    expect((await c.post('/api/auth/logout')).statusCode).toBe(204);
    expect(c.hasCookie).toBe(false);
    expect((await c.get('/api/me')).statusCode).toBe(401);
  });

  it('gives identical answers for unknown users and wrong passwords', async () => {
    const t = await setup();
    const a = await login(t.client('10.0.1.1'), 'wrong password');
    const b = await login(t.client('10.0.1.2'), ADMIN.password, 'nobody');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
  });

  it('locks the account after 5 failures and unlocks after 15 minutes', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) {
      expect((await login(t.client(`10.0.2.${i}`), 'wrong password')).statusCode).toBe(401);
    }
    const locked = await login(t.client('10.0.2.9'));
    expect(locked.statusCode).toBe(401);
    expect(code(locked)).toBe('invalid_credentials');
    t.clock.advance(16 * MIN);
    expect((await login(t.client('10.0.2.10'))).statusCode).toBe(200);
    expect(t.db.select().from(users).get()!.failedLoginCount).toBe(0);
  });

  it('rate-limits auth endpoints per IP and per login name', async () => {
    const t = await setup();
    const c = t.client('10.0.3.1');
    let last;
    for (let i = 0; i < 31; i += 1) last = await c.post('/api/auth/login/passkey/options');
    expect(last!.statusCode).toBe(429);
    expect(code(last!)).toBe('rate_limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);

    for (let i = 0; i < 10; i += 1) await login(t.client(`10.0.4.${i}`), 'wrong', 'someone');
    const byName = await login(t.client('10.0.4.99'), 'wrong', 'someone');
    expect(byName.statusCode).toBe(429);
  });

  it('uses X-Forwarded-For only when TRUST_PROXY is on', async () => {
    const t = await setup({ TRUST_PROXY: 'true' });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me/sessions',
      headers: { cookie: (await loginCookie(t.admin)) ?? '', 'x-forwarded-for': '100.64.1.2' },
      remoteAddress: '172.18.0.3',
    });
    expect(res.json<SessionInfo[]>().some((s) => s.ip === '100.64.1.2')).toBe(true);
  });
});

async function loginCookie(client: TestClient): Promise<string | null> {
  const res = await login(client);
  const header = String(res.headers['set-cookie'] ?? '');
  return header.split(';')[0] ?? null;
}

describe('sessions', () => {
  it('slides expiry with use and expires after 30 idle days', async () => {
    const t = await setup();
    await t.admin.patch('/api/me', { lockTimeoutSeconds: null });
    t.clock.advance(29 * DAY);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    t.clock.advance(29 * DAY);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    t.clock.advance(31 * DAY);
    expect((await t.admin.get('/api/me')).statusCode).toBe(401);
    expect(t.db.select().from(sessions).all()).toHaveLength(0);
  });

  it('lists sessions and signs out the others', async () => {
    const t = await setup();
    const phone = t.client('10.0.5.1');
    await login(phone);
    const list = (await t.admin.get('/api/me/sessions')).json<SessionInfo[]>();
    expect(list).toHaveLength(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect((await t.admin.post('/api/me/sessions/revoke-others')).json()).toEqual({ revoked: 1 });
    expect((await phone.get('/api/me')).statusCode).toBe(401);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
  });

  it('revokes a single own session but not someone else’s', async () => {
    const t = await setup();
    const other = t.client('10.0.5.2');
    await login(other);
    const otherId = (await other.get('/api/me/sessions'))
      .json<SessionInfo[]>()
      .find((s) => s.current)!.id;
    expect((await t.admin.delete(`/api/me/sessions/${otherId}`)).statusCode).toBe(204);
    expect((await other.get('/api/me')).statusCode).toBe(401);
    expect((await t.admin.delete('/api/me/sessions/does-not-exist')).statusCode).toBe(404);
  });
});

describe('app lock', () => {
  it('locks after the inactivity timeout and only unlock routes work', async () => {
    const t = await setup();
    t.clock.advance(4 * MIN);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    t.clock.advance(4 * MIN); // 4 min since last request: still open
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    t.clock.advance(5 * MIN + 1000);
    const locked = await t.admin.get('/api/me');
    expect(locked.statusCode).toBe(423);
    expect(code(locked)).toBe('session_locked');
    expect((await t.admin.get('/api/auth/session')).json<AuthState>()).toMatchObject({
      authenticated: true,
      locked: true,
    });
    expect((await t.admin.post('/api/me/recovery-code')).statusCode).toBe(423);

    const wrong = await t.admin.post('/api/auth/verify/password', { password: 'nope nope' });
    expect(wrong.statusCode).toBe(401);
    expect((await t.admin.get('/api/me')).statusCode).toBe(423);

    expect(
      (await t.admin.post('/api/auth/verify/password', { password: ADMIN.password })).statusCode,
    ).toBe(204);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
  });

  it('locks immediately on request and stays locked across time', async () => {
    const t = await setup();
    expect((await t.admin.post('/api/auth/lock')).statusCode).toBe(204);
    expect((await t.admin.get('/api/me')).statusCode).toBe(423);
    // Logout still works while locked.
    expect((await t.admin.post('/api/auth/logout')).statusCode).toBe(204);
    expect((await t.admin.get('/api/auth/session')).json<AuthState>().authenticated).toBe(false);
  });

  it('honours 즉시 (backstop after 1 minute) and 끔', async () => {
    const t = await setup();
    await t.admin.patch('/api/me', { lockTimeoutSeconds: 0 });
    t.clock.advance(50_000);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    t.clock.advance(61_000);
    expect((await t.admin.get('/api/me')).statusCode).toBe(423);
    await t.admin.post('/api/auth/verify/password', { password: ADMIN.password });
    await t.admin.patch('/api/me', { lockTimeoutSeconds: null });
    t.clock.advance(10 * DAY);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    expect((await t.admin.patch('/api/me', { lockTimeoutSeconds: 42 })).statusCode).toBe(400);
  });
});

describe('step-up re-auth', () => {
  it('requires a recent verification for sensitive actions', async () => {
    const t = await setup();
    await t.admin.patch('/api/me', { lockTimeoutSeconds: null });
    expect((await t.admin.post('/api/me/recovery-code')).statusCode).toBe(200); // fresh login
    t.clock.advance(6 * MIN);
    for (const [method, url, body] of [
      ['POST', '/api/me/recovery-code', {}],
      ['POST', '/api/me/password', { newPassword: 'another pass 3' }],
      ['POST', '/api/me/passkeys/options', {}],
      ['DELETE', '/api/me/passkeys/x', undefined],
      ['POST', '/api/invites', {}],
      ['PATCH', '/api/members/1', { role: 'admin' }],
    ] as const) {
      const res = await t.admin.request(method, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(code(res), url).toBe('reauth_required');
    }
    expect(
      (await t.admin.post('/api/auth/verify/password', { password: ADMIN.password })).statusCode,
    ).toBe(204);
    expect((await t.admin.post('/api/me/recovery-code')).statusCode).toBe(200);
  });

  it('changes the password and ends other sessions', async () => {
    const t = await setup();
    const other = t.client('10.0.6.1');
    await login(other);
    const res = await t.admin.post('/api/me/password', { newPassword: 'brand new pass 4' });
    expect(res.statusCode).toBe(204);
    expect((await other.get('/api/me')).statusCode).toBe(401);
    expect((await t.admin.get('/api/me')).statusCode).toBe(200);
    expect((await login(t.client('10.0.6.2'))).statusCode).toBe(401);
    expect((await login(t.client('10.0.6.3'), 'brand new pass 4')).statusCode).toBe(200);
  });
});

describe('recovery code', () => {
  it('resets the password, issues a new code and ends existing sessions', async () => {
    const t = await setup();
    const c = t.client('10.0.7.1');
    const res = await c.post('/api/auth/recovery', {
      loginName: 'admin',
      recoveryCode: t.recoveryCode.toLowerCase().replaceAll('-', ' '),
      newPassword: 'recovered pass 5',
    });
    expect(res.statusCode).toBe(200);
    const next = res.json<{ recoveryCode: string; user: Me }>();
    expect(next.recoveryCode).not.toBe(t.recoveryCode);
    expect((await c.get('/api/me')).statusCode).toBe(200);
    expect((await t.admin.get('/api/me')).statusCode).toBe(401);
    expect((await login(t.client('10.0.7.2'), 'recovered pass 5')).statusCode).toBe(200);

    const reused = await t.client('10.0.7.3').post('/api/auth/recovery', {
      loginName: 'admin',
      recoveryCode: t.recoveryCode,
      newPassword: 'whatever pass 6',
    });
    expect(reused.statusCode).toBe(401);
    expect(code(reused)).toBe('invalid_credentials');
  });

  it('regenerating replaces the previous code', async () => {
    const t = await setup();
    const fresh = (await t.admin.post('/api/me/recovery-code')).json<{ recoveryCode: string }>();
    const old = await t.client('10.0.8.1').post('/api/auth/recovery', {
      loginName: 'admin',
      recoveryCode: t.recoveryCode,
      newPassword: 'whatever pass 7',
    });
    expect(old.statusCode).toBe(401);
    const ok = await t.client('10.0.8.2').post('/api/auth/recovery', {
      loginName: 'admin',
      recoveryCode: fresh.recoveryCode,
      newPassword: 'whatever pass 7',
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('disabled users', () => {
  it('cannot use existing sessions', async () => {
    const t = await setup();
    t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.loginName, 'admin')).run();
    expect((await t.admin.get('/api/me')).statusCode).toBe(401);
    expect((await login(t.client('10.0.9.1'))).statusCode).toBe(401);
  });
});
