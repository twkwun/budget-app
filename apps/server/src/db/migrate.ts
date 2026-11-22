import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { AppDatabase } from './client.ts';

/** `apps/server/drizzle`, resolved the same way from src/ and dist/. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function runMigrations(db: AppDatabase, migrationsFolder = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder });
}
