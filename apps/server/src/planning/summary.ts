import type { HomeSummary, ListBasis, YearMonth } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { isAdmin, targetUser, type Viewer } from '../ledger/access.ts';
import { monthSummary } from '../ledger/queries.ts';
import { monthBudgets } from './budgets.ts';
import { recurringOverview, suggestionCount } from './recurring.ts';

/**
 * The 홈 summary: month totals for the scope (a member only ever has their own;
 * an admin may look at the family or one member) plus the budget progress and
 * 고정지출 of the member in scope — the viewer themself in the 전체 scope.
 * With the `billing` basis the totals follow 결제월, while budgets keep
 * counting spending by the day it happened.
 */
export function homeSummary(
  db: AppDatabase,
  viewer: Viewer,
  month: YearMonth,
  ownerId: number | null,
  now: number,
  basis: ListBasis = 'date',
): HomeSummary {
  const planUserId = targetUser(viewer, ownerId);
  const summary = monthSummary(db, viewer.id, month, ownerId, basis);
  // A member's 전체 is already just their own spending.
  const sameScope = ownerId === planUserId || !isAdmin(viewer);
  const spent =
    basis === 'date' && sameScope
      ? summary
      : monthSummary(db, viewer.id, month, planUserId, 'date');
  const recurring = recurringOverview(db, viewer.id, planUserId, month, now, {
    includeOthers: false,
  });
  return {
    ...summary,
    planUserId,
    budgets: monthBudgets(db, planUserId, month, now, spent.expense, spent.expenseByCategory),
    recurring: {
      items: recurring.items,
      remainingAmount: recurring.remainingAmount,
      suggestionCount: suggestionCount(db, planUserId),
    },
  };
}
