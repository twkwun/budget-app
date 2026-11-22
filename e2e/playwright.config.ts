import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const ORIGIN = `http://localhost:${PORT}`;
// The data dir is created once by the main process, which also starts the server.
process.env.E2E_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), 'budget-e2e-'));

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: ORIGIN,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    // Runs the production build: `pnpm e2e` builds first.
    command: 'node apps/server/dist/index.js',
    cwd: path.resolve(import.meta.dirname, '..'),
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: process.env.E2E_DATA_DIR,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_SECRET: randomBytes(32).toString('base64url'),
      BACKUP_ENABLED: 'false',
      LOG_LEVEL: 'warn',
    },
  },
});
