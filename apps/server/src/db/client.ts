import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenedDatabase {
  db: AppDatabase;
  sqlite: Database.Database;
}

/** Open (creating if needed) the SQLite file with the pragmas the app relies on. */
export function openDatabase(file: string): OpenedDatabase {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) {
    sqlite.close();
    throw new Error('SQLite foreign key enforcement could not be enabled');
  }
  const db = drizzle({ client: sqlite, schema });
  return { db, sqlite };
}
