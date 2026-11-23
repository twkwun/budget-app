/**
 * Duplicate detection (DESIGN 6.3), shared by SMS ingestion and (stage 5) file import.
 *
 * 1. Same account and approval number → the same transaction.
 * 2. Otherwise candidates are transactions of the same type and amount within
 *    ±1 local day, on the same account (or with no account recorded), visible
 *    to the viewer, that are not already claimed by the incoming source (an
 *    SMS never matches a transaction that already has an SMS; a file row never
 *    matches one already linked to a row of the same import batch).
 *    A 간편결제 placeholder merchant counts as a plausible match.
 * 3. Merchant similarity decides: exactly one candidate scoring >= 0.6 is a
 *    match; candidates whose known merchant scores < 0.3 are different
 *    purchases; anything else is ambiguous and goes to the 인박스.
 */
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { addDays, isAggregatorMerchant, merchantSimilarity, toLocalDate } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { importBatches, rawRecords, transactions } from '../db/schema.ts';

export const MATCH_THRESHOLD = 0.6;
export const DIFFERENT_THRESHOLD = 0.3;

export interface DuplicateInput {
  type: 'expense' | 'income' | 'transfer';
  amount: number;
  occurredAt: number;
  accountId: number | null;
  merchant: string | null;
  approvalNo?: string | null;
  /** Skip candidates that already have a record from this source (SMS). */
  excludeLinkedSource?: 'sms';
  /** Skip candidates already linked to a row of this import batch. */
  excludeBatchId?: number;
  /**
   * Skip candidates already backed by a row from a file of the same layout
   * (header signature). Each row of one source maps to its own transaction,
   * so two identical purchases in a 뱅크샐러드 export never collapse into
   * one; a different source (a card issuer file, an SMS) still matches.
   */
  excludeLayoutSignature?: string | null;
  /** Skip candidates claimed by earlier rows of the same analysis. */
  excludeIds?: ReadonlySet<number>;
  viewerId: number;
}

export type DuplicateResult =
  | { kind: 'none' }
  | { kind: 'match'; transactionId: number; score: number }
  | { kind: 'ambiguous'; candidateIds: number[] };

export function findDuplicate(
  db: Pick<AppDatabase, 'select'>,
  input: DuplicateInput,
): DuplicateResult {
  if (input.approvalNo && input.accountId !== null) {
    const byApproval = db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, input.accountId),
          eq(transactions.approvalNo, input.approvalNo),
        ),
      )
      .get();
    if (byApproval) return { kind: 'match', transactionId: byApproval.id, score: 1 };
  }

  const day = toLocalDate(input.occurredAt);
  const days = [addDays(day, -1), day, addDays(day, 1)];
  const candidates = db
    .select({ id: transactions.id, merchant: transactions.merchant })
    .from(transactions)
    .where(
      and(
        eq(transactions.type, input.type),
        eq(transactions.amount, input.amount),
        ne(transactions.status, 'cancelled'),
        inArray(transactions.occurredDate, days),
        input.accountId === null
          ? undefined
          : or(eq(transactions.accountId, input.accountId), isNull(transactions.accountId)),
        or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, input.viewerId)),
        input.excludeLinkedSource
          ? sql`not exists (select 1 from ${rawRecords} where ${rawRecords.transactionId} = ${transactions.id} and ${rawRecords.source} = ${input.excludeLinkedSource})`
          : undefined,
        input.excludeBatchId !== undefined
          ? sql`not exists (select 1 from ${rawRecords} where ${rawRecords.transactionId} = ${transactions.id} and ${rawRecords.importBatchId} = ${input.excludeBatchId})`
          : undefined,
        input.excludeLayoutSignature
          ? sql`not exists (select 1 from ${rawRecords} join ${importBatches} on ${importBatches.id} = ${rawRecords.importBatchId} where ${rawRecords.transactionId} = ${transactions.id} and ${importBatches.headerSignature} = ${input.excludeLayoutSignature})`
          : undefined,
      ),
    )
    .all()
    .filter((c) => !input.excludeIds?.has(c.id));
  if (candidates.length === 0) return { kind: 'none' };

  const scored = candidates.map((c) => ({
    id: c.id,
    score:
      c.merchant && input.merchant
        ? isAggregatorMerchant(c.merchant) || isAggregatorMerchant(input.merchant)
          ? MATCH_THRESHOLD
          : merchantSimilarity(c.merchant, input.merchant)
        : null,
  }));
  const plausible = scored.filter((c) => c.score === null || c.score >= DIFFERENT_THRESHOLD);
  const confident = plausible.filter((c) => c.score !== null && c.score >= MATCH_THRESHOLD);
  const [best] = confident;
  if (confident.length === 1 && best) {
    return { kind: 'match', transactionId: best.id, score: best.score ?? 1 };
  }
  if (plausible.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', candidateIds: plausible.map((c) => c.id) };
}
