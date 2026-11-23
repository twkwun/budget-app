import { describe, expect, it } from 'vitest';
import {
  isAggregatorMerchant,
  merchantSimilarity,
  normalizeMerchant,
  suggestRulePattern,
} from '../src/merchant.ts';

describe('merchant helpers', () => {
  it('normalizes corporate markers, spacing, punctuation and width', () => {
    expect(normalizeMerchant('(주)스타벅스 강남점')).toBe('스타벅스강남점');
    expect(normalizeMerchant('주식회사 행복마트')).toBe('행복마트');
    expect(normalizeMerchant('ｇｓ２５ 역삼점')).toBe('GS25역삼점');
    expect(normalizeMerchant('S-OIL 바다주유소')).toBe('SOIL바다주유소');
    expect(normalizeMerchant('㈜구름·카페')).toBe('구름카페');
  });

  it('suggests a brand pattern only when the branch is clearly separated', () => {
    expect(suggestRulePattern('스타벅스 강남점')).toBe('스타벅스');
    expect(suggestRulePattern('스타벅스강남점')).toBe('스타벅스강남점');
    expect(suggestRulePattern('(주)행복마트 본점')).toBe('행복마트');
    expect(suggestRulePattern('달빛 분식')).toBe('달빛분식');
  });

  it('recognises payment intermediaries', () => {
    expect(isAggregatorMerchant('네이버페이')).toBe(true);
    expect(isAggregatorMerchant('카카오페이 결제')).toBe(true);
    expect(isAggregatorMerchant('NAVER PAY')).toBe(true);
    expect(isAggregatorMerchant('구름카페')).toBe(false);
    expect(isAggregatorMerchant(null)).toBe(false);
  });

  it('scores similarity', () => {
    expect(merchantSimilarity('스타벅스 강남점', '(주)스타벅스강남점')).toBe(1);
    expect(merchantSimilarity('스타벅스', '스타벅스강남점')).toBe(0.9);
    expect(merchantSimilarity('행복마트', '행복슈퍼마켓')).toBeGreaterThan(0.2);
    expect(merchantSimilarity('행복마트', '하늘택시')).toBe(0);
  });
});
