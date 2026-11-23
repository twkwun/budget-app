import { buildApp } from './app.ts';
import { startBackupScheduler, type BackupScheduler } from './backup/scheduler.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { seedDefaultCategories } from './db/seed.ts';
import { deleteExpiredPreviews } from './importer/service.ts';
import { backfillMerchantKeys, seedKeywordRules } from './ledger/categorize.ts';
import { refreshSuggestions } from './planning/recurring.ts';

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const { db, sqlite } = openDatabase(config.dbFile);
runMigrations(db);
const seeded = seedDefaultCategories(db);
seedKeywordRules(db);
backfillMerchantKeys(db);

let backups: BackupScheduler | null = null;
const app = await buildApp({ config, db, backups: () => backups });
app.log.info(
  { version: config.app.version, dbFile: config.dbFile, seededCategories: seeded },
  'database ready',
);

backups = config.backup.enabled
  ? startBackupScheduler({
      sqlite,
      dir: config.backupDir,
      time: config.backup.time,
      retentionDays: config.backup.retentionDays,
      logger: app.log,
    })
  : null;

// Hourly: delete previews not applied within a day, and look for new 고정지출 candidates.
const sweepImports = () => {
  try {
    const n = deleteExpiredPreviews(db, Date.now());
    if (n) app.log.info({ deleted: n }, 'expired import previews deleted');
  } catch (error) {
    app.log.error({ err: error }, 'import preview cleanup failed');
  }
  try {
    const n = refreshSuggestions(db, Date.now());
    if (n) app.log.info({ added: n }, 'new recurring expense suggestions');
  } catch (error) {
    app.log.error({ err: error }, 'recurring detection failed');
  }
};
sweepImports();
const importSweeper = setInterval(sweepImports, 60 * 60 * 1000);
importSweeper.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  backups?.stop();
  clearInterval(importSweeper);
  try {
    await app.close();
  } finally {
    sqlite.close();
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  sqlite.close();
  process.exit(1);
}
