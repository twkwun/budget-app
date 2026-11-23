import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  EDITABLE_STATUSES,
  MAX_AMOUNT,
  MEMO_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  currentYearMonth,
  isYearMonth,
  toLocalDate,
  type EntryDefaults,
  type MonthSummary,
  type TransactionPage,
  type TransactionType,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth } from '../auth/guard.ts';
import type { UserRow } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { accounts, categories, transactions, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import {
  entryDefaults,
  getTransaction,
  listTransactions,
  monthSummary,
  visibleTo,
} from '../ledger/queries.ts';

type TxRow = typeof transactions.$inferSelect;

const MIN_INSTANT = Date.UTC(2000, 0, 1);
const MAX_INSTANT = Date.UTC(2100, 0, 1);

const instantSchema = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .refine((d) => d.getTime() >= MIN_INSTANT && d.getTime() < MAX_INSTANT, 'out of range');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

const fields = {
  type: z.enum(TRANSACTION_TYPES),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  occurredAt: instantSchema,
  categoryId: z.number().int().positive().nullable(),
  accountId: z.number().int().positive().nullable(),
  ownerUserId: z.number().int().positive(),
  merchant: optionalText(MERCHANT_MAX_LENGTH),
  memo: optionalText(MEMO_MAX_LENGTH),
  status: z.enum(EDITABLE_STATUSES),
  isPrivate: z.boolean(),
};

const monthSchema = z.string().refine(isYearMonth, 'must be YYYY-MM');
const optionalInt = z.coerce.number().int().positive().optional();

const listQuery = z.object({
  month: monthSchema,
  type: z.enum(TRANSACTION_TYPES).optional(),
  category: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  accountId: optionalInt,
  ownerId: optionalInt,
  status: z.enum(TRANSACTION_STATUSES).optional(),
  minAmount: z.coerce.number().int().min(0).max(MAX_AMOUNT).optional(),
  maxAmount: z.coerce.number().int().min(0).max(MAX_AMOUNT).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface Final {
  type: TransactionType;
  categoryId: number | null;
  accountId: number | null;
  ownerUserId: number;
  isPrivate: boolean;
}

/**
 * Cross-field rules. Archived categories/accounts and disabled owners are
 * rejected unless the transaction already had them (editing old entries).
 */
function validateReferences(ctx: AppContext, user: UserRow, next: Final, prev?: TxRow): void {
  if (next.categoryId !== null) {
    if (next.type === 'transfer') {
      throw errors.conflict('category_invalid', 'Transfers have no category');
    }
    const cat = ctx.db.select().from(categories).where(eq(categories.id, next.categoryId)).get();
    if (!cat) throw errors.conflict('category_invalid', 'Unknown category');
    if (cat.kind !== next.type) {
      throw errors.conflict('category_invalid', 'Category kind does not match the type');
    }
    if (cat.archivedAt && prev?.categoryId !== cat.id) {
      throw errors.conflict('category_invalid', 'Category is archived');
    }
  }
  if (next.accountId !== null) {
    const acc = ctx.db.select().from(accounts).where(eq(accounts.id, next.accountId)).get();
    if (!acc) throw errors.conflict('account_invalid', 'Unknown account');
    if (acc.archivedAt && prev?.accountId !== acc.id) {
      throw errors.conflict('account_invalid', 'Account is archived');
    }
  }
  if (next.ownerUserId !== prev?.ownerUserId) {
    const owner = ctx.db.select().from(users).where(eq(users.id, next.ownerUserId)).get();
    if (!owner || owner.disabledAt) throw errors.validation('Unknown member');
  }
  // A private entry is only visible to its owner, so only the owner can make one.
  if (next.isPrivate && next.ownerUserId !== user.id) {
    throw errors.validation('Only your own transactions can be private');
  }
}

export function transactionRoutes(ctx: AppContext): FastifyPluginAsync {
  const idParam = z.object({ id: z.coerce.number().int().positive() });

  const loadVisible = (userId: number, id: number): TxRow => {
    const row = ctx.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), visibleTo(userId)))
      .get();
    if (!row) throw errors.notFound('Transaction not found');
    return row;
  };

  return async (app) => {
    app.get('/transactions', async (request): Promise<TransactionPage> => {
      const { user } = currentAuth(request);
      const q = parse(listQuery, request.query);
      return listTransactions(ctx.db, user.id, q, { cursor: q.cursor, limit: q.limit });
    });

    app.get('/transactions/:id', async (request) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const found = getTransaction(ctx.db, user.id, id);
      if (!found) throw errors.notFound('Transaction not found');
      return found;
    });

    app.post('/transactions', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          type: fields.type,
          amount: fields.amount,
          occurredAt: fields.occurredAt.optional(),
          categoryId: fields.categoryId.default(null),
          accountId: fields.accountId.default(null),
          ownerUserId: fields.ownerUserId.optional(),
          merchant: fields.merchant.default(null),
          memo: fields.memo.default(null),
          status: fields.status.default('confirmed'),
          isPrivate: fields.isPrivate.default(false),
        }),
        request.body,
      );
      const next: Final = {
        type: body.type,
        categoryId: body.categoryId,
        accountId: body.accountId,
        ownerUserId: body.ownerUserId ?? user.id,
        isPrivate: body.isPrivate,
      };
      validateReferences(ctx, user, next);
      const occurredAt = body.occurredAt ?? new Date(ctx.now());
      const now = new Date(ctx.now());
      const created = ctx.db
        .insert(transactions)
        .values({
          ...next,
          amount: body.amount,
          occurredAt,
          occurredDate: toLocalDate(occurredAt),
          merchant: body.merchant,
          memo: body.memo,
          status: body.status,
          source: 'manual',
          createdByUserId: user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: transactions.id })
        .get();
      return reply.code(201).send(getTransaction(ctx.db, user.id, created.id));
    });

    // Any member may edit any transaction they can see (family ledger).
    app.patch('/transactions/:id', async (request) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const body = parse(
        z
          .object({
            type: fields.type.optional(),
            amount: fields.amount.optional(),
            occurredAt: fields.occurredAt.optional(),
            categoryId: fields.categoryId.optional(),
            accountId: fields.accountId.optional(),
            ownerUserId: fields.ownerUserId.optional(),
            merchant: fields.merchant.optional(),
            memo: fields.memo.optional(),
            status: fields.status.optional(),
            isPrivate: fields.isPrivate.optional(),
          })
          .strict(),
        request.body,
      );
      const prev = loadVisible(user.id, id);
      const type = body.type ?? prev.type;
      // Changing to a type the old category does not fit clears the category.
      let categoryId = body.categoryId === undefined ? prev.categoryId : body.categoryId;
      if (body.type !== undefined && body.categoryId === undefined && body.type !== prev.type) {
        categoryId = null;
      }
      const next: Final = {
        type,
        categoryId,
        accountId: body.accountId === undefined ? prev.accountId : body.accountId,
        ownerUserId: body.ownerUserId ?? prev.ownerUserId,
        isPrivate: body.isPrivate ?? prev.isPrivate,
      };
      validateReferences(ctx, user, next, prev);
      const amount = body.amount ?? prev.amount;
      const occurredAt = body.occurredAt ?? prev.occurredAt;
      ctx.db
        .update(transactions)
        .set({
          ...next,
          amount,
          // Keep the partial-cancel invariant: original_amount >= amount.
          originalAmount:
            prev.originalAmount !== null && prev.originalAmount < amount
              ? null
              : prev.originalAmount,
          occurredAt,
          occurredDate: toLocalDate(occurredAt),
          merchant: body.merchant === undefined ? prev.merchant : body.merchant,
          memo: body.memo === undefined ? prev.memo : body.memo,
          status: body.status ?? prev.status,
          updatedAt: new Date(ctx.now()),
        })
        .where(eq(transactions.id, id))
        .run();
      return getTransaction(ctx.db, user.id, id);
    });

    app.delete('/transactions/:id', async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      loadVisible(user.id, id);
      ctx.db.delete(transactions).where(eq(transactions.id, id)).run();
      return reply.code(204).send();
    });

    app.get('/summary', async (request): Promise<MonthSummary> => {
      const { user } = currentAuth(request);
      const q = parse(
        z.object({
          month: monthSchema.default(currentYearMonth(ctx.now())),
          owner: z.union([z.literal('all'), z.coerce.number().int().positive()]).default('all'),
        }),
        request.query,
      );
      return monthSummary(ctx.db, user.id, q.month, q.owner === 'all' ? null : q.owner);
    });

    app.get('/entry-defaults', async (request): Promise<EntryDefaults> =>
      entryDefaults(ctx.db, currentAuth(request).user.id),
    );
  };
}
