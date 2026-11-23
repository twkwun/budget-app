import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setAuthHandlers } from '../src/api/client.ts';
import { describeUserAgent } from '../src/auth/format.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const err = (code: string, status: number) => json({ error: { code, message: code } }, status);

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthHandlers(null);
});

function handlers(overrides: Partial<Parameters<typeof setAuthHandlers>[0] & object> = {}) {
  const h = {
    onUnauthenticated: vi.fn(),
    onLocked: vi.fn(async () => true),
    onReauthRequired: vi.fn(async () => true),
    ...overrides,
  };
  setAuthHandlers(h);
  return h;
}

describe('api client', () => {
  it('sends JSON with credentials and returns the body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/x', { a: 1 })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
  });

  it('waits for unlock and retries a request that hit the lock', async () => {
    const h = handlers();
    const responses = [err('session_locked', 423), json({ ok: 2 })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    await expect(api.get('/me')).resolves.toEqual({ ok: 2 });
    expect(h.onLocked).toHaveBeenCalledOnce();
  });

  it('re-verifies and retries once on reauth_required, or gives up when cancelled', async () => {
    const h = handlers();
    const responses = [err('reauth_required', 403), json({ ok: 3 })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    );
    await expect(api.post('/me/recovery-code')).resolves.toEqual({ ok: 3 });
    expect(h.onReauthRequired).toHaveBeenCalledOnce();

    handlers({ onReauthRequired: vi.fn(async () => false) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err('reauth_required', 403)),
    );
    await expect(api.post('/me/recovery-code')).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('reports sign-out and rethrows on unauthenticated', async () => {
    const h = handlers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err('unauthenticated', 401)),
    );
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiError);
    expect(h.onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('skips the handlers for raw requests and maps network failures', async () => {
    const h = handlers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err('session_locked', 423)),
    );
    await expect(api.get('/auth/session', { raw: true })).rejects.toMatchObject({
      code: 'session_locked',
    });
    expect(h.onLocked).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(api.post('/auth/lock')).resolves.toBeUndefined();
  });
});

describe('describeUserAgent', () => {
  it('names common devices', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('아이폰 · Safari');
    expect(describeUserAgent(null)).toBe('알 수 없는 기기');
  });
});

describe('biometricName', () => {
  it('names the platform authenticator', async () => {
    const { biometricName, withRo } = await import('../src/auth/platform.ts');
    expect(biometricName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(
      'Face ID',
    );
    expect(biometricName('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5)).toBe('Face ID');
    expect(biometricName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('Face ID'); // iPadOS desktop UA
    expect(biometricName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('Touch ID');
    expect(biometricName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe('Windows Hello');
    expect(biometricName('Mozilla/5.0 (X11; Linux x86_64)', 0)).toBe('패스키');
    expect(withRo('패스키')).toBe('패스키로');
    expect(withRo('Face ID')).toBe('Face ID로');
  });
});
