/**
 * Card payment SMS parsers (신한, KB국민, 삼성).
 *
 * UNVERIFIED: built from commonly seen layouts with invented values, not from
 * real samples. They are deliberately tolerant (line breaks or spaces, optional
 * `[Web발신]`, optional masked name, optional 누적, masked card digits) and
 * deliberately strict about what counts as a confident parse: a message must
 * yield a KRW amount, a date and time, and a merchant, or it goes to the 인박스.
 *
 * Recognition is separate from parsing. A message is a card notification only
 * if it STARTS (after `[Web발신]`) with a known issuer header followed by
 * 승인/취소. Everything else (verification codes, delivery notices, personal
 * texts, other issuers) is not recognised and must be discarded unstored.
 */
import {
  HOUSEHOLD_TIME_ZONE,
  addDays,
  parseKrw,
  toLocalDate,
  zonedTimeToUtc,
} from '@budget/shared';

export type Issuer = 'shinhan' | 'kb' | 'samsung';
export type CardMessageKind = 'approval' | 'cancel';

export interface ParsedCardMessage {
  issuer: Issuer;
  kind: CardMessageKind;
  /** Four characters, digits or `*` for masked positions (`1234`, `1*3*`), or null. */
  cardDigits: string | null;
  cardType: 'credit' | 'check';
  /** KRW amount; null for foreign-currency approvals without a won amount. */
  amount: number | null;
  currency: string | null;
  foreignAmount: string | null;
  /** Installment months (>= 2); null for 일시불. */
  installmentMonths: number | null;
  /** Wall-clock date and time from the message (no year), Asia/Seoul. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  merchant: string | null;
  cumulative: number | null;
}

export interface ParserInfo {
  id: string;
  version: number;
  issuer: Issuer;
}

export type ParseResult =
  | { recognized: false }
  | {
      recognized: true;
      parser: ParserInfo;
      ok: true;
      value: ParsedCardMessage;
    }
  | {
      recognized: true;
      parser: ParserInfo;
      ok: false;
      reason: string;
      partial: Partial<ParsedCardMessage>;
    };

interface IssuerSpec extends ParserInfo {
  /**
   * Header at the very start of the message. Groups: `type` (체크 marker),
   * `digits`, `kind` (승인 / 취소 / 승인취소 / 취소승인).
   */
  header: RegExp;
}

// Card digits: four characters of digits or '*', optionally in parentheses.
const DIGITS = String.raw`\(?(?<digits>[\d*]{4})\)?`;
const KIND = String.raw`(?<kind>승인취소|취소승인|취소|승인)`;

export const PARSERS: readonly IssuerSpec[] = [
  {
    id: 'shinhan-sms',
    version: 1,
    issuer: 'shinhan',
    header: new RegExp(String.raw`^신한(?<type>체크)?(?:카드)?\s*${DIGITS}?\s*(?:체크)?\s*${KIND}`),
  },
  {
    id: 'kb-sms',
    version: 1,
    issuer: 'kb',
    header: new RegExp(
      String.raw`^(?:KB국민|국민|KB)(?<type>체크)?(?:카드)?\s*${DIGITS}?\s*(?:체크)?\s*${KIND}`,
    ),
  },
  {
    id: 'samsung-sms',
    version: 1,
    issuer: 'samsung',
    header: new RegExp(String.raw`^삼성(?<type>체크)?(?:카드)?\s*${DIGITS}?\s*(?:체크)?\s*${KIND}`),
  },
];

export function parserTag(p: ParserInfo): string {
  return `${p.id}@${p.version}`;
}

export function currentParserTags(): Set<string> {
  return new Set(PARSERS.map(parserTag));
}

/** Strip `[Web발신]`, unify line breaks and spaces, NFKC. */
export function normalizeSms(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\[?\s*Web\s*발신\s*\]?\s*/i, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

const NAME = /^[가-힣A-Za-z][*＊][가-힣A-Za-z]?\s*님?$|^[가-힣]{1,2}[*＊][가-힣]{0,2}\s*님?$/;
const DATETIME = /(?<!\d)(?<m>\d{1,2})[/.-](?<d>\d{1,2})\s*(?<h>\d{1,2}):(?<min>\d{2})(?!\d)/;
const CUMULATIVE = /누적\s*:?\s*(?<cum>-?[\d,]+)\s*원/;
const WON = /(?<!누적\s*)(?<amt>-?[\d,]+)\s*원/;
const FOREIGN =
  /(?<cur>USD|JPY|EUR|CNY|GBP|HKD|SGD|THB|VND|AUD|CAD|CHF|TWD|PHP)\s*(?<famt>[\d,]+(?:\.\d+)?)|(?<famt2>[\d,]+(?:\.\d+)?)\s*(?<cur2>USD|JPY|EUR|CNY|GBP|달러|엔|유로|위안)/;
const INSTALLMENT = /(?<n>\d{1,2})\s*개월/;

export function parseSms(raw: string): ParseResult {
  const text = normalizeSms(raw);
  let spec: IssuerSpec | undefined;
  let header: RegExpExecArray | null = null;
  for (const candidate of PARSERS) {
    header = candidate.header.exec(text);
    if (header) {
      spec = candidate;
      break;
    }
  }
  if (!spec || !header) return { recognized: false };
  const info: ParserInfo = { id: spec.id, version: spec.version, issuer: spec.issuer };
  const g = header.groups ?? {};
  const kind: CardMessageKind = (g.kind ?? '').includes('취소') ? 'cancel' : 'approval';

  // A payment notification has an amount (won or foreign currency). A header
  // match without any amount (e.g. "신한카드 승인 거절 안내") is not one.
  let rest = text.slice(header[0].length);
  if (!WON.test(rest) && !FOREIGN.test(rest)) return { recognized: false };
  if (/거절|불가|실패/.test(rest)) return { recognized: false };

  const partial: Partial<ParsedCardMessage> = {
    issuer: spec.issuer,
    kind,
    cardDigits: g.digits ?? null,
    cardType: g.type || /체크/.test(text.slice(0, header[0].length + 8)) ? 'check' : 'credit',
  };
  const fail = (reason: string): ParseResult => ({
    recognized: true,
    parser: info,
    ok: false,
    reason,
    partial,
  });

  const cum = CUMULATIVE.exec(rest);
  partial.cumulative = cum?.groups?.cum ? parseKrw(`${cum.groups.cum}원`) : null;
  if (cum) rest = rest.replace(cum[0], ' ');

  const dt = DATETIME.exec(rest);
  if (!dt?.groups) return fail('no_datetime');
  const month = Number(dt.groups.m);
  const day = Number(dt.groups.d);
  const hour = Number(dt.groups.h);
  const minute = Number(dt.groups.min);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return fail('bad_datetime');
  }
  Object.assign(partial, { month, day, hour, minute });

  // Merchant: what follows the date/time, up to the end of that line or the
  // next line when the date stands alone on its line.
  const before = rest.slice(0, dt.index);
  let after = rest.slice(dt.index + dt[0].length);
  const afterLines = after.split('\n').map((s) => s.trim());
  let merchant = afterLines[0] || afterLines.find((l) => l) || '';
  merchant = merchant.replace(/^[,:\s]+/, '').trim();
  after = after.replace(merchant, ' ');

  const amountSource = `${before}\n${after}`;
  const won = WON.exec(amountSource);
  const foreign = FOREIGN.exec(amountSource);
  partial.amount = won?.groups?.amt ? parseKrw(`${won.groups.amt}원`) : null;
  if (partial.amount !== null && partial.amount !== undefined)
    partial.amount = Math.abs(partial.amount);
  partial.currency = foreign ? (foreign.groups?.cur ?? foreign.groups?.cur2 ?? null) : null;
  partial.foreignAmount = foreign ? (foreign.groups?.famt ?? foreign.groups?.famt2 ?? null) : null;

  const inst = INSTALLMENT.exec(amountSource);
  const months = inst?.groups?.n ? Number(inst.groups.n) : null;
  partial.installmentMonths = months !== null && months >= 2 ? months : null;

  // Drop a trailing masked name or amount tokens that slipped into the merchant line.
  merchant = merchant
    .replace(WON, '')
    .replace(/일시불|\d{1,2}\s*개월/g, '')
    .trim();
  if (NAME.test(merchant)) merchant = '';
  partial.merchant = merchant || null;

  if (partial.amount === null || partial.amount === undefined) {
    return fail(partial.currency ? 'foreign_currency' : 'no_amount');
  }
  if (partial.amount === 0) return fail('zero_amount');
  if (!partial.merchant) return fail('no_merchant');

  return {
    recognized: true,
    parser: info,
    ok: true,
    value: partial as ParsedCardMessage,
  };
}

/**
 * Instant of a message's date/time. Messages carry no year: use the receive
 * year, or the previous year when that would put the purchase more than a day
 * after the message was received (a 12/31 purchase received on 1/1).
 */
export function messageInstant(
  m: Pick<ParsedCardMessage, 'month' | 'day' | 'hour' | 'minute'>,
  receivedAt: number,
): number {
  const received = toLocalDate(receivedAt, HOUSEHOLD_TIME_ZONE);
  let year = Number(received.slice(0, 4));
  const at = (y: number) =>
    zonedTimeToUtc({ year: y, month: m.month, day: m.day, hour: m.hour, minute: m.minute });
  const limit = zonedTimeToUtc({
    ...(() => {
      const [y, mo, d] = addDays(received, 2).split('-').map(Number) as [number, number, number];
      return { year: y, month: mo, day: d };
    })(),
  });
  if (at(year) >= limit) year -= 1;
  return at(year);
}

/** Does a card's stored last-4 match message digits that may be masked (`1*3*`)? */
export function digitsMatch(last4: string | null, messageDigits: string | null): boolean {
  if (!last4 || !messageDigits || messageDigits.length !== 4) return false;
  if (!/\d/.test(messageDigits)) return false; // fully masked: no evidence
  return [...messageDigits].every((c, i) => c === '*' || c === last4[i]);
}
