import type { HomeSummary, ListBasis, YearMonth } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { monthSummary } from '../ledger/queries.ts';
import { monthBudgets } from './budgets.ts';
import { recurringOverview, suggestionCount } from './recurring.ts';

/**
 * The 홈 summary: month totals plus budget progress and 고정지출 for the
 * family scope. With the `billing` basis the totals follow 결제월, while
 * budgets keep counting spending by the day it happened.
 */
export function homeSummary(
  db: AppDatabase,
  viewerId: number,
  month: YearMonth,
  ownerId: number | null,
  now: number,
  basis: ListBasis = 'date',
): HomeSummary {
  const summary = monthSummary(db, viewerId, month, ownerId, basis);
  if (ownerId !== null) return { ...summary, budgets: null, recurring: null };
  const spent = basis === 'date' ? summary : monthSummary(db, viewerId, month, null, 'date');
  const recurring = recurringOverview(db, viewerId, month, now, { includeOthers: false });
  return {
    ...summary,
    budgets: monthBudgets(db, month, now, spent.expense, spent.expenseByCategory),
    recurring: {
      items: recurring.items,
      remainingAmount: recurring.remainingAmount,
      suggestionCount: suggestionCount(db),
    },
  };
}
