/** Card billing months (결제월), the 결제월 list basis and bulk edits. */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AccountInfo,
  HomeSummary,
  RangeStats,
  TransactionInfo,
  TransactionPage,
  YearStats,
} from '@budget/shared';
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

describe('card payment day and usage-period cutoff', () => {
  it('fills the usual cutoff, keeps a chosen one, and clears both for non-cards', async () => {
    const t = await setup();
    const card = await addAccount(t.admin, { billingDay: 25 });
    expect(card).toMatchObject({ billingDay: 25, cutoffDay: 11 });

    const custom = await addAccount(t.admin, { billingDay: 25, cutoffDay: 12 });
    expect(custom.cutoffDay).toBe(12);

    // Editing something else keeps the chosen cutoff.
    const renamed = await t.admin.patch(`/api/accounts/${custom.id}`, { name: '새 이름' });
    expect(renamed.json<AccountInfo>().cutoffDay).toBe(12);

    // A new payment day without a cutoff moves the cutoff along.
    const moved = await t.admin.patch(`/api/accounts/${custom.id}`, { billingDay: 14 });
    expect(moved.json<AccountInfo>()).toMatchObject({ billingDay: 14, cutoffDay: 31 });

    const bank = await addAccount(t.admin, { kind: 'bank', billingDay: 25, cutoffDay: 3 });
    expect(bank).toMatchObject({ billingDay: null, cutoffDay: null });

    const pay = await addAccount(t.admin, { kind: 'pay', name: '카카오페이' });
    expect(pay.kind).toBe('pay');
  });
});

describe('billing month and the 결제월 basis', () => {
  it('reports each card transaction’s billing month and lists by it', async () => {
    const t = await setup();
    const card = await addAccount(t.admin, { name: '25일 카드', billingDay: 25 });
    const bank = await addAccount(t.admin, { kind: 'bank', name: '통장' });
    const early = await addTx(t.admin, {
      amount: 1000,
      accountId: card.id,
      occurredAt: '2026-11-05T12:00:00+09:00',
    });
    const late = await addTx(t.admin, {
      amount: 2000,
      accountId: card.id,
      occurredAt: '2026-11-25T12:00:00+09:00',
    });
    const debit = await addTx(t.admin, {
      amount: 4000,
      accountId: bank.id,
      occurredAt: '2026-11-25T12:00:00+09:00',
    });
    const octLate = await addTx(t.admin, {
      amount: 8000,
      accountId: card.id,
      occurredAt: '2026-10-20T12:00:00+09:00',
    });
    expect(early).toMatchObject({ accountKind: 'card', billingMonth: '2026-11' });
    expect(late.billingMonth).toBe('2026-12');
    expect(debit).toMatchObject({ accountKind: 'bank', billingMonth: null });

    const byDate = (await t.admin.get('/api/transactions?month=2026-11')).json<TransactionPage>();
    expect(byDate.totals).toMatchObject({ expense: 7000, count: 3 });

    const byBilling = (
      await t.admin.get('/api/transactions?month=2026-11&basis=billing')
    ).json<TransactionPage>();
    expect(byBilling.items.map((i) => i.id).sort()).toEqual(
      [early.id, debit.id, octLate.id].sort(),
    );
    expect(byBilling.totals).toMatchObject({ expense: 13000, count: 3 });

    const dec = (
      await t.admin.get('/api/transactions?month=2026-12&basis=billing')
    ).json<TransactionPage>();
    expect(dec.items.map((i) => i.id)).toEqual([late.id]);
  });
});

describe('home and statistics by 결제월', () => {
  it('counts card spending in its billing month and on the payment day', async () => {
    const t = await setup();
    const card = await addAccount(t.admin, { name: '25일 카드', billingDay: 25 });
    const food = t.cat('식비/외식');
    // Paid 11/25 (used before the 11th cutoff) and 12/25 (used after it).
    await addTx(t.admin, {
      amount: 1000,
      accountId: card.id,
      categoryId: food,
      occurredAt: '2026-11-05T12:00:00+09:00',
    });
    await addTx(t.admin, {
      amount: 2000,
      accountId: card.id,
      categoryId: food,
      occurredAt: '2026-11-20T12:00:00+09:00',
    });
    await addTx(t.admin, { amount: 4000, occurredAt: '2026-11-20T12:00:00+09:00' });
    await addTx(t.admin, {
      amount: 8000,
      accountId: card.id,
      categoryId: food,
      occurredAt: '2026-10-20T12:00:00+09:00',
    });
    await t.admin.put('/api/budgets', { month: '2026-11', categoryId: null, amount: 100000 });

    const byDate = (await t.admin.get('/api/summary?month=2026-11')).json<HomeSummary>();
    expect(byDate).toMatchObject({ basis: 'date', expense: 7000 });

    const nov = (await t.admin.get('/api/summary?month=2026-11&basis=billing')).json<HomeSummary>();
    expect(nov).toMatchObject({ basis: 'billing', expense: 13000 });
    expect(nov.previous.expense).toBe(0);
    expect(nov.daily.find((d) => d.date === '2026-11-25')?.expense).toBe(9000);
    expect(nov.daily.find((d) => d.date === '2026-11-20')?.expense).toBe(4000);
    expect(nov.expenseByCategory[0]).toMatchObject({ amount: 9000 });
    // Budgets keep counting by the day the money was spent.
    expect(nov.budgets?.overall?.spent).toBe(7000);

    const range = (
      await t.admin.get('/api/stats/range?from=2026-10&to=2026-12&basis=billing')
    ).json<RangeStats>();
    expect(range.basis).toBe('billing');
    expect(range.months.map((m) => m.expense)).toEqual([0, 13000, 2000]);
    const plain = (
      await t.admin.get('/api/stats/range?from=2026-10&to=2026-12')
    ).json<RangeStats>();
    expect(plain.months.map((m) => m.expense)).toEqual([8000, 7000, 0]);

    const year = (await t.admin.get('/api/stats/year?year=2026&basis=billing')).json<YearStats>();
    expect(year.months[10]?.expense).toBe(13000);
  });
});

describe('bulk edit', () => {
  it('re-categorises many entries, turning transfers into the category’s kind', async () => {
    const t = await setup();
    const at = '2026-11-10T12:00:00+09:00';
    const card = await addAccount(t.admin);
    const a = await addTx(t.admin, { amount: 1000, occurredAt: at });
    const b = await addTx(t.admin, { amount: 2000, occurredAt: at, type: 'transfer' });
    const c = await addTx(t.admin, { amount: 3000, occurredAt: at, type: 'income' });

    const food = t.cat('식비/외식');
    const res = await t.admin.post('/api/transactions/bulk', {
      ids: [a.id, b.id, c.id],
      categoryId: food,
      accountId: card.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ updated: 3 });
    for (const id of [a.id, b.id, c.id]) {
      const tx = (await t.admin.get(`/api/transactions/${id}`)).json<TransactionInfo>();
      expect(tx).toMatchObject({ type: 'expense', categoryId: food, accountId: card.id });
    }

    // Making them transfers clears the category; status can change at the same time.
    await t.admin.post('/api/transactions/bulk', {
      ids: [a.id, b.id],
      type: 'transfer',
      status: 'needs_review',
    });
    const moved = (await t.admin.get(`/api/transactions/${a.id}`)).json<TransactionInfo>();
    expect(moved).toMatchObject({ type: 'transfer', categoryId: null, status: 'needs_review' });
  });

  it('rejects mismatched kinds, empty changes and entries the person cannot see', async () => {
    const t = await setup();
    const at = '2026-11-10T12:00:00+09:00';
    const mine = await addTx(t.admin, { amount: 1000, occurredAt: at });
    const hidden = await addTx(t.member, { amount: 1000, occurredAt: at, isPrivate: true });

    const mismatch = await t.admin.post('/api/transactions/bulk', {
      ids: [mine.id],
      type: 'income',
      categoryId: t.cat('식비'),
    });
    expect(code(mismatch)).toBe('category_invalid');

    const empty = await t.admin.post('/api/transactions/bulk', { ids: [mine.id] });
    expect(empty.statusCode).toBe(400);

    const other = await t.admin.post('/api/transactions/bulk', {
      ids: [mine.id, hidden.id],
      categoryId: null,
    });
    expect(other.statusCode).toBe(404);
  });

  it('lists every id the filters match for select-all', async () => {
    const t = await setup();
    const at = '2026-11-10T12:00:00+09:00';
    const x = await addTx(t.admin, { amount: 1000, occurredAt: at, merchant: '구름카페' });
    await addTx(t.admin, { amount: 1000, occurredAt: at, merchant: '달빛분식' });
    const res = await t.admin.get('/api/transactions/ids?month=2026-11&q=구름');
    expect(res.json()).toEqual({ ids: [x.id], truncated: false });
  });
});
