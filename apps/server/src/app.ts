import path from 'node:path';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { ApiErrorBody, ApiErrorCode } from '@budget/shared';
import { registerAuthGuard, type RouteAccess } from './auth/guard.ts';
import type { ScryptParams } from './auth/password.ts';
import type { Config } from './config.ts';
import { createContext } from './context.ts';
import type { AppDatabase } from './db/client.ts';
import { HttpError } from './http/errors.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
import { categoryRoutes } from './routes/categories.ts';
import { healthRoutes } from './routes/health.ts';
import { importRoutes } from './routes/imports.ts';
import { inboxRoutes } from './routes/inbox.ts';
import { meRoutes } from './routes/me.ts';
import { memberRoutes } from './routes/members.ts';
import { passkeyRoutes } from './routes/passkeys.ts';
import { ruleRoutes } from './routes/rules.ts';
import { setupRoutes } from './routes/setup.ts';
import { transactionRoutes } from './routes/transactions.ts';
import { webhookRoutes } from './routes/webhook.ts';
import { hasWebBuild, registerWebApp } from './static.ts';

export interface BuildAppOptions {
  config: Config;
  db: AppDatabase;
  logger?: FastifyServerOptions['logger'];
  /** Clock override for tests. */
  now?: () => number;
  /** Password hashing cost override for tests. */
  passwordParams?: ScryptParams;
  /** Filled with every /api route and its access level once the app is built. */
  routeAccess?: RouteAccess[];
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/**
 * Path of a raw request URL, percent-decoded (repeatedly, to undo double
 * encoding), with backslashes and repeated slashes folded and lowercased.
 * Used only to classify requests, never to route them.
 */
export function canonicalPath(url: string): string {
  let pathname = url.split(/[?#]/, 1)[0] ?? '';
  for (let i = 0; i < 3; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      break;
    }
    if (decoded === pathname) break;
    pathname = decoded;
  }
  return pathname
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/** True for /api and anything below it, however it is encoded. */
export function isApiPath(url: string): boolean {
  const pathname = canonicalPath(url);
  return pathname === '/api' || pathname.startsWith('/api/');
}

function apiError(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = options;
  const ctx = createContext({
    config,
    db,
    now: options.now,
    passwordParams: options.passwordParams,
  });
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  app.setErrorHandler<FastifyError | HttpError>((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .headers(error.headers)
        .send(apiError(error.code, error.message));
    }
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // The static file server refuses odd paths such as `//api/x` or `/api%5cx`
    // with 403; anything that looks like an API path gets the API's 404 instead.
    if ((status === 403 || status === 404) && isApiPath(request.url)) {
      return reply.code(404).send(apiError('not_found', 'Route not found'));
    }
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send(apiError('internal_error', 'Internal server error'));
    }
    const code: ApiErrorCode = error.validation || status === 400 ? 'validation_error' : 'error';
    return reply.code(status).send(apiError(code, error.message));
  });

  await app.register(
    async (api) => {
      // Every /api route requires an unlocked session unless it opts out.
      registerAuthGuard(api, ctx, options.routeAccess);
      await api.register(healthRoutes, { db, app: config.app });
      await api.register(setupRoutes(ctx));
      await api.register(authRoutes(ctx), { prefix: '/auth' });
      await api.register(meRoutes(ctx));
      await api.register(passkeyRoutes(ctx));
      await api.register(memberRoutes(ctx));
      await api.register(accountRoutes(ctx));
      await api.register(categoryRoutes(ctx));
      await api.register(transactionRoutes(ctx));
      await api.register(ruleRoutes(ctx));
      await api.register(inboxRoutes(ctx));
      await api.register(webhookRoutes(ctx));
      await api.register(importRoutes(ctx));
    },
    { prefix: '/api' },
  );

  const serveWeb = hasWebBuild(config.webDistDir);
  if (serveWeb) {
    await registerWebApp(app, config.webDistDir);
    app.log.info({ dir: config.webDistDir }, 'serving web app');
  } else {
    app.log.info({ dir: config.webDistDir }, 'web build not found; serving API only');
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = canonicalPath(request.url);
    const isPageRequest =
      serveWeb &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !isApiPath(request.url) &&
      // A missing file (e.g. /assets/old-hash.js) is a real 404, not a page.
      !path.posix.basename(pathname).includes('.');
    if (isPageRequest) {
      return reply.header('cache-control', 'no-cache').type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .send(
        apiError('not_found', `Route ${request.method} ${request.url.split('?', 1)[0]} not found`),
      );
  });

  return app;
}
