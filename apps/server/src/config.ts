import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readPackageVersion, type AppVersion } from './version.ts';

/** Placeholder used only outside production so that `pnpm dev` works without a .env file. */
export const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-0000000000';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().min(1).default('./data'),
    SESSION_SECRET: z.string().optional(),
    PUBLIC_ORIGIN: z.string().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEB_DIST_DIR: z.string().min(1).optional(),
    TRUST_PROXY: z.stringbool().default(false),
    BACKUP_ENABLED: z.stringbool().default(true),
    BACKUP_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h, Asia/Seoul)')
      .default('04:00'),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    APP_VERSION: z.string().min(1).optional(),
    APP_COMMIT: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';

    if (env.SESSION_SECRET !== undefined || production) {
      const secret = env.SESSION_SECRET ?? '';
      if (secret.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'must be at least 32 characters (generate with `openssl rand -base64 48`)',
        });
      } else if (production && secret === DEV_SESSION_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_SECRET'],
          message: 'must not be the development placeholder in production',
        });
      }
    }

    if (env.PUBLIC_ORIGIN === undefined) {
      if (production) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_ORIGIN'],
          message: 'is required in production, e.g. https://budget.example-tailnet.ts.net',
        });
      }
      return;
    }
    let url: URL;
    try {
      url = new URL(env.PUBLIC_ORIGIN);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be a URL' });
      return;
    }
    if (url.origin !== env.PUBLIC_ORIGIN.replace(/\/$/, '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_ORIGIN'],
        message: 'must be an origin only (scheme://host[:port]) without a path',
      });
    } else if (url.protocol !== 'https:' && !LOCAL_HOSTNAMES.has(url.hostname)) {
      // Passkeys and PWA installation both require a secure context.
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_ORIGIN'],
        message: 'must use https unless the host is localhost',
      });
    }
  });

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  sessionSecret: string;
  publicOrigin: string;
  logLevel: LogLevel;
  /**
   * Trust X-Forwarded-For from the reverse proxy (the Tailscale sidecar) for the
   * client IP. Only enable when the app port is reachable solely via that proxy.
   */
  trustProxy: boolean;
  /** Directory with the built web app; served only if it contains index.html. */
  webDistDir: string;
  backup: {
    enabled: boolean;
    /** Local time of day in the household zone, HH:MM. */
    time: string;
    retentionDays: number;
  };
  app: AppVersion;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const defaultWebDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** Parse and validate configuration from environment variables. Throws ConfigError. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  // Treat empty strings as unset so that `FOO=` in a .env file means "use the default".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = result.data;
  const dataDir = path.resolve(cwd, env.DATA_DIR);
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    dataDir,
    dbFile: path.join(dataDir, 'budget.sqlite'),
    backupDir: path.join(dataDir, 'backups'),
    sessionSecret: env.SESSION_SECRET ?? DEV_SESSION_SECRET,
    publicOrigin: (env.PUBLIC_ORIGIN ?? `http://localhost:5173`).replace(/\/$/, ''),
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    webDistDir: env.WEB_DIST_DIR ? path.resolve(cwd, env.WEB_DIST_DIR) : defaultWebDistDir,
    backup: {
      enabled: env.BACKUP_ENABLED,
      time: env.BACKUP_TIME,
      retentionDays: env.BACKUP_RETENTION_DAYS,
    },
    app: {
      version: env.APP_VERSION ?? readPackageVersion(),
      commit: env.APP_COMMIT ?? null,
    },
  };
}
