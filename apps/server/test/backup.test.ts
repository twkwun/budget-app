import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  createBackup,
  listBackups,
  parseBackupFileName,
  pruneBackups,
} from '../src/backup/backup.ts';
import { nextRunAt, startBackupScheduler, type TimerApi } from '../src/backup/scheduler.ts';
import { users } from '../src/db/schema.ts';
import type { Logger } from '../src/logger.ts';
import { migratedDatabase, tempDir } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe('backup file names', () => {
  it('round-trips a UTC timestamp', () => {
    const at = new Date('2026-11-22T19:00:05.678Z');
    expect(backupFileName(at)).toBe('budget-20261122T190005Z.sqlite');
    expect(parseBackupFileName(backupFileName(at))?.toISOString()).toBe('2026-11-22T19:00:05.000Z');
    expect(parseBackupFileName('budget.sqlite')).toBeNull();
    expect(parseBackupFileName('budget-20261122T190005Z.sqlite.partial')).toBeNull();
  });
});

describe('createBackup', () => {
  it('writes a consistent standalone copy while the database is in use', async () => {
    const { db, sqlite } = migratedDatabase();
    db.insert(users).values({ loginName: 'a', displayName: '가' }).run();
    const dir = path.join(tempDir(), 'backups');
    const result = await createBackup(sqlite, dir, new Date('2026-11-22T19:00:00Z'));

    expect(path.basename(result.file)).toBe('budget-20261122T190000Z.sqlite');
    expect(result.bytes).toBeGreaterThan(0);
    expect(readdirSync(dir)).toEqual(['budget-20261122T190000Z.sqlite']);

    const copy = new Database(result.file, { readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(copy.prepare('select login_name from users').pluck().all()).toEqual(['a']);
    } finally {
      copy.close();
    }
  });
});

describe('pruneBackups', () => {
  it('keeps the last 30 days and removes older backups and stale partials', async () => {
    const dir = tempDir();
    const now = new Date('2026-11-22T19:00:00Z');
    // One backup per day for 40 days, as the daily job would leave them.
    for (let age = 0; age < 40; age += 1) {
      writeFileSync(path.join(dir, backupFileName(new Date(now.getTime() - age * DAY))), '');
    }
    writeFileSync(path.join(dir, 'unrelated.txt'), '');
    const stale = path.join(dir, 'budget-20200101T000000Z.sqlite.partial');
    writeFileSync(stale, '');
    utimesSync(stale, new Date('2020-01-01'), new Date('2020-01-01'));

    const deleted = await pruneBackups(dir, 30, now);

    const remaining = await listBackups(dir);
    expect(remaining).toHaveLength(31); // ages 0..30 days inclusive
    expect(remaining[0]?.takenAt.toISOString()).toBe('2026-10-23T19:00:00.000Z');
    expect(deleted).toHaveLength(10);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(dir, 'unrelated.txt'))).toBe(true);
  });

  it('never deletes the newest backup', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, backupFileName(new Date('2025-01-01T00:00:00Z'))), '');
    writeFileSync(path.join(dir, backupFileName(new Date('2025-01-02T00:00:00Z'))), '');
    const deleted = await pruneBackups(dir, 30, new Date('2026-11-22T00:00:00Z'));
    expect(deleted).toEqual(['budget-20250101T000000Z.sqlite']);
    expect(await listBackups(dir)).toHaveLength(1);
  });
});

describe('nextRunAt (Asia/Seoul)', () => {
  it('schedules later the same local day', () => {
    // 2026-11-22 02:00 KST -> 04:00 KST the same day.
    expect(new Date(nextRunAt(Date.parse('2026-11-21T17:00:00Z'), '04:00')).toISOString()).toBe(
      '2026-11-21T19:00:00.000Z',
    );
  });

  it('rolls to the next local day once the time has passed', () => {
    // 2026-11-22 04:00 KST exactly -> next day.
    expect(new Date(nextRunAt(Date.parse('2026-11-21T19:00:00Z'), '04:00')).toISOString()).toBe(
      '2026-11-22T19:00:00.000Z',
    );
    // 23:30 KST on the last day of the year -> 04:00 KST on Jan 1.
    expect(new Date(nextRunAt(Date.parse('2026-12-31T14:30:00Z'), '04:00')).toISOString()).toBe(
      '2026-12-31T19:00:00.000Z',
    );
  });
});

class FakeTimers implements TimerApi {
  pending: { fn: () => void; ms: number }[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fn, ms };
    this.pending.push(entry);
    return entry;
  }
  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p !== handle);
  }
  fire(): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no timer pending');
    next.fn();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error('condition not met');
}

describe('startBackupScheduler', () => {
  it('runs daily at the configured local time and prunes, without waiting a day', async () => {
    const { sqlite } = migratedDatabase();
    const dir = path.join(tempDir(), 'backups');
    let clock = Date.parse('2026-11-21T18:30:00Z'); // 03:30 KST
    const timers = new FakeTimers();
    const scheduler = startBackupScheduler({
      sqlite,
      dir,
      time: '04:00',
      retentionDays: 2,
      logger: silent,
      catchUp: false,
      now: () => clock,
      timers,
    });

    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0]?.ms).toBe(30 * 60 * 1000);

    for (let day = 0; day < 4; day += 1) {
      clock = scheduler.nextRun()!;
      timers.fire();
      await until(() => timers.pending.length === 1);
      expect(timers.pending[0]?.ms).toBe(DAY);
    }

    const names = (await listBackups(dir)).map((b) => b.name);
    expect(names).toEqual([
      'budget-20261122T190000Z.sqlite',
      'budget-20261123T190000Z.sqlite',
      'budget-20261124T190000Z.sqlite',
    ]);
    scheduler.stop();
    expect(timers.pending).toHaveLength(0);
    expect(scheduler.nextRun()).toBeNull();
  });

  it('catches up at startup when the newest backup is over a day old', async () => {
    const { sqlite } = migratedDatabase();
    const dir = path.join(tempDir(), 'backups');
    const clock = Date.parse('2026-11-22T10:00:00Z');
    const scheduler = startBackupScheduler({
      sqlite,
      dir,
      time: '04:00',
      retentionDays: 30,
      logger: silent,
      now: () => clock,
      timers: new FakeTimers(),
    });
    await until(() => existsSync(dir) && readdirSync(dir).some((n) => n.endsWith('Z.sqlite')));
    expect(await listBackups(dir)).toHaveLength(1);
    scheduler.stop();
  });

  it('logs instead of throwing when a backup fails', async () => {
    const { sqlite } = migratedDatabase();
    const errors: object[] = [];
    const scheduler = startBackupScheduler({
      sqlite,
      dir: path.join(tempDir(), 'backups'),
      time: '04:00',
      retentionDays: 30,
      logger: { ...silent, error: (obj) => errors.push(obj) },
      catchUp: false,
      timers: new FakeTimers(),
    });
    sqlite.close();
    await expect(scheduler.runNow()).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    scheduler.stop();
  });
});
