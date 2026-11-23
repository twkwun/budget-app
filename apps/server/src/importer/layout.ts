/**
 * Finding the header row and mapping columns by header name.
 *
 * UNVERIFIED: no real export has been seen yet. Column names come from the
 * commonly seen Korean card, bank and 뱅크샐러드 downloads; files whose
 * required columns cannot be identified go to a manual mapping step, and
 * that mapping is remembered by the header's signature.
 */
import { createHash } from 'node:crypto';
import type { ColumnMap, ColumnRole } from '@budget/shared';
import type { Cell, Sheet } from './types.ts';

export const ALIASES: Record<ColumnRole, string[]> = {
  date: [
    '날짜',
    '일자',
    '이용일',
    '이용일자',
    '이용일시',
    '거래일',
    '거래일자',
    '거래일시',
    '승인일',
    '승인일자',
    '승인일시',
    '매출일',
    '매출일자',
    '사용일',
    '사용일자',
    '거래날짜',
    '이용날짜',
    '결제일시',
    '일시',
  ],
  time: ['시간', '시각', '이용시간', '승인시간', '승인시각', '거래시간', '거래시각'],
  merchant: [
    '내용',
    '가맹점',
    '가맹점명',
    '이용가맹점',
    '이용가맹점명',
    '이용처',
    '이용하신곳',
    '사용처',
    '상호',
    '상호명',
    '거래처',
    '적요',
    '거래내용',
    '기재내용',
    '받는분',
    '보낸분',
    '가맹점정보',
    '상점',
    '상점명',
    '가게',
  ],
  amount: [
    '금액',
    '이용금액',
    '결제금액',
    '승인금액',
    '거래금액',
    '사용금액',
    '매출금액',
    '원화금액',
    '이용원금',
    '결제원금',
    '결제액',
    '이용액',
    '사용액',
  ],
  withdrawal: ['출금', '출금액', '출금금액', '찾으신금액', '지급금액', '출금원'],
  deposit: ['입금', '입금액', '입금금액', '맡기신금액', '입금원'],
  type: ['타입', '유형', '거래유형', '입출구분', '수입지출', '구분'],
  category: ['대분류', '분류', '카테고리'],
  subcategory: ['소분류', '세부분류'],
  payment: [
    '결제수단',
    '이용카드',
    '카드명',
    '카드번호',
    '결제카드',
    '카드',
    '계좌',
    '계좌번호',
    '이용카드번호',
  ],
  approval: ['승인번호'],
  installment: ['할부', '할부개월', '할부기간', '할부개월수', '이용구분', '할부구분'],
  cancel: ['취소', '취소여부', '승인구분', '매출구분', '상태', '거래상태', '취소구분', '승인상태'],
  memo: ['메모', '비고'],
  currency: ['화폐', '통화', '통화코드'],
};

/** Normalised header text: no spaces or bracketed units ("이용금액(원)" → "이용금액"). */
export function normalizeHeader(cell: Cell): string {
  return String(cell ?? '')
    .normalize('NFKC')
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[\s:*·._-]/g, '')
    .toLowerCase();
}

const LOOKUP = new Map<string, ColumnRole>();
for (const [role, names] of Object.entries(ALIASES) as [ColumnRole, string[]][]) {
  for (const n of names) if (!LOOKUP.has(normalizeHeader(n))) LOOKUP.set(normalizeHeader(n), role);
}

export function roleOf(cell: Cell): ColumnRole | undefined {
  return LOOKUP.get(normalizeHeader(cell));
}

export function mapHeader(header: Cell[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((cell, index) => {
    const role = roleOf(cell);
    if (role && map[role] === undefined) map[role] = index;
  });
  // 'category' alone without a 'subcategory' is fine; '구분' as type only when nothing better.
  return map;
}

export function missingRoles(map: ColumnMap): ColumnRole[] {
  const missing: ColumnRole[] = [];
  if (map.date === undefined) missing.push('date');
  if (map.amount === undefined && map.withdrawal === undefined && map.deposit === undefined)
    missing.push('amount');
  return missing;
}

export function headerSignature(header: Cell[]): string {
  return createHash('sha256')
    .update(header.map(normalizeHeader).join('|'))
    .digest('hex')
    .slice(0, 32);
}

export interface DetectedLayout {
  sheet: Sheet;
  headerIndex: number;
  header: string[];
  map: ColumnMap;
  score: number;
}

/**
 * Pick the sheet and header row: within the first 30 rows of each sheet,
 * the row whose cells match the most known column names (it must contain a
 * date and an amount column to count). Without one, the first row with
 * three or more text cells is offered for manual mapping.
 */
export function detectLayout(sheets: Sheet[]): DetectedLayout | null {
  let best: DetectedLayout | null = null;
  for (const sheet of sheets) {
    for (const [i, row] of sheet.rows.slice(0, 30).entries()) {
      const map = mapHeader(row);
      const score = Object.keys(map).length;
      if (missingRoles(map).length === 0 && (!best || score > best.score)) {
        best = { sheet, headerIndex: i, header: row.map((c) => String(c ?? '')), map, score };
      }
    }
  }
  if (best) return best;
  for (const sheet of sheets) {
    const i = sheet.rows.findIndex(
      (r) => r.filter((c) => typeof c === 'string' && c.trim() !== '').length >= 3,
    );
    const row = sheet.rows[i];
    if (row) {
      return {
        sheet,
        headerIndex: i,
        header: row.map((c) => String(c ?? '')),
        map: mapHeader(row),
        score: 0,
      };
    }
  }
  return null;
}

/** 뱅크샐러드 가계부 내역 (as recalled; unverified): 타입 + 대분류 + 결제수단 present. */
export function isBanksalad(map: ColumnMap, header: string[]): boolean {
  const h = header.map(normalizeHeader);
  return (
    map.type !== undefined &&
    h.includes('타입') &&
    map.category !== undefined &&
    map.payment !== undefined
  );
}
