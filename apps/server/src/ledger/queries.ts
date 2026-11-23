/**
 * Transaction queries. Every read goes through `visibleTo`, so a private
 * transaction is only ever seen (and counted) by its owner.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  addDays,
  addMonths,
  daysInMonth,
  monthRange,
  type CategoryShare,
  type DayTotal,
  type MonthSummary,
  type TransactionInfo,
  type TransactionStatus,
  type TransactionType,
  type YearMonth,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { accounts, categories, rawRecords, transactions, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';

export function visibleTo(userId: number): SQL {
  return or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, userId)) as SQL;
}

/** Counted in totals: not cancelled. Transfers are excluded by summing only expense/income. */
const counted = ne(transactions.status, 'cancelled');
const sumOf = (type: TransactionType) =>
  sql<number>`coalesce(sum(case when ${transactions.type} = ${type} and ${transactions.status} <> 'cancelled' then ${transactions.amount} else 0 end), 0)`;

export interface ListFilters {
  month: YearMonth;
  type?: TransactionType;
  /** A category id (a parent includes its children), or 'none' for 미분류. */
  category?: number | 'none';
  accountId?: number;
  ownerId?: number;
  status?: TransactionStatus;
  minAmount?: number;
  maxAmount?: number;
  q?: string;
}

interface Cursor {
  t: number;
  id: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.t, c.id])).toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  try {
    const [t, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown[];
    if (Number.isSafeInteger(t) && Number.isSafeInteger(id))
      return { t: t as number, id: id as number };
  } catch {
    // fall through
  }
  throw errors.validation('Invalid cursor');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterConditions(db: AppDatabase, viewerId: number, f: ListFilters): SQL[] {
  const { start, end } = monthRange(f.month);
  const where: SQL[] = [
    visibleTo(viewerId),
    gte(transactions.occurredAt, new Date(start)),
    lt(transactions.occurredAt, new Date(end)),
  ];
  if (f.type) where.push(eq(transactions.type, f.type));
  if (f.status) where.push(eq(transactions.status, f.status));
  if (f.accountId) where.push(eq(transactions.accountId, f.accountId));
  if (f.ownerId) where.push(eq(transactions.ownerUserId, f.ownerId));
  if (f.minAmount !== undefined) where.push(gte(transactions.amount, f.minAmount));
  if (f.maxAmount !== undefined) where.push(lte(transactions.amount, f.maxAmount));
  if (f.category === 'none') {
    where.push(isNull(transactions.categoryId), ne(transactions.type, 'transfer'));
  } else if (f.category !== undefined) {
    const ids = db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.id, f.category), eq(categories.parentId, f.category)))
      .all()
      .map((r) => r.id);
    where.push(ids.length ? inArray(transactions.categoryId, ids) : sql`0`);
  }
  const q = f.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where.push(
      sql`(${transactions.merchant} like ${pattern} escape '\\' or ${transactions.memo} like ${pattern} escape '\\')`,
    );
  }
  return where;
}

const category = alias(categories, 'category');
const parent = alias(categories, 'parent_category');
const owner = alias(users, 'owner');

function selectInfo(db: AppDatabase) {
  return db
    .select({
      t: transactions,
      categoryName: category.name,
      parentName: parent.name,
      parentId: parent.id,
      accountName: accounts.name,
      ownerName: owner.displayName,
      hasSms: sql<number>`exists (select 1 from ${rawRecords} where ${rawRecords.transactionId} = ${transactions.id} and ${rawRecords.source} = 'sms')`,
    })
    .from(transactions)
    .leftJoin(category, eq(transactions.categoryId, category.id))
    .leftJoin(parent, eq(category.parentId, parent.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
    .innerJoin(owner, eq(transactions.ownerUserId, owner.id));
}

type InfoRow = Awaited<ReturnType<ReturnType<typeof selectInfo>['all']>>[number];

function toInfo(r: InfoRow): TransactionInfo {
  const t = r.t;
  return {
    id: t.id,
    occurredAt: t.occurredAt.toISOString(),
    occurredDate: t.occurredDate,
    type: t.type,
    amount: t.amount,
    originalAmount: t.originalAmount,
    merchant: t.merchant,
    memo: t.memo,
    categoryId: t.categoryId,
    categoryName: r.categoryName
      ? r.parentName
        ? `${r.parentName} > ${r.categoryName}`
        : r.categoryName
      : null,
    topCategoryId: t.categoryId === null ? null : (r.parentId ?? t.categoryId),
    accountId: t.accountId,
    accountName: r.accountName ?? null,
    ownerUserId: t.ownerUserId,
    ownerName: r.ownerName,
    status: t.status,
    source: t.source,
    installmentMonths: t.installmentMonths,
    isPrivate: t.isPrivate,
    hasSms: Boolean(r.hasSms),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function getTransaction(
  db: AppDatabase,
  viewerId: number,
  id: number,
): TransactionInfo | null {
  const row = selectInfo(db)
    .where(and(eq(transactions.id, id), visibleTo(viewerId)))
    .get();
  return row ? toInfo(row) : null;
}

export function listTransactions(
  db: AppDatabase,
  viewerId: number,
  filters: ListFilters,
  page: { cursor?: string; limit: number },
) {
  const where = filterConditions(db, viewerId, filters);
  const pageWhere = [...where];
  if (page.cursor) {
    const c = decodeCursor(page.cursor);
    const at = new Date(c.t);
    pageWhere.push(
      or(
        lt(transactions.occurredAt, at),
        and(eq(transactions.occurredAt, at), lt(transactions.id, c.id)),
      ) as SQL,
    );
  }
  // Newest first; id breaks ties so pages never skip or repeat rows.
  const rows = selectInfo(db)
    .where(and(...pageWhere))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(page.limit + 1)
    .all();
  const more = rows.length > page.limit;
  const items = rows.slice(0, page.limit).map(toInfo);
  const last = items.at(-1);
  const nextCursor =
    more && last ? encodeCursor({ t: Date.parse(last.occurredAt), id: last.id }) : null;

  if (page.cursor) return { items, nextCursor };

  const days: DayTotal[] = db
    .select({
      date: transactions.occurredDate,
      expense: sumOf('expense'),
      income: sumOf('income'),
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...where))
    .groupBy(transactions.occurredDate)
    .orderBy(desc(transactions.occurredDate))
    .all();
  const totals = days.reduce(
    (acc, d) => ({
      expense: acc.expense + d.expense,
      income: acc.income + d.income,
      count: acc.count + d.count,
    }),
    { expense: 0, income: 0, count: 0 },
  );
  return { items, nextCursor, days, totals };
}

function monthWhere(viewerId: number, month: YearMonth, ownerId: number | null): SQL[] {
  const { start, end } = monthRange(month);
  const where = [
    visibleTo(viewerId),
    gte(transactions.occurredAt, new Date(start)),
    lt(transactions.occurredAt, new Date(end)),
  ];
  if (ownerId !== null) where.push(eq(transactions.ownerUserId, ownerId));
  return where;
}

function totalsFor(db: AppDatabase, where: SQL[]) {
  return (
    db
      .select({ expense: sumOf('expense'), income: sumOf('income') })
      .from(transactions)
      .where(and(...where))
      .get() ?? { expense: 0, income: 0 }
  );
}

function sharesFor(db: AppDatabase, where: SQL[], type: 'expense' | 'income'): CategoryShare[] {
  const top = sql<number | null>`coalesce(${category.parentId}, ${category.id})`;
  const rows = db
    .select({
      categoryId: top,
      amount: sql<number>`sum(${transactions.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .leftJoin(category, eq(transactions.categoryId, category.id))
    .where(and(...where, eq(transactions.type, type), counted))
    .groupBy(top)
    .all();
  const ids = rows.map((r) => r.categoryId).filter((id): id is number => id !== null);
  const names = new Map(
    ids.length
      ? db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, ids))
          .all()
          .map((c) => [c.id, c.name])
      : [],
  );
  return rows
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.categoryId === null ? '미분류' : (names.get(r.categoryId) ?? '알 수 없음'),
      amount: r.amount,
      count: r.count,
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'ko'));
}

export function monthSummary(
  db: AppDatabase,
  viewerId: number,
  month: YearMonth,
  ownerId: number | null,
): MonthSummary {
  const where = monthWhere(viewerId, month, ownerId);
  const previousMonth = addMonths(month, -1);
  const current = totalsFor(db, where);
  const previous = totalsFor(db, monthWhere(viewerId, previousMonth, ownerId));

  const byDay = new Map(
    db
      .select({
        date: transactions.occurredDate,
        expense: sumOf('expense'),
        income: sumOf('income'),
        count: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(and(...where))
      .groupBy(transactions.occurredDate)
      .all()
      .map((d) => [d.date, d]),
  );
  const daily: DayTotal[] = [];
  for (let i = 0, date = `${month}-01`; i < daysInMonth(month); i += 1, date = addDays(date, 1)) {
    daily.push(byDay.get(date) ?? { date, expense: 0, income: 0, count: 0 });
  }

  const counts = db
    .select({
      uncategorized: sql<number>`coalesce(sum(case when ${transactions.categoryId} is null and ${transactions.type} <> 'transfer' and ${transactions.status} <> 'cancelled' then 1 else 0 end), 0)`,
      needsReview: sql<number>`coalesce(sum(case when ${transactions.status} = 'needs_review' then 1 else 0 end), 0)`,
      total: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...where))
    .get() ?? { uncategorized: 0, needsReview: 0, total: 0 };

  return {
    month,
    owner: ownerId ?? 'all',
    expense: current.expense,
    income: current.income,
    previous: { month: previousMonth, ...previous },
    expenseByCategory: sharesFor(db, where, 'expense'),
    incomeByCategory: sharesFor(db, where, 'income'),
    daily,
    uncategorizedCount: counts.uncategorized,
    needsReviewCount: counts.needsReview,
    transactionCount: counts.total,
  };
}

/** Recently used categories (by this user) and the account to preselect for quick entry. */
export function entryDefaults(db: AppDatabase, userId: number) {
  const recent = (type: 'expense' | 'income') =>
    db
      .select({ id: transactions.categoryId, last: sql<number>`max(${transactions.createdAt})` })
      .from(transactions)
      .innerJoin(category, eq(transactions.categoryId, category.id))
      .where(
        and(
          eq(transactions.createdByUserId, userId),
          eq(transactions.type, type),
          isNull(category.archivedAt),
        ),
      )
      .groupBy(transactions.categoryId)
      .orderBy(desc(sql`max(${transactions.createdAt})`))
      .limit(8)
      .all()
      .map((r) => r.id as number);

  const lastUsed = db
    .select({ id: accounts.id })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(eq(transactions.createdByUserId, userId), isNull(accounts.archivedAt)))
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(1)
    .get();
  const own = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.ownerUserId, userId), isNull(accounts.archivedAt)))
    .orderBy(asc(accounts.sortOrder), asc(accounts.id))
    .all();
  return {
    accountId: lastUsed?.id ?? own[0]?.id ?? null,
    hasOwnAccount: own.length > 0,
    recentCategoryIds: { expense: recent('expense'), income: recent('income') },
  };
}
