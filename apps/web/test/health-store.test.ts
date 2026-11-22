import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '@budget/shared';
import { activeTabFor, MORE_ITEMS, NAV_ITEMS } from '../src/nav.ts';
import { useHealthStore } from '../src/stores/health.ts';

const okBody: HealthResponse = {
  status: 'ok',
  version: '0.1.0',
  commit: null,
  time: '2026-11-22T00:00:00.000Z',
  uptimeSeconds: 1,
  db: { status: 'ok', journalMode: 'wal' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('health store', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  it('goes online when the server and database are healthy', async () => {
    const fetchMock = vi.fn(async (_input: string) => jsonResponse(okBody));
    vi.stubGlobal('fetch', fetchMock);
    const store = useHealthStore();
    await Promise.all([store.check(), store.check()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/health');
    expect(store.state).toBe('online');
    expect(store.health?.version).toBe('0.1.0');
    expect(store.checkedAt).toBeInstanceOf(Date);
  });

  it('reports degraded on a 503 health body', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ ...okBody, status: 'degraded', db: { status: 'error' } }, 503),
    );
    const store = useHealthStore();
    await store.check();
    expect(store.state).toBe('degraded');
  });

  it('reports offline on network errors or non-JSON responses', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const store = useHealthStore();
    await store.check();
    expect(store.state).toBe('offline');
    expect(store.health).toBeNull();

    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 502 }));
    await store.check();
    expect(store.state).toBe('offline');
  });
});

describe('navigation', () => {
  it('lists every DESIGN.md screen once', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      '홈',
      '내역',
      '인박스',
      '추가',
      '가져오기',
      '통계',
      '설정',
    ]);
    expect(MORE_ITEMS.map((i) => i.label)).toEqual(['가져오기', '통계', '설정']);
  });

  it('highlights 더보기 for screens that are not tabs', () => {
    expect(activeTabFor('home')).toBe('home');
    expect(activeTabFor('stats')).toBe('more');
    expect(activeTabFor('more')).toBe('more');
    expect(activeTabFor('not-found')).toBe('');
  });
});
