import { parseYearMonth, type YearMonth } from '@budget/shared';
import { compactKrw } from './format.ts';

/**
 * Trend of spending against the overall budget, for 통계 › 월별 예산·지출:
 * a 3-month moving average and up to two plain sentences built by fixed
 * rules (facts only, no advice). Months still in progress or not yet begun
 * are left out so a half-spent month does not bend the trend.
 */

export interface TrendMonth {
  month: YearMonth;
  expense: number;
  /** Overall budget that month; null when there was none. */
  budget: number | null;
  /** The current month (in progress) or a later one: not counted. */
  open: boolean;
}

/** Months averaged by the trend line. */
export const TREND_WINDOW = 3;
/** Finished months with a budget needed before any sentence is shown. */
export const TREND_MIN_MONTHS = 4;
/** A change within ±5% reads as 「비슷」. */
export const TREND_FLAT_RATIO = 0.05;
/** Sentences shown at most. */
export const TREND_MAX_SENTENCES = 2;

/** `293만 원`, `8,000원`. */
function won(amount: number): string {
  return amount >= 10_000 ? `${compactKrw(amount)} 원` : `${amount.toLocaleString('ko-KR')}원`;
}

/** `8~10월`, or `25년 12월~26년 2월` across a year. */
function span(from: YearMonth, to: YearMonth): string {
  const a = parseYearMonth(from);
  const b = parseYearMonth(to);
  if (a.year === b.year) return `${a.month}~${b.month}월`;
  return `${String(a.year).slice(2)}년 ${a.month}월~${String(b.year).slice(2)}년 ${b.month}월`;
}

const average = (values: number[]) => values.reduce((n, v) => n + v, 0) / values.length;

/**
 * The average of each finished month and the `TREND_WINDOW - 1` months before
 * it; null where the window is not complete or the month is still open.
 */
export function movingAverage(months: TrendMonth[]): (number | null)[] {
  return months.map((m, i) => {
    if (m.open || i < TREND_WINDOW - 1) return null;
    const window = months.slice(i - TREND_WINDOW + 1, i + 1);
    if (window.some((w) => w.open)) return null;
    return Math.round(average(window.map((w) => w.expense)));
  });
}

/** Rule 1: the latest 3 finished months against the 3 before them. */
function recentVsBefore(finished: TrendMonth[]): string | null {
  if (finished.length < TREND_WINDOW * 2) return null;
  const recent = finished.slice(-TREND_WINDOW);
  const before = finished.slice(-TREND_WINDOW * 2, -TREND_WINDOW);
  const now = Math.round(average(recent.map((m) => m.expense)));
  const then = Math.round(average(before.map((m) => m.expense)));
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last) return null;
  const head = `최근 3달(${span(first.month, last.month)}) 평균 지출 ${won(now)}`;
  if (then === 0) return `${head}입니다.`;
  const diff = now - then;
  const ratio = diff / then;
  if (Math.abs(ratio) < TREND_FLAT_RATIO) return `${head}, 그 전 3달과 비슷합니다.`;
  const percent = Math.round(Math.abs(ratio) * 100);
  return `${head}, 그 전 3달보다 ${won(Math.abs(diff))}(${percent}%) ${diff > 0 ? '늘었습니다' : '줄었습니다'}.`;
}

/**
 * Rule 2: when the budget changed across those 6 months, the amounts alone
 * mislead, so compare the share of the budget used instead.
 */
function usageWhenBudgetChanged(finished: TrendMonth[]): string | null {
  if (finished.length < TREND_WINDOW * 2) return null;
  const six = finished.slice(-TREND_WINDOW * 2);
  if (six.some((m) => m.budget === null || m.budget <= 0)) return null;
  const budgets = six.map((m) => m.budget ?? 0);
  if (budgets.every((b) => b === budgets[0])) return null;
  const rate = (ms: TrendMonth[]) =>
    Math.round(average(ms.map((m) => (m.expense / (m.budget ?? 1)) * 100)));
  const before = six.slice(0, TREND_WINDOW);
  const recent = six.slice(TREND_WINDOW);
  const first = budgets[0] ?? 0;
  const last = budgets.at(-1) ?? 0;
  const moved = last > first ? '올라' : last < first ? '내려' : '바뀌어';
  return `예산이 ${won(last)}으로 ${moved} 평균 사용률은 ${rate(before)}% → ${rate(recent)}%입니다.`;
}

/** Rule 3: how many of the latest finished budgeted months ran the same way. */
function streak(finished: TrendMonth[]): string | null {
  let count = 0;
  let over: boolean | null = null;
  for (let i = finished.length - 1; i >= 0; i--) {
    const m = finished[i];
    if (!m || m.budget === null) break;
    const isOver = m.expense > m.budget;
    if (over === null) over = isOver;
    else if (isOver !== over) break;
    count++;
  }
  if (count < 2 || over === null) return null;
  return over ? `${count}달 연속 예산을 넘었습니다.` : `${count}달 연속 예산 안에서 썼습니다.`;
}

/** Up to two sentences, most telling first; none with too few months. */
export function trendSentences(months: TrendMonth[]): string[] {
  const finished = months.filter((m) => !m.open);
  if (finished.filter((m) => m.budget !== null).length < TREND_MIN_MONTHS) return [];
  return [recentVsBefore(finished), usageWhenBudgetChanged(finished), streak(finished)]
    .filter((s): s is string => s !== null)
    .slice(0, TREND_MAX_SENTENCES);
}
