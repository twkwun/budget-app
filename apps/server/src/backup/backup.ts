import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^budget-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite$/;
const PARTIAL_SUFFIX = '.partial';

export interface BackupFile {
  name: string;
  file: string;
  /** When the backup was taken (from the file name, UTC). */
  takenAt: Date;
}

export interface BackupResult {
  file: string;
  bytes: number;
  durationMs: number;
}

/** `budget-20261122T190000Z.sqlite` — UTC, sortable, parseable without trusting mtime. */
export function backupFileName(at: Date): string {
  const iso = at.toISOString(); // 2026-11-22T19:00:00.000Z
  const compact = iso.slice(0, 19).replaceAll('-', '').replaceAll(':', '');
  return `budget-${compact}Z.sqlite`;
}

export function parseBackupFileName(name: string): Date | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export async function listBackups(dir: string): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const backups: BackupFile[] = [];
  for (const name of names) {
    const takenAt = parseBackupFileName(name);
    if (takenAt) backups.push({ name, file: path.join(dir, name), takenAt });
  }
  return backups.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
}

/**
 * Copy the live database with SQLite's online backup API (safe while the app
 * keeps writing), verify the copy, and atomically move it into place. The copy
 * is switched to rollback-journal mode so it is a single self-contained file.
 */
export async function createBackup(
  sqlite: Database.Database,
  dir: string,
  now: Date = new Date(),
): Promise<BackupResult> {
  const started = performance.now();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, backupFileName(now));
  const partial = file + PARTIAL_SUFFIX;
  try {
    await sqlite.backup(partial);
    const copy = new Database(partial);
    try {
      copy.pragma('journal_mode = DELETE');
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`Backup integrity check failed: ${String(check)}`);
    } finally {
      copy.close();
    }
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const { size } = await stat(file);
  return { file, bytes: size, durationMs: Math.round(performance.now() - started) };
}

/**
 * Delete backups older than `retentionDays` (by the timestamp in the name), and
 * leftover partial files from interrupted runs. Returns deleted file names.
 * The newest backup is always kept, even if it is old, so a long outage never
 * leaves the folder empty.
 */
export async function pruneBackups(
  dir: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const backups = await listBackups(dir);
  const newest = backups.at(-1);
  const deleted: string[] = [];
  for (const backup of backups) {
    if (backup !== newest && backup.takenAt.getTime() < cutoff) {
      await rm(backup.file, { force: true });
      deleted.push(backup.name);
    }
  }
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue;
    const full = path.join(dir, name);
    const { mtimeMs } = await stat(full);
    if (now.getTime() - mtimeMs > DAY_MS) {
      await rm(full, { force: true });
      deleted.push(name);
    }
  }
  return deleted;
}
