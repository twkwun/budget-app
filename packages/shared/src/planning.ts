/** Wire types for budgets, 고정지출 and statistics. */
import type { LocalDate, YearMonth } from './date.ts';
import type { RecurringStatus } from './domain.ts';
import type { MonthSummary } from './ledger.ts';

/**
 * A budget is set for a month and stays in force for later months until it is
 * changed. An amount of 0 removes it from that month on.
 */
export interface BudgetSetting {
  /** null = the overall monthly budget. */
  categoryId: number | null;
  name: string;
  amount: number;
  /** Month the amount in force was set for. */
  since: YearMonth;
}

export interface BudgetProgress extends BudgetSetting {
  /** Spending counted against the budget (a category includes its children). */
  spent: number;
  /** budget - spent; negative when over. */
  remaining: number;
  /** spent / budget × 100, rounded down; may exceed 100. */
  percent: number;
  over: boolean;
}

export type PaceStatus = 'ok' | 'ahead' | 'over';

/** For the current month: spending so far against the share of the month elapsed. */
export interface BudgetPace {
  /** 0–1: share of the month elapsed in Asia/Seoul. */
  elapsed: number;
  /** Budget × elapsed: what "on pace" spending would be by now. */
  expectedSpent: number;
  /** `ahead`: spending more than 10 points ahead of the month's progress. */
  status: PaceStatus;
}

export interface MonthBudgets {
  month: YearMonth;
  /** Whether `month` is the household's current month (pace only then). */
  isCurrentMonth: boolean;
  overall: (BudgetProgress & { pace: BudgetPace | null }) | null;
  categories: (BudgetProgress & { pace: BudgetPace | null })[];
}

export interface BudgetChange {
  id: number;
  month: YearMonth;
  categoryId: number | null;
  name: string;
  amount: number;
  updatedByName: string | null;
  updatedAt: string;
}

export interface BudgetOverview extends MonthBudgets {
  /** Top-level expense categories that can carry a budget. */
  categoryOptions: { id: number; name: string }[];
  history: BudgetChange[];
}

/** Tolerance used when matching a payment to a 고정지출 (±20%). */
export const RECURRING_AMOUNT_TOLERANCE = 0.2;

export type RecurringMonthState =
  /** A matching payment was found this month. */
  | 'paid'
  /** Expected later this month (or today). */
  | 'upcoming'
  /** Expected day has passed without a matching payment. */
  | 'late';

export interface RecurringItem {
  id: number;
  name: string;
  matchKey: string;
  amount: number;
  dayOfMonth: number;
  categoryId: number | null;
  categoryName: string | null;
  accountId: number | null;
  accountName: string | null;
  status: RecurringStatus;
  source: 'detected' | 'manual';
  /** For suggestions: months it was seen in (latest first). */
  seenMonths: YearMonth[];
}

export interface RecurringMonthItem extends RecurringItem {
  month: YearMonth;
  /** The expected date in this month (day clamped to the month length). */
  expectedDate: LocalDate;
  state: RecurringMonthState;
  paid: { transactionId: number; date: LocalDate; amount: number } | null;
}

export interface RecurringOverview {
  month: YearMonth;
  /** Confirmed items with their state this month, by expected date. */
  items: RecurringMonthItem[];
  suggestions: RecurringItem[];
  dismissed: RecurringItem[];
  /** Sum of confirmed items not yet paid this month. */
  remainingAmount: number;
}

export interface MonthTotals {
  month: YearMonth;
  expense: number;
  income: number;
}

export interface CategorySeries {
  /** Top-level category; null = 미분류. */
  categoryId: number | null;
  name: string;
  total: number;
  /** One value per month of the range. */
  values: number[];
}

export interface MemberSeries {
  userId: number;
  name: string;
  expense: number;
  income: number;
  /** Monthly expense, one value per month of the range. */
  values: number[];
}

export interface MerchantTotal {
  merchant: string;
  amount: number;
  count: number;
}

export interface RangeStats {
  from: YearMonth;
  to: YearMonth;
  owner: 'all' | number;
  months: MonthTotals[];
  totals: { expense: number; income: number };
  /** Spending per top-level category, largest total first. */
  categories: CategorySeries[];
  /** Per transaction owner; only for the family scope (owner = all). */
  members: MemberSeries[];
  merchants: MerchantTotal[];
}

export interface YearStats extends RangeStats {
  year: number;
  previous: {
    year: number;
    months: MonthTotals[];
    /**
     * Last month counted in `totals` and `categories`: December, or for the
     * year in progress the same month a year earlier (like-for-like).
     */
    through: YearMonth;
    totals: { expense: number; income: number };
    /** Previous-year spending by top-level category id ('none' = 미분류). */
    categories: Record<string, number>;
  };
}

export interface BackupStatus {
  enabled: boolean;
  /** Local HH:MM of the daily run. */
  time: string;
  retentionDays: number;
  nextRunAt: string | null;
  count: number;
  totalBytes: number;
  last: { takenAt: string; bytes: number } | null;
}

/** 홈 summary: the month summary plus budgets and 고정지출 (family scope only). */
export interface HomeSummary extends MonthSummary {
  /** null in a member scope: budgets are for the whole family. */
  budgets: MonthBudgets | null;
  recurring: {
    items: RecurringMonthItem[];
    remainingAmount: number;
    suggestionCount: number;
  } | null;
}
