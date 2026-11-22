import { buildApp } from './app.ts';
import { startBackupScheduler } from './backup/scheduler.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { openDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { seedDefaultCategories } from './db/seed.ts';

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

const app = await buildApp({ config, db });
app.log.info(
  { version: config.app.version, dbFile: config.dbFile, seededCategories: seeded },
  'database ready',
);

const backups = config.backup.enabled
  ? startBackupScheduler({
      sqlite,
      dir: config.backupDir,
      time: config.backup.time,
      retentionDays: config.backup.retentionDays,
      logger: app.log,
    })
  : null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  backups?.stop();
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
