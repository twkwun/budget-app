/**
 * End-to-end: first-run setup → passkey → logout → passkey login → lock →
 * passkey unlock → invite → accept in a fresh browser context.
 * Passkeys use Chromium's CDP virtual authenticator (internal, resident keys, UV).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      // Behave like a synced passkey (iCloud Keychain): BE and BS flags set.
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  });
  return {
    credentials: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
  };
}

const ADMIN = { name: '엄마', login: 'mom', password: 'e2e-admin-pass-1' };
const MEMBER = { name: '아빠', login: 'dad', password: 'e2e-member-pass-2' };

async function fillAccount(page: Page, account: typeof ADMIN): Promise<void> {
  await page.getByTestId('account-display-name').fill(account.name);
  await page.getByTestId('account-login-name').fill(account.login);
  await page.getByTestId('account-password').fill(account.password);
  await page.getByTestId('account-password-confirm').fill(account.password);
}

async function confirmRecoveryCode(page: Page): Promise<string> {
  const code = (await page.getByTestId('recovery-code-value').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  await page.getByLabel('복구 코드를 안전한 곳에 저장했습니다').check();
  await page.getByRole('button', { name: '계속' }).click();
  return code;
}

test('setup, passkeys, lock and invite', async ({ browser, context, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // 401/423 responses are expected parts of the flow; anything else is a bug.
    if (m.type() === 'error' && !/status of (401|423)/.test(m.text())) errors.push(m.text());
  });
  const authenticator = await addVirtualAuthenticator(context, page);

  // 1. First run redirects to setup.
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await fillAccount(page, ADMIN);
  await page.getByRole('button', { name: '관리자 계정 만들기' }).click();
  await confirmRecoveryCode(page);

  // 2. Add a passkey right after setup.
  await page.getByRole('button', { name: '패스키 추가' }).click();
  await expect(page.getByTestId('passkey-added')).toBeVisible();
  expect(await authenticator.credentials()).toHaveLength(1);
  await page.getByRole('button', { name: '시작하기' }).click();
  await expect(page.getByTestId('health-status')).toHaveAttribute('data-state', 'online');

  // 3. Log out.
  await page.goto('/settings');
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await shot(page, 'login-phone');

  // 4. Username-less passkey login.
  await page.getByTestId('login-passkey').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('health-status')).toBeVisible();

  // 5. Security settings show the passkey and this session.
  await page.goto('/settings/security');
  await expect(page.getByTestId('passkey-list')).toContainText('동기화됨');
  await expect(page.getByTestId('session-list')).toContainText('이 기기');
  await shot(page, 'security-phone', true);

  // 6. Lock now, then unlock with the passkey.
  await page.getByTestId('lock-now').click();
  await expect(page.getByTestId('lock-screen')).toBeVisible();
  // The server enforces the lock as well, not just the UI.
  const locked = await page.request.get('/api/me');
  expect(locked.status()).toBe(423);
  await shot(page, 'lock-phone');
  await page.getByTestId('verify-passkey').click();
  await expect(page.getByTestId('lock-screen')).toBeHidden();
  expect((await page.request.get('/api/me')).status()).toBe(200);

  // 7. Invite a member.
  await page.goto('/settings/members');
  await page.getByTestId('create-invite').click();
  const inviteUrl = await page.getByTestId('invite-url').inputValue();
  expect(inviteUrl).toMatch(/\/invite\/[\w-]{43}$/);
  await shot(page, 'members-phone', true);

  // 8. Accept the invite in a fresh context (no cookies).
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  await guest.goto(inviteUrl);
  await fillAccount(guest, MEMBER);
  await guest.getByRole('button', { name: '가입하기' }).click();
  await confirmRecoveryCode(guest);
  await expect(guest.getByTestId('passkey-prompt')).toBeVisible();
  await guest.getByRole('button', { name: '나중에' }).click();
  await expect(guest).toHaveURL(/\/$/);
  await guest.goto('/settings');
  await expect(guest.getByText(`${MEMBER.name} (${MEMBER.login}) · 구성원`)).toBeVisible();
  await expect(guest.getByTestId('settings-members-link')).toHaveCount(0);
  // The used link no longer works.
  const reused = await guest.request.get(`/api/invite/${inviteUrl.split('/invite/')[1]}`);
  expect((await reused.json()).valid).toBe(false);
  await guestContext.close();

  // 9. The admin sees the new member.
  await page.reload();
  await expect(page.getByTestId('member-list')).toContainText(MEMBER.name);

  // Desktop login page screenshot.
  if (SHOTS) {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await desktop.newPage();
    await p.goto('/login');
    await expect(p.getByTestId('login-passkey')).toBeVisible();
    await shot(p, 'login-desktop');
    await desktop.close();
  }

  expect(errors).toEqual([]);
});

test('password login, wrong password and recovery link', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill('not the password');
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page.getByTestId('login-error')).toContainText('맞지 않습니다');
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/$/);
  // Redirect back to a protected page after sign-in.
  await page.context().clearCookies();
  await page.goto('/settings/security');
  await expect(page).toHaveURL(/\/login\?redirect=\/settings\/security$/);
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/settings\/security$/);
});

test('fast entry, list, home total, edit and delete', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/login');
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('kpi-expense').locator('.value')).toHaveText('0원');

  // 금액 → 분류 → 저장
  await page.goto('/add');
  for (const key of ['1', '2', '3', '0', '0']) await page.getByTestId(`key-${key}`).click();
  await expect(page.getByTestId('amount-display')).toHaveText('12,300원');
  await page.getByTestId('amount-next').click();
  await page.getByRole('button', { name: '식비', exact: true }).click();
  await page.getByRole('button', { name: '외식', exact: true }).click();
  await page.getByTestId('entry-merchant').fill('테스트분식');
  // A new user has no account yet: offer a cash account.
  await page.getByTestId('create-cash').click();
  await expect(page.getByTestId('entry-account')).toHaveValue(/\d+/);
  await page.getByTestId('entry-save').click();
  await expect(page.getByTestId('saved-notice')).toContainText('식비 > 외식');
  // Ready for the next entry.
  await expect(page.getByTestId('amount-display')).toHaveText('0원');

  // 내역
  await page.goto('/transactions');
  const row = page.getByTestId('tx-row').filter({ hasText: '테스트분식' });
  await expect(row).toContainText('-12,300원');
  await expect(row).toContainText('식비 > 외식');

  // 홈 total
  await page.goto('/');
  await expect(page.getByTestId('kpi-expense').locator('.value')).toHaveText('12,300원');
  await expect(page.getByTestId('category-list')).toContainText('식비');

  // Edit the category.
  await page.goto('/transactions');
  await page.getByTestId('tx-row').filter({ hasText: '테스트분식' }).click();
  await page.getByTestId('edit-category').selectOption({ label: '장보기' });
  await page.getByTestId('edit-save').click();
  await expect(page.getByTestId('edit-sheet')).toBeHidden();
  await expect(page.getByTestId('tx-row').filter({ hasText: '테스트분식' })).toContainText(
    '식비 > 장보기',
  );

  // Delete it.
  await page.getByTestId('tx-row').filter({ hasText: '테스트분식' }).click();
  await page.getByTestId('edit-delete').click();
  await expect(page.getByTestId('empty-list')).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('kpi-expense').locator('.value')).toHaveText('0원');
});
