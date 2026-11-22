/**
 * Money helpers. Every amount in the app is an integer number of Korean won.
 * KRW has no minor unit in practice, so there are no fractional amounts.
 */

/** Integer amount in KRW. */
export type Krw = number;

const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

export function isKrw(value: unknown): value is Krw {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertKrw(value: unknown, label = 'amount'): asserts value is Krw {
  if (!isKrw(value)) throw new TypeError(`${label} must be an integer KRW amount`);
}

/** `12345` -> `12,345원`; `-500` -> `-500원`. */
export function formatKrw(amount: Krw, options: { withSign?: boolean } = {}): string {
  assertKrw(amount);
  const body = numberFormat.format(Math.abs(amount));
  const sign = amount < 0 ? '-' : options.withSign && amount > 0 ? '+' : '';
  return `${sign}${body}원`;
}

const KRW_TEXT_RE = /^([+-])?\s*(?:₩|\\)?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(?:원)?$/u;

/**
 * Parse a KRW amount as it appears in card messages and spreadsheets:
 * `12,345원`, `₩12,345`, `12345`, `-1,000원`. Returns null for anything else,
 * including decimals, so that bad input is never silently rounded.
 */
export function parseKrw(text: string): Krw | null {
  const m = KRW_TEXT_RE.exec(text.trim());
  if (!m) return null;
  const value = Number((m[2] ?? '').replaceAll(',', ''));
  if (!Number.isSafeInteger(value)) return null;
  return m[1] === '-' ? -value : value;
}

/** Sum that refuses to lose precision. */
export function sumKrw(amounts: Iterable<Krw>): Krw {
  let total = 0;
  for (const amount of amounts) {
    assertKrw(amount);
    total += amount;
    if (!Number.isSafeInteger(total)) throw new RangeError('KRW sum overflow');
  }
  return total;
}
