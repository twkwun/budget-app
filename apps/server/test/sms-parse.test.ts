/** All fixtures are invented: names, card digits, merchants and amounts are made up. */
import { describe, expect, it } from 'vitest';
import {
  digitsMatch,
  messageInstant,
  normalizeSms,
  parseSms,
  type ParseResult,
} from '../src/sms/parse.ts';

function ok(text: string) {
  const r = parseSms(text);
  if (!r.recognized || !r.ok) throw new Error(`expected a parse: ${JSON.stringify(r)}`);
  return { ...r.value, parser: r.parser.id };
}

function failure(text: string): Extract<ParseResult, { ok: false }> {
  const r = parseSms(text);
  if (!r.recognized || r.ok) throw new Error(`expected a recognised failure: ${JSON.stringify(r)}`);
  return r;
}

describe('신한', () => {
  it('parses a one-line approval', () => {
    expect(
      ok(
        '[Web발신]\n신한카드(1234)승인 홍*동 12,300원(일시불)11/22 14:05 구름카페강남점 누적1,234,567원',
      ),
    ).toEqual({
      parser: 'shinhan-sms',
      issuer: 'shinhan',
      kind: 'approval',
      cardDigits: '1234',
      cardType: 'credit',
      amount: 12300,
      currency: null,
      foreignAmount: null,
      installmentMonths: null,
      month: 11,
      day: 22,
      hour: 14,
      minute: 5,
      merchant: '구름카페강남점',
      cumulative: 1234567,
    });
  });

  it('parses without [Web발신], name or 누적, with line breaks', () => {
    const v = ok('신한카드(5678)승인\n9,900원(일시불)\n01/03 09:41\n달빛분식');
    expect(v).toMatchObject({
      cardDigits: '5678',
      amount: 9900,
      month: 1,
      day: 3,
      hour: 9,
      minute: 41,
      merchant: '달빛분식',
      cumulative: null,
    });
  });

  it('parses cancellation, installment and check card', () => {
    expect(ok('신한카드(1234)승인취소 홍*동 12,300원 11/22 15:00 구름카페강남점')).toMatchObject({
      kind: 'cancel',
      amount: 12300,
    });
    expect(ok('신한카드(1234)취소 홍*동 5,000원 11/22 15:00 구름카페강남점')).toMatchObject({
      kind: 'cancel',
      amount: 5000,
    });
    expect(ok('신한카드(1234)승인 홍*동 360,000원(03개월)11/22 14:05 모노가전')).toMatchObject({
      installmentMonths: 3,
    });
    expect(ok('신한체크(1234)승인 홍*동 4,500원 11/22 08:10 별빛편의점')).toMatchObject({
      cardType: 'check',
      amount: 4500,
    });
  });

  it('sends overseas approvals without a won amount to the inbox', () => {
    const f = failure('신한카드(1234)승인 홍*동 USD 12.50 11/22 14:05 EXAMPLE STORE');
    expect(f.reason).toBe('foreign_currency');
    expect(f.partial).toMatchObject({
      currency: 'USD',
      foreignAmount: '12.50',
      merchant: 'EXAMPLE STORE',
    });
  });
});

describe('KB국민', () => {
  it('parses the multi-line layout with masked digits', () => {
    expect(
      ok(
        '[Web발신]\nKB국민카드1*3*승인\n홍*동\n12,300원 일시불\n11/22 14:05\n구름카페강남점\n누적1,234,567원',
      ),
    ).toMatchObject({
      parser: 'kb-sms',
      cardDigits: '1*3*',
      amount: 12300,
      merchant: '구름카페강남점',
      cumulative: 1234567,
      installmentMonths: null,
    });
  });

  it('parses spaces instead of line breaks, check cards, installments and cancels', () => {
    expect(
      ok('KB국민카드1*3*승인 홍*동 12,300원 일시불 11/22 14:05 구름카페강남점 누적1,234,567원'),
    ).toMatchObject({ amount: 12300, merchant: '구름카페강남점' });
    expect(ok('KB국민체크(2*4*)승인\n홍*동\n7,000원\n11/22 12:00\n골목국수')).toMatchObject({
      cardType: 'check',
      cardDigits: '2*4*',
    });
    expect(ok('KB국민카드1*3*승인\n홍*동\n240,000원 06개월\n11/22 14:05\n모노가전')).toMatchObject({
      installmentMonths: 6,
    });
    expect(
      ok('KB국민카드1*3*승인취소\n홍*동\n12,300원 일시불\n11/22 14:30\n구름카페강남점'),
    ).toMatchObject({ kind: 'cancel' });
  });
});

describe('삼성', () => {
  it('parses the two-line layout', () => {
    expect(
      ok(
        '[Web발신]\n삼성1234승인 홍*동\n12,300원 일시불\n11/22 14:05 구름카페강남점\n누적1,234,567원',
      ),
    ).toMatchObject({
      parser: 'samsung-sms',
      cardDigits: '1234',
      amount: 12300,
      merchant: '구름카페강남점',
    });
  });

  it('parses 삼성카드 prefix, cancels and missing name', () => {
    expect(ok('삼성카드1234승인\n12,300원 일시불\n11/22 14:05 구름카페강남점')).toMatchObject({
      amount: 12300,
    });
    expect(ok('삼성1234승인취소 홍*동\n12,300원 일시불\n11/22 14:10 구름카페강남점')).toMatchObject(
      { kind: 'cancel' },
    );
    expect(ok('삼성1234승인 홍*동\n1,200,000원 12개월\n11/22 19:05 바다가구')).toMatchObject({
      installmentMonths: 12,
      amount: 1200000,
    });
  });
});

describe('recognised but not confident', () => {
  it.each([
    ['신한카드(1234)승인 홍*동 12,300원 구름카페', 'no_datetime'],
    ['KB국민카드1*3*승인\n홍*동\n12,300원 일시불\n11/22 14:05', 'no_merchant'],
    ['삼성1234승인 홍*동\n0원\n11/22 14:05 구름카페', 'zero_amount'],
    ['신한카드(1234)승인 홍*동 12,300원 13/45 14:05 구름카페', 'bad_datetime'],
  ])('%j → %s', (text, reason) => {
    expect(failure(text).reason).toBe(reason);
  });
});

describe('not card notifications: discarded', () => {
  it.each([
    '[Web발신]\n[신한카드] 인증번호 [482913]를 입력해 주세요.',
    '[Web발신]\nKB국민카드 본인확인 인증번호 123456',
    '[삼성카드] 이번 달 결제 예정 금액 안내입니다.',
    '[Web발신]\n고객님의 택배가 오늘 14~16시 도착 예정입니다.',
    '오늘 저녁 7시에 만나자! 12,000원짜리 케이크 사갈게',
    '현대카드(1234)승인 홍*동 12,300원 일시불 11/22 14:05 구름카페',
    '신한카드(1234)승인 거절 11/22 14:05 한도초과',
    '내 신한카드(1234)승인 됐어? 12,300원 11/22 14:05 구름카페', // not at the start
    '',
  ])('%j', (text) => {
    expect(parseSms(text).recognized).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizes [Web발신] and spacing', () => {
    expect(normalizeSms('  [Web발신]\r\n신한카드(1234)승인   홍*동\r\n\r\n12,300원 ')).toBe(
      '신한카드(1234)승인 홍*동\n12,300원',
    );
  });

  it('infers the year from the receive time across the year boundary', () => {
    const at = (iso: string) => new Date(iso).getTime();
    const m = { month: 12, day: 31, hour: 23, minute: 58 };
    expect(new Date(messageInstant(m, at('2027-01-01T00:01:00+09:00'))).toISOString()).toBe(
      '2026-12-31T14:58:00.000Z',
    );
    expect(new Date(messageInstant(m, at('2026-12-31T23:59:00+09:00'))).toISOString()).toBe(
      '2026-12-31T14:58:00.000Z',
    );
    const jan = { month: 1, day: 2, hour: 9, minute: 0 };
    expect(new Date(messageInstant(jan, at('2027-01-02T09:01:00+09:00'))).toISOString()).toBe(
      '2027-01-02T00:00:00.000Z',
    );
  });

  it('matches masked digits', () => {
    expect(digitsMatch('1234', '1234')).toBe(true);
    expect(digitsMatch('1234', '1*3*')).toBe(true);
    expect(digitsMatch('1534', '1*3*')).toBe(true);
    expect(digitsMatch('2234', '1*3*')).toBe(false);
    expect(digitsMatch('1234', '****')).toBe(false);
    expect(digitsMatch(null, '1234')).toBe(false);
  });
});
