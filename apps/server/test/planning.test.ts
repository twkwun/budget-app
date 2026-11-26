import { describe, expect, it } from 'vitest';
import {
  zonedTimeToUtc,
  type BackupStatus,
  type BudgetMonthsReport,
  type BudgetOverview,
  type HomeSummary,
  type RangeStats,
  type RecurringOverview,
  type YearStats,
} from '@budget/shared';
import { monthElapsed, paceOf } from '../src/planning/budgets.ts';
import { csvCell } from '../src/planning/export.ts';
import { detectCandidate, matchPayments } from '../src/planning/recurring.ts';
import { ADMIN } from './support/client.ts';
import { addTx, code, ledgerSetup } from './support/ledger.ts';

type Setup = Awaited<ReturnType<typeof ledgerSetup>>;

const kst = (date: string, time = '12:00') => `${date}T${time}:00+09:00`;

async function budgets(t: Setup, month: string, client = t.admin) {
  const res = await client.get(`/api/budgets?month=${month}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<BudgetOverview>();
}

async function setBudget(t: Setup, month: string, categoryId: number | null, amount: number) {
  const res = await t.admin.put('/api/budgets', { month, categoryId, amount });
  expect(res.statusCode, res.body).toBe(204);
}

describe('budgets', () => {
  it('carries a budget forward until it is changed, without rewriting earlier months', async () => {
    const t = await ledgerSetup();
    await setBudget(t, '2026-09', null, 1_000_000);
    expect((await budgets(t, '2026-08')).overall).toBeNull();
    for (const month of ['2026-09', '2026-10', '2026-11', '2027-03']) {
      const overall = (await budgets(t, month)).overall;
      expect(overall?.amount, month).toBe(1_000_000);
      expect(overall?.since, month).toBe('2026-09');
    }

    await setBudget(t, '2026-11', null, 800_000);
    expect((await budgets(t, '2026-10')).overall?.amount).toBe(1_000_000);
    expect((await budgets(t, '2026-11')).overall?.amount).toBe(800_000);
    expect((await budgets(t, '2027-01')).overall?.amount).toBe(800_000);

    // 0 removes it from that month on; earlier months keep theirs.
    await setBudget(t, '2026-12', null, 0);
    expect((await budgets(t, '2026-12')).overall).toBeNull();
    expect((await budgets(t, '2027-05')).overall).toBeNull();
    expect((await budgets(t, '2026-11')).overall?.amount).toBe(800_000);

    // Changing a month twice keeps one row for it.
    await setBudget(t, '2026-11', null, 700_000);
    const overview = await budgets(t, '2026-11');
    expect(overview.overall?.amount).toBe(700_000);
    expect(overview.history.map((h) => [h.month, h.amount])).toEqual([
      ['2026-12', 0],
      ['2026-11', 700_000],
      ['2026-09', 1_000_000],
    ]);
    expect(overview.history[0]?.updatedByName).toBe(ADMIN.displayName);

    // Setting back the amount in force before the month removes that month's change.
    await setBudget(t, '2026-11', null, 1_000_000);
    expect((await budgets(t, '2026-11')).history.map((h) => h.month)).toEqual([
      '2026-12',
      '2026-09',
    ]);
  });

  it('counts a category budget with its children and the overall budget with everything', async () => {
    const t = await ledgerSetup();
    const food = t.cat('식비');
    await setBudget(t, '2026-11', null, 100_000);
    await setBudget(t, '2026-11', food, 20_000);
    const at = kst('2026-11-10');
    await addTx(t.admin, { amount: 10_000, occurredAt: at, categoryId: t.cat('식비/외식') });
    await addTx(t.admin, { amount: 5_000, occurredAt: at, categoryId: t.cat('식비/카페·간식') });
    await addTx(t.admin, { amount: 3_000, occurredAt: at, categoryId: food });
    await addTx(t.admin, { amount: 7_000, occurredAt: at, categoryId: t.cat('생활/편의점') });
    await addTx(t.admin, { amount: 2_000, occurredAt: at }); // 미분류
    await addTx(t.admin, { amount: 500_000, occurredAt: at, type: 'transfer' });
    await addTx(t.admin, {
      amount: 90_000,
      occurredAt: at,
      categoryId: food,
      status: 'cancelled',
    });
    await addTx(t.admin, {
      amount: 3_000_000,
      occurredAt: at,
      type: 'income',
      categoryId: t.cat('근로소득/급여'),
    });
    // A member's spending counts toward their own budgets, not the admin's.
    await addTx(t.member, { amount: 6_000, occurredAt: at, categoryId: t.cat('식비/외식') });
    await addTx(t.member, {
      amount: 4_000,
      occurredAt: at,
      categoryId: t.cat('식비/외식'),
      isPrivate: true,
    });

    const admin = await budgets(t, '2026-11');
    expect(admin.overall).toMatchObject({ spent: 27_000, remaining: 73_000, percent: 27 });
    expect(admin.categories).toHaveLength(1);
    expect(admin.categories[0]).toMatchObject({
      categoryId: food,
      name: '식비',
      spent: 18_000,
      remaining: 2_000,
      percent: 90,
      over: false,
    });
    expect(admin.userId).toBe(t.adminId);

    // Every member keeps their own budgets, against their own spending.
    let member = await budgets(t, '2026-11', t.member);
    expect(member).toMatchObject({ userId: t.memberId, overall: null, categories: [] });
    const put = await t.member.put('/api/budgets', {
      month: '2026-11',
      categoryId: food,
      amount: 9_000,
    });
    expect(put.statusCode, put.body).toBe(204);
    member = await budgets(t, '2026-11', t.member);
    expect(member.categories[0]).toMatchObject({ spent: 10_000, over: true, percent: 111 });
    expect(member.categories[0]?.pace?.status).toBe('over');
    expect(member.history.map((h) => h.amount)).toEqual([9_000]);
    expect((await budgets(t, '2026-11')).categories[0]?.amount).toBe(20_000);

    // An admin sees (and may set) a member's budgets, minus their private spending.
    const seen = await t.admin.get(`/api/budgets?month=2026-11&user=${t.memberId}`);
    expect(seen.json<BudgetOverview>().categories[0]).toMatchObject({
      amount: 9_000,
      spent: 6_000,
    });
    // A member never sees another member's budgets.
    expect((await t.member.get(`/api/budgets?month=2026-11&user=${t.adminId}`)).statusCode).toBe(
      403,
    );
    expect(
      (
        await t.member.put('/api/budgets', {
          month: '2026-11',
          categoryId: null,
          amount: 1,
          userId: t.adminId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.admin.put('/api/budgets', {
          month: '2026-11',
          categoryId: null,
          amount: 50_000,
          userId: t.memberId,
        })
      ).statusCode,
    ).toBe(204);
    expect((await budgets(t, '2026-11', t.member)).overall?.amount).toBe(50_000);
  });

  it('accepts only top-level, active expense categories', async () => {
    const t = await ledgerSetup();
    for (const categoryId of [t.cat('식비/외식'), t.cat('근로소득'), 999_999]) {
      const res = await t.admin.put('/api/budgets', { month: '2026-11', categoryId, amount: 1 });
      expect(code(res)).toBe('budget_invalid');
    }
    await t.admin.patch(`/api/categories/${t.cat('생활')}`, { archived: true });
    const archived = await t.admin.put('/api/budgets', {
      month: '2026-11',
      categoryId: t.cat('생활'),
      amount: 1,
    });
    expect(code(archived)).toBe('budget_invalid');
    const bad = await t.admin.put('/api/budgets', {
      month: '2026-13',
      categoryId: null,
      amount: 1,
    });
    expect(bad.statusCode).toBe(400);
    const negative = await t.admin.put('/api/budgets', {
      month: '2026-11',
      categoryId: null,
      amount: -1,
    });
    expect(negative.statusCode).toBe(400);
  });

  it('reports pace for the current month only, from the share of the month elapsed in Seoul', async () => {
    const t = await ledgerSetup();
    await setBudget(t, '2026-10', null, 300_000);
    // Clock: 2026-11-22 21:00 KST → 21 days and 21 hours of a 30-day month.
    await addTx(t.admin, { amount: 240_000, occurredAt: kst('2026-11-03') });
    const now = await budgets(t, '2026-11');
    expect(now.isCurrentMonth).toBe(true);
    const elapsed = (21 * 24 + 21) / (30 * 24);
    expect(now.overall?.pace?.elapsed).toBeCloseTo(elapsed, 6);
    expect(now.overall?.pace?.expectedSpent).toBe(Math.round(300_000 * elapsed));
    expect(now.overall?.pace?.status).toBe('ok'); // 80% spent vs 73% elapsed
    const past = await budgets(t, '2026-10');
    expect(past.isCurrentMonth).toBe(false);
    expect(past.overall?.pace).toBeNull();

    // 홈 shows the budgets of the person in scope (the viewer in 전체),
    // against that person's spending only.
    await addTx(t.member, { amount: 30_000, occurredAt: kst('2026-11-04') });
    const summary = (await t.admin.get('/api/summary?month=2026-11')).json<HomeSummary>();
    expect(summary.expense).toBe(270_000);
    expect(summary.planUserId).toBe(t.adminId);
    expect(summary.budgets?.overall?.spent).toBe(240_000);
    const scoped = (
      await t.admin.get(`/api/summary?month=2026-11&owner=${t.adminId}`)
    ).json<HomeSummary>();
    expect(scoped.budgets?.overall?.spent).toBe(240_000);
    const ofMember = (
      await t.admin.get(`/api/summary?month=2026-11&owner=${t.memberId}`)
    ).json<HomeSummary>();
    expect(ofMember).toMatchObject({ planUserId: t.memberId, expense: 30_000 });
    expect(ofMember.budgets?.overall).toBeNull();
    const member = (await t.member.get('/api/summary?month=2026-11')).json<HomeSummary>();
    expect(member).toMatchObject({ planUserId: t.memberId, expense: 30_000 });
    expect((await t.member.get(`/api/summary?month=2026-11&owner=${t.adminId}`)).statusCode).toBe(
      403,
    );
  });

  it('pace around month start and end', () => {
    const start = zonedTimeToUtc({ year: 2026, month: 11, day: 1 }, 'Asia/Seoul');
    const end = zonedTimeToUtc({ year: 2026, month: 12, day: 1 }, 'Asia/Seoul');
    expect(monthElapsed('2026-11', start)).toBe(0);
    expect(monthElapsed('2026-11', start - 1)).toBeNull(); // still October in Seoul
    expect(monthElapsed('2026-11', end)).toBeNull();
    expect(monthElapsed('2026-11', end - 60_000)).toBeCloseTo(1, 4);

    // First minutes of the month: a little spending is fine, a lot is "ahead".
    expect(paceOf(100_000, 5_000, 0).status).toBe('ok');
    expect(paceOf(100_000, 10_000, 0).status).toBe('ok');
    expect(paceOf(100_000, 10_001, 0).status).toBe('ahead');
    // Last minute: everything up to the budget is on pace; above it is over.
    expect(paceOf(100_000, 100_000, 0.9999).status).toBe('ok');
    expect(paceOf(100_000, 100_001, 0.9999).status).toBe('over');
    expect(paceOf(100_000, 50_000, 0.5).expectedSpent).toBe(50_000);
  });
});

describe('budget months (월별 비교)', () => {
  async function report(t: Setup, query: string, client = t.admin) {
    const res = await client.get(`/api/budgets/months?${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BudgetMonthsReport>();
  }

  async function seed() {
    const t = await ledgerSetup();
    const food = t.cat('식비');
    const living = t.cat('생활');
    await setBudget(t, '2026-08', null, 100_000);
    await setBudget(t, '2026-08', food, 20_000);
    await setBudget(t, '2026-10', food, 30_000);
    await setBudget(t, '2026-09', living, 10_000);
    await setBudget(t, '2026-11', living, 0);
    const dining = t.cat('식비/외식');
    const store = t.cat('생활/편의점');
    await addTx(t.admin, { amount: 25_000, occurredAt: kst('2026-08-05'), categoryId: dining });
    await addTx(t.admin, { amount: 5_000, occurredAt: kst('2026-08-06'), categoryId: store });
    await addTx(t.admin, { amount: 10_000, occurredAt: kst('2026-09-05'), categoryId: food });
    await addTx(t.admin, { amount: 12_000, occurredAt: kst('2026-09-06'), categoryId: store });
    await addTx(t.admin, { amount: 3_000, occurredAt: kst('2026-09-07') }); // 미분류
    await addTx(t.admin, { amount: 30_000, occurredAt: kst('2026-10-05'), categoryId: dining });
    await addTx(t.admin, { amount: 500_000, occurredAt: kst('2026-10-06'), type: 'transfer' });
    await addTx(t.admin, {
      amount: 90_000,
      occurredAt: kst('2026-10-07'),
      categoryId: food,
      status: 'cancelled',
    });
    await addTx(t.admin, { amount: 40_000, occurredAt: kst('2026-11-05'), categoryId: dining });
    await addTx(t.admin, { amount: 4_000, occurredAt: kst('2026-11-06'), categoryId: store });
    await addTx(t.member, {
      amount: 4_000,
      occurredAt: kst('2026-11-07'),
      categoryId: dining,
      isPrivate: true,
    });
    // Outside the range: must not leak into it.
    await addTx(t.admin, { amount: 77_000, occurredAt: kst('2026-07-31'), categoryId: dining });
    return { t, food, living };
  }

  it('lays budgets against spending month by month', async () => {
    const { t, food, living } = await seed();
    const r = await report(t, 'to=2026-11&count=4');
    expect(r.months).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(r.totalSpent).toEqual([30_000, 25_000, 30_000, 44_000]);

    expect(r.overall?.cells.map((c) => [c.budget, c.spent, c.percent, c.over])).toEqual([
      [100_000, 30_000, 30, false],
      [100_000, 25_000, 25, false],
      [100_000, 30_000, 30, false],
      [100_000, 44_000, 44, false],
    ]);
    expect(r.overall?.cells.map((c) => c.current)).toEqual([false, false, false, true]);
    expect(r.overall?.cells[3]?.pace?.status).toBe('ok');
    expect(r.overall?.cells[2]?.pace).toBeNull();
    // The month in progress is left out of the average and the sums.
    expect(r.overall?.summary).toEqual({
      budgetedMonths: 4,
      overMonths: 0,
      avgPercent: 28,
      budgetTotal: 300_000,
      spentTotal: 85_000,
    });

    expect(r.categories.map((c) => [c.categoryId, c.name])).toEqual([
      [food, '식비'],
      [living, '생활'],
    ]);
    const [foodRow, livingRow] = r.categories;
    expect(foodRow?.cells.map((c) => [c.budget, c.spent, c.percent, c.over])).toEqual([
      [20_000, 25_000, 125, true],
      [20_000, 10_000, 50, false],
      [30_000, 30_000, 100, false],
      [30_000, 40_000, 133, true],
    ]);
    expect(foodRow?.cells[3]?.pace?.status).toBe('over');
    expect(foodRow?.summary).toEqual({
      budgetedMonths: 4,
      overMonths: 2,
      avgPercent: 92,
      budgetTotal: 70_000,
      spentTotal: 65_000,
    });
    // 생활 had a budget in September and October only; spending is shown anyway.
    expect(livingRow?.cells.map((c) => [c.budget, c.spent, c.percent, c.over])).toEqual([
      [null, 5_000, null, false],
      [10_000, 12_000, 120, true],
      [10_000, 0, 0, false],
      [null, 4_000, null, false],
    ]);
    expect(livingRow?.summary).toMatchObject({ budgetedMonths: 2, overMonths: 1, avgPercent: 60 });
    // Everything outside a category budget that month: other categories and 미분류.
    expect(r.unbudgetedSpent).toEqual([5_000, 3_000, 0, 4_000]);
  });

  it('agrees with the single-month budgets view', async () => {
    const { t } = await seed();
    const r = await report(t, 'to=2026-11&count=4');
    for (const [i, month] of r.months.entries()) {
      const one = await budgets(t, month);
      expect(r.overall?.cells[i]?.spent, month).toBe(one.overall?.spent);
      for (const b of one.categories) {
        const row = r.categories.find((c) => c.categoryId === b.categoryId);
        expect(row?.cells[i]).toMatchObject({ budget: b.amount, spent: b.spent, over: b.over });
      }
    }
  });

  it("is per member: a member's own budgets and spending only", async () => {
    const { t } = await seed();
    const member = await report(t, 'to=2026-11&count=4', t.member);
    expect(member.overall).toBeNull();
    expect(member.categories).toEqual([]);
    expect(member.totalSpent).toEqual([0, 0, 0, 4_000]);
    // The admin's own report leaves the member's spending out.
    expect((await report(t, 'to=2026-11&count=4')).totalSpent[3]).toBe(44_000);
    // An admin may look at a member's report (without their private spending).
    const ofMember = await report(t, `to=2026-11&count=4&user=${t.memberId}`);
    expect(ofMember.totalSpent[3]).toBe(0);
    expect(
      (await t.member.get(`/api/budgets/months?to=2026-11&count=4&user=${t.adminId}`)).statusCode,
    ).toBe(403);
  });

  it('defaults to 12 months ending this month, never past it, and validates', async () => {
    const { t, living } = await seed();
    const r = await report(t, '');
    expect(r.months).toHaveLength(12);
    expect([r.from, r.to]).toEqual(['2025-12', '2026-11']);
    const future = await report(t, 'to=2027-03&count=3');
    expect(future.months).toEqual(['2026-09', '2026-10', '2026-11']);
    for (const query of ['count=2', 'count=25', 'to=2026-13', 'count=x']) {
      const res = await t.admin.get(`/api/budgets/months?${query}`);
      expect(res.statusCode, query).toBe(400);
    }

    // Before any budget there are no rows, but spending is still there.
    const early = await report(t, 'to=2026-07&count=3');
    expect(early.overall).toBeNull();
    expect(early.categories).toEqual([]);
    expect(early.unbudgetedSpent).toEqual([0, 0, 77_000]);

    // An archived category drops out, as it does on the single-month view.
    await t.admin.patch(`/api/categories/${living}`, { archived: true });
    const after = await report(t, 'to=2026-11&count=4');
    expect(after.categories.map((c) => c.name)).toEqual(['식비']);
    expect(after.unbudgetedSpent).toEqual([5_000, 15_000, 0, 4_000]);
  });
});

describe('recurring detection', () => {
  const row = (id: number, date: string, amount: number, key = '넷플릭스') => ({
    id,
    merchant: key,
    merchantKey: key,
    date,
    amount,
    categoryId: null,
    accountId: null,
  });

  it('suggests three consecutive months of one similar payment', () => {
    const rows = [
      row(1, '2026-08-05', 17_000),
      row(2, '2026-09-04', 17_000),
      row(3, '2026-10-06', 17_500),
    ];
    expect(detectCandidate(rows, '2026-11')).toMatchObject({
      matchKey: '넷플릭스',
      amount: 17_000,
      dayOfMonth: 5,
      months: ['2026-10', '2026-09', '2026-08'],
    });
    // This month's payment extends the run.
    expect(
      detectCandidate([...rows, row(4, '2026-11-05', 17_000)], '2026-11')?.months,
    ).toHaveLength(4);
  });

  it('rejects near misses', () => {
    const cases: [string, ReturnType<typeof row>[]][] = [
      ['only two months', [row(1, '2026-09-05', 17_000), row(2, '2026-10-05', 17_000)]],
      [
        'a gap month',
        [row(1, '2026-07-05', 17_000), row(2, '2026-08-05', 17_000), row(3, '2026-10-05', 17_000)],
      ],
      [
        'amount varies by more than 20%',
        [row(1, '2026-08-05', 17_000), row(2, '2026-09-05', 17_000), row(3, '2026-10-05', 21_000)],
      ],
      [
        'days spread over more than a week',
        [row(1, '2026-08-01', 17_000), row(2, '2026-09-05', 17_000), row(3, '2026-10-09', 17_000)],
      ],
      [
        'twice in a month',
        [
          row(1, '2026-08-05', 17_000),
          row(2, '2026-09-05', 17_000),
          row(3, '2026-09-20', 17_000),
          row(4, '2026-10-05', 17_000),
        ],
      ],
      [
        'stopped (nothing last month or this month)',
        [row(1, '2026-06-05', 17_000), row(2, '2026-07-05', 17_000), row(3, '2026-08-05', 17_000)],
      ],
      [
        'paid twice this month',
        [
          row(1, '2026-08-05', 17_000),
          row(2, '2026-09-05', 17_000),
          row(3, '2026-10-05', 17_000),
          row(4, '2026-11-02', 17_000),
          row(5, '2026-11-09', 17_000),
        ],
      ],
    ];
    for (const [label, rows] of cases) expect(detectCandidate(rows, '2026-11'), label).toBeNull();
    // Exactly 20% off the median still counts.
    expect(
      detectCandidate(
        [row(1, '2026-08-05', 10_000), row(2, '2026-09-05', 10_000), row(3, '2026-10-05', 12_000)],
        '2026-11',
      ),
    ).not.toBeNull();
  });

  it('matches each payment to one item, most specific key first, nearest date', () => {
    const items = [
      { id: 1, matchKey: '쿠팡', amount: 50_000, dayOfMonth: 10 },
      { id: 2, matchKey: '쿠팡와우', amount: 7_890, dayOfMonth: 3 },
    ];
    const rows = [
      row(10, '2026-11-03', 7_890, '쿠팡와우멤버십'),
      row(11, '2026-11-02', 48_000, '쿠팡'),
      row(12, '2026-11-12', 52_000, '쿠팡'),
      row(13, '2026-10-10', 50_000, '쿠팡'),
    ];
    const matched = matchPayments(items, rows, '2026-11');
    expect(matched.get(2)?.id).toBe(10);
    expect(matched.get(1)?.id).toBe(12); // 12th is nearer the 10th than the 2nd
    expect(matchPayments(items, [row(14, '2026-11-10', 70_000, '쿠팡')], '2026-11').size).toBe(0);
  });
});

describe('recurring API', () => {
  async function seedNetflix(t: Setup) {
    for (const month of ['08', '09', '10']) {
      await addTx(t.admin, {
        amount: 17_000,
        merchant: '넷플릭스',
        occurredAt: kst(`2026-${month}-05`),
        categoryId: t.cat('주거·통신/통신비'),
      });
    }
  }

  it('suggests, confirms, matches and dismisses', async () => {
    const t = await ledgerSetup();
    await seedNetflix(t);
    // Each member gets suggestions from their own spending only, never from
    // private entries.
    for (const month of ['08', '09', '10']) {
      await addTx(t.member, {
        amount: 12_000,
        merchant: '음악구독',
        occurredAt: kst(`2026-${month}-09`),
      });
      await addTx(t.member, {
        amount: 9_900,
        merchant: '비밀구독',
        occurredAt: kst(`2026-${month}-07`),
        isPrivate: true,
      });
    }
    let overview = (await t.admin.get('/api/recurring')).json<RecurringOverview>();
    expect(overview.suggestions.map((s) => s.name)).toEqual(['넷플릭스']);
    const suggestion = overview.suggestions[0]!;
    expect(suggestion).toMatchObject({ amount: 17_000, dayOfMonth: 5, source: 'detected' });
    expect(suggestion.seenMonths).toEqual(['2026-10', '2026-09', '2026-08']);
    const mine = (await t.member.get('/api/recurring')).json<RecurringOverview>();
    expect(mine.userId).toBe(t.memberId);
    expect(mine.suggestions.map((s) => s.name)).toEqual(['음악구독']);
    // Another member's items are out of reach for a member.
    expect(
      (await t.member.patch(`/api/recurring/${suggestion.id}`, { status: 'confirmed' })).statusCode,
    ).toBe(404);
    expect((await t.member.delete(`/api/recurring/${suggestion.id}`)).statusCode).toBe(404);
    expect((await t.member.get(`/api/recurring?user=${t.adminId}`)).statusCode).toBe(403);
    // An admin may look at a member's list.
    const ofMember = (
      await t.admin.get(`/api/recurring?user=${t.memberId}`)
    ).json<RecurringOverview>();
    expect(ofMember.suggestions.map((s) => s.name)).toEqual(['음악구독']);

    // Not yet confirmed: nothing expected on 홈.
    let home = (await t.admin.get('/api/summary')).json<HomeSummary>();
    expect(home.recurring).toMatchObject({ items: [], suggestionCount: 1 });

    expect(
      (await t.admin.patch(`/api/recurring/${suggestion.id}`, { status: 'confirmed' })).statusCode,
    ).toBe(204);
    home = (await t.admin.get('/api/summary')).json<HomeSummary>();
    // The 5th has passed (clock: 22 Nov) without a payment.
    expect(home.recurring?.items.map((i) => [i.name, i.state, i.expectedDate])).toEqual([
      ['넷플릭스', 'late', '2026-11-05'],
    ]);
    expect(home.recurring?.remainingAmount).toBe(17_000);

    // A payment far off the amount does not match; a close one does.
    await addTx(t.admin, { amount: 30_000, merchant: '넷플릭스', occurredAt: kst('2026-11-06') });
    home = (await t.admin.get('/api/summary')).json<HomeSummary>();
    expect(home.recurring?.items[0]?.state).toBe('late');
    const paid = await addTx(t.admin, {
      amount: 17_000,
      merchant: '넷플릭스서비시즈코리아',
      occurredAt: kst('2026-11-07'),
    });
    home = (await t.admin.get('/api/summary')).json<HomeSummary>();
    expect(home.recurring?.items[0]).toMatchObject({
      state: 'paid',
      paid: { transactionId: paid.id, date: '2026-11-07', amount: 17_000 },
    });
    expect(home.recurring?.remainingAmount).toBe(0);
    // Next month it is upcoming again.
    const dec = (await t.admin.get('/api/recurring?month=2026-12')).json<RecurringOverview>();
    expect(dec.items[0]).toMatchObject({ state: 'upcoming', expectedDate: '2026-12-05' });

    // Removing a detected item keeps it dismissed so it is not suggested again.
    expect((await t.admin.delete(`/api/recurring/${suggestion.id}`)).statusCode).toBe(204);
    overview = (await t.admin.get('/api/recurring')).json<RecurringOverview>();
    expect(overview.items).toEqual([]);
    expect(overview.suggestions).toEqual([]);
    expect(overview.dismissed.map((d) => d.name)).toEqual(['넷플릭스']);
  });

  it('adds, edits and removes items by hand', async () => {
    const t = await ledgerSetup();
    const created = await t.admin.post('/api/recurring', {
      name: '아파트 관리비',
      amount: 250_000,
      dayOfMonth: 31,
      categoryId: t.cat('주거·통신/관리비'),
      accountId: null,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: number }>();
    let overview = (await t.admin.get('/api/recurring?month=2026-11')).json<RecurringOverview>();
    expect(overview.items[0]).toMatchObject({
      matchKey: '아파트관리비',
      source: 'manual',
      status: 'confirmed',
      expectedDate: '2026-11-30', // clamped to the month length
      state: 'upcoming',
      categoryName: '관리비',
    });

    const dup = await t.admin.post('/api/recurring', {
      name: '아파트 관리비',
      amount: 1,
      dayOfMonth: 1,
      categoryId: null,
      accountId: null,
    });
    expect(code(dup)).toBe('recurring_exists');
    const income = await t.admin.patch(`/api/recurring/${id}`, {
      categoryId: t.cat('근로소득'),
    });
    expect(code(income)).toBe('recurring_invalid');
    const suggested = await t.admin.patch(`/api/recurring/${id}`, { status: 'suggested' });
    expect(code(suggested)).toBe('recurring_invalid');

    await t.admin.patch(`/api/recurring/${id}`, { amount: 260_000, matchKey: '관리비' });
    await addTx(t.admin, {
      amount: 255_000,
      merchant: '○○아파트 관리비',
      occurredAt: kst('2026-11-20'),
    });
    overview = (await t.admin.get('/api/recurring?month=2026-11')).json<RecurringOverview>();
    expect(overview.items[0]).toMatchObject({ amount: 260_000, state: 'paid' });

    expect((await t.admin.delete(`/api/recurring/${id}`)).statusCode).toBe(204);
    overview = (await t.admin.get('/api/recurring')).json<RecurringOverview>();
    expect([...overview.items, ...overview.dismissed]).toEqual([]);
  });

  it('does not suggest what an item already covers', async () => {
    const t = await ledgerSetup();
    await t.admin.post('/api/recurring', {
      name: '넷플릭스',
      amount: 17_000,
      dayOfMonth: 5,
      categoryId: null,
      accountId: null,
    });
    for (const month of ['08', '09', '10']) {
      await addTx(t.admin, {
        amount: 17_000,
        merchant: '넷플릭스서비시즈',
        occurredAt: kst(`2026-${month}-05`),
      });
    }
    const overview = (await t.admin.get('/api/recurring')).json<RecurringOverview>();
    expect(overview.suggestions).toEqual([]);
  });
});

describe('statistics', () => {
  /**
   * Fixture (hand-computed below):
   *   2025-11  admin  expense 식비/외식 10,000 (가게A)
   *   2026-01  admin  expense 식비 20,000 (가게A), income 급여 1,000,000
   *   2026-02  member expense 생활/편의점 5,000 (가게B), transfer 300,000 (excluded)
   *   2026-02  admin  expense 식비/카페 7,000 (가게C) cancelled (excluded)
   *   2026-03  member expense 미분류 3,000 (가게F); member private 식비 40,000 (가게D)
   *   2025-03  admin  expense 생활 8,000 (previous year)
   */
  async function seedStats(t: Setup) {
    const food = t.cat('식비');
    await addTx(t.admin, {
      amount: 10_000,
      merchant: '가게A',
      occurredAt: kst('2025-11-15'),
      categoryId: t.cat('식비/외식'),
    });
    await addTx(t.admin, {
      amount: 20_000,
      merchant: '가게A',
      occurredAt: kst('2026-01-31', '23:30'),
      categoryId: food,
    });
    await addTx(t.admin, {
      type: 'income',
      amount: 1_000_000,
      merchant: '급여',
      occurredAt: kst('2026-01-25'),
      categoryId: t.cat('근로소득/급여'),
    });
    await addTx(t.member, {
      amount: 5_000,
      merchant: '가게B',
      occurredAt: kst('2026-02-01', '00:10'),
      categoryId: t.cat('생활/편의점'),
    });
    await addTx(t.member, { type: 'transfer', amount: 300_000, occurredAt: kst('2026-02-10') });
    await addTx(t.admin, {
      amount: 7_000,
      merchant: '가게C',
      occurredAt: kst('2026-02-11'),
      categoryId: t.cat('식비/카페·간식'),
      status: 'cancelled',
    });
    await addTx(t.member, { amount: 3_000, merchant: '가게F', occurredAt: kst('2026-03-02') });
    await addTx(t.member, {
      amount: 40_000,
      merchant: '가게D',
      occurredAt: kst('2026-03-03'),
      categoryId: food,
      isPrivate: true,
    });
    await addTx(t.admin, {
      amount: 8_000,
      merchant: '가게E',
      occurredAt: kst('2025-03-03'),
      categoryId: t.cat('생활'),
    });
  }

  it('builds monthly, category, member and merchant series for a range', async () => {
    const t = await ledgerSetup();
    await seedStats(t);
    const res = await t.admin.get('/api/stats/range?from=2025-11&to=2026-03');
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json<RangeStats>();
    expect(s.months).toEqual([
      { month: '2025-11', expense: 10_000, income: 0 },
      { month: '2025-12', expense: 0, income: 0 },
      { month: '2026-01', expense: 20_000, income: 1_000_000 },
      { month: '2026-02', expense: 5_000, income: 0 },
      { month: '2026-03', expense: 3_000, income: 0 },
    ]);
    expect(s.totals).toEqual({ expense: 38_000, income: 1_000_000 });
    expect(s.categories).toEqual([
      { categoryId: t.cat('식비'), name: '식비', total: 30_000, values: [10_000, 0, 20_000, 0, 0] },
      { categoryId: t.cat('생활'), name: '생활', total: 5_000, values: [0, 0, 0, 5_000, 0] },
      { categoryId: null, name: '미분류', total: 3_000, values: [0, 0, 0, 0, 3_000] },
    ]);
    expect(s.members).toEqual([
      {
        userId: t.adminId,
        name: '관리자',
        expense: 30_000,
        income: 1_000_000,
        values: [10_000, 0, 20_000, 0, 0],
      },
      {
        userId: t.memberId,
        name: '구성원',
        expense: 8_000,
        income: 0,
        values: [0, 0, 0, 5_000, 3_000],
      },
    ]);
    expect(s.merchants).toEqual([
      { merchant: '가게A', amount: 30_000, count: 2 },
      { merchant: '가게B', amount: 5_000, count: 1 },
      { merchant: '가게F', amount: 3_000, count: 1 },
    ]);
  });

  it('counts the owner’s private spending only for the owner, and filters by member', async () => {
    const t = await ledgerSetup();
    await seedStats(t);
    const mine = (
      await t.member.get('/api/stats/range?from=2026-03&to=2026-03')
    ).json<RangeStats>();
    expect(mine.totals.expense).toBe(43_000);
    expect(mine.merchants.map((m) => m.merchant)).toEqual(['가게D', '가게F']);
    const admin = (
      await t.admin.get(`/api/stats/range?from=2026-01&to=2026-03&owner=${t.memberId}`)
    ).json<RangeStats>();
    expect(admin.totals).toEqual({ expense: 8_000, income: 0 });
    expect(admin.members).toEqual([]);
    expect(admin.categories.map((c) => c.name)).toEqual(['생활', '미분류']);
  });

  it('compares a year with the previous year', async () => {
    const t = await ledgerSetup();
    await seedStats(t);
    // December 2025 is outside the like-for-like window for 2026 (through November).
    await addTx(t.admin, { amount: 50_000, merchant: '가게G', occurredAt: kst('2025-12-10') });
    const s = (await t.admin.get('/api/stats/year?year=2026')).json<YearStats>();
    expect(s.from).toBe('2026-01');
    expect(s.to).toBe('2026-12');
    expect(s.months).toHaveLength(12);
    expect(s.totals).toEqual({ expense: 28_000, income: 1_000_000 });
    expect(s.previous.year).toBe(2025);
    // Clock: Nov 2026, so 2026 is compared with Jan–Nov 2025.
    expect(s.previous.through).toBe('2025-11');
    expect(s.previous.totals).toEqual({ expense: 18_000, income: 0 });
    const past = (await t.admin.get('/api/stats/year?year=2025')).json<YearStats>();
    expect(past.previous.through).toBe('2024-12');
    expect(past.totals.expense).toBe(68_000);
    expect(s.previous.months[11]).toEqual({ month: '2025-12', expense: 50_000, income: 0 });
    expect(s.previous.months[2]).toEqual({ month: '2025-03', expense: 8_000, income: 0 });
    expect(s.previous.categories).toEqual({
      [String(t.cat('식비'))]: 10_000,
      [String(t.cat('생활'))]: 8_000,
    });
  });

  it('validates ranges', async () => {
    const t = await ledgerSetup();
    for (const q of [
      'from=2026-03&to=2026-01',
      'from=2023-01&to=2026-01',
      'from=2026-1&to=2026-02',
    ]) {
      expect((await t.admin.get(`/api/stats/range?${q}`)).statusCode, q).toBe(400);
    }
    expect((await t.admin.get('/api/stats/range?from=2023-02&to=2026-01')).statusCode).toBe(200);
    expect((await t.admin.get('/api/stats/year?year=1999')).statusCode).toBe(400);
  });
});

describe('CSV export', () => {
  it('neutralises formula starters and quotes', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+82 10')).toBe("'+82 10");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('|x')).toBe("'|x");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1,"2"')).toBe(`"'=1,""2"""`);
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell('스타벅스')).toBe('스타벅스');
  });

  it('requires a recent identity check and exports visible transactions as UTF-8 with BOM', async () => {
    const t = await ledgerSetup();
    await addTx(t.admin, {
      amount: 12_000,
      merchant: '=HYPERLINK("http://example.invalid")',
      memo: '메모, 쉼표',
      occurredAt: kst('2026-11-01', '09:05'),
      categoryId: t.cat('식비/외식'),
    });
    await addTx(t.member, {
      amount: 4_000,
      merchant: '비밀',
      occurredAt: kst('2026-11-02'),
      isPrivate: true,
    });
    await addTx(t.admin, { amount: 1, merchant: '범위밖', occurredAt: kst('2026-12-01', '00:00') });

    const url = '/api/export/transactions.csv?from=2026-11-01&to=2026-11-30';
    t.clock.advance(10 * 60 * 1000);
    const denied = await t.admin.get(url);
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('reauth_required');
    await t.admin.post('/api/auth/verify/password', { password: ADMIN.password });
    const res = await t.admin.get(url);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('budget-2026-11-01_2026-11-30.csv');
    expect(res.headers['cache-control']).toBe('no-store');
    const bytes = res.rawPayload;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString('utf8').split('\r\n');
    expect(lines[0]).toBe(
      '날짜,시간,구분,금액,가맹점,대분류,소분류,결제수단,사용자,상태,메모,비공개,입력 경로',
    );
    expect(lines[1]).toBe(
      `2026-11-01,09:05,지출,12000,"'=HYPERLINK(""http://example.invalid"")",식비,외식,,관리자,정상,"메모, 쉼표",,직접 입력`,
    );
    expect(lines.slice(2)).toEqual(['']);

    const bad = await t.admin.get('/api/export/transactions.csv?from=2026-11-30&to=2026-11-01');
    expect(bad.statusCode).toBe(400);
  });
});

describe('backup status', () => {
  it('shows backups to admins and takes one on request', async () => {
    const t = await ledgerSetup();
    expect((await t.member.get('/api/admin/backup')).statusCode).toBe(403);
    expect((await t.member.post('/api/admin/backup')).statusCode).toBe(403);
    const before = (await t.admin.get('/api/admin/backup')).json<BackupStatus>();
    expect(before).toMatchObject({ count: 0, last: null, totalBytes: 0 });
    const res = await t.admin.post('/api/admin/backup');
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json<BackupStatus>();
    expect(after.count).toBe(1);
    expect(after.last?.takenAt).toBe(
      new Date(t.clock.now()).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    );
    expect(after.last?.bytes).toBeGreaterThan(0);
    expect(after.totalBytes).toBe(after.last?.bytes);
  });
});
