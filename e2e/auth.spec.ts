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

test('SMS webhook: token, two messages, 인박스 rule, automatic categorisation', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/$/);

  // Create a token in 설정 → 문자 전달 (fresh sign-in satisfies re-auth).
  await page.goto('/settings/sms');
  await page.getByTestId('token-device').fill('E2E 아이폰');
  await page.getByTestId('create-token').click();
  const token = (await page.getByTestId('token-value').textContent())?.trim() ?? '';
  expect(token).toMatch(/^bgt_/);
  const url = (await page.getByTestId('webhook-url').textContent())?.trim() ?? '';
  expect(url).toMatch(/\/api\/webhook\/sms$/);

  // Fixed past dates (Asia/Seoul) so the test never depends on today's date.
  const MONTH = '2026-03';
  const at = (day: number, hh: number, mm: number) => ({
    when: `03/${String(day).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    receivedAt: new Date(Date.UTC(2026, 2, day, hh - 9, mm, 20)).toISOString(),
  });
  const send = async (
    amount: string,
    t: { when: string; receivedAt: string },
    merchant: string,
  ) => {
    const res = await page.request.post(url, {
      headers: { authorization: `Bearer ${token}` },
      data: {
        text: `[Web발신]\n신한카드(4321)승인 테*트 ${amount}원(일시불)${t.when} ${merchant} 누적100,000원`,
        receivedAt: t.receivedAt,
      },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()) as { result: string; transactionId: number };
  };
  const cafe = await send('5,500', at(14, 9, 10), '구름카페 강남점');
  const craft = await send('32,000', at(14, 11, 30), '솔방울공방');
  expect(cafe.result).toBe('created');
  expect(craft.result).toBe('created');

  // Both appear in 내역 with the 문자 badge; the café was categorised by keyword.
  await page.goto(`/transactions?month=${MONTH}`);
  const cafeRow = page.getByTestId('tx-row').filter({ hasText: '구름카페 강남점' });
  await expect(cafeRow).toContainText('식비 > 카페·간식');
  await expect(cafeRow.getByTestId('source-sms')).toBeVisible();
  await expect(page.getByTestId('tx-row').filter({ hasText: '솔방울공방' })).toContainText(
    '미분류',
  );

  // 인박스: categorise the 미분류 one and remember it.
  await expect(page.getByTestId('inbox-badge')).toBeVisible();
  await page.goto('/inbox');
  const item = page.getByTestId('inbox-item').filter({ hasText: '솔방울공방' });
  await item.getByTestId(`inbox-category-${craft.transactionId}`).selectOption({ label: '취미' });
  await expect(item.getByTestId('inbox-remember')).toBeChecked();
  await item.getByRole('button', { name: '적용' }).click();
  await expect(page.getByTestId('inbox-item').filter({ hasText: '솔방울공방' })).toHaveCount(0);

  // A third message from the same merchant is categorised automatically.
  const third = await send('18,000', at(15, 16, 45), '솔방울공방');
  const tx = await (await page.request.get(`/api/transactions/${third.transactionId}`)).json();
  expect(tx.categoryName).toBe('문화·여가 > 취미');
  await page.goto(`/transactions?month=${MONTH}`);
  await expect(page.getByTestId('tx-row').filter({ hasText: '18,000원' })).toContainText(
    '문화·여가 > 취미',
  );
});

test('file import: password, payment-method mapping, 확인됨 with SMS, re-import adds nothing', async ({
  page,
}) => {
  const { encryptXlsx, makeBanksalad } = await import('../apps/server/test/support/files.ts');
  await page.goto('/login');
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/$/);
  const origin = new URL(page.url()).origin;

  // A card, and an SMS for one purchase that the file also contains.
  const account = await (
    await page.request.post('/api/accounts', {
      headers: { origin },
      data: { kind: 'card', name: '신한 생활카드', issuer: 'shinhan', last4: '4321' },
    })
  ).json();
  const token = (
    await (
      await page.request.post('/api/me/webhook-tokens', {
        headers: { origin },
        data: { deviceName: 'e2e' },
      })
    ).json()
  ).token;
  const sms = await page.request.post('/api/webhook/sms', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      text: '신한카드(4321)승인 테*트 5,500원(일시불)04/02 12:30 구름카페강남점',
      receivedAt: '2026-04-02T03:31:00.000Z',
    },
  });
  expect((await sms.json()).result).toBe('created');

  const rows = [
    [
      '2026-04-02',
      '12:30',
      '지출',
      '식비',
      '카페',
      '구름카페 강남점',
      -5500,
      'KRW',
      '생활비카드',
      '',
    ],
    ['2026-04-03', '19:00', '지출', '식비', '외식', '달빛분식', -12000, 'KRW', '생활비카드', ''],
    ['2026-04-05', '09:00', '수입', '급여', '', '회사급여', 2500000, 'KRW', '생활비 통장', ''],
  ];
  const file = {
    name: '뱅크샐러드_2026.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: encryptXlsx(makeBanksalad(rows), '0402e2e', 2000),
  };

  const uploadWithPassword = async () => {
    await page.goto('/import');
    await page.getByTestId('file-input').setInputFiles(file);
    await expect(page.getByTestId('import-password')).toBeVisible();
    await page.getByTestId('import-password-input').fill('0402e2e');
    await page.getByTestId('import-password-submit').click();
    await expect(page.getByTestId('import-summary')).toBeVisible();
  };

  await uploadWithPassword();
  // '생활비카드' has no issuer or digits: nothing is suggested until it is mapped.
  const select = page.getByTestId('account-map-생활비카드');
  await expect(select).toHaveValue('');
  await select.selectOption(String(account.id));
  await expect(page.getByTestId('count-duplicate')).toHaveText('중복 1');
  await expect(page.getByTestId('count-new')).toHaveText('신규 2');
  await page.getByTestId('import-apply').click();
  await expect(page.getByTestId('result-created')).toHaveText('2건');
  await expect(page.getByTestId('result-attached')).toHaveText('1건');

  await page.goto('/transactions?month=2026-04');
  const cafe = page.getByTestId('tx-row').filter({ hasText: '구름카페' });
  await expect(cafe).toHaveCount(1);
  await expect(cafe.getByTestId('confirmed')).toBeVisible();
  await expect(page.getByTestId('tx-row')).toHaveCount(3);

  // The same file again: everything is 이미 가져옴, nothing to apply.
  await uploadWithPassword();
  await expect(page.getByTestId('count-already')).toHaveText('이미 가져옴 3');
  await expect(page.getByTestId('count-new')).toHaveCount(0);
  await expect(page.getByTestId('import-apply')).toBeDisabled();
});

test('budget on 홈, 통계 month into 내역, CSV export', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/login');
  await page.getByTestId('login-name').fill(ADMIN.login);
  await page.getByTestId('login-password').fill(ADMIN.password);
  await page.getByRole('button', { name: '비밀번호로 로그인' }).click();
  await expect(page).toHaveURL(/\/$/);

  // Today in Seoul, whatever the machine clock says.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const month = today.slice(0, 7);
  const tree = (await (await page.request.get('/api/categories')).json()) as {
    expense: { id: number; name: string }[];
  };
  const food = tree.expense.find((c) => c.name === '식비')?.id;
  const created = await page.request.post('/api/transactions', {
    headers: { origin: new URL(page.url()).origin },
    data: {
      type: 'expense',
      amount: 50_000,
      merchant: '=예산테스트',
      categoryId: food,
      occurredAt: new Date().toISOString(),
    },
  });
  expect(created.status()).toBe(201);

  // 예산: overall 200,000 and 식비 40,000 (over).
  await page.goto('/budgets');
  await page.getByTestId('edit-overall').click();
  await page.getByTestId('budget-amount').fill('200000');
  await page.getByTestId('save-budget').click();
  await expect(page.getByTestId('budget-sheet')).toBeHidden();
  await page.getByTestId('budget-category').selectOption({ label: '식비' });
  await page.getByTestId('add-category-budget').click();
  await page.getByTestId('budget-amount').fill('40000');
  await page.getByTestId('save-budget').click();
  await expect(page.getByTestId('budget-history')).toContainText('식비');

  // 홈 shows both; the over-budget one says so in words.
  await page.goto('/');
  const budgets = page.getByTestId('home-budgets');
  await expect(budgets.getByTestId('budget-meter')).toHaveCount(2);
  await expect(budgets.getByTestId('budget-meter').first()).toContainText('200,000원');
  const over = budgets.locator('[data-state="over"]');
  await expect(over).toContainText('식비');
  await expect(over).toContainText('10,000원 초과');
  // Over budget: a line marks the budget, only the excess is hatched.
  await expect(over.getByTestId('budget-plan-line')).toHaveCount(1);
  await expect(budgets.getByTestId('budget-plan-line')).toHaveCount(1);

  // 통계 → this month in the table → 내역 filtered to that month's spending.
  await page.goto('/stats');
  await expect(page.getByTestId('stats-expense')).not.toHaveText('0원');
  await page.getByTestId('monthly-table').locator('summary').click();
  const [y, m] = month.split('-').map(Number);
  await page
    .getByTestId('monthly-table')
    .getByRole('link', { name: `${y}년 ${m}월` })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/transactions\\?month=${month}&basis=date&type=expense`),
  );
  await expect(page.getByTestId('tx-row').filter({ hasText: '=예산테스트' })).toHaveCount(1);

  // CSV export of today: UTF-8 with BOM, formula-like text neutralised.
  await page.goto('/settings/backup');
  await page.getByTestId('export-from').fill(today);
  await page.getByTestId('export-to').fill(today);
  const download = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(file);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  expect(text.split('\r\n')[0]).toContain('날짜,시간,구분,금액,가맹점');
  expect(text).toContain(`${today},`);
  expect(text).toContain("'=예산테스트");
});
