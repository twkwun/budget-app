import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import type { AppVersion } from '../version.ts';

export interface HealthRouteOptions {
  db: AppDatabase;
  app: AppVersion;
}

const startedAt = Date.now();

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (fastify, opts) => {
  fastify.get('/health', async (request, reply) => {
    let db: HealthResponse['db'];
    try {
      opts.db.get(sql`select 1`);
      const journalMode = opts.db.$client.pragma('journal_mode', { simple: true });
      db = { status: 'ok', journalMode: String(journalMode) };
    } catch (error) {
      request.log.error({ err: error }, 'health check database query failed');
      db = { status: 'error', error: 'database unavailable' };
    }
    const body: HealthResponse = {
      status: db.status === 'ok' ? 'ok' : 'degraded',
      version: opts.app.version,
      commit: opts.app.commit,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      db,
    };
    return reply
      .code(db.status === 'ok' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(body);
  });
};
