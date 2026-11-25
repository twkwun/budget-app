/**
 * Screenshots for the user manual (apps/web/public/manual/*.jpg).
 *
 *   pnpm build && pnpm manual:shots
 *
 * Seeds the made-up demo household into a temporary data folder, runs the
 * production build against it and captures each screen at a desktop width.
 * Uses the installed Google Chrome (MANUAL_BROWSER=chromium for Playwright's
 * own build). Never touches ./data.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'apps/web/public/manual');
const PORT = Number(process.env.MANUAL_PORT ?? 4180);
const ORIGIN = `http://localhost:${PORT}`;
const DEMO_LOGIN = 'demo-sujin';
// From apps/server/src/cli/seed-demo.ts (made-up demo household only).
const DEMO_PASSWORD = 'demo-pass-1234';

interface Shot {
  file: string;
  path: string;
  /** Capture the whole page instead of the first screen. */
  full?: boolean;
  /** Extra steps after the page settles. */
  prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  { file: '01-home', path: '/' },
  { file: '02-transactions', path: '/transactions' },
  { file: '03-inbox', path: '/inbox' },
  { file: '04-add', path: '/add' },
  { file: '05-import', path: '/import' },
  { file: '06-stats', path: '/stats' },
  { file: '07-budgets', path: '/budgets' },
  { file: '08-settings', path: '/settings' },
  { file: '09-security', path: '/settings/security' },
  { file: '10-accounts', path: '/settings/accounts' },
  { file: '11-categories', path: '/settings/categories' },
  { file: '12-sms', path: '/settings/sms' },
  { file: '13-rules', path: '/settings/rules' },
  { file: '14-recurring', path: '/settings/recurring' },
  { file: '15-backup', path: '/settings/backup' },
  { file: '16-members', path: '/settings/members' },
  { file: '17-changelog', path: '/changelog' },
];

async function waitForHealth(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer on ${ORIGIN}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Charts animate in; let them finish.
  await page.waitForTimeout(900);
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'budget-manual-'));
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PUBLIC_ORIGIN: ORIGIN,
    SESSION_SECRET: randomBytes(32).toString('base64url'),
    BACKUP_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    TZ: 'Asia/Seoul',
  };
  let server: ChildProcess | undefined;
  try {
    const seed = spawnSync(
      process.execPath,
      ['--conditions=@budget/source', 'src/cli/seed-demo.ts'],
      { cwd: path.join(ROOT, 'apps/server'), env, encoding: 'utf8' },
    );
    if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr}`);

    server = spawn(process.execPath, ['apps/server/dist/index.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(Date.now() + 30_000);

    const browser = await chromium.launch(
      process.env.MANUAL_BROWSER === 'chromium' ? {} : { channel: 'chrome' },
    );
    const context = await browser.newContext({
      baseURL: ORIGIN,
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: 1.5,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      colorScheme: 'light',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();

    await page.goto('/login');
    await page.getByTestId('login-name').fill(DEMO_LOGIN);
    await page.getByTestId('login-password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
    await page.waitForURL(`${ORIGIN}/`);

    mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      await page.goto(shot.path);
      await settle(page);
      await shot.prepare?.(page);
      await page.screenshot({
        path: path.join(OUT, `${shot.file}.jpg`),
        type: 'jpeg',
        quality: 80,
        fullPage: shot.full ?? false,
      });
      process.stdout.write(`saved ${shot.file}.jpg\n`);
    }

    // Signed-out screen last.
    await context.clearCookies();
    await page.goto('/login');
    await settle(page);
    await page.screenshot({ path: path.join(OUT, '00-login.jpg'), type: 'jpeg', quality: 80 });
    process.stdout.write('saved 00-login.jpg\n');

    await browser.close();
  } finally {
    server?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
