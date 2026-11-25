import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { FastifyPluginAsync } from 'fastify';
import {
  ACCOUNT_KINDS,
  ACCOUNT_NAME_MAX_LENGTH,
  ISSUERS,
  defaultCutoffDay,
  type AccountInfo,
  type LabelLinkResult,
  type UnlinkedLabelInfo,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth } from '../auth/guard.ts';
import type { UserRow } from '../auth/sessions.ts';
import type { AppContext } from '../context.ts';
import { accounts, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { linkLabels, unlinkedLabels } from '../importer/labels.ts';
import { linkUnmatchedCards } from '../sms/ingest.ts';

type AccountRow = typeof accounts.$inferSelect;

const issuerSchema = z.enum(ISSUERS.map((i) => i.code) as [string, ...string[]]);
const accountFields = {
  name: z.string().trim().min(1).max(ACCOUNT_NAME_MAX_LENGTH),
  issuer: issuerSchema.nullable(),
  last4: z
    .string()
    .regex(/^\d{4}$/, 'last4 must be 4 digits')
    .nullable(),
  billingDay: z.number().int().min(1).max(31).nullable(),
  cutoffDay: z.number().int().min(1).max(31).nullable(),
  primaryUserId: z.number().int().positive().nullable(),
};

/**
 * Payment day and usage-period cutoff to store. Only cards keep them; a card
 * with a payment day always gets a cutoff (the usual one unless given), and
 * changing the payment day without a cutoff moves the cutoff along with it.
 */
function billingFields(
  kind: AccountRow['kind'],
  billingDay: number | null,
  cutoffDay: number | null | undefined,
  previous?: Pick<AccountRow, 'billingDay' | 'cutoffDay'>,
): { billingDay: number | null; cutoffDay: number | null } {
  if (kind !== 'card' || billingDay === null) return { billingDay: null, cutoffDay: null };
  if (cutoffDay != null) return { billingDay, cutoffDay };
  if (cutoffDay === undefined && previous?.billingDay === billingDay && previous.cutoffDay) {
    return { billingDay, cutoffDay: previous.cutoffDay };
  }
  return { billingDay, cutoffDay: defaultCutoffDay(billingDay) };
}

export function canEditAccount(user: UserRow, account: Pick<AccountRow, 'ownerUserId'>): boolean {
  return user.role === 'admin' || account.ownerUserId === user.id;
}

function ensureActiveUser(ctx: AppContext, id: number | null | undefined): void {
  if (id === null || id === undefined) return;
  const user = ctx.db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!user) throw errors.validation('Unknown member');
}

export function accountRoutes(ctx: AppContext): FastifyPluginAsync {
  const owner = alias(users, 'owner');
  const primary = alias(users, 'primary_user');

  const list = (viewer: UserRow, where?: ReturnType<typeof eq>): AccountInfo[] =>
    ctx.db
      .select({ account: accounts, ownerName: owner.displayName, primaryName: primary.displayName })
      .from(accounts)
      .innerJoin(owner, eq(accounts.ownerUserId, owner.id))
      .leftJoin(primary, eq(accounts.primaryUserId, primary.id))
      .where(where)
      .orderBy(asc(accounts.sortOrder), asc(accounts.id))
      .all()
      .map(({ account: a, ownerName, primaryName }) => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        issuer: a.issuer,
        last4: a.last4,
        billingDay: a.billingDay,
        cutoffDay: a.cutoffDay,
        sortOrder: a.sortOrder,
        archived: a.archivedAt !== null,
        ownerUserId: a.ownerUserId,
        ownerName,
        primaryUserId: a.primaryUserId,
        primaryUserName: primaryName ?? null,
        canEdit: canEditAccount(viewer, a),
      }));

  const getOne = (viewer: UserRow, id: number): AccountInfo => {
    const found = list(viewer, eq(accounts.id, id))[0];
    if (!found) throw errors.notFound('Account not found');
    return found;
  };

  return async (app) => {
    // Accounts are household-wide: everyone sees every account (names only).
    app.get('/accounts', async (request) => list(currentAuth(request).user));

    app.post('/accounts', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          kind: z.enum(ACCOUNT_KINDS),
          ...accountFields,
          issuer: accountFields.issuer.default(null),
          last4: accountFields.last4.default(null),
          billingDay: accountFields.billingDay.default(null),
          cutoffDay: accountFields.cutoffDay.default(null),
          primaryUserId: accountFields.primaryUserId.default(null),
          ownerUserId: z.number().int().positive().optional(),
        }),
        request.body,
      );
      if (body.ownerUserId !== undefined && body.ownerUserId !== user.id && user.role !== 'admin') {
        throw errors.forbidden('Only an admin can create an account for someone else');
      }
      ensureActiveUser(ctx, body.ownerUserId);
      ensureActiveUser(ctx, body.primaryUserId);
      const maxOrder = ctx.db.select({ sortOrder: accounts.sortOrder }).from(accounts).all();
      const created = ctx.db
        .insert(accounts)
        .values({
          kind: body.kind,
          name: body.name,
          issuer: body.issuer,
          last4: body.last4,
          ...billingFields(body.kind, body.billingDay, body.cutoffDay),
          primaryUserId: body.primaryUserId,
          ownerUserId: body.ownerUserId ?? user.id,
          sortOrder: maxOrder.reduce((m, r) => Math.max(m, r.sortOrder + 1), 0),
        })
        .returning()
        .get();
      linkUnmatchedCards(ctx.db, created, ctx.now());
      return reply.code(201).send(getOne(user, created.id));
    });

    app.patch('/accounts/:id', async (request) => {
      const { user } = currentAuth(request);
      const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), request.params);
      const body = parse(
        z
          .object({
            kind: z.enum(ACCOUNT_KINDS).optional(),
            name: accountFields.name.optional(),
            issuer: accountFields.issuer.optional(),
            last4: accountFields.last4.optional(),
            billingDay: accountFields.billingDay.optional(),
            cutoffDay: accountFields.cutoffDay.optional(),
            primaryUserId: accountFields.primaryUserId.optional(),
            ownerUserId: z.number().int().positive().optional(),
            archived: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      const existing = ctx.db.select().from(accounts).where(eq(accounts.id, id)).get();
      if (!existing) throw errors.notFound('Account not found');
      if (!canEditAccount(user, existing)) {
        throw errors.forbidden('Only the owner or an admin can change this account');
      }
      if (body.ownerUserId !== undefined && body.ownerUserId !== existing.ownerUserId) {
        if (user.role !== 'admin') throw errors.forbidden('Only an admin can change the owner');
        ensureActiveUser(ctx, body.ownerUserId);
      }
      ensureActiveUser(ctx, body.primaryUserId);
      const kind = body.kind ?? existing.kind;
      ctx.db
        .update(accounts)
        .set({
          kind,
          name: body.name ?? existing.name,
          issuer: body.issuer === undefined ? existing.issuer : body.issuer,
          last4: body.last4 === undefined ? existing.last4 : body.last4,
          ...billingFields(
            kind,
            body.billingDay === undefined ? existing.billingDay : body.billingDay,
            body.cutoffDay,
            existing,
          ),
          primaryUserId:
            body.primaryUserId === undefined ? existing.primaryUserId : body.primaryUserId,
          ownerUserId: body.ownerUserId ?? existing.ownerUserId,
          archivedAt:
            body.archived === undefined
              ? existing.archivedAt
              : body.archived
                ? (existing.archivedAt ?? new Date(ctx.now()))
                : null,
        })
        .where(eq(accounts.id, id))
        .run();
      const updated = ctx.db.select().from(accounts).where(eq(accounts.id, id)).get();
      if (updated) linkUnmatchedCards(ctx.db, updated, ctx.now());
      return getOne(user, id);
    });

    /** 결제수단 labels of imported transactions still without an account. */
    app.get('/accounts/unlinked-labels', async (request): Promise<UnlinkedLabelInfo[]> => {
      currentAuth(request);
      return unlinkedLabels(ctx.db);
    });

    /** Link labels to accounts (creating them as asked) and fill those transactions. */
    app.post('/accounts/link-labels', async (request): Promise<LabelLinkResult> => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          items: z
            .array(
              z
                .object({
                  label: z.string().trim().min(1).max(200),
                  accountId: z.number().int().positive().optional(),
                  create: z
                    .object({
                      kind: z.enum(ACCOUNT_KINDS),
                      name: accountFields.name,
                      issuer: accountFields.issuer.default(null),
                      last4: accountFields.last4.default(null),
                    })
                    .optional(),
                })
                .refine((i) => (i.accountId === undefined) !== (i.create === undefined), {
                  message: 'Give either accountId or create',
                }),
            )
            .min(1)
            .max(200),
        }),
        request.body,
      );
      const result = linkLabels(ctx.db, body.items, user.id, ctx.now());
      for (const account of result.createdAccounts) linkUnmatchedCards(ctx.db, account, ctx.now());
      return { created: result.created, linked: result.linked };
    });

    // Display order is shared presentation, so any member may reorder.
    app.put('/accounts/order', async (request) => {
      const { user } = currentAuth(request);
      const { ids } = parse(
        z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }),
        request.body,
      );
      if (new Set(ids).size !== ids.length) throw errors.validation('Duplicate ids');
      ctx.db.transaction((tx) => {
        const found = tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(inArray(accounts.id, ids))
          .all();
        if (found.length !== ids.length) throw errors.validation('Unknown account');
        ids.forEach((accountId, index) => {
          tx.update(accounts)
            .set({ sortOrder: index })
            .where(and(eq(accounts.id, accountId)))
            .run();
        });
      });
      return list(user);
    });
  };
}
