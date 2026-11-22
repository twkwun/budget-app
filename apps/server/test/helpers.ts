import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, type OpenedDatabase } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

export function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', DATA_DIR: tempDir(), LOG_LEVEL: 'silent', ...env });
}

/** A migrated database in a fresh temp directory, closed after the test. */
export function migratedDatabase(dir = tempDir()): OpenedDatabase {
  const opened = openDatabase(path.join(dir, 'budget.sqlite'));
  cleanups.unshift(() => {
    if (opened.sqlite.open) opened.sqlite.close();
  });
  runMigrations(opened.db);
  return opened;
}
