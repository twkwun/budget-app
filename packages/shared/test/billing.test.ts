import { describe, expect, it } from 'vitest';
import {
  cardBillingMonth,
  defaultCutoffDay,
  inferAccountKind,
  monthLabel,
  usagePeriodText,
} from '../src/billing.ts';

describe('card billing month', () => {
  it('derives the usual cutoff from the payment day', () => {
    expect(defaultCutoffDay(25)).toBe(11);
    expect(defaultCutoffDay(15)).toBe(1);
    expect(defaultCutoffDay(14)).toBe(31);
    expect(defaultCutoffDay(10)).toBe(26);
    expect(defaultCutoffDay(1)).toBe(17);
  });

  it('pays day-25 cards next month for spending after the cutoff', () => {
    expect(cardBillingMonth('2026-11-05', 25, 11)).toBe('2026-11');
    expect(cardBillingMonth('2026-11-11', 25, 11)).toBe('2026-11');
    expect(cardBillingMonth('2026-11-12', 25, 11)).toBe('2026-12');
    expect(cardBillingMonth('2026-11-25', 25, 11)).toBe('2026-12');
  });

  it('pays day-14 cards (마감 말일) the month after', () => {
    expect(cardBillingMonth('2026-11-01', 14, 31)).toBe('2026-12');
    expect(cardBillingMonth('2026-11-30', 14, 31)).toBe('2026-12');
    expect(cardBillingMonth('2026-12-31', 14, 31)).toBe('2027-01');
  });

  it('pays early payment days up to two months later', () => {
    expect(cardBillingMonth('2026-11-17', 1, 17)).toBe('2026-12');
    expect(cardBillingMonth('2026-11-18', 1, 17)).toBe('2027-01');
  });

  it('describes the usage period', () => {
    expect(usagePeriodText(25, 11)).toBe('전월 12일 ~ 당월 11일');
    expect(usagePeriodText(14, 31)).toBe('전월 1일 ~ 전월 말일');
    expect(usagePeriodText(1, 17)).toBe('전전월 18일 ~ 전월 17일');
  });

  it('labels months with the year only when it differs', () => {
    expect(monthLabel('2026-12', '2026-11')).toBe('12월');
    expect(monthLabel('2027-01', '2026-12')).toBe('2027년 1월');
  });
});

describe('payment-method kind from a label', () => {
  it.each([
    ['CJ 현대카드 M 임직원 Edition2', 'card'],
    ['THE 1 BY SAMSUNG CARD', 'card'],
    ['삼성후불하이패스카드', 'card'],
    ['카카오페이 간편결제', 'pay'],
    ['네이버페이 간편결제(포인트)', 'pay'],
    ['두드림통장', 'bank'],
    ['KB종합통장-보통예금', 'bank'],
    ['세이프박스', 'bank'],
    ['현금', 'cash'],
    ['T-economy', null],
  ])('%s → %s', (label, kind) => {
    expect(inferAccountKind(label)).toBe(kind);
  });
});
