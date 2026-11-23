/**
 * 인박스: everything that needs one decision from a person.
 * - 미분류 transactions (visible to the viewer, any member's)
 * - the viewer's own unparsed messages, unmatched cards, unmatched
 *   cancellations and ambiguous duplicates (raw records they sent)
 */
import { and, count, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  EDITABLE_STATUSES,
  MAX_AMOUNT,
  MERCHANT_MAX_LENGTH,
  normalizeMerchant,
  toLocalDate,
  type InboxItem,
  type InboxList,
  type ParsedCardFields,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { accounts, categories, rawRecords, transactions } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { categorize } from '../ledger/categorize.ts';
import { getTransaction, visibleTo } from '../ledger/queries.ts';
import { applyCancel, createFromParse, matchAccount, type StoredParse } from '../sms/ingest.ts';

const UNCATEGORIZED_LIMIT = 50;
const idParam = z.object({ id: z.coerce.number().int().positive() });

export function inboxRoutes(ctx: AppContext): FastifyPluginAsync {
  const uncategorizedWhere = (userId: number) =>
    and(
      visibleTo(userId),
      isNull(transactions.categoryId),
      ne(transactions.type, 'transfer'),
      ne(transactions.status, 'cancelled'),
    );

  const openRaw = (userId: number) =>
    ctx.db
      .select()
      .from(rawRecords)
      .where(
        and(
          eq(rawRecords.userId, userId),
          isNull(rawRecords.resolvedAt),
          sql`${rawRecords.issue} is not null`,
        ),
      )
      .orderBy(desc(rawRecords.receivedAt))
      .all();

  /** Category suggestions: the engine's guess, then the household's most used for that kind. */
  const suggestionsFor = (merchant: string | null, type: string, userId: number): number[] => {
    const kind = type === 'income' ? 'income' : 'expense';
    const out: number[] = [];
    const guess = categorize(ctx.db, { merchant, type: kind, viewerId: userId }).categoryId;
    if (guess) out.push(guess);
    const popular = ctx.db
      .select({ id: transactions.categoryId, n: count() })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          eq(transactions.type, kind),
          isNull(categories.archivedAt),
          gte(transactions.occurredAt, new Date(ctx.now() - 90 * 24 * 60 * 60 * 1000)),
        ),
      )
      .groupBy(transactions.categoryId)
      .orderBy(desc(count()))
      .limit(6)
      .all();
    for (const p of popular) if (p.id && !out.includes(p.id)) out.push(p.id);
    return out.slice(0, 5);
  };

  const countFor = (userId: number): number => {
    const tx =
      ctx.db.select({ n: count() }).from(transactions).where(uncategorizedWhere(userId)).get()?.n ??
      0;
    const raws = openRaw(userId);
    const cards = new Set(
      raws
        .filter((r) => r.issue === 'unmatched_card')
        .map((r) => {
          const p = r.parsed as StoredParse | null;
          return `${p?.issuer}:${p?.cardDigits}`;
        }),
    );
    return tx + raws.filter((r) => r.issue !== 'unmatched_card').length + cards.size;
  };

  const loadOwnRaw = (userId: number, id: number) => {
    const raw = ctx.db.select().from(rawRecords).where(eq(rawRecords.id, id)).get();
    if (!raw || raw.userId !== userId || raw.resolvedAt || !raw.issue) {
      throw errors.notFound('Inbox item not found');
    }
    return raw;
  };

  const resolve = (id: number, values: Partial<typeof rawRecords.$inferInsert> = {}) =>
    ctx.db
      .update(rawRecords)
      .set({ resolvedAt: new Date(ctx.now()), ...values })
      .where(eq(rawRecords.id, id))
      .run();

  return async (app) => {
    app.get('/inbox/count', async (request) => ({ count: countFor(currentAuth(request).user.id) }));

    app.get('/inbox', async (request): Promise<InboxList> => {
      const { user } = currentAuth(request);
      const items: InboxItem[] = [];
      const raws = openRaw(user.id);
      const info = (id: number) => getTransaction(ctx.db, user.id, id);

      // Message problems first: they block a transaction from existing at all.
      for (const r of raws) {
        const parsed = (r.parsed ?? null) as ParsedCardFields | null;
        const base = { rawRecordId: r.id, receivedAt: r.receivedAt.toISOString() };
        if (r.issue === 'unparsed') {
          items.push({
            kind: 'unparsed',
            key: `raw-${r.id}`,
            ...base,
            rawText: r.rawText,
            reason: String(
              (r.issueData as { reason?: string } | null)?.reason ?? r.error ?? 'unknown',
            ),
            parsed,
          });
        } else if (r.issue === 'ambiguous_duplicate') {
          const ids = (r.issueData as { candidateIds?: number[] } | null)?.candidateIds ?? [];
          items.push({
            kind: 'ambiguous_duplicate',
            key: `raw-${r.id}`,
            ...base,
            parsed: parsed ?? {},
            candidates: ids.map(info).filter((t) => t !== null),
          });
        } else if (r.issue === 'unmatched_cancel') {
          const amount = parsed?.amount ?? 0;
          const at = parsed?.occurredAt ? Date.parse(parsed.occurredAt) : r.receivedAt.getTime();
          const candidates = ctx.db
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                visibleTo(user.id),
                eq(transactions.type, 'expense'),
                ne(transactions.status, 'cancelled'),
                gte(transactions.amount, amount),
                gte(transactions.occurredAt, new Date(at - 120 * 24 * 60 * 60 * 1000)),
              ),
            )
            .orderBy(sql`${transactions.amount} = ${amount} desc`, desc(transactions.occurredAt))
            .limit(5)
            .all();
          items.push({
            kind: 'unmatched_cancel',
            key: `raw-${r.id}`,
            ...base,
            parsed: parsed ?? {},
            candidates: candidates.map((c) => info(c.id)).filter((t) => t !== null),
          });
        }
      }

      const cards = new Map<string, { issuer: string; digits: string | null; txIds: number[] }>();
      for (const r of raws.filter((x) => x.issue === 'unmatched_card')) {
        const p = r.parsed as StoredParse | null;
        const key = `${p?.issuer}:${p?.cardDigits}`;
        const entry = cards.get(key) ?? {
          issuer: p?.issuer ?? '',
          digits: p?.cardDigits ?? null,
          txIds: [],
        };
        if (r.transactionId) entry.txIds.push(r.transactionId);
        cards.set(key, entry);
      }
      for (const [key, c] of cards) {
        const txs = c.txIds.map(info).filter((t) => t !== null);
        items.push({
          kind: 'unmatched_card',
          key: `card-${key}`,
          issuer: c.issuer,
          digits: c.digits,
          count: txs.length,
          total: txs.reduce((n, t) => n + t.amount, 0),
          latest: txs[0] ?? null,
        });
      }

      const uncategorized = ctx.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(uncategorizedWhere(user.id))
        .orderBy(desc(transactions.occurredAt), desc(transactions.id))
        .limit(UNCATEGORIZED_LIMIT)
        .all();
      for (const { id } of uncategorized) {
        const t = info(id);
        if (!t) continue;
        items.push({
          kind: 'uncategorized',
          key: `tx-${id}`,
          transaction: t,
          suggestions: suggestionsFor(t.merchant, t.type, user.id),
        });
      }
      return { count: countFor(user.id), items };
    });

    /** Dismiss a message item (and keep any linked transaction as it is). */
    app.post('/inbox/raw/:id/dismiss', async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const raw = loadOwnRaw(user.id, id);
      resolve(id, raw.transactionId ? {} : { status: 'ignored' });
      return reply.code(204).send();
    });

    /** Turn an unparsed message into a transaction with the person's corrections. */
    app.post('/inbox/raw/:id/transaction', async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const raw = loadOwnRaw(user.id, id);
      if (raw.issue !== 'unparsed')
        throw errors.validation('Only unparsed messages can be entered');
      const body = parse(
        z.object({
          amount: z.number().int().min(1).max(MAX_AMOUNT),
          occurredAt: z.iso.datetime({ offset: true }),
          merchant: z.string().trim().max(MERCHANT_MAX_LENGTH).nullable().default(null),
          categoryId: z.number().int().positive().nullable().default(null),
          accountId: z.number().int().positive().nullable().default(null),
          status: z.enum(EDITABLE_STATUSES).default('confirmed'),
        }),
        request.body,
      );
      if (body.categoryId) {
        const cat = ctx.db
          .select()
          .from(categories)
          .where(eq(categories.id, body.categoryId))
          .get();
        if (!cat || cat.kind !== 'expense' || cat.archivedAt)
          throw errors.conflict('category_invalid', 'Invalid category');
      }
      if (body.accountId) {
        const acc = ctx.db.select().from(accounts).where(eq(accounts.id, body.accountId)).get();
        if (!acc || acc.archivedAt) throw errors.conflict('account_invalid', 'Invalid account');
      }
      const at = new Date(body.occurredAt);
      const created = ctx.db
        .insert(transactions)
        .values({
          type: 'expense',
          amount: body.amount,
          occurredAt: at,
          occurredDate: toLocalDate(at),
          merchant: body.merchant || null,
          merchantKey: body.merchant ? normalizeMerchant(body.merchant) : null,
          categoryId:
            body.categoryId ??
            categorize(ctx.db, { merchant: body.merchant, type: 'expense', viewerId: user.id })
              .categoryId,
          accountId: body.accountId,
          ownerUserId: user.id,
          createdByUserId: user.id,
          status: body.status,
          source: 'sms',
          createdAt: new Date(ctx.now()),
          updatedAt: new Date(ctx.now()),
        })
        .returning()
        .get();
      resolve(id, { status: 'linked', transactionId: created.id });
      return reply.code(201).send(getTransaction(ctx.db, user.id, created.id));
    });

    /** Ambiguous duplicate: it is this existing transaction. Unmatched cancel: cancel this one. */
    app.post('/inbox/raw/:id/attach', async (request) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const raw = loadOwnRaw(user.id, id);
      const { transactionId } = parse(
        z.object({ transactionId: z.number().int().positive() }),
        request.body,
      );
      const target = ctx.db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), visibleTo(user.id)))
        .get();
      if (!target) throw errors.notFound('Transaction not found');
      const p = raw.parsed as StoredParse;
      if (raw.issue === 'unmatched_cancel') {
        applyCancel(ctx.db, target, p.amount ?? target.amount, ctx.now());
      } else if (raw.issue === 'ambiguous_duplicate') {
        if (target.status === 'needs_review') {
          ctx.db
            .update(transactions)
            .set({ status: 'confirmed' })
            .where(eq(transactions.id, target.id))
            .run();
        }
      } else {
        throw errors.validation('Nothing to attach for this item');
      }
      resolve(id, { status: 'linked', transactionId: target.id });
      return getTransaction(ctx.db, user.id, target.id);
    });

    /** Ambiguous duplicate: it is a separate purchase, create it. */
    app.post('/inbox/raw/:id/create', async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const raw = loadOwnRaw(user.id, id);
      if (raw.issue !== 'ambiguous_duplicate')
        throw errors.validation('Only for possible duplicates');
      const p = raw.parsed as StoredParse;
      const account = matchAccount(ctx.db, p.issuer, p.cardDigits, user.id);
      const created = createFromParse(ctx.db, ctx.now(), p, {
        accountId: account?.id ?? null,
        ownerUserId: account?.primaryUserId ?? user.id,
        createdByUserId: user.id,
      });
      ctx.db
        .update(rawRecords)
        .set({
          status: 'linked',
          transactionId: created.id,
          issue: account ? null : 'unmatched_card',
          issueData: account ? null : { issuer: p.issuer, digits: p.cardDigits },
          resolvedAt: account ? new Date(ctx.now()) : null,
        })
        .where(eq(rawRecords.id, id))
        .run();
      return reply.code(201).send(getTransaction(ctx.db, user.id, created.id));
    });

    /** "이 카드는 등록하지 않음": close the unmatched-card item for this card. */
    app.post('/inbox/cards/dismiss', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({ issuer: z.string().max(20), digits: z.string().max(4).nullable() }),
        request.body,
      );
      const ids = openRaw(user.id)
        .filter((r) => {
          const p = r.parsed as StoredParse | null;
          return (
            r.issue === 'unmatched_card' &&
            p?.issuer === body.issuer &&
            (p.cardDigits ?? null) === body.digits
          );
        })
        .map((r) => r.id);
      if (ids.length) {
        ctx.db
          .update(rawRecords)
          .set({ resolvedAt: new Date(ctx.now()) })
          .where(inArray(rawRecords.id, ids))
          .run();
      }
      return reply.code(204).send();
    });
  };
}
