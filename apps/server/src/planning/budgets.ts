/**
 * Budgets: every member keeps their own — one overall monthly budget plus
 * optional budgets on top-level expense categories — measured against their
 * own spending. A budget set for a month stays in force for later months
 * until it is changed; changing it in a month never rewrites earlier months.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  monthRange,
  toYearMonth,
  type BudgetChange,
  type BudgetMonthCell,
  type BudgetMonthRow,
  type BudgetMonthsReport,
  type BudgetPace,
  type BudgetProgress,
  type BudgetSetting,
  type CategoryShare,
  type MonthBudgets,
  type YearMonth,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { budgets, categories, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { categorySeries, monthTotals, monthsBetween, rangeWhere } from './stats.ts';

/** Spending more than this share ahead of the month's progress counts as "ahead". */
export const PACE_TOLERANCE = 0.1;

interface BudgetRow {
  categoryId: number | null;
  amount: number;
  since: YearMonth;
  name: string | null;
  parentId: number | null;
  archivedAt: Date | null;
}

/** Every change to `userId`'s budgets up to `through`, oldest month first. */
function budgetRowsThrough(db: AppDatabase, userId: number, through: YearMonth): BudgetRow[] {
  return db
    .select({
      categoryId: budgets.categoryId,
      amount: budgets.amount,
      since: budgets.month,
      name: categories.name,
      parentId: categories.parentId,
      archivedAt: categories.archivedAt,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .where(and(eq(budgets.userId, userId), sql`${budgets.month} <= ${through}`))
    .orderBy(asc(budgets.month))
    .all();
}

/**
 * Budgets in force for `month` from `rows` (oldest first): per category, the
 * latest row at or before it, when its amount is above 0 and the category can
 * still carry a budget (top-level and not archived).
 */
export function resolveBudgets(rows: BudgetRow[], month: YearMonth): BudgetSetting[] {
  const latest = new Map<number | null, BudgetRow>();
  for (const row of rows) {
    if (row.since > month) break;
    latest.set(row.categoryId, row);
  }
  return [...latest.values()]
    .filter((r) => r.amount > 0)
    .filter((r) => r.categoryId === null || (r.parentId === null && r.archivedAt === null))
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.categoryId === null ? '전체 예산' : (r.name ?? '알 수 없음'),
      amount: r.amount,
      since: r.since,
    }));
}

/** `userId`'s budgets in force for `month`: per category, the latest row at or before it (amount > 0). */
export function budgetsInForce(db: AppDatabase, userId: number, month: YearMonth): BudgetSetting[] {
  return resolveBudgets(budgetRowsThrough(db, userId, month), month);
}

/** Share (0–1) of the month elapsed at `now`, or null when `now` is outside the month. */
export function monthElapsed(month: YearMonth, now: number): number | null {
  const { start, end } = monthRange(month);
  if (now < start || now >= end) return null;
  return (now - start) / (end - start);
}

export function paceOf(budget: number, spent: number, elapsed: number): BudgetPace {
  const share = budget > 0 ? spent / budget : 0;
  const status = spent > budget ? 'over' : share > elapsed + PACE_TOLERANCE ? 'ahead' : 'ok';
  return { elapsed, expectedSpent: Math.round(budget * elapsed), status };
}

function progress(setting: BudgetSetting, spent: number): BudgetProgress {
  return {
    ...setting,
    spent,
    remaining: setting.amount - spent,
    percent: Math.floor((spent / setting.amount) * 100),
    over: spent > setting.amount,
  };
}

/**
 * Progress of `userId`'s budgets in force for `month`, against that member's
 * spending: `totalExpense` and the top-level rollup `byCategory` (children included).
 */
export function monthBudgets(
  db: AppDatabase,
  userId: number,
  month: YearMonth,
  now: number,
  totalExpense: number,
  byCategory: CategoryShare[],
): MonthBudgets {
  const elapsed = monthElapsed(month, now);
  const spentBy = new Map(byCategory.map((c) => [c.categoryId, c.amount]));
  const withPace = (p: BudgetProgress) => ({
    ...p,
    pace: elapsed === null ? null : paceOf(p.amount, p.spent, elapsed),
  });
  const settings = budgetsInForce(db, userId, month);
  const overall = settings.find((s) => s.categoryId === null);
  const sortOrder = new Map(
    db
      .select({ id: categories.id, sortOrder: categories.sortOrder })
      .from(categories)
      .where(isNull(categories.parentId))
      .all()
      .map((c) => [c.id, c.sortOrder]),
  );
  return {
    month,
    isCurrentMonth: toYearMonth(now) === month,
    overall: overall ? withPace(progress(overall, totalExpense)) : null,
    categories: settings
      .filter((s) => s.categoryId !== null)
      .sort(
        (a, b) =>
          (sortOrder.get(a.categoryId ?? 0) ?? 0) - (sortOrder.get(b.categoryId ?? 0) ?? 0) ||
          (a.categoryId ?? 0) - (b.categoryId ?? 0),
      )
      .map((s) => withPace(progress(s, spentBy.get(s.categoryId) ?? 0))),
  };
}

function percentOf(spent: number, budget: number): number {
  return Math.floor((spent / budget) * 100);
}

/**
 * 월별 비교: `userId`'s budgets in force each month of `from`–`to` against
 * that member's spending (as far as the viewer can see it). Spending is
 * summed exactly like the statistics (and like `monthBudgets`): expense only,
 * cancelled left out, a category with its children.
 */
export function budgetMonths(
  db: AppDatabase,
  viewerId: number,
  userId: number,
  from: YearMonth,
  to: YearMonth,
  now: number,
): BudgetMonthsReport {
  const months = monthsBetween(from, to);
  const currentMonth = toYearMonth(now);
  const rows = budgetRowsThrough(db, userId, to);
  const inForce = months.map((m) => new Map(resolveBudgets(rows, m).map((s) => [s.categoryId, s])));

  const where = rangeWhere(viewerId, from, to, userId);
  const totalSpent = monthTotals(db, where, months).map((m) => m.expense);
  const spentBy = new Map(categorySeries(db, where, months).map((c) => [c.categoryId, c.values]));

  const rowFor = (categoryId: number | null, spent: number[]): BudgetMonthRow => {
    const cells: BudgetMonthCell[] = months.map((month, i) => {
      const setting = inForce[i]?.get(categoryId);
      const amount = setting?.amount ?? null;
      const value = spent[i] ?? 0;
      const current = month === currentMonth;
      const elapsed = current ? monthElapsed(month, now) : null;
      return {
        month,
        budget: amount,
        spent: value,
        percent: amount === null ? null : percentOf(value, amount),
        over: amount !== null && value > amount,
        current,
        pace: amount !== null && elapsed !== null ? paceOf(amount, value, elapsed) : null,
      };
    });
    const budgeted = cells.filter((c) => c.budget !== null);
    const finished = budgeted.filter((c) => c.month < currentMonth);
    const budgetTotal = finished.reduce((n, c) => n + (c.budget ?? 0), 0);
    const name =
      categoryId === null
        ? '전체 예산'
        : (inForce.findLast((m) => m.has(categoryId))?.get(categoryId)?.name ?? '알 수 없음');
    return {
      categoryId,
      name,
      cells,
      summary: {
        budgetedMonths: budgeted.length,
        overMonths: budgeted.filter((c) => c.over).length,
        avgPercent: finished.length
          ? Math.round(finished.reduce((n, c) => n + (c.percent ?? 0), 0) / finished.length)
          : null,
        budgetTotal,
        spentTotal: finished.reduce((n, c) => n + c.spent, 0),
      },
    };
  };

  const budgeted = new Set<number>();
  for (const month of inForce) {
    for (const id of month.keys()) if (id !== null) budgeted.add(id);
  }
  const sortOrder = new Map(
    db
      .select({ id: categories.id, sortOrder: categories.sortOrder })
      .from(categories)
      .where(isNull(categories.parentId))
      .all()
      .map((c) => [c.id, c.sortOrder]),
  );
  const categoryRows = [...budgeted]
    .sort((a, b) => (sortOrder.get(a) ?? 0) - (sortOrder.get(b) ?? 0) || a - b)
    .map((id) => rowFor(id, spentBy.get(id) ?? []));

  return {
    from,
    to,
    months,
    overall: inForce.some((m) => m.has(null)) ? rowFor(null, totalSpent) : null,
    categories: categoryRows,
    totalSpent,
    unbudgetedSpent: months.map(
      (_, i) =>
        (totalSpent[i] ?? 0) -
        categoryRows.reduce(
          (n, r) => n + (r.cells[i]?.budget !== null ? (r.cells[i]?.spent ?? 0) : 0),
          0,
        ),
    ),
  };
}

/** Top-level, active expense categories (the only ones that can carry a budget). */
export function budgetCategoryOptions(db: AppDatabase): { id: number; name: string }[] {
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(
        eq(categories.kind, 'expense'),
        isNull(categories.parentId),
        isNull(categories.archivedAt),
      ),
    )
    .orderBy(categories.sortOrder, categories.id)
    .all();
}

export function budgetHistory(db: AppDatabase, userId: number, limit = 100): BudgetChange[] {
  return db
    .select({
      id: budgets.id,
      month: budgets.month,
      categoryId: budgets.categoryId,
      categoryName: categories.name,
      amount: budgets.amount,
      updatedByName: users.displayName,
      updatedAt: budgets.updatedAt,
    })
    .from(budgets)
    .leftJoin(categories, eq(budgets.categoryId, categories.id))
    .leftJoin(users, eq(budgets.updatedByUserId, users.id))
    .where(eq(budgets.userId, userId))
    .orderBy(desc(budgets.month), desc(budgets.updatedAt), desc(budgets.id))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      month: r.month,
      categoryId: r.categoryId,
      name: r.categoryId === null ? '전체 예산' : (r.categoryName ?? '알 수 없음'),
      amount: r.amount,
      updatedByName: r.updatedByName,
      updatedAt: r.updatedAt.toISOString(),
    }));
}

/**
 * Set `ownerId`'s budget for `categoryId` (null = overall) from `month` on.
 * Earlier months keep what was in force for them. Setting the amount that was
 * already in force before `month` drops this month's row instead of adding a no-op.
 */
export function setBudget(
  db: AppDatabase,
  input: { month: YearMonth; categoryId: number | null; amount: number },
  ownerId: number,
  userId: number,
): void {
  const { month, categoryId, amount } = input;
  if (categoryId !== null) {
    const cat = db.select().from(categories).where(eq(categories.id, categoryId)).get();
    if (!cat) throw errors.conflict('budget_invalid', 'Unknown category');
    if (cat.kind !== 'expense' || cat.parentId !== null) {
      throw errors.conflict('budget_invalid', 'Budgets are for top-level expense categories');
    }
    if (cat.archivedAt) throw errors.conflict('budget_invalid', 'Category is archived');
  }
  const sameCategory = and(
    eq(budgets.userId, ownerId),
    categoryId === null ? isNull(budgets.categoryId) : eq(budgets.categoryId, categoryId),
  );
  db.transaction((tx) => {
    const before = tx
      .select({ amount: budgets.amount })
      .from(budgets)
      .where(and(sameCategory, sql`${budgets.month} < ${month}`))
      .orderBy(desc(budgets.month))
      .limit(1)
      .get();
    const existing = tx
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(sameCategory, eq(budgets.month, month)))
      .get();
    const inForceBefore = before?.amount ?? 0;
    if (amount === inForceBefore) {
      if (existing) tx.delete(budgets).where(eq(budgets.id, existing.id)).run();
      return;
    }
    if (existing) {
      tx.update(budgets)
        .set({ amount, updatedByUserId: userId })
        .where(eq(budgets.id, existing.id))
        .run();
    } else {
      tx.insert(budgets)
        .values({ userId: ownerId, month, categoryId, amount, updatedByUserId: userId })
        .run();
    }
  });
}
