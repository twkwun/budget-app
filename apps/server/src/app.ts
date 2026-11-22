import path from 'node:path';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { ApiErrorBody } from '@budget/shared';
import type { Config } from './config.ts';
import type { AppDatabase } from './db/client.ts';
import { healthRoutes } from './routes/health.ts';
import { hasWebBuild, registerWebApp } from './static.ts';

export interface BuildAppOptions {
  config: Config;
  db: AppDatabase;
  logger?: FastifyServerOptions['logger'];
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

export function isApiPath(url: string): boolean {
  const pathname = url.split('?', 1)[0] ?? '';
  return pathname === '/api' || pathname.startsWith('/api/');
}

function apiError(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = options;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
  });

  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    const message = status >= 500 ? 'Internal server error' : error.message;
    return reply.code(status).send(apiError(error.code ?? 'error', message));
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, { db, app: config.app });
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
    const pathname = request.url.split('?', 1)[0] ?? '';
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
      .send(apiError('not_found', `Route ${request.method} ${pathname} not found`));
  });

  return app;
}
