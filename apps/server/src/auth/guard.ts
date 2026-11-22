import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { errors } from '../http/errors.ts';
import type { ResolvedSession } from './sessions.ts';

/**
 * Per-route access level, set with `config: { auth: ... }`.
 * - `session` (default when omitted): signed in and unlocked.
 * - `session-locked-ok`: signed in; also allowed while the app is locked (unlock, lock, logout).
 * - `public`: no session needed (health, sign-in entry points).
 */
export type AuthMode = 'session' | 'session-locked-ok' | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthMode;
    /** Set false only for machine clients that cannot send Origin (e.g. future SMS webhook). */
    checkOrigin?: boolean;
  }
  interface FastifyRequest {
    auth: ResolvedSession | null;
  }
}

export interface RouteAccess {
  method: string;
  url: string;
  auth: AuthMode;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Session resolution, default-deny access control and Origin checks for every /api route. */
export function registerAuthGuard(
  api: FastifyInstance,
  ctx: AppContext,
  routes: RouteAccess[] = [],
): void {
  api.decorateRequest('auth', null);
  // Record each route's effective access level (used by tests to audit public routes).
  api.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({ method, url: route.url, auth: route.config?.auth ?? 'session' });
    }
  });

  api.addHook('onRequest', async (request) => {
    const routeConfig = request.routeOptions.config;

    if (!SAFE_METHODS.has(request.method) && routeConfig.checkOrigin !== false) {
      // Browsers always send Origin on POST/PATCH/DELETE; anything else is refused.
      if (request.headers.origin !== ctx.config.publicOrigin) throw errors.invalidOrigin();
    }

    const token = ctx.sessions.tokenFromCookieHeader(request.headers.cookie);
    request.auth = token ? ctx.sessions.resolve(token) : null;

    const mode = routeConfig.auth ?? 'session';
    if (mode === 'public') return;
    if (!request.auth) throw errors.unauthenticated();
    if (request.auth.locked) {
      if (mode !== 'session-locked-ok') throw errors.locked();
      return;
    }
    if (mode === 'session') ctx.sessions.touch(request.auth.session, request.ip);
  });
}

/** The signed-in session for a protected route (guaranteed by the guard). */
export function currentAuth(request: FastifyRequest): ResolvedSession {
  if (!request.auth) throw errors.unauthenticated();
  return request.auth;
}

/** preHandler: admins only. */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (currentAuth(request).user.role !== 'admin') throw errors.forbidden('Admins only');
}

/**
 * preHandler factory for 민감 작업 재확인: requires a passkey or password check
 * within REAUTH_WINDOW_MS, otherwise answers `reauth_required` so the client
 * can verify (POST /api/auth/verify/...) and retry.
 */
export function requireRecentVerification(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!ctx.sessions.isRecentlyVerified(currentAuth(request).session)) {
      throw errors.reauthRequired();
    }
  };
}

/** Throws 429 if any of the keyed limiters is exhausted. */
export function enforceRateLimit(
  ctx: AppContext,
  request: FastifyRequest,
  loginName?: string,
): void {
  const byIp = ctx.limits.authByIp.hit(`ip:${request.ip}`);
  if (!byIp.allowed) throw errors.rateLimited(byIp.retryAfterSeconds);
  if (loginName !== undefined) {
    const byName = ctx.limits.byLoginName.hit(`name:${loginName}`);
    if (!byName.allowed) throw errors.rateLimited(byName.retryAfterSeconds);
  }
}
