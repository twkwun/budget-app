/**
 * Budgets: one overall monthly budget plus optional budgets on top-level
 * expense categories. A budget set for a month stays in force for later months
 * until it is changed; changing it in a month never rewrites earlier months.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  monthRange,
  toYearMonth,
  type BudgetChange,
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

/** Spending more than this share ahead of the month's progress counts as "ahead". */
export const PACE_TOLERANCE = 0.1;

/** Budgets in force for `month`: per category, the latest row at or before it (amount > 0). */
export function budgetsInForce(db: AppDatabase, month: YearMonth): BudgetSetting[] {
  const rows = db
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
    .where(
      sql`${budgets.month} = (select max(b2.month) from budgets b2 where b2.month <= ${month} and b2.category_id is ${budgets.categoryId})`,
    )
    .all();
  return rows
    .filter((r) => r.amount > 0)
    .filter((r) => r.categoryId === null || (r.parentId === null && r.archivedAt === null))
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.categoryId === null ? '전체 예산' : (r.name ?? '알 수 없음'),
      amount: r.amount,
      since: r.since,
    }));
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
 * Progress of the budgets in force for `month`, against spending the viewer can
 * see: `totalExpense` and the top-level rollup `byCategory` (children included).
 */
export function monthBudgets(
  db: AppDatabase,
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
  const settings = budgetsInForce(db, month);
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

export function budgetHistory(db: AppDatabase, limit = 100): BudgetChange[] {
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
 * Set the budget for `categoryId` (null = overall) from `month` on. Earlier
 * months keep what was in force for them. Setting the amount that was already
 * in force before `month` drops this month's row instead of adding a no-op.
 */
export function setBudget(
  db: AppDatabase,
  input: { month: YearMonth; categoryId: number | null; amount: number },
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
  const sameCategory =
    categoryId === null ? isNull(budgets.categoryId) : eq(budgets.categoryId, categoryId);
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
      tx.insert(budgets).values({ month, categoryId, amount, updatedByUserId: userId }).run();
    }
  });
}
