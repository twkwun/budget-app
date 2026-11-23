/** Turning a mapped spreadsheet row into a typed import row. */
import { normalizeMerchant, type ColumnMap, type TransactionType } from '@budget/shared';
import { excelSerialToText, type Cell } from './types.ts';

export interface ParsedRow {
  row: number;
  date: string | null;
  time: string | null;
  type: TransactionType;
  /** Type came from the file (뱅크샐러드 타입, 입출금 columns) rather than assumed. */
  explicitType: boolean;
  amount: number;
  /** Negative amount or 취소 marker: a refund/cancellation of an earlier purchase. */
  refund: boolean;
  merchant: string | null;
  memo: string | null;
  paymentLabel: string | null;
  categoryMajor: string | null;
  categoryMinor: string | null;
  approvalNo: string | null;
  installmentMonths: number | null;
  /** Bank statement layout (입금/출금 columns). */
  bankLayout: boolean;
  error: string | null;
}

const text = (c: Cell | undefined): string | null => {
  if (c === null || c === undefined) return null;
  const s = String(c).trim();
  return s === '' ? null : s;
};

const pad = (n: number | string) => String(n).padStart(2, '0');

interface DateParts {
  y: string;
  mo: string;
  d: string;
  meridiem?: string;
  h?: string;
  mi?: string;
  s?: string;
}

const DATE_PATTERNS: ((s: string) => DateParts | null)[] = [
  // 2026-11-22, 2026.11.22, 2026/11/22, 2026년 11월 22일 [오후] 14:05[:00]
  (s) => {
    const m =
      /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\.?(?:[ T]+(?:(오전|오후)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
        s,
      );
    return m
      ? { y: m[1] ?? '', mo: m[2] ?? '', d: m[3] ?? '', meridiem: m[4], h: m[5], mi: m[6], s: m[7] }
      : null;
  },
  // 20261122, 20261122 140500
  (s) => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(s);
    return m ? { y: m[1] ?? '', mo: m[2] ?? '', d: m[3] ?? '', h: m[4], mi: m[5], s: m[6] } : null;
  },
  // 26.11.22 [14:05]
  (s) => {
    const m = /^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      s,
    );
    return m
      ? { y: `20${m[1] ?? ''}`, mo: m[2] ?? '', d: m[3] ?? '', h: m[4], mi: m[5], s: m[6] }
      : null;
  },
];

/** Many date spellings → `YYYY-MM-DD` and optional `HH:mm:ss`. */
export function parseDateTime(
  cell: Cell | undefined,
): { date: string; time: string | null } | null {
  if (cell === null || cell === undefined) return null;
  let text: string;
  if (typeof cell === 'number') {
    if (cell > 20000 && cell < 80000) text = excelSerialToText(cell) ?? '';
    else if (cell >= 19000101 && cell <= 21001231) text = String(Math.floor(cell));
    else return null;
  } else text = String(cell).trim();
  let parts: DateParts | null = null;
  for (const pattern of DATE_PATTERNS) {
    parts = pattern(text);
    if (parts) break;
  }
  if (!parts) return null;
  const y = Number(parts.y);
  const mo = Number(parts.mo);
  const d = Number(parts.d);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return null;
  let time: string | null = null;
  if (parts.h !== undefined && parts.mi !== undefined) {
    let h = Number(parts.h);
    if (parts.meridiem === '오후' && h < 12) h += 12;
    if (parts.meridiem === '오전' && h === 12) h = 0;
    if (h <= 23 && Number(parts.mi) <= 59) time = `${pad(h)}:${pad(parts.mi)}:${pad(parts.s ?? 0)}`;
  }
  return { date: `${y}-${pad(mo)}-${pad(d)}`, time };
}

export function parseTime(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') {
    if (cell >= 0 && cell < 1) {
      const secs = Math.round(cell * 86400);
      return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
    }
    cell = String(cell).padStart(cell < 10000 ? 4 : 6, '0');
  }
  const s = String(cell).trim();
  const m = /(?:^|\s)(?:(오전|오후)\s*)?(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/.exec(s);
  if (!m) return null;
  let h = Number(m[2]);
  if (m[1] === '오후' && h < 12) h += 12;
  if (m[1] === '오전' && h === 12) h = 0;
  if (h > 23 || Number(m[3]) > 59) return null;
  return `${pad(h)}:${pad(m[3] ?? 0)}:${pad(m[4] ?? 0)}`;
}

/** `12,300`, `-12,300원`, `(12,300)`, `₩12,300`, numbers. Returns null when not an amount. */
export function parseAmount(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.round(cell) : null;
  let s = String(cell)
    .normalize('NFKC')
    .replace(/[\s,원₩\\]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s));
  return Number.isSafeInteger(n) ? (negative ? -n : n) : null;
}

function typeFromText(s: string | null): TransactionType | null {
  if (!s) return null;
  if (/이체|송금/.test(s)) return 'transfer';
  if (/수입|입금/.test(s)) return 'income';
  if (/지출|출금|사용|결제/.test(s)) return 'expense';
  return null;
}

export function parseRow(
  cells: Cell[],
  map: ColumnMap,
  rowNumber: number,
  banksalad: boolean,
): ParsedRow {
  const get = (role: keyof ColumnMap) => {
    const index = map[role];
    return index === undefined ? undefined : cells[index];
  };
  const out: ParsedRow = {
    row: rowNumber,
    date: null,
    time: null,
    type: 'expense',
    explicitType: false,
    amount: 0,
    refund: false,
    merchant: text(get('merchant'))?.slice(0, 100) ?? null,
    memo: text(get('memo'))?.slice(0, 500) ?? null,
    paymentLabel: text(get('payment'))?.slice(0, 100) ?? null,
    categoryMajor: text(get('category')),
    categoryMinor: text(get('subcategory')),
    approvalNo: text(get('approval'))?.replace(/\s/g, '').slice(0, 40) ?? null,
    installmentMonths: null,
    bankLayout: map.withdrawal !== undefined || map.deposit !== undefined,
    error: null,
  };

  const dt = parseDateTime(get('date'));
  if (!dt) {
    out.error = 'bad_date';
    return out;
  }
  out.date = dt.date;
  out.time = parseTime(get('time')) ?? dt.time;

  const currency = text(get('currency'));
  if (currency && !/^(KRW|원|￦|₩)$/i.test(currency)) {
    out.error = 'foreign_currency';
  }

  const declared = typeFromText(text(get('type')));
  let amount: number | null;
  if (out.bankLayout) {
    const w = parseAmount(get('withdrawal')) ?? 0;
    const d = parseAmount(get('deposit')) ?? 0;
    if (w !== 0) {
      out.type = 'expense';
      amount = w;
    } else if (d !== 0) {
      out.type = 'income';
      amount = d;
    } else amount = parseAmount(get('amount'));
    out.explicitType = w !== 0 || d !== 0;
  } else {
    amount = parseAmount(get('amount'));
  }
  if (declared && !out.bankLayout) {
    out.type = declared;
    out.explicitType = true;
  }
  if (amount === null) {
    out.error ??= 'bad_amount';
    return out;
  }
  if (amount === 0) {
    out.error ??= 'zero_amount';
    return out;
  }

  const cancelMark =
    /취소/.test(String(get('cancel') ?? '')) || /취소/.test(text(get('type')) ?? '');
  if (banksalad) {
    // 뱅크샐러드: expenses are negative; a positive 지출 is a refund.
    if (out.type === 'expense') out.refund = amount > 0;
    else out.refund = false;
  } else if (out.bankLayout) {
    out.refund = amount < 0;
  } else {
    out.refund = amount < 0;
  }
  if (cancelMark && out.type === 'expense') out.refund = true;
  out.amount = Math.abs(amount);

  const inst = text(get('installment'));
  const months = inst ? /(\d{1,2})\s*(개월)?/.exec(inst) : null;
  out.installmentMonths =
    months && Number(months[1]) >= 2 && !/일시불/.test(inst ?? '') ? Number(months[1]) : null;
  return out;
}

/** Stable identity of a source row across files, used to skip rows imported before. */
export function rowIdentity(r: ParsedRow): string {
  return [
    r.date,
    r.time ?? '',
    r.refund ? '-' : '',
    r.amount,
    normalizeMerchant(r.merchant ?? ''),
    r.approvalNo ?? '',
  ].join('|');
}

const TRANSFER_WORDS =
  /카드대금|카드\s*결제\s*대금|카드결제|(신한|국민|KB|삼성|현대|롯데|하나|우리|농협|NH|BC|비씨|씨티)\s*카드|본인\s*(계좌|이체)?|내\s*계좌|계좌\s*간|타행\s*본인/i;

/** Bank rows that look like a card bill payment or a move between own accounts. */
export function looksLikeTransfer(r: Pick<ParsedRow, 'merchant' | 'memo'>): boolean {
  return TRANSFER_WORDS.test(`${r.merchant ?? ''} ${r.memo ?? ''}`);
}
