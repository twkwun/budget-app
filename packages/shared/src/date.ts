/**
 * Date helpers for the household time zone.
 *
 * Instants are stored as UTC epoch milliseconds. Calendar concepts (a local
 * date, a month) are always interpreted in the household time zone, so a
 * purchase at 00:30 KST on the 1st belongs to the new month even though it is
 * still the previous day in UTC.
 */

export const HOUSEHOLD_TIME_ZONE = 'Asia/Seoul';

/** Calendar date in the household zone, formatted `YYYY-MM-DD`. */
export type LocalDate = string;
/** Calendar month in the household zone, formatted `YYYY-MM`. */
export type YearMonth = string;

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Half-open UTC range `[start, end)` in epoch milliseconds. */
export interface UtcRange {
  start: number;
  end: number;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function toEpochMs(instant: Date | number): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('Invalid instant');
  return ms;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Korea has used a fixed UTC+9 with no daylight saving since 1988-10-09, so
 * instants after that are converted arithmetically (much faster than Intl,
 * which matters when importing tens of thousands of rows).
 */
const KST_FIXED_SINCE = Date.UTC(1988, 9, 9);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Wall-clock parts of an instant in the given zone (seconds precision). */
export function toZonedParts(
  instant: Date | number,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): LocalDateTimeParts {
  const ms = toEpochMs(instant);
  if (timeZone === HOUSEHOLD_TIME_ZONE && ms >= KST_FIXED_SINCE) {
    const d = new Date(ms + KST_OFFSET_MS);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
  const parts = formatterFor(timeZone).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} in formatted date`);
    return Number(part.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of the zone from UTC at the given instant, in milliseconds (KST: +9h). */
export function timeZoneOffsetMs(
  instant: Date | number,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): number {
  const ms = toEpochMs(instant);
  const p = toZonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * Convert a wall-clock time in the zone to a UTC instant (epoch ms).
 * Missing time fields default to midnight.
 */
export function zonedTimeToUtc(
  local: Pick<LocalDateTimeParts, 'year' | 'month' | 'day'> & Partial<LocalDateTimeParts>,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): number {
  const naive = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  if (timeZone === HOUSEHOLD_TIME_ZONE && naive - KST_OFFSET_MS >= KST_FIXED_SINCE) {
    return naive - KST_OFFSET_MS;
  }
  // Two passes handle zones whose offset differs on either side of the instant.
  const firstGuess = naive - timeZoneOffsetMs(naive, timeZone);
  return naive - timeZoneOffsetMs(firstGuess, timeZone);
}

export function isLocalDate(value: string): boolean {
  const m = LOCAL_DATE_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonthOf(Number(m[1]), month);
}

export function isYearMonth(value: string): boolean {
  const m = YEAR_MONTH_RE.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function parseLocalDate(value: LocalDate): { year: number; month: number; day: number } {
  if (!isLocalDate(value)) throw new RangeError(`Invalid local date: ${value}`);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

export function parseYearMonth(value: YearMonth): { year: number; month: number } {
  if (!isYearMonth(value)) throw new RangeError(`Invalid year-month: ${value}`);
  const [year, month] = value.split('-').map(Number) as [number, number];
  return { year, month };
}

function daysInMonthOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function daysInMonth(yearMonth: YearMonth): number {
  const { year, month } = parseYearMonth(yearMonth);
  return daysInMonthOf(year, month);
}

/** Household-zone calendar date of an instant. */
export function toLocalDate(
  instant: Date | number,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): LocalDate {
  const p = toZonedParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Household-zone month of an instant. */
export function toYearMonth(
  instant: Date | number,
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): YearMonth {
  const p = toZonedParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addMonths(yearMonth: YearMonth, months: number): YearMonth {
  const { year, month } = parseYearMonth(yearMonth);
  const index = year * 12 + (month - 1) + months;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

/** UTC range covering one household-zone calendar day. */
export function dayRange(date: LocalDate, timeZone: string = HOUSEHOLD_TIME_ZONE): UtcRange {
  const { year, month, day } = parseLocalDate(date);
  const next = parseLocalDate(addDays(date, 1));
  return {
    start: zonedTimeToUtc({ year, month, day }, timeZone),
    end: zonedTimeToUtc(next, timeZone),
  };
}

/** UTC range covering one household-zone calendar month. */
export function monthRange(yearMonth: YearMonth, timeZone: string = HOUSEHOLD_TIME_ZONE): UtcRange {
  const { year, month } = parseYearMonth(yearMonth);
  const next = parseYearMonth(addMonths(yearMonth, 1));
  return {
    start: zonedTimeToUtc({ year, month, day: 1 }, timeZone),
    end: zonedTimeToUtc({ year: next.year, month: next.month, day: 1 }, timeZone),
  };
}

/** Month containing `now` in the household zone. */
export function currentYearMonth(
  now: Date | number = Date.now(),
  timeZone: string = HOUSEHOLD_TIME_ZONE,
): YearMonth {
  return toYearMonth(now, timeZone);
}
