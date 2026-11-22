import type Database from 'better-sqlite3';
import {
  HOUSEHOLD_TIME_ZONE,
  addDays,
  parseLocalDate,
  toLocalDate,
  zonedTimeToUtc,
} from '@budget/shared';
import type { Logger } from '../logger.ts';
import { createBackup, listBackups, pruneBackups, type BackupResult } from './backup.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Next instant (epoch ms, strictly after `now`) at local `HH:MM` in the zone. */
export function nextRunAt(
  now: number,
  time: string,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  let date = toLocalDate(now, timeZone);
  for (let i = 0; i < 3; i += 1) {
    const candidate = zonedTimeToUtc({ ...parseLocalDate(date), hour, minute }, timeZone);
    if (candidate > now) return candidate;
    date = addDays(date, 1);
  }
  throw new Error('Could not compute next backup time');
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface BackupSchedulerOptions {
  sqlite: Database.Database;
  dir: string;
  /** Local `HH:MM` in the household zone. */
  time: string;
  retentionDays: number;
  logger: Logger;
  /** Run once at start if the newest backup is older than a day (e.g. after the NAS was off). */
  catchUp?: boolean;
  /** Injection points for tests. */
  now?: () => number;
  timers?: TimerApi;
}

export interface BackupScheduler {
  /** Take a backup and prune old ones now. Concurrent calls share one run. */
  runNow(): Promise<BackupResult | null>;
  /** Epoch ms of the next scheduled run, or null once stopped. */
  nextRun(): number | null;
  stop(): void;
}

export function startBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const { logger } = options;
  let handle: unknown = null;
  let next: number | null = null;
  let running: Promise<BackupResult | null> | null = null;
  let stopped = false;

  const run = async (): Promise<BackupResult | null> => {
    try {
      const at = new Date(now());
      const result = await createBackup(options.sqlite, options.dir, at);
      const deleted = await pruneBackups(options.dir, options.retentionDays, at);
      logger.info({ ...result, pruned: deleted }, 'database backup completed');
      return result;
    } catch (error) {
      logger.error({ err: error }, 'database backup failed');
      return null;
    }
  };

  const runNow = (): Promise<BackupResult | null> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (): void => {
    if (stopped) return;
    const current = now();
    next = nextRunAt(current, options.time);
    handle = timers.setTimeout(
      () => {
        void runNow().finally(schedule);
      },
      Math.max(0, next - current),
    );
    logger.info({ nextRun: new Date(next).toISOString() }, 'next database backup scheduled');
  };

  schedule();

  if (options.catchUp ?? true) {
    void listBackups(options.dir).then((backups) => {
      const newest = backups.at(-1);
      if (!stopped && (!newest || now() - newest.takenAt.getTime() > DAY_MS)) {
        logger.info({}, 'no backup in the last 24h; running one now');
        void runNow();
      }
    });
  }

  return {
    runNow,
    nextRun: () => next,
    stop: () => {
      stopped = true;
      next = null;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
