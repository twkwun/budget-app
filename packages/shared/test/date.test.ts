import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  currentYearMonth,
  dayRange,
  daysInMonth,
  isLocalDate,
  isYearMonth,
  monthRange,
  timeZoneOffsetMs,
  toLocalDate,
  toYearMonth,
  toZonedParts,
  zonedTimeToUtc,
} from '../src/date.ts';

const HOUR = 3_600_000;

describe('household time zone (Asia/Seoul)', () => {
  it('has a fixed +09:00 offset', () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 1))).toBe(9 * HOUR);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1, 12, 34, 56, 789))).toBe(9 * HOUR);
  });

  it('maps a UTC instant late on the last day to the next local day and month', () => {
    // 2026-10-31T15:30Z is 2026-11-01 00:30 KST.
    const instant = Date.UTC(2026, 9, 31, 15, 30);
    expect(toLocalDate(instant)).toBe('2026-11-01');
    expect(toYearMonth(instant)).toBe('2026-11');
    expect(toZonedParts(instant)).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 0,
      minute: 30,
      second: 0,
    });
  });

  it('keeps an instant just before local midnight in the old month', () => {
    // 2026-10-31T14:59:59Z is 2026-10-31 23:59:59 KST.
    expect(toYearMonth(Date.UTC(2026, 9, 31, 14, 59, 59))).toBe('2026-10');
  });

  it('converts local wall-clock time to UTC', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1 })).toBe(Date.UTC(2026, 9, 31, 15));
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 5, hour: 12, minute: 7, second: 9 })).toBe(
      Date.UTC(2026, 2, 5, 3, 7, 9),
    );
  });

  it('round-trips through local parts', () => {
    const instant = Date.UTC(2027, 1, 28, 20, 0, 1);
    expect(zonedTimeToUtc(toZonedParts(instant))).toBe(instant);
  });

  it('accepts Date objects and rejects invalid instants', () => {
    expect(toLocalDate(new Date('2026-01-01T00:00:00+09:00'))).toBe('2026-01-01');
    expect(() => toLocalDate(Number.NaN)).toThrow(RangeError);
  });
});

describe('month and day ranges', () => {
  it('computes month boundaries at KST midnight', () => {
    const range = monthRange('2026-11');
    expect(new Date(range.start).toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(new Date(range.end).toISOString()).toBe('2026-11-30T15:00:00.000Z');
  });

  it('handles year rollover', () => {
    const range = monthRange('2026-12');
    expect(new Date(range.start).toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(new Date(range.end).toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });

  it('puts boundary instants in exactly one month', () => {
    const nov = monthRange('2026-11');
    const dec = monthRange('2026-12');
    expect(nov.end).toBe(dec.start);
    const midnight = dec.start;
    expect(midnight >= nov.start && midnight < nov.end).toBe(false);
    expect(midnight >= dec.start && midnight < dec.end).toBe(true);
  });

  it('computes a day range', () => {
    const range = dayRange('2026-02-28');
    expect(new Date(range.start).toISOString()).toBe('2026-02-27T15:00:00.000Z');
    expect(range.end - range.start).toBe(24 * HOUR);
  });

  it('gives the current month in KST', () => {
    expect(currentYearMonth(Date.UTC(2026, 11, 31, 16))).toBe('2027-01');
  });
});

describe('calendar arithmetic and validation', () => {
  it('adds days across month and leap-year boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('adds months across years', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-05', -17)).toBe('2024-12');
  });

  it('knows month lengths', () => {
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2026-04')).toBe(30);
  });

  it('validates formats', () => {
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-1-01')).toBe(false);
    expect(isYearMonth('2026-00')).toBe(false);
    expect(isYearMonth('2026-12')).toBe(true);
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });
});
