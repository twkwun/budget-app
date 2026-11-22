import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** True if the built web app is present in `dir`. */
export function hasWebBuild(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html'));
}

/**
 * Serve the built SPA. Hashed files under /assets are cached forever; anything
 * else (index.html, sw.js, manifest) must revalidate so updates reach
 * installed PWAs. Unknown paths fall back to index.html via the not-found
 * handler in app.ts, which keeps /api/* 404s as JSON.
 */
export async function registerWebApp(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
    cacheControl: false,
    setHeaders(res, filePath) {
      const rel = path.relative(root, filePath).split(path.sep).join('/');
      res.header(
        'cache-control',
        rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}
