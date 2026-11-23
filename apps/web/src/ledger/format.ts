import {
  HOUSEHOLD_TIME_ZONE,
  formatKrw,
  parseLocalDate,
  parseYearMonth,
  toZonedParts,
  zonedTimeToUtc,
  type LocalDate,
  type TransactionType,
  type YearMonth,
} from '@budget/shared';

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function monthLabel(month: YearMonth): string {
  const { year, month: m } = parseYearMonth(month);
  return `${year}년 ${m}월`;
}

/** `11월 22일 (일)` */
export function dayLabel(date: LocalDate): string {
  const { year, month, day } = parseLocalDate(date);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}월 ${day}일 (${weekday})`;
}

export function timeLabel(iso: string): string {
  const p = toZonedParts(Date.parse(iso));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Signed amount for display: expenses negative, income positive, transfers plain. */
export function signedAmount(type: TransactionType, amount: number): string {
  if (type === 'expense') return formatKrw(-amount);
  if (type === 'income') return formatKrw(amount, { withSign: true });
  return formatKrw(amount);
}

/** Compact won for axes: 32만, 1.2억. */
export function compactKrw(amount: number): string {
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(1).replace(/\.0$/, '')}억`;
  if (amount >= 10_000) return `${Math.round(amount / 10_000).toLocaleString('ko-KR')}만`;
  return amount.toLocaleString('ko-KR');
}

/** ISO instant → `YYYY-MM-DDTHH:mm` in the household zone, for `<input type="datetime-local">`. */
export function toLocalInput(iso: string | number): string {
  const p = toZonedParts(typeof iso === 'number' ? iso : Date.parse(iso), HOUSEHOLD_TIME_ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** `YYYY-MM-DDTHH:mm` interpreted in Asia/Seoul (whatever the device zone) → ISO instant. */
export function fromLocalInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(zonedTimeToUtc({ year, month, day, hour, minute })).toISOString();
}

/** Percentage change, or null when there is nothing to compare with. */
export function changeRatio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}
