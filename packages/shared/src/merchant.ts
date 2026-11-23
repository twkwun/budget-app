/**
 * Merchant name normalisation, shared so the server (rules, history lookup,
 * duplicate detection) and the web app (rule suggestions) agree.
 */

const CORPORATE_MARKERS = /(주식회사|유한회사|\(주\)|\(유\)|㈜|（주）)/g;
const PUNCTUATION = /[\s·・.,\-_/\\'"`~!@#$%^&*+=|:;<>?()[\]{}（）]/g;

/**
 * Canonical key: NFKC, uppercase Latin, corporate markers and punctuation and
 * spaces removed. `(주)스타벅스 강남점` → `스타벅스강남점`.
 */
export function normalizeMerchant(name: string): string {
  return name
    .normalize('NFKC')
    .replace(CORPORATE_MARKERS, '')
    .replace(PUNCTUATION, '')
    .toUpperCase();
}

/**
 * Pattern suggested for "이 가맹점은 앞으로도 이렇게": the merchant without a
 * trailing branch word when it is clearly separated (`스타벅스 강남점` →
 * `스타벅스`). Joined names (`스타벅스강남점`) are kept whole because the
 * brand/branch split cannot be known safely.
 */
export function suggestRulePattern(name: string): string {
  const cleaned = name.normalize('NFKC').replace(CORPORATE_MARKERS, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && /(점|지점|직영점|센터|매장)$/.test(words.at(-1) ?? '')) {
    words.pop();
  }
  const pattern = normalizeMerchant(words.join(' '));
  return pattern.length >= 2 ? pattern : normalizeMerchant(cleaned);
}

/** Payment intermediaries that hide the real merchant (DESIGN 6.4): always left 미분류. */
const AGGREGATORS = [
  '네이버페이',
  'NAVERPAY',
  '카카오페이',
  'KAKAOPAY',
  '토스페이',
  'TOSSPAY',
  '페이코',
  'PAYCO',
  '스마일페이',
  'SMILEPAY',
  '쿠페이',
  '간편결제',
  '페이팔',
  'PAYPAL',
].map(normalizeMerchant);

export function isAggregatorMerchant(name: string | null | undefined): boolean {
  if (!name) return false;
  const key = normalizeMerchant(name);
  return AGGREGATORS.some((a) => key.startsWith(a));
}

/** Similarity of two merchant names in [0, 1] (Dice coefficient over character bigrams). */
export function merchantSimilarity(a: string, b: string): number {
  const x = normalizeMerchant(a);
  const y = normalizeMerchant(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(1, x.length - 1 + (y.length - 1));
  return (2 * overlap) / total;
}
