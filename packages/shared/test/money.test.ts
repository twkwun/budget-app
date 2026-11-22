import { describe, expect, it } from 'vitest';
import { assertKrw, formatKrw, isKrw, parseKrw, sumKrw } from '../src/money.ts';

describe('formatKrw', () => {
  it('formats with thousands separators and the won suffix', () => {
    expect(formatKrw(0)).toBe('0원');
    expect(formatKrw(1234567)).toBe('1,234,567원');
    expect(formatKrw(-5000)).toBe('-5,000원');
    expect(formatKrw(5000, { withSign: true })).toBe('+5,000원');
  });

  it('rejects non-integers', () => {
    expect(() => formatKrw(10.5)).toThrow(TypeError);
  });
});

describe('parseKrw', () => {
  it.each([
    ['12,345원', 12345],
    ['12345', 12345],
    ['₩12,345', 12345],
    [' 1,000 원 ', 1000],
    ['-3,300원', -3300],
    ['+700원', 700],
    ['0원', 0],
  ])('parses %j', (input, expected) => {
    expect(parseKrw(input)).toBe(expected);
  });

  it.each(['', '원', '12.5', '1,23,4원', 'abc', '12,345.00원', '99999999999999999999'])(
    'rejects %j',
    (input) => {
      expect(parseKrw(input)).toBeNull();
    },
  );
});

describe('isKrw / assertKrw / sumKrw', () => {
  it('accepts only safe integers', () => {
    expect(isKrw(1)).toBe(true);
    expect(isKrw(1.1)).toBe(false);
    expect(isKrw('1')).toBe(false);
    expect(() => assertKrw(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError);
  });

  it('sums and guards overflow', () => {
    expect(sumKrw([1000, 2500, -500])).toBe(3000);
    expect(() => sumKrw([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});
