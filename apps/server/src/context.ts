import { ChallengeStore } from './auth/challenges.ts';
import { PasswordHasher, type ScryptParams } from './auth/password.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionService } from './auth/sessions.ts';
import type { Config } from './config.ts';
import type { AppDatabase } from './db/client.ts';

/** Shared services handed to route plugins. */
export interface AppContext {
  config: Config;
  db: AppDatabase;
  now: () => number;
  hasher: PasswordHasher;
  sessions: SessionService;
  challenges: ChallengeStore;
  limits: {
    /** Every auth entry point, keyed by client IP. */
    authByIp: RateLimiter;
    /** Password and recovery attempts, keyed by login name. */
    byLoginName: RateLimiter;
    /** SMS webhook, keyed by client IP (also counts bad tokens). */
    webhookByIp: RateLimiter;
    /** SMS webhook, keyed by token id. */
    webhookByToken: RateLimiter;
    /** File uploads, keyed by user. */
    importsByUser: RateLimiter;
  };
  webauthn: {
    rpName: string;
    rpID: string;
    origin: string;
  };
}

export interface ContextOptions {
  config: Config;
  db: AppDatabase;
  now?: () => number;
  passwordParams?: ScryptParams;
}

export function createContext(options: ContextOptions): AppContext {
  const now = options.now ?? Date.now;
  const { config } = options;
  return {
    config,
    db: options.db,
    now,
    hasher: new PasswordHasher(options.passwordParams),
    sessions: new SessionService(options.db, config.publicOrigin, now),
    challenges: new ChallengeStore(now),
    limits: {
      authByIp: new RateLimiter(30, 5 * 60 * 1000, now),
      byLoginName: new RateLimiter(10, 15 * 60 * 1000, now),
      webhookByIp: new RateLimiter(120, 10 * 60 * 1000, now),
      webhookByToken: new RateLimiter(60, 10 * 60 * 1000, now),
      importsByUser: new RateLimiter(20, 10 * 60 * 1000, now),
    },
    webauthn: {
      rpName: '가계부',
      rpID: new URL(config.publicOrigin).hostname,
      origin: config.publicOrigin,
    },
  };
}
