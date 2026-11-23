import type { HomeSummary, YearMonth } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { monthSummary } from '../ledger/queries.ts';
import { monthBudgets } from './budgets.ts';
import { recurringOverview, suggestionCount } from './recurring.ts';

/** The 홈 summary: month totals plus budget progress and 고정지출 for the family scope. */
export function homeSummary(
  db: AppDatabase,
  viewerId: number,
  month: YearMonth,
  ownerId: number | null,
  now: number,
): HomeSummary {
  const summary = monthSummary(db, viewerId, month, ownerId);
  if (ownerId !== null) return { ...summary, budgets: null, recurring: null };
  const recurring = recurringOverview(db, viewerId, month, now, { includeOthers: false });
  return {
    ...summary,
    budgets: monthBudgets(db, month, now, summary.expense, summary.expenseByCategory),
    recurring: {
      items: recurring.items,
      remainingAmount: recurring.remainingAmount,
      suggestionCount: suggestionCount(db),
    },
  };
}
