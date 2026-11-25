/**
 * Statistics over a range of months. Like every ledger read they go through
 * `visibleTo`, so another member's private transactions are never counted.
 * Only expense and income are summed (이체 is excluded everywhere), and
 * cancelled transactions are left out.
 */
import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  addMonths,
  parseYearMonth,
  type CategorySeries,
  type ListBasis,
  type MemberSeries,
  type MerchantTotal,
  type MonthTotals,
  type RangeStats,
  type YearMonth,
  type YearStats,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { categories, transactions, users } from '../db/schema.ts';
import { monthOfSql, periodConditions, visibleTo } from '../ledger/queries.ts';

export const MAX_RANGE_MONTHS = 36;

const category = alias(categories, 'category');
const topCategory = sql<number | null>`coalesce(${category.parentId}, ${category.id})`;
const counted = ne(transactions.status, 'cancelled');
const sumOf = (type: 'expense' | 'income') =>
  sql<number>`coalesce(sum(case when ${transactions.type} = ${type} then ${transactions.amount} else 0 end), 0)`;

export function monthsBetween(from: YearMonth, to: YearMonth): YearMonth[] {
  const months: YearMonth[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  return months;
}

export function rangeWhere(
  viewerId: number,
  from: YearMonth,
  to: YearMonth,
  ownerId: number | null,
  basis: ListBasis = 'date',
): SQL[] {
  const where = [
    visibleTo(viewerId),
    ...periodConditions(from, to, basis),
    inArray(transactions.type, ['expense', 'income']),
    counted,
  ];
  if (ownerId !== null) where.push(eq(transactions.ownerUserId, ownerId));
  return where;
}

export function monthTotals(
  db: AppDatabase,
  where: SQL[],
  months: YearMonth[],
  basis: ListBasis = 'date',
): MonthTotals[] {
  const monthOf = monthOfSql(basis);
  const rows = new Map(
    db
      .select({ month: monthOf, expense: sumOf('expense'), income: sumOf('income') })
      .from(transactions)
      .where(and(...where))
      .groupBy(monthOf)
      .all()
      .map((r) => [r.month, r]),
  );
  return months.map((month) => ({
    month,
    expense: rows.get(month)?.expense ?? 0,
    income: rows.get(month)?.income ?? 0,
  }));
}

function categoryNames(db: AppDatabase, ids: number[]): Map<number, string> {
  if (!ids.length) return new Map();
  return new Map(
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.id, ids))
      .all()
      .map((c) => [c.id, c.name]),
  );
}

export function categorySeries(
  db: AppDatabase,
  where: SQL[],
  months: YearMonth[],
  basis: ListBasis = 'date',
): CategorySeries[] {
  const monthOf = monthOfSql(basis);
  const rows = db
    .select({
      month: monthOf,
      categoryId: topCategory,
      amount: sql<number>`sum(${transactions.amount})`,
    })
    .from(transactions)
    .leftJoin(category, eq(transactions.categoryId, category.id))
    .where(and(...where, eq(transactions.type, 'expense')))
    .groupBy(monthOf, topCategory)
    .all();
  const index = new Map(months.map((m, i) => [m, i]));
  const series = new Map<number | null, CategorySeries>();
  const names = categoryNames(
    db,
    rows.map((r) => r.categoryId).filter((id): id is number => id !== null),
  );
  for (const row of rows) {
    let s = series.get(row.categoryId);
    if (!s) {
      s = {
        categoryId: row.categoryId,
        name: row.categoryId === null ? '미분류' : (names.get(row.categoryId) ?? '알 수 없음'),
        total: 0,
        values: months.map(() => 0),
      };
      series.set(row.categoryId, s);
    }
    s.values[index.get(row.month) ?? 0] = row.amount;
    s.total += row.amount;
  }
  return [...series.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'),
  );
}

function memberSeries(
  db: AppDatabase,
  where: SQL[],
  months: YearMonth[],
  basis: ListBasis,
): MemberSeries[] {
  const monthOf = monthOfSql(basis);
  const rows = db
    .select({
      userId: transactions.ownerUserId,
      month: monthOf,
      expense: sumOf('expense'),
      income: sumOf('income'),
    })
    .from(transactions)
    .where(and(...where))
    .groupBy(transactions.ownerUserId, monthOf)
    .all();
  const index = new Map(months.map((m, i) => [m, i]));
  const members = db
    .select({ id: users.id, name: users.displayName, disabledAt: users.disabledAt })
    .from(users)
    .orderBy(asc(users.id))
    .all();
  const series = new Map<number, MemberSeries>(
    members.map((m) => [
      m.id,
      { userId: m.id, name: m.name, expense: 0, income: 0, values: months.map(() => 0) },
    ]),
  );
  for (const row of rows) {
    const s = series.get(row.userId);
    if (!s) continue;
    s.values[index.get(row.month) ?? 0] = row.expense;
    s.expense += row.expense;
    s.income += row.income;
  }
  // Disabled members only appear when they have something in the range.
  return members
    .map((m) => ({ member: m, s: series.get(m.id) }))
    .filter(
      (x): x is { member: (typeof members)[number]; s: MemberSeries } =>
        !!x.s && (!x.member.disabledAt || x.s.expense > 0 || x.s.income > 0),
    )
    .map((x) => x.s);
}

function topMerchants(db: AppDatabase, where: SQL[], limit: number): MerchantTotal[] {
  const key = sql<string>`coalesce(${transactions.merchantKey}, ${transactions.merchant})`;
  return db
    .select({
      merchant: sql<string>`max(${transactions.merchant})`,
      amount: sql<number>`sum(${transactions.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(and(...where, eq(transactions.type, 'expense'), isNotNull(transactions.merchant)))
    .groupBy(key)
    .orderBy(sql`sum(${transactions.amount}) desc`, sql`count(*) desc`, key)
    .limit(limit)
    .all();
}

export function rangeStats(
  db: AppDatabase,
  viewerId: number,
  from: YearMonth,
  to: YearMonth,
  ownerId: number | null,
  basis: ListBasis = 'date',
): RangeStats {
  const months = monthsBetween(from, to);
  const where = rangeWhere(viewerId, from, to, ownerId, basis);
  const series = monthTotals(db, where, months, basis);
  return {
    from,
    to,
    basis,
    owner: ownerId ?? 'all',
    months: series,
    totals: {
      expense: series.reduce((s, m) => s + m.expense, 0),
      income: series.reduce((s, m) => s + m.income, 0),
    },
    categories: categorySeries(db, where, months, basis),
    members: ownerId === null ? memberSeries(db, where, months, basis) : [],
    merchants: topMerchants(db, where, 10),
  };
}

export function yearStats(
  db: AppDatabase,
  viewerId: number,
  year: number,
  ownerId: number | null,
  currentMonth: YearMonth,
  basis: ListBasis = 'date',
): YearStats {
  const pad = (y: number) => String(y).padStart(4, '0');
  const current = rangeStats(db, viewerId, `${pad(year)}-01`, `${pad(year)}-12`, ownerId, basis);
  const prevFrom = `${pad(year - 1)}-01`;
  const prevTo = `${pad(year - 1)}-12`;
  // The year in progress is compared with the same months of the previous year.
  const { year: nowYear, month: nowMonth } = parseYearMonth(currentMonth);
  const throughMonth = year === nowYear ? nowMonth : 12;
  const prevThrough = `${pad(year - 1)}-${String(throughMonth).padStart(2, '0')}`;
  const prevMonths = monthTotals(
    db,
    rangeWhere(viewerId, prevFrom, prevTo, ownerId, basis),
    monthsBetween(prevFrom, prevTo),
    basis,
  );
  const prevWhere = rangeWhere(viewerId, prevFrom, prevThrough, ownerId, basis);
  const compared = prevMonths.slice(0, throughMonth);
  const prevCategories: Record<string, number> = {};
  for (const row of db
    .select({ categoryId: topCategory, amount: sql<number>`sum(${transactions.amount})` })
    .from(transactions)
    .leftJoin(category, eq(transactions.categoryId, category.id))
    .where(and(...prevWhere, eq(transactions.type, 'expense')))
    .groupBy(topCategory)
    .all()) {
    prevCategories[row.categoryId === null ? 'none' : String(row.categoryId)] = row.amount;
  }
  return {
    ...current,
    year,
    previous: {
      year: year - 1,
      months: prevMonths,
      through: prevThrough,
      totals: {
        expense: compared.reduce((s, m) => s + m.expense, 0),
        income: compared.reduce((s, m) => s + m.income, 0),
      },
      categories: prevCategories,
    },
  };
}

export function isValidRange(from: YearMonth, to: YearMonth): boolean {
  if (from > to) return false;
  const a = parseYearMonth(from);
  const b = parseYearMonth(to);
  return (b.year - a.year) * 12 + (b.month - a.month) < MAX_RANGE_MONTHS;
}
