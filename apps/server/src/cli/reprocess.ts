/**
 * Re-run the SMS parsers over stored messages that failed or were parsed by
 * an older parser version. Safe to run repeatedly.
 *   pnpm reprocess                                   (development)
 *   docker exec <container> node dist/cli/reprocess.js   (production image)
 */
import { ConfigError, loadConfig } from '../config.ts';
import { openDatabase } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { reprocessRawRecords } from '../sms/ingest.ts';

try {
  const config = loadConfig();
  const { db, sqlite } = openDatabase(config.dbFile);
  try {
    runMigrations(db);
    console.log(JSON.stringify(reprocessRawRecords(db, Date.now())));
  } finally {
    sqlite.close();
  }
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}
