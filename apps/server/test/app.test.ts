import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthResponse } from '@budget/shared';
import { buildApp, isApiPath } from '../src/app.ts';
import { migratedDatabase, tempDir, testConfig } from './helpers.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function webDist(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>가계부</title>');
  writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  return dir;
}

async function start(options: { web?: boolean } = {}) {
  const config = testConfig(options.web ? { WEB_DIST_DIR: webDist() } : {});
  const opened = migratedDatabase(config.dataDir);
  app = await buildApp({ config, db: opened.db, logger: false });
  return { app, ...opened };
}

describe('GET /api/health', () => {
  it('reports version and database status', async () => {
    const { app } = await start();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.db).toEqual({ status: 'ok', journalMode: 'wal' });
    expect(Date.parse(body.time)).not.toBeNaN();
  });

  it('returns 503 when the database is unavailable', async () => {
    const { app, sqlite } = await start();
    sqlite.close();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json<HealthResponse>()).toMatchObject({
      status: 'degraded',
      db: { status: 'error' },
    });
  });

  it('sends security headers', async () => {
    const { app } = await start();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

describe('routing', () => {
  it.each([true, false])('returns JSON 404 for unknown API routes (web build: %s)', async (web) => {
    const { app } = await start({ web });
    for (const url of ['/api/x', '/api/x/y?z=1', '/api']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const post = await app.inject({ method: 'POST', url: '/api/nope', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.headers['content-type']).toContain('application/json');
  });

  it('serves the SPA with fallback for client routes', async () => {
    const { app } = await start({ web: true });
    for (const url of ['/', '/transactions', '/settings/backup?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('가계부');
    }
  });

  it('caches hashed assets and 404s missing files instead of falling back', async () => {
    const { app } = await start({ web: true });
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.headers['cache-control']).toBe('no-cache');
    const missing = await app.inject({ method: 'GET', url: '/assets/app-old.js' });
    expect(missing.statusCode).toBe(404);
  });

  it('does not serve pages without a web build', async () => {
    const { app } = await start({ web: false });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    '/api%2fhealth',
    '/api%2Fhealth',
    '/api%252fhealth',
    '/%61%70%69%2f%68ealth',
    '/API/x',
    '//api/x',
    '/api%5chealth',
    '/api%2f',
  ])('returns JSON 404 for the encoded or odd API path %s', async (url) => {
    const { app } = await start({ web: true });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('routes percent-encoded letters to the real API, never to the SPA', async () => {
    const { app } = await start({ web: true });
    const res = await app.inject({ method: 'GET', url: '/%61pi/health' });
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json<HealthResponse>().status).toBe('ok');
  });

  it('classifies API paths exactly', () => {
    expect(isApiPath('/api%2Fx')).toBe(true);
    expect(isApiPath('/api%zz')).toBe(false);
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/health?x')).toBe(true);
    expect(isApiPath('/api?x')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});
