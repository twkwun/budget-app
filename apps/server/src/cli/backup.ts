/**
 * Take a backup immediately and prune old ones, outside the daily schedule.
 *   pnpm backup                                   (development)
 *   docker exec <container> node dist/cli/backup.js   (production image)
 */
import { existsSync } from 'node:fs';
import { createBackup, pruneBackups } from '../backup/backup.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';

try {
  const config = loadConfig();
  if (!existsSync(config.dbFile)) {
    console.error(`Database not found: ${config.dbFile}`);
    process.exit(1);
  }
  const { sqlite } = openDatabase(config.dbFile);
  try {
    const result = await createBackup(sqlite, config.backupDir);
    const pruned = await pruneBackups(config.backupDir, config.backup.retentionDays);
    console.log(JSON.stringify({ ...result, pruned }));
  } finally {
    sqlite.close();
  }
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
