import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { TEST_SCRYPT_PARAMS } from '../../src/auth/password.ts';
import { buildApp } from '../../src/app.ts';
import type { RouteAccess } from '../../src/auth/guard.ts';
import { seedDefaultCategories } from '../../src/db/seed.ts';
import { migratedDatabase, testConfig } from '../helpers.ts';

export const ORIGIN = 'http://localhost:5173';

export class Clock {
  t = Date.parse('2026-11-22T12:00:00Z');
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Fastify inject wrapper with a cookie jar and the browser's Origin header. */
export class TestClient {
  private cookie: string | null = null;
  ip: string;
  origin: string | null = ORIGIN;
  private readonly app: FastifyInstance;

  constructor(app: FastifyInstance, ip = '10.0.0.1') {
    this.app = app;
    this.ip = ip;
  }

  withOrigin(origin: string | null): this {
    this.origin = origin;
    return this;
  }

  get hasCookie(): boolean {
    return this.cookie !== null;
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && this.origin) headers.origin = this.origin;
    const res = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(body !== undefined && { payload: body as object }),
    });
    const setCookie = res.headers['set-cookie'];
    const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (value) {
      const [pair] = value.split(';');
      const [name, val] = (pair ?? '').split('=');
      this.cookie = /Max-Age=0/.test(value) || !val ? null : `${name}=${val}`;
    }
    return res;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}) => this.request('POST', url, body);
  patch = (url: string, body: unknown) => this.request('PATCH', url, body);
  put = (url: string, body: unknown) => this.request('PUT', url, body);
  delete = (url: string) => this.request('DELETE', url);
}

export async function startTestApp(env: Record<string, string> = {}) {
  const clock = new Clock();
  const config = testConfig({ PUBLIC_ORIGIN: ORIGIN, ...env });
  const { db, sqlite } = migratedDatabase(config.dataDir);
  seedDefaultCategories(db);
  const routeAccess: RouteAccess[] = [];
  const app = await buildApp({
    routeAccess,
    config,
    db,
    logger: false,
    now: clock.now,
    passwordParams: TEST_SCRYPT_PARAMS,
  });
  await app.ready();
  return {
    app,
    db,
    sqlite,
    clock,
    config,
    routeAccess,
    client: (ip?: string) => new TestClient(app, ip),
  };
}

export const ADMIN = { displayName: '관리자', loginName: 'admin', password: 'correct horse 1' };
export const MEMBER = { displayName: '구성원', loginName: 'member', password: 'battery staple 2' };
