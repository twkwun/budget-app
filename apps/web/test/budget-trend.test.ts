import { describe, expect, it } from 'vitest';
import type { YearMonth } from '@budget/shared';
import { movingAverage, trendSentences, type TrendMonth } from '../src/ledger/budget-trend.ts';

/** Months from 2025-12 on; the last one open unless `closed`. */
function months(
  rows: [expense: number, budget: number | null][],
  { closed = false } = {},
): TrendMonth[] {
  return rows.map(([expense, budget], i) => {
    const d = new Date(Date.UTC(2025, 11 + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return {
      month: month as YearMonth,
      expense,
      budget,
      open: !closed && i === rows.length - 1,
    };
  });
}

// The demo household: 270만 until July, 300만 from August; November in progress.
const DEMO = months([
  [3_156_500, 2_700_000],
  [2_263_300, 2_700_000],
  [2_501_300, 2_700_000],
  [2_494_400, 2_700_000],
  [2_830_500, 2_700_000],
  [2_584_200, 2_700_000],
  [2_114_200, 2_700_000],
  [2_749_600, 2_700_000],
  [3_548_700, 3_000_000],
  [2_415_500, 3_000_000],
  [2_833_100, 3_000_000],
  [1_631_100, 2_800_000],
]);

describe('movingAverage', () => {
  it('averages three finished months and leaves the open month out', () => {
    const avg = movingAverage(DEMO);
    expect(avg.slice(0, 2)).toEqual([null, null]);
    expect(avg[2]).toBe(Math.round((3_156_500 + 2_263_300 + 2_501_300) / 3));
    expect(avg[10]).toBe(Math.round((3_548_700 + 2_415_500 + 2_833_100) / 3));
    expect(avg[11]).toBeNull();
  });
});

describe('trendSentences', () => {
  it('compares the latest 3 months, then the usage when the budget changed', () => {
    expect(trendSentences(DEMO)).toEqual([
      '최근 3달(8~10월) 평균 지출 293만 원, 그 전 3달보다 45만 원(18%) 늘었습니다.',
      '예산이 300만 원으로 올라 평균 사용률은 92% → 98%입니다.',
    ]);
  });

  it('calls a small change 비슷 and falls back to the streak', () => {
    const flat = months(
      [
        [1_000_000, 1_200_000],
        [1_000_000, 1_200_000],
        [1_000_000, 1_200_000],
        [1_020_000, 1_200_000],
        [1_020_000, 1_200_000],
        [1_020_000, 1_200_000],
      ],
      { closed: true },
    );
    expect(trendSentences(flat)).toEqual([
      '최근 3달(3~5월) 평균 지출 102만 원, 그 전 3달과 비슷합니다.',
      '6달 연속 예산 안에서 썼습니다.',
    ]);
  });

  it('counts an over streak up to the first month that was not over', () => {
    const over = months(
      [
        [900_000, 1_000_000],
        [1_100_000, 1_000_000],
        [1_200_000, 1_000_000],
        [1_050_000, 1_000_000],
      ],
      { closed: true },
    );
    expect(trendSentences(over)).toEqual(['3달 연속 예산을 넘었습니다.']);
  });

  it('says nothing with fewer than 4 finished months that had a budget', () => {
    const short = months([
      [1_000_000, null],
      [1_000_000, null],
      [1_000_000, 1_000_000],
      [1_000_000, 1_000_000],
      [1_000_000, 1_000_000],
      [500_000, 1_000_000],
    ]);
    expect(trendSentences(short)).toEqual([]);
  });

  it('names both years when the 3 months cross January', () => {
    const across = months(
      [
        [1_000_000, 1_000_000],
        [1_000_000, 1_000_000],
        [1_000_000, 1_000_000],
        [800_000, 1_000_000],
        [800_000, 1_000_000],
        [800_000, 1_000_000],
      ],
      { closed: true },
    ).map((m, i) => ({ ...m, month: `2026-${String(i + 7).padStart(2, '0')}` as YearMonth }));
    across[3]!.month = '2026-12';
    across[4]!.month = '2027-01';
    across[5]!.month = '2027-02';
    expect(trendSentences(across)[0]).toBe(
      '최근 3달(26년 12월~27년 2월) 평균 지출 80만 원, 그 전 3달보다 20만 원(20%) 줄었습니다.',
    );
  });
});
