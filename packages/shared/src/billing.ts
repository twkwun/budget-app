/**
 * Card billing months (결제월) and payment-method helpers.
 *
 * A card bills what was used in one usage period (이용기간) on its payment
 * day (결제일). The period ends on the cutoff day (이용기간 마감일): spending
 * on or before the cutoff belongs to that period, later spending to the next.
 * The bill for a period is paid on the first payment day after the cutoff:
 * in the cutoff's month when the payment day comes later in that month,
 * otherwise in the following month.
 *
 * Example, 결제일 25일 (마감 11일): spending on 11/5 is paid 11/25, spending on
 * 11/25 is paid 12/25. 결제일 14일 (마감 말일): spending in November is paid 12/14.
 */
import type { AccountKind } from './domain.ts';
import { addMonths, type LocalDate, type YearMonth } from './date.ts';

/** Cutoff value meaning "the last day of the month" (말일). */
export const CUTOFF_MONTH_END = 31;

/**
 * Usual cutoff for a payment day at Korean card issuers (about two weeks
 * before payment). Issuers differ by a day or two, so it can be changed.
 */
export function defaultCutoffDay(billingDay: number): number {
  if (billingDay >= 15) return billingDay - 14;
  if (billingDay === 14) return CUTOFF_MONTH_END;
  return billingDay + 16;
}

/** Month whose payment day pays for spending on `date`. */
export function cardBillingMonth(
  date: LocalDate,
  billingDay: number,
  cutoffDay: number,
): YearMonth {
  const day = Number(date.slice(8, 10));
  const offset = (day > cutoffDay ? 1 : 0) + (billingDay > cutoffDay ? 0 : 1);
  return addMonths(date.slice(0, 7), offset);
}

/** "전월 12일 ~ 당월 11일": the usage period paid on one payment day. */
export function usagePeriodText(billingDay: number, cutoffDay: number): string {
  // Months before the payment month in which the period ends.
  const endBack = billingDay > cutoffDay ? 0 : 1;
  const names = ['당월', '전월', '전전월'];
  if (cutoffDay >= CUTOFF_MONTH_END) {
    return `${names[endBack]} 1일 ~ ${names[endBack]} 말일`;
  }
  return `${names[endBack + 1]} ${cutoffDay + 1}일 ~ ${names[endBack]} ${cutoffDay}일`;
}

/** "11월" or "2027년 1월" relative to the year of `reference`. */
export function monthLabel(month: YearMonth, reference?: YearMonth): string {
  const [y, m] = month.split('-');
  return reference && reference.slice(0, 4) !== y ? `${y}년 ${Number(m)}월` : `${Number(m)}월`;
}

/**
 * Guess what kind of payment method a label (뱅크샐러드 결제수단, a card SMS
 * sender, …) names. Returns null when nothing in the label says.
 */
export function inferAccountKind(label: string): AccountKind | null {
  const s = label.normalize('NFKC');
  if (/현금/.test(s)) return 'cash';
  if (/카드|card|하이패스/i.test(s)) return 'card';
  if (/페이|pay|머니|포인트|간편결제/i.test(s)) return 'pay';
  if (/통장|예금|적금|계좌|은행|입출금|박스|CMA|저축|RIA|ISA|super ?365/i.test(s)) return 'bank';
  return null;
}
