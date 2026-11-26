/**
 * 고정지출: monthly payments a member expects. Every member keeps their own
 * list. Candidates are detected from the member's own (non-private) spending — the same
 * merchant, a similar amount, once a month for at least three consecutive
 * months — and suggested; the member confirms or dismisses them, or adds items
 * by hand. Confirmed items are matched against the member's own payments.
 */
import { and, eq, gte, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  RECURRING_AMOUNT_TOLERANCE,
  addMonths,
  daysInMonth,
  isAggregatorMerchant,
  parseLocalDate,
  toLocalDate,
  toYearMonth,
  type LocalDate,
  type RecurringItem,
  type RecurringMonthItem,
  type RecurringOverview,
  type YearMonth,
} from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { accounts, categories, recurringExpenses, transactions, users } from '../db/schema.ts';
import { visibleTo } from '../ledger/queries.ts';

type RecurringRow = typeof recurringExpenses.$inferSelect;

/** Detection settings. */
export const DETECTION = {
  /** Months looked back (plus the current month). */
  lookbackMonths: 12,
  /** Consecutive months with exactly one payment needed for a suggestion. */
  minMonths: 3,
  /** Payment days may spread over at most this many days. */
  maxDaySpread: 7,
} as const;

interface PaymentRow {
  id: number;
  merchant: string | null;
  merchantKey: string;
  date: LocalDate;
  amount: number;
  categoryId: number | null;
  accountId: number | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const at = (i: number) => sorted[i] ?? 0;
  return sorted.length % 2 ? at(mid) : Math.round((at(mid - 1) + at(mid)) / 2);
}

export function amountMatches(expected: number, actual: number): boolean {
  return Math.abs(actual - expected) <= expected * RECURRING_AMOUNT_TOLERANCE;
}

/**
 * `ownerId`'s payments in the range: those `viewerId` can see, or — for
 * detection, without a viewer — the non-private ones, so a suggestion (which
 * an admin can see) never reveals a 나만 보기 entry.
 */
function payments(
  db: AppDatabase,
  fromDate: LocalDate,
  toDateExclusive: LocalDate,
  ownerId: number,
  viewerId?: number,
): PaymentRow[] {
  return db
    .select({
      id: transactions.id,
      merchant: transactions.merchant,
      merchantKey: sql<string>`${transactions.merchantKey}`,
      date: transactions.occurredDate,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.type, 'expense'),
        ne(transactions.status, 'cancelled'),
        isNotNull(transactions.merchantKey),
        gte(transactions.occurredDate, fromDate),
        lt(transactions.occurredDate, toDateExclusive),
        eq(transactions.ownerUserId, ownerId),
        viewerId === undefined ? eq(transactions.isPrivate, false) : visibleTo(viewerId),
      ),
    )
    .all();
}

export interface Candidate {
  name: string;
  matchKey: string;
  amount: number;
  dayOfMonth: number;
  categoryId: number | null;
  accountId: number | null;
  months: YearMonth[];
}

/**
 * Pure detection over one merchant's payments: the latest run of consecutive
 * months with exactly one payment each, ending this month or last month, at
 * least `minMonths` long, amounts within the tolerance of their median and
 * payment days within `maxDaySpread`.
 */
export function detectCandidate(rows: PaymentRow[], currentMonth: YearMonth): Candidate | null {
  const byMonth = new Map<YearMonth, PaymentRow[]>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), row]);
  }
  // The run must still be active: it ends this month, or last month when this
  // month's payment has not come yet.
  let end = currentMonth;
  if (byMonth.get(end)?.length !== 1) {
    if (byMonth.has(end)) return null;
    end = addMonths(currentMonth, -1);
  }
  const run: PaymentRow[] = [];
  for (let m = end, rows = byMonth.get(m); rows?.length === 1;) {
    run.push(...rows);
    m = addMonths(m, -1);
    rows = byMonth.get(m);
  }
  if (run.length < DETECTION.minMonths) return null;
  const mid = median(run.map((r) => r.amount));
  if (!run.every((r) => amountMatches(mid, r.amount))) return null;
  const days = run.map((r) => parseLocalDate(r.date).day);
  if (Math.max(...days) - Math.min(...days) > DETECTION.maxDaySpread) return null;
  const [latest] = run;
  if (!latest) return null;
  return {
    name: latest.merchant ?? latest.merchantKey,
    matchKey: latest.merchantKey,
    amount: mid,
    dayOfMonth: median(days),
    categoryId: latest.categoryId,
    accountId: latest.accountId,
    months: run.map((r) => r.date.slice(0, 7)),
  };
}

/**
 * Find new candidates in a member's spending (every active member's when
 * `userId` is omitted) and store them as that member's suggestions. Returns how many.
 */
export function refreshSuggestions(db: AppDatabase, now: number, userId?: number): number {
  if (userId === undefined) {
    return db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.disabledAt))
      .all()
      .reduce((n, u) => n + refreshSuggestions(db, now, u.id), 0);
  }
  const currentMonth = toYearMonth(now);
  const from = `${addMonths(currentMonth, -DETECTION.lookbackMonths)}-01`;
  const to = `${addMonths(currentMonth, 1)}-01`;
  const byKey = new Map<string, PaymentRow[]>();
  for (const row of payments(db, from, to, userId)) {
    if (isAggregatorMerchant(row.merchant)) continue;
    byKey.set(row.merchantKey, [...(byKey.get(row.merchantKey) ?? []), row]);
  }
  const known = db
    .select({ matchKey: recurringExpenses.matchKey })
    .from(recurringExpenses)
    .where(eq(recurringExpenses.userId, userId))
    .all();
  let added = 0;
  for (const [key, rows] of byKey) {
    // Anything an existing item (in any state) already covers is not suggested again.
    if (known.some((k) => key.includes(k.matchKey))) continue;
    const candidate = detectCandidate(rows, currentMonth);
    if (!candidate) continue;
    db.insert(recurringExpenses)
      .values({
        userId,
        name: candidate.name,
        matchKey: candidate.matchKey,
        amount: candidate.amount,
        dayOfMonth: candidate.dayOfMonth,
        categoryId: candidate.categoryId,
        accountId: candidate.accountId,
        status: 'suggested',
        source: 'detected',
      })
      .onConflictDoNothing()
      .run();
    known.push({ matchKey: key });
    added += 1;
  }
  return added;
}

export function expectedDate(month: YearMonth, dayOfMonth: number): LocalDate {
  return `${month}-${String(Math.min(dayOfMonth, daysInMonth(month))).padStart(2, '0')}`;
}

/**
 * Assign payments to items for one month: each payment pays at most one item;
 * more specific (longer) match keys pick first; the payment closest to the
 * expected date wins.
 */
export function matchPayments(
  items: Pick<RecurringRow, 'id' | 'matchKey' | 'amount' | 'dayOfMonth'>[],
  rows: PaymentRow[],
  month: YearMonth,
): Map<number, PaymentRow> {
  const used = new Set<number>();
  const result = new Map<number, PaymentRow>();
  const ordered = [...items].sort((a, b) => b.matchKey.length - a.matchKey.length || a.id - b.id);
  for (const item of ordered) {
    const target = parseLocalDate(expectedDate(month, item.dayOfMonth)).day;
    const best = rows
      .filter(
        (r) =>
          !used.has(r.id) &&
          r.date.startsWith(month) &&
          r.merchantKey.includes(item.matchKey) &&
          amountMatches(item.amount, r.amount),
      )
      .sort(
        (a, b) =>
          Math.abs(parseLocalDate(a.date).day - target) -
            Math.abs(parseLocalDate(b.date).day - target) || a.id - b.id,
      )[0];
    if (best) {
      used.add(best.id);
      result.set(item.id, best);
    }
  }
  return result;
}

function itemRows(db: AppDatabase, userId: number) {
  return db
    .select({
      item: recurringExpenses,
      categoryName: categories.name,
      accountName: accounts.name,
    })
    .from(recurringExpenses)
    .leftJoin(categories, eq(recurringExpenses.categoryId, categories.id))
    .leftJoin(accounts, eq(recurringExpenses.accountId, accounts.id))
    .where(eq(recurringExpenses.userId, userId))
    .all();
}

function toItem(
  row: ReturnType<typeof itemRows>[number],
  seenMonths: YearMonth[] = [],
): RecurringItem {
  const { item } = row;
  return {
    id: item.id,
    name: item.name,
    matchKey: item.matchKey,
    amount: item.amount,
    dayOfMonth: item.dayOfMonth,
    categoryId: item.categoryId,
    categoryName: row.categoryName,
    accountId: item.accountId,
    accountName: row.accountName,
    status: item.status,
    source: item.source,
    seenMonths,
  };
}

/**
 * `userId`'s confirmed items with their state in `month`, plus suggestions and
 * dismissed items, matched against that member's payments `viewerId` can see.
 */
export function recurringOverview(
  db: AppDatabase,
  viewerId: number,
  userId: number,
  month: YearMonth,
  now: number,
  options: { includeOthers?: boolean } = {},
): RecurringOverview {
  const rows = itemRows(db, userId);
  const confirmed = rows.filter((r) => r.item.status === 'confirmed');
  const today = toLocalDate(now);
  const includeOthers = options.includeOthers ?? true;
  // Suggestions show the months they were seen in, so look back further for those.
  const historyMonths = includeOthers ? 6 : 0;
  const from = `${addMonths(month, -historyMonths)}-01`;
  const to = `${addMonths(month, 1)}-01`;
  const visible = rows.length ? payments(db, from, to, userId, viewerId) : [];

  const matched = matchPayments(
    confirmed.map((r) => r.item),
    visible,
    month,
  );
  const items: RecurringMonthItem[] = confirmed
    .map((row) => {
      const date = expectedDate(month, row.item.dayOfMonth);
      const paid = matched.get(row.item.id);
      return {
        ...toItem(row),
        month,
        expectedDate: date,
        state: paid ? 'paid' : date >= today ? 'upcoming' : 'late',
        paid: paid ? { transactionId: paid.id, date: paid.date, amount: paid.amount } : null,
      } satisfies RecurringMonthItem;
    })
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id - b.id);

  const seen = (row: (typeof rows)[number]): YearMonth[] => {
    const months = new Set<YearMonth>();
    for (const p of visible) {
      if (p.merchantKey.includes(row.item.matchKey) && amountMatches(row.item.amount, p.amount)) {
        months.add(p.date.slice(0, 7));
      }
    }
    return [...months].sort().reverse();
  };
  return {
    userId,
    month,
    items,
    suggestions: includeOthers
      ? rows.filter((r) => r.item.status === 'suggested').map((r) => toItem(r, seen(r)))
      : [],
    dismissed: includeOthers
      ? rows.filter((r) => r.item.status === 'dismissed').map((r) => toItem(r))
      : [],
    remainingAmount: items.filter((i) => i.state !== 'paid').reduce((s, i) => s + i.amount, 0),
  };
}

export function suggestionCount(db: AppDatabase, userId: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(recurringExpenses)
      .where(and(eq(recurringExpenses.userId, userId), eq(recurringExpenses.status, 'suggested')))
      .get()?.n ?? 0
  );
}
