import { afterEach, describe, expect, it } from 'vitest';
import type {
  EntryDefaults,
  MonthSummary,
  RangeStats,
  TransactionInfo,
  TransactionPage,
} from '@budget/shared';
import { transactions } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import { invite } from './support/invite.ts';
import { addAccount, addTx, code, ledgerSetup } from './support/ledger.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await ledgerSetup();
  close = () => t.app.close();
  return t;
}

describe('month boundaries in Asia/Seoul', () => {
  it('assigns instants around KST midnight to the right month and day', async () => {
    const t = await setup();
    const cases = [
      ['2026-10-31T14:59:59.999Z', '2026-10-31'], // 23:59:59.999 KST, October
      ['2026-10-31T15:00:00.000Z', '2026-11-01'], // 00:00 KST Nov 1
      ['2026-11-30T14:59:59.999Z', '2026-11-30'], // last instant of November
      ['2026-11-30T15:00:00.000Z', '2026-12-01'], // 00:00 KST Dec 1
      ['2026-11-15T09:30:00+09:00', '2026-11-15'], // explicit offset
    ] as const;
    for (const [occurredAt, date] of cases) {
      const tx = await addTx(t.admin, { amount: 1000, occurredAt });
      expect(tx.occurredDate, occurredAt).toBe(date);
    }
    const nov = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(nov.items.map((i) => i.occurredDate).sort()).toEqual([
      '2026-11-01',
      '2026-11-15',
      '2026-11-30',
    ]);
    const summary = (await t.admin.get('/api/summary?month=2026-11')).json<MonthSummary>();
    expect(summary.expense).toBe(3000);
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily[0]).toMatchObject({ date: '2026-11-01', expense: 1000 });
    expect(summary.daily[29]).toMatchObject({ date: '2026-11-30', expense: 1000 });
    expect(summary.previous).toMatchObject({ month: '2026-10', expense: 1000 });
    const dec = (await t.admin.get('/api/summary?month=2026-12')).json<MonthSummary>();
    expect(dec.expense).toBe(1000);
  });

  it('re-derives the local date when the time is edited', async () => {
    const t = await setup();
    const tx = await addTx(t.admin, { amount: 500, occurredAt: '2026-11-10T12:00:00+09:00' });
    const moved = await t.admin.patch(`/api/transactions/${tx.id}`, {
      occurredAt: '2026-11-30T15:30:00Z',
    });
    expect(moved.json<TransactionInfo>().occurredDate).toBe('2026-12-01');
  });
});

describe('summary rules', () => {
  it('excludes transfers and cancelled items, keeps needs_review, rolls up to top categories', async () => {
    const t = await setup();
    const at = '2026-11-10T12:00:00+09:00';
    await addTx(t.admin, { amount: 10000, occurredAt: at, categoryId: t.cat('식비/외식') });
    await addTx(t.admin, { amount: 5000, occurredAt: at, categoryId: t.cat('식비/카페·간식') });
    await addTx(t.admin, { amount: 3000, occurredAt: at, categoryId: t.cat('식비') });
    await addTx(t.admin, {
      amount: 7000,
      occurredAt: at,
      categoryId: t.cat('교통·차량/택시'),
      status: 'needs_review',
    });
    await addTx(t.admin, {
      amount: 99000,
      occurredAt: at,
      categoryId: t.cat('쇼핑/의류·잡화'),
      status: 'cancelled',
    });
    await addTx(t.admin, { amount: 500000, occurredAt: at, type: 'transfer' });
    await addTx(t.admin, { amount: 2000, occurredAt: at }); // 미분류
    await addTx(t.admin, {
      amount: 3000000,
      occurredAt: at,
      type: 'income',
      categoryId: t.cat('근로소득/급여'),
    });

    const s = (await t.admin.get('/api/summary?month=2026-11')).json<MonthSummary>();
    expect(s.expense).toBe(10000 + 5000 + 3000 + 7000 + 2000);
    expect(s.income).toBe(3000000);
    expect(s.expenseByCategory).toEqual([
      { categoryId: t.cat('식비'), name: '식비', amount: 18000, count: 3 },
      { categoryId: t.cat('교통·차량'), name: '교통·차량', amount: 7000, count: 1 },
      { categoryId: null, name: '미분류', amount: 2000, count: 1 },
    ]);
    expect(s.incomeByCategory[0]).toMatchObject({ name: '근로소득', amount: 3000000 });
    expect(s.uncategorizedCount).toBe(1);
    expect(s.needsReviewCount).toBe(1);
    expect(s.transactionCount).toBe(8);
    expect(s.daily.find((d) => d.date === '2026-11-10')).toMatchObject({
      expense: 27000,
      income: 3000000,
    });

    const page = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(page.totals).toEqual({ expense: 27000, income: 3000000, count: 8 });
  });

  it('uses the net amount after a partial cancellation', async () => {
    const t = await setup();
    const tx = await addTx(t.admin, { amount: 30000, occurredAt: '2026-11-03T10:00:00+09:00' });
    // Stage 4/5 importers record partial cancels like this.
    t.db
      .update(transactions)
      .set({ amount: 18000, originalAmount: 30000 })
      .where(eq(transactions.id, tx.id))
      .run();
    const s = (await t.admin.get('/api/summary?month=2026-11')).json<MonthSummary>();
    expect(s.expense).toBe(18000);
    const edited = (
      await t.admin.patch(`/api/transactions/${tx.id}`, { amount: 40000 })
    ).json<TransactionInfo>();
    expect(edited.originalAmount).toBeNull(); // amount above the original resets it
  });

  it('switches between family and one member', async () => {
    const t = await setup();
    const at = '2026-11-05T10:00:00+09:00';
    await addTx(t.admin, { amount: 1000, occurredAt: at });
    await addTx(t.member, { amount: 2000, occurredAt: at });
    await addTx(t.admin, { amount: 4000, occurredAt: at, ownerUserId: t.memberId });
    const all = (await t.admin.get('/api/summary?month=2026-11&owner=all')).json<MonthSummary>();
    const member = (
      await t.admin.get(`/api/summary?month=2026-11&owner=${t.memberId}`)
    ).json<MonthSummary>();
    expect(all.expense).toBe(7000);
    expect(member.expense).toBe(6000);
    expect(member.owner).toBe(t.memberId);
  });
});

describe('separate ledgers', () => {
  it("keeps members out of each other's transactions; an admin sees everyone's", async () => {
    const t = await setup();
    const other = await invite(t, t.admin, {
      displayName: '둘째',
      loginName: 'second',
      password: 'battery staple 3',
    });
    await other.patch('/api/me', { lockTimeoutSeconds: null });
    const at = '2026-11-08T10:00:00+09:00';
    const mine = await addTx(t.member, { amount: 1000, occurredAt: at, merchant: '구성원가게' });
    const theirs = await addTx(other, { amount: 2000, occurredAt: at, merchant: '둘째가게' });
    const admins = await addTx(t.admin, { amount: 4000, occurredAt: at, merchant: '관리자가게' });

    const list = (await t.member.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
    expect(list.totals?.expense).toBe(1000);
    const search = (
      await t.member.get('/api/transactions?month=2026-11&q=가게')
    ).json<TransactionPage>();
    expect(search.items.map((i) => i.id)).toEqual([mine.id]);
    const summary = (await t.member.get('/api/summary?month=2026-11')).json<MonthSummary>();
    expect(summary.expense).toBe(1000);
    for (const id of [theirs.id, admins.id]) {
      expect((await t.member.get(`/api/transactions/${id}`)).statusCode).toBe(404);
      expect((await t.member.patch(`/api/transactions/${id}`, { amount: 1 })).statusCode).toBe(404);
      expect((await t.member.delete(`/api/transactions/${id}`)).statusCode).toBe(404);
    }
    expect(
      (
        await t.member.post('/api/transactions/bulk', {
          ids: [mine.id, theirs.id],
          status: 'confirmed',
        })
      ).statusCode,
    ).toBe(404);
    // Asking for someone else's scope is refused rather than quietly empty.
    expect((await t.member.get(`/api/summary?owner=${t.adminId}`)).statusCode).toBe(403);
    expect(
      (await t.member.get(`/api/stats/range?from=2026-11&to=2026-11&owner=${t.adminId}`))
        .statusCode,
    ).toBe(403);
    const stats = (
      await t.member.get('/api/stats/range?from=2026-11&to=2026-11')
    ).json<RangeStats>();
    expect(stats.months[0]?.expense).toBe(1000);
    expect(stats.members).toEqual([]);

    const all = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(all.items.map((i) => i.id).sort()).toEqual([mine.id, theirs.id, admins.id].sort());
    expect(
      (await t.admin.get('/api/summary?month=2026-11&owner=all')).json<MonthSummary>().expense,
    ).toBe(7000);
    const family = (
      await t.admin.get('/api/stats/range?from=2026-11&to=2026-11')
    ).json<RangeStats>();
    expect(family.members.map((m) => m.expense).sort()).toEqual([1000, 2000, 4000]);
    expect((await t.admin.get(`/api/transactions/${theirs.id}`)).statusCode).toBe(200);
  });

  it('lets only an admin record for someone else', async () => {
    const t = await setup();
    const forAdmin = await t.member.post('/api/transactions', {
      type: 'expense',
      amount: 100,
      ownerUserId: t.adminId,
    });
    expect(forAdmin.statusCode).toBe(403);
    const own = await addTx(t.member, { amount: 100 });
    expect(
      (await t.member.patch(`/api/transactions/${own.id}`, { ownerUserId: t.adminId })).statusCode,
    ).toBe(403);
    const forMember = await addTx(t.admin, { amount: 300, ownerUserId: t.memberId });
    expect((await t.member.get(`/api/transactions/${forMember.id}`)).statusCode).toBe(200);
  });

  it("refuses another member's card or account as the payment method", async () => {
    const t = await setup();
    const adminCard = await addAccount(t.admin, { name: '관리자카드' });
    const family = await addAccount(t.admin, { name: '가족카드', primaryUserId: t.memberId });
    const res = await t.member.post('/api/transactions', {
      type: 'expense',
      amount: 100,
      accountId: adminCard.id,
    });
    expect(code(res)).toBe('account_invalid');
    expect((await addTx(t.member, { amount: 100, accountId: family.id })).accountName).toBe(
      '가족카드',
    );
    const own = await addTx(t.member, { amount: 100 });
    expect(
      code(
        await t.member.post('/api/transactions/bulk', { ids: [own.id], accountId: adminCard.id }),
      ),
    ).toBe('account_invalid');
  });
});

describe('private transactions', () => {
  it('are visible to and counted for their owner only', async () => {
    const t = await setup();
    const at = '2026-11-08T10:00:00+09:00';
    await addTx(t.member, { amount: 1000, occurredAt: at });
    const secret = await addTx(t.member, {
      amount: 50000,
      occurredAt: at,
      isPrivate: true,
      merchant: '비밀 선물',
    });

    const own = (await t.member.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(own.items.map((i) => i.id)).toContain(secret.id);
    expect(own.totals?.expense).toBe(51000);
    expect((await t.member.get('/api/summary?month=2026-11')).json<MonthSummary>().expense).toBe(
      51000,
    );

    const other = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(other.items.map((i) => i.id)).not.toContain(secret.id);
    expect(other.totals?.expense).toBe(1000);
    expect(other.days?.[0]?.count).toBe(1);
    const search = (
      await t.admin.get('/api/transactions?month=2026-11&q=비밀')
    ).json<TransactionPage>();
    expect(search.items).toEqual([]);
    for (const owner of ['all', String(t.memberId)]) {
      const s = (
        await t.admin.get(`/api/summary?month=2026-11&owner=${owner}`)
      ).json<MonthSummary>();
      expect(s.expense, owner).toBe(1000);
      expect(s.transactionCount).toBe(1);
    }
    expect((await t.admin.get(`/api/transactions/${secret.id}`)).statusCode).toBe(404);
    expect((await t.admin.patch(`/api/transactions/${secret.id}`, { amount: 1 })).statusCode).toBe(
      404,
    );
    expect((await t.admin.delete(`/api/transactions/${secret.id}`)).statusCode).toBe(404);
  });

  it('can only be made by the owner', async () => {
    const t = await setup();
    const res = await t.admin.post('/api/transactions', {
      type: 'expense',
      amount: 100,
      ownerUserId: t.memberId,
      isPrivate: true,
    });
    expect(res.statusCode).toBe(400);
    const mine = await addTx(t.admin, { amount: 100, isPrivate: true });
    expect(
      (await t.admin.patch(`/api/transactions/${mine.id}`, { ownerUserId: t.memberId })).statusCode,
    ).toBe(400);
  });
});

describe('transaction validation and editing', () => {
  it('rejects mismatched, archived or impossible references', async () => {
    const t = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ amount: 0 }, 'validation_error'],
      [{ amount: 1.5 }, 'validation_error'],
      [{ amount: 1000, categoryId: t.cat('근로소득/급여') }, 'category_invalid'],
      [{ amount: 1000, type: 'transfer', categoryId: t.cat('식비') }, 'category_invalid'],
      [{ amount: 1000, categoryId: 99999 }, 'category_invalid'],
      [{ amount: 1000, accountId: 99999 }, 'account_invalid'],
      [{ amount: 1000, occurredAt: '2026-11-01' }, 'validation_error'],
      [{ amount: 1000, occurredAt: '1999-12-31T00:00:00Z' }, 'validation_error'],
      [{ amount: 1000, status: 'pending' }, 'validation_error'],
    ];
    for (const [body, expected] of cases) {
      const res = await t.admin.post('/api/transactions', { type: 'expense', ...body });
      expect(code(res), JSON.stringify(body)).toBe(expected);
    }
  });

  it('keeps an archived category on old entries but refuses it for new ones', async () => {
    const t = await setup();
    const taxi = t.cat('교통·차량/택시');
    const tx = await addTx(t.admin, { amount: 8000, categoryId: taxi });
    await t.admin.patch(`/api/categories/${taxi}`, { archived: true });
    expect(
      code(
        await t.admin.post('/api/transactions', { type: 'expense', amount: 1, categoryId: taxi }),
      ),
    ).toBe('category_invalid');
    expect((await t.admin.patch(`/api/transactions/${tx.id}`, { memo: '야근' })).statusCode).toBe(
      200,
    );
  });

  it('clears the category when the type changes, and sets status', async () => {
    const t = await setup();
    const tx = await addTx(t.admin, { amount: 8000, categoryId: t.cat('식비') });
    const asIncome = (
      await t.admin.patch(`/api/transactions/${tx.id}`, { type: 'income' })
    ).json<TransactionInfo>();
    expect(asIncome).toMatchObject({ type: 'income', categoryId: null });
    const cancelled = (
      await t.admin.patch(`/api/transactions/${tx.id}`, { status: 'cancelled' })
    ).json<TransactionInfo>();
    expect(cancelled.status).toBe('cancelled');
  });

  it("lets an admin edit and delete a member's transactions", async () => {
    const t = await setup();
    const tx = await addTx(t.member, { amount: 8000, merchant: '행복마트' });
    const edited = await t.admin.patch(`/api/transactions/${tx.id}`, {
      categoryId: t.cat('생활/생활용품'),
    });
    expect(edited.json<TransactionInfo>().categoryName).toBe('생활 > 생활용품');
    expect((await t.admin.delete(`/api/transactions/${tx.id}`)).statusCode).toBe(204);
    expect((await t.member.get(`/api/transactions/${tx.id}`)).statusCode).toBe(404);
  });

  it('defaults to now, the signed-in owner and manual source', async () => {
    const t = await setup();
    const tx = await addTx(t.member, { amount: 1234 });
    expect(tx).toMatchObject({ ownerUserId: t.memberId, source: 'manual', status: 'confirmed' });
    expect(Date.parse(tx.occurredAt)).toBe(t.clock.now());
  });
});

describe('list filters', () => {
  it('filters by type, category (parent includes children), none, account, owner, amount, status and text', async () => {
    const t = await setup();
    const card = await addAccount(t.admin, { name: '신한카드' });
    const at = '2026-11-12T10:00:00+09:00';
    const a = await addTx(t.admin, {
      amount: 12000,
      occurredAt: at,
      categoryId: t.cat('식비/외식'),
      accountId: card.id,
      merchant: '달빛분식',
    });
    const b = await addTx(t.admin, {
      amount: 4500,
      occurredAt: at,
      categoryId: t.cat('식비'),
      memo: '100% 할인_쿠폰',
    });
    const c = await addTx(t.member, {
      amount: 60000,
      occurredAt: at,
      categoryId: t.cat('쇼핑/의류·잡화'),
      status: 'needs_review',
    });
    const d = await addTx(t.member, { amount: 900, occurredAt: at });
    const e = await addTx(t.admin, { amount: 2500000, occurredAt: at, type: 'income' });
    await addTx(t.admin, { amount: 300000, occurredAt: at, type: 'transfer' });

    const ids = async (query: string) =>
      (await t.admin.get(`/api/transactions?month=2026-11&${query}`))
        .json<TransactionPage>()
        .items.map((i) => i.id)
        .sort((x, y) => x - y);

    expect(await ids(`category=${t.cat('식비')}`)).toEqual([a.id, b.id]);
    expect(await ids(`category=${t.cat('식비/외식')}`)).toEqual([a.id]);
    expect(await ids('category=none')).toEqual([d.id, e.id]);
    expect(await ids('type=income')).toEqual([e.id]);
    expect(await ids(`accountId=${card.id}`)).toEqual([a.id]);
    expect(await ids(`ownerId=${t.memberId}`)).toEqual([c.id, d.id]);
    expect(await ids('minAmount=4500&maxAmount=60000')).toEqual([a.id, b.id, c.id]);
    expect(await ids('status=needs_review')).toEqual([c.id]);
    expect(await ids(`q=${encodeURIComponent('분식')}`)).toEqual([a.id]);
    expect(await ids(`q=${encodeURIComponent('100%')}`)).toEqual([b.id]);
    expect(await ids(`q=${encodeURIComponent('_')}`)).toEqual([b.id]);
    expect(await ids(`q=${encodeURIComponent('%')}`)).toEqual([b.id]);
    expect((await t.admin.get('/api/transactions?month=2026-13')).statusCode).toBe(400);
    expect((await t.admin.get('/api/transactions')).statusCode).toBe(400);
  });
});

describe('cursor pagination', () => {
  it('walks a month without gaps or repeats, even with equal timestamps and concurrent inserts', async () => {
    const t = await setup();
    const instants = ['2026-11-20T10:00:00Z', '2026-11-20T10:00:00Z', '2026-11-19T10:00:00Z'];
    const created: number[] = [];
    for (let i = 0; i < 75; i += 1) {
      created.push((await addTx(t.admin, { amount: 100 + i, occurredAt: instants[i % 3] })).id);
    }
    const seen: TransactionInfo[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/transactions?month=2026-11&limit=20${cursor ? `&cursor=${cursor}` : ''}`;
      const page: TransactionPage = (await t.admin.get(url)).json<TransactionPage>();
      if (pages === 0) {
        expect(page.days).toBeDefined();
        // A newer entry arriving mid-scroll must not disturb older pages.
        await addTx(t.admin, { amount: 1, occurredAt: '2026-11-25T10:00:00Z' });
      } else {
        expect(page.days).toBeUndefined();
      }
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen.map((s) => s.id).sort((a, b) => a - b)).toEqual(created);
    for (let i = 1; i < seen.length; i += 1) {
      const prev = seen[i - 1]!;
      const cur = seen[i]!;
      const order = Date.parse(prev.occurredAt) - Date.parse(cur.occurredAt) || prev.id - cur.id;
      expect(order).toBeGreaterThan(0);
    }
    expect((await t.admin.get('/api/transactions?month=2026-11&cursor=garbage')).statusCode).toBe(
      400,
    );
  });
});

describe('entry defaults', () => {
  it('suggests recent categories and the last used account', async () => {
    const t = await setup();
    let d = (await t.member.get('/api/entry-defaults')).json<EntryDefaults>();
    expect(d).toEqual({
      accountId: null,
      hasOwnAccount: false,
      recentCategoryIds: { expense: [], income: [] },
    });
    const cash = await addAccount(t.member, { kind: 'cash', name: '현금' });
    const card = await addAccount(t.member, { name: '카드' });
    d = (await t.member.get('/api/entry-defaults')).json<EntryDefaults>();
    expect(d).toMatchObject({ accountId: cash.id, hasOwnAccount: true });
    await addTx(t.member, { amount: 1, categoryId: t.cat('식비/외식'), accountId: card.id });
    t.clock.advance(1000);
    await addTx(t.member, { amount: 1, categoryId: t.cat('생활/편의점'), accountId: card.id });
    d = (await t.member.get('/api/entry-defaults')).json<EntryDefaults>();
    expect(d.accountId).toBe(card.id);
    expect(d.recentCategoryIds.expense).toEqual([t.cat('생활/편의점'), t.cat('식비/외식')]);
  });
});
