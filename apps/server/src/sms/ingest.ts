/**
 * SMS ingestion: one card notification in, at most one transaction out.
 *
 * Privacy rule: a message that is not recognised as a card notification is
 * never stored; only the token's ignored counter and time are updated.
 *
 * Redelivery rule: the same token sending the same normalised text again is
 * a redelivery when the client receive time is identical (to the second), or,
 * when no client time is sent, when it arrives within REDELIVERY_WINDOW_MS of
 * the earlier copy. Two separate identical purchases produce two messages
 * with different receive times, so both are kept.
 */
import { and, desc, eq, gte, isNull, lte, ne, sql, type AnyColumn } from 'drizzle-orm';
import {
  formatKrw,
  merchantSimilarity,
  normalizeMerchant,
  toLocalDate,
  type RawRecordIssue,
} from '@budget/shared';
import { sha256 } from '../auth/tokens.ts';
import type { AppDatabase } from '../db/client.ts';
import { accounts, rawRecords, transactions, webhookTokens } from '../db/schema.ts';
import { categorize } from '../ledger/categorize.ts';
import { findDuplicate } from '../ledger/dedupe.ts';
import { visibleTo } from '../ledger/queries.ts';
import {
  digitsMatch,
  messageInstant,
  normalizeSms,
  parseSms,
  parserTag,
  currentParserTags,
  type Issuer,
  type ParsedCardMessage,
  type ParseResult,
} from './parse.ts';

export const REDELIVERY_WINDOW_MS = 2 * 60 * 1000;
const CANCEL_LOOKBACK_MS = 120 * 24 * 60 * 60 * 1000;

type RawRow = typeof rawRecords.$inferSelect;
/** A database handle or a transaction. */
export type Tx = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete'>;
type AccountRow = typeof accounts.$inferSelect;

export type IngestResult = 'created' | 'attached' | 'cancelled' | 'inbox' | 'duplicate' | 'ignored';

export interface IngestOutcome {
  result: IngestResult;
  rawRecordId?: number;
  transactionId?: number;
  issue?: RawRecordIssue;
  /** Short Korean summary for the Shortcuts app. */
  message: string;
}

export interface StoredParse extends ParsedCardMessage {
  occurredAt: string;
}

export interface IngestInput {
  tokenId: number;
  userId: number;
  text: string;
  sender?: string | null;
  clientReceivedAt?: number | null;
}

export function matchAccount(
  db: Pick<AppDatabase, 'select'>,
  issuer: Issuer,
  digits: string | null,
  preferUserId: number,
): AccountRow | null {
  const found = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.issuer, issuer), isNull(accounts.archivedAt)))
    .all()
    .filter((a) => digitsMatch(a.last4, digits));
  if (found.length <= 1) return found[0] ?? null;
  // Several cards share the visible digits: prefer the sender's own card.
  return (
    found.find((a) => a.primaryUserId === preferUserId) ??
    found.find((a) => a.ownerUserId === preferUserId) ??
    null
  );
}

function summary(v: ParsedCardMessage): string {
  const amount = v.amount === null ? '' : ` ${formatKrw(v.amount)}`;
  return `${v.merchant ?? ''}${amount}`.trim();
}

export function ingestSms(db: AppDatabase, now: number, input: IngestInput): IngestOutcome {
  const parsed = parseSms(input.text);
  if (!parsed.recognized) {
    db.update(webhookTokens)
      .set({ ignoredCount: sqlIncrement(webhookTokens.ignoredCount), lastIgnoredAt: new Date(now) })
      .where(eq(webhookTokens.id, input.tokenId))
      .run();
    return { result: 'ignored', message: '카드 결제 문자가 아니어서 저장하지 않았습니다' };
  }

  const contentHash = sha256(normalizeSms(input.text));
  const clientAt = input.clientReceivedAt ?? null;
  const earlier = db
    .select({ id: rawRecords.id, transactionId: rawRecords.transactionId })
    .from(rawRecords)
    .where(
      and(
        eq(rawRecords.webhookTokenId, input.tokenId),
        eq(rawRecords.contentHash, contentHash),
        clientAt !== null
          ? eq(rawRecords.clientReceivedAt, new Date(clientAt))
          : gte(rawRecords.receivedAt, new Date(now - REDELIVERY_WINDOW_MS)),
      ),
    )
    .get();
  if (earlier) {
    return {
      result: 'duplicate',
      rawRecordId: earlier.id,
      transactionId: earlier.transactionId ?? undefined,
      message: '이미 받은 문자입니다',
    };
  }

  const raw = db
    .insert(rawRecords)
    .values({
      source: 'sms',
      userId: input.userId,
      webhookTokenId: input.tokenId,
      receivedAt: new Date(now),
      clientReceivedAt: clientAt === null ? null : new Date(clientAt),
      rawText: input.text.trim().slice(0, 2000),
      sender: input.sender?.slice(0, 100) ?? null,
      contentHash,
      status: 'received',
    })
    .returning()
    .get();
  db.update(webhookTokens)
    .set({
      receivedCount: sqlIncrement(webhookTokens.receivedCount),
      lastReceivedAt: new Date(now),
    })
    .where(eq(webhookTokens.id, input.tokenId))
    .run();
  return processRawRecord(db, now, raw, parsed);
}

function sqlIncrement(column: AnyColumn) {
  return sql`${column} + 1`;
}

/** Turn a stored raw record into a transaction, an attachment, a cancellation or a 인박스 item. */
export function processRawRecord(
  db: AppDatabase,
  now: number,
  raw: RawRow,
  parsed: ParseResult = parseSms(raw.rawText),
): IngestOutcome {
  const update = (values: Partial<typeof rawRecords.$inferInsert>) =>
    db
      .update(rawRecords)
      .set({ processedAt: new Date(now), ...values })
      .where(eq(rawRecords.id, raw.id))
      .run();

  if (!parsed.recognized) {
    update({
      status: 'failed',
      issue: 'unparsed',
      issueData: { reason: 'not_recognized' },
      resolvedAt: null,
    });
    return {
      result: 'inbox',
      rawRecordId: raw.id,
      issue: 'unparsed',
      message: '해석하지 못해 인박스로 보냈습니다',
    };
  }
  const tag = parserTag(parsed.parser);
  if (!parsed.ok) {
    update({
      status: 'failed',
      parser: tag,
      parsed: parsed.partial,
      error: parsed.reason,
      issue: 'unparsed',
      issueData: { reason: parsed.reason },
      resolvedAt: null,
    });
    return {
      result: 'inbox',
      rawRecordId: raw.id,
      issue: 'unparsed',
      message: '해석하지 못해 인박스로 보냈습니다',
    };
  }

  const v = parsed.value;
  const userId = raw.userId ?? 0;
  const receivedAt = (raw.clientReceivedAt ?? raw.receivedAt).getTime();
  const occurredAt = messageInstant(v, receivedAt);
  const stored: StoredParse = { ...v, occurredAt: new Date(occurredAt).toISOString() };
  const account = matchAccount(db, v.issuer, v.cardDigits, userId);
  const ownerUserId = account?.primaryUserId ?? userId;
  const amount = v.amount as number;

  return db.transaction((tx) => {
    const done = (values: Partial<typeof rawRecords.$inferInsert>) =>
      tx
        .update(rawRecords)
        .set({ processedAt: new Date(now), parser: tag, parsed: stored, error: null, ...values })
        .where(eq(rawRecords.id, raw.id))
        .run();

    if (v.kind === 'cancel') {
      const original = findCancelTarget(tx, {
        accountId: account?.id ?? null,
        amount,
        merchant: v.merchant,
        at: occurredAt,
        viewerId: userId,
      });
      if (!original) {
        done({ status: 'parsed', issue: 'unmatched_cancel', issueData: null, resolvedAt: null });
        return {
          result: 'inbox',
          rawRecordId: raw.id,
          issue: 'unmatched_cancel',
          message: `취소할 원래 거래를 찾지 못했습니다: ${summary(v)}`,
        } as IngestOutcome;
      }
      applyCancel(tx, original, amount, now);
      done({
        status: 'linked',
        transactionId: original.id,
        issue: null,
        issueData: null,
        resolvedAt: null,
      });
      return {
        result: 'cancelled',
        rawRecordId: raw.id,
        transactionId: original.id,
        message: `취소 반영: ${summary(v)}`,
      } as IngestOutcome;
    }

    const dup = findDuplicate(tx, {
      type: 'expense',
      amount,
      occurredAt,
      accountId: account?.id ?? null,
      merchant: v.merchant,
      excludeLinkedSource: 'sms',
      viewerId: userId,
    });
    if (dup.kind === 'match') {
      const existing = tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, dup.transactionId))
        .get();
      if (!existing) throw new Error('duplicate candidate vanished');
      tx.update(transactions)
        .set({
          status: existing.status === 'needs_review' ? 'confirmed' : existing.status,
          accountId: existing.accountId ?? account?.id ?? null,
          installmentMonths: existing.installmentMonths ?? v.installmentMonths,
          updatedAt: new Date(now),
        })
        .where(eq(transactions.id, existing.id))
        .run();
      done({
        status: 'linked',
        transactionId: existing.id,
        issue: null,
        issueData: null,
        resolvedAt: null,
      });
      return {
        result: 'attached',
        rawRecordId: raw.id,
        transactionId: existing.id,
        message: `이미 입력된 거래와 연결했습니다: ${summary(v)}`,
      } as IngestOutcome;
    }
    if (dup.kind === 'ambiguous') {
      done({
        status: 'parsed',
        issue: 'ambiguous_duplicate',
        issueData: { candidateIds: dup.candidateIds },
        resolvedAt: null,
      });
      return {
        result: 'inbox',
        rawRecordId: raw.id,
        issue: 'ambiguous_duplicate',
        message: `비슷한 거래가 있어 인박스에서 확인이 필요합니다: ${summary(v)}`,
      } as IngestOutcome;
    }

    const created = createFromParse(tx, now, stored, {
      accountId: account?.id ?? null,
      ownerUserId,
      createdByUserId: userId,
    });
    done({
      status: 'linked',
      transactionId: created.id,
      issue: account ? null : 'unmatched_card',
      issueData: account ? null : { issuer: v.issuer, digits: v.cardDigits },
      resolvedAt: null,
    });
    const category = created.categoryId ? '' : ' (미분류)';
    return {
      result: 'created',
      rawRecordId: raw.id,
      transactionId: created.id,
      issue: account ? undefined : 'unmatched_card',
      message: `등록했습니다: ${summary(v)}${category}`,
    } as IngestOutcome;
  });
}

export function createFromParse(
  db: Tx,
  now: number,
  v: StoredParse,
  who: { accountId: number | null; ownerUserId: number; createdByUserId: number },
): typeof transactions.$inferSelect {
  const occurredAt = new Date(v.occurredAt);
  const guess = categorize(db, {
    merchant: v.merchant,
    type: 'expense',
    viewerId: who.ownerUserId,
  });
  return db
    .insert(transactions)
    .values({
      type: 'expense',
      amount: v.amount as number,
      occurredAt,
      occurredDate: toLocalDate(occurredAt),
      merchant: v.merchant,
      merchantKey: v.merchant ? normalizeMerchant(v.merchant) : null,
      categoryId: guess.categoryId,
      accountId: who.accountId,
      ownerUserId: who.ownerUserId,
      createdByUserId: who.createdByUserId,
      status: 'confirmed',
      source: 'sms',
      installmentMonths: v.installmentMonths,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .returning()
    .get();
}

/** The most recent uncancelled expense that a cancellation refers to. */
export function findCancelTarget(
  db: Tx,
  c: {
    accountId: number | null;
    amount: number;
    merchant: string | null;
    at: number;
    viewerId: number;
  },
): typeof transactions.$inferSelect | null {
  const rows = db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.type, 'expense'),
        ne(transactions.status, 'cancelled'),
        gte(transactions.amount, c.amount),
        gte(transactions.occurredAt, new Date(c.at - CANCEL_LOOKBACK_MS)),
        lte(transactions.occurredAt, new Date(c.at + 60 * 60 * 1000)),
        c.accountId === null ? undefined : eq(transactions.accountId, c.accountId),
        visibleTo(c.viewerId),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .all()
    .filter((t) => !c.merchant || !t.merchant || merchantSimilarity(t.merchant, c.merchant) >= 0.6);
  // Prefer an exact amount (full cancellation), then the most recent.
  return rows.find((t) => t.amount === c.amount) ?? rows[0] ?? null;
}

/** Full cancel marks it cancelled; partial cancel reduces amount and keeps original_amount. */
export function applyCancel(
  db: Tx,
  target: typeof transactions.$inferSelect,
  cancelAmount: number,
  now: number,
): void {
  if (cancelAmount >= target.amount) {
    db.update(transactions)
      .set({ status: 'cancelled', updatedAt: new Date(now) })
      .where(eq(transactions.id, target.id))
      .run();
    return;
  }
  db.update(transactions)
    .set({
      originalAmount: target.originalAmount ?? target.amount,
      amount: target.amount - cancelAmount,
      updatedAt: new Date(now),
    })
    .where(eq(transactions.id, target.id))
    .run();
}

/**
 * Link transactions from previously unmatched cards to a newly created or
 * edited account, and close those 인박스 items. Returns how many were linked.
 */
export function linkUnmatchedCards(db: AppDatabase, account: AccountRow, now: number): number {
  if (!account.issuer || !account.last4 || account.archivedAt) return 0;
  const open = db
    .select()
    .from(rawRecords)
    .where(and(eq(rawRecords.issue, 'unmatched_card'), isNull(rawRecords.resolvedAt)))
    .all()
    .filter((r) => {
      const p = r.parsed as StoredParse | null;
      return p?.issuer === account.issuer && digitsMatch(account.last4, p.cardDigits);
    });
  db.transaction((tx) => {
    for (const r of open) {
      if (r.transactionId) {
        tx.update(transactions)
          .set({
            accountId: account.id,
            ...(account.primaryUserId ? { ownerUserId: account.primaryUserId } : {}),
            updatedAt: new Date(now),
          })
          .where(and(eq(transactions.id, r.transactionId), isNull(transactions.accountId)))
          .run();
      }
      tx.update(rawRecords)
        .set({ resolvedAt: new Date(now) })
        .where(eq(rawRecords.id, r.id))
        .run();
    }
  });
  return open.length;
}

export interface ReprocessReport {
  checked: number;
  reparsed: number;
  created: number;
  stillFailing: number;
}

/**
 * Re-run parsers over SMS records that failed or were parsed by an older
 * parser version. Records already linked to a transaction only get their
 * parse refreshed, so running this repeatedly never duplicates transactions.
 */
export function reprocessRawRecords(db: AppDatabase, now: number): ReprocessReport {
  const current = currentParserTags();
  const rows = db
    .select()
    .from(rawRecords)
    .where(and(eq(rawRecords.source, 'sms'), ne(rawRecords.status, 'ignored')))
    .all()
    .filter(
      (r) =>
        r.status === 'failed' || r.status === 'received' || !r.parser || !current.has(r.parser),
    );
  const report: ReprocessReport = {
    checked: rows.length,
    reparsed: 0,
    created: 0,
    stillFailing: 0,
  };
  for (const raw of rows) {
    const parsed = parseSms(raw.rawText);
    if (raw.transactionId || raw.status === 'parsed') {
      if (parsed.recognized && parsed.ok) {
        db.update(rawRecords)
          .set({
            parser: parserTag(parsed.parser),
            parsed: { ...(raw.parsed as object), ...parsed.value },
          })
          .where(eq(rawRecords.id, raw.id))
          .run();
        report.reparsed += 1;
      }
      continue;
    }
    const outcome = processRawRecord(db, now, raw, parsed);
    if (outcome.transactionId) report.created += 1;
    else report.stillFailing += 1;
  }
  return report;
}

/** Preview of what ingesting `text` would do, without writing anything. */
export function previewSms(db: AppDatabase, text: string, receivedAt: number, userId: number) {
  const parsed = parseSms(text);
  if (!parsed.recognized) return { recognized: false as const };
  if (!parsed.ok) {
    return {
      recognized: true as const,
      ok: false as const,
      parser: parserTag(parsed.parser),
      reason: parsed.reason,
      partial: parsed.partial,
    };
  }
  const v = parsed.value;
  const account = matchAccount(db, v.issuer, v.cardDigits, userId);
  const occurredAt = new Date(messageInstant(v, receivedAt)).toISOString();
  const guess =
    v.kind === 'approval'
      ? categorize(db, { merchant: v.merchant, type: 'expense', viewerId: userId })
      : null;
  return {
    recognized: true as const,
    ok: true as const,
    parser: parserTag(parsed.parser),
    value: { ...v, occurredAt },
    account: account ? { id: account.id, name: account.name } : null,
    categoryId: guess?.categoryId ?? null,
    categoryReason: guess?.reason ?? null,
  };
}
