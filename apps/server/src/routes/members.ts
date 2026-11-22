import { and, count, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  USER_ROLES,
  type CreatedInvite,
  type InviteCheck,
  type InviteInfo,
  type MemberInfo,
  type RecoveryCodeIssued,
  type SignedIn,
} from '@budget/shared';
import { z } from 'zod';
import {
  currentAuth,
  enforceRateLimit,
  requireAdmin,
  requireRecentVerification,
} from '../auth/guard.ts';
import { generateRecoveryCode, hashRecoveryCode, randomToken, sha256 } from '../auth/tokens.ts';
import { countActiveAdmins, findUserByLoginName } from '../auth/users.ts';
import type { AppContext } from '../context.ts';
import { invites, passkeys, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { startSession } from './auth.ts';
import { newAccountSchema } from './setup.ts';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type InviteRow = typeof invites.$inferSelect;

function inviteStatus(row: InviteRow, now: number): InviteInfo['status'] {
  if (row.revokedAt) return 'revoked';
  if (row.usedAt) return 'used';
  if (row.expiresAt.getTime() <= now) return 'expired';
  return 'pending';
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const tokenParam = z.object({ token: z.string().min(16).max(100) });

export function memberRoutes(ctx: AppContext): FastifyPluginAsync {
  const reauth = requireRecentVerification(ctx);
  const admin = [requireAdmin, reauth];

  const listInvites = (): InviteInfo[] => {
    const creator = alias(users, 'creator');
    const usedBy = alias(users, 'used_by');
    const now = ctx.now();
    return ctx.db
      .select({ invite: invites, creator: creator.displayName, usedBy: usedBy.displayName })
      .from(invites)
      .innerJoin(creator, eq(invites.createdByUserId, creator.id))
      .leftJoin(usedBy, eq(invites.usedByUserId, usedBy.id))
      .all()
      .sort((a, b) => b.invite.createdAt.getTime() - a.invite.createdAt.getTime())
      .map((r) => ({
        id: r.invite.id,
        role: r.invite.role,
        status: inviteStatus(r.invite, now),
        createdAt: r.invite.createdAt.toISOString(),
        expiresAt: r.invite.expiresAt.toISOString(),
        createdBy: r.creator,
        usedBy: r.usedBy ?? null,
      }));
  };

  const findUsableInvite = (token: string): InviteRow | undefined => {
    const row = ctx.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, sha256(token)))
      .get();
    return row && inviteStatus(row, ctx.now()) === 'pending' ? row : undefined;
  };

  return async (app) => {
    app.get('/members', async (): Promise<MemberInfo[]> => {
      const counts = new Map(
        ctx.db
          .select({ userId: passkeys.userId, n: count() })
          .from(passkeys)
          .groupBy(passkeys.userId)
          .all()
          .map((r) => [r.userId, r.n]),
      );
      return ctx.db
        .select()
        .from(users)
        .all()
        .map((u) => ({
          id: u.id,
          loginName: u.loginName,
          displayName: u.displayName,
          role: u.role,
          disabled: u.disabledAt !== null,
          createdAt: u.createdAt.toISOString(),
          passkeyCount: counts.get(u.id) ?? 0,
        }));
    });

    app.patch('/members/:id', { preHandler: admin }, async (request) => {
      const { id } = parse(idParam, request.params);
      const body = parse(
        z
          .object({ role: z.enum(USER_ROLES).optional(), disabled: z.boolean().optional() })
          .strict(),
        request.body,
      );
      const updated = ctx.db.transaction((tx) => {
        const target = tx.select().from(users).where(eq(users.id, id)).get();
        if (!target) throw errors.notFound('Member not found');
        const isActiveAdmin = target.role === 'admin' && !target.disabledAt;
        const losesAdmin =
          (body.role !== undefined && body.role !== 'admin') || body.disabled === true;
        if (isActiveAdmin && losesAdmin && countActiveAdmins(tx) <= 1) {
          throw errors.conflict('last_admin', 'At least one active admin is required');
        }
        const disabledAt =
          body.disabled === undefined
            ? target.disabledAt
            : body.disabled
              ? (target.disabledAt ?? new Date(ctx.now()))
              : null;
        return tx
          .update(users)
          .set({ role: body.role ?? target.role, disabledAt })
          .where(eq(users.id, id))
          .returning()
          .get();
      });
      if (!updated) throw errors.notFound('Member not found');
      if (updated.disabledAt) ctx.sessions.revokeAllForUser(updated.id);
      return { id: updated.id, role: updated.role, disabled: updated.disabledAt !== null };
    });

    app.get('/invites', { preHandler: requireAdmin }, async () => listInvites());

    app.post('/invites', { preHandler: admin }, async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(z.object({ role: z.enum(USER_ROLES).default('member') }), request.body);
      const token = randomToken(32);
      const row = ctx.db
        .insert(invites)
        .values({
          tokenHash: sha256(token),
          role: body.role,
          createdByUserId: user.id,
          createdAt: new Date(ctx.now()),
          expiresAt: new Date(ctx.now() + INVITE_TTL_MS),
        })
        .returning()
        .get();
      const invite = listInvites().find((i) => i.id === row.id);
      if (!invite) throw new Error('invite vanished');
      const result: CreatedInvite = {
        invite,
        url: `${ctx.config.publicOrigin}/invite/${token}`,
      };
      return reply.code(201).send(result);
    });

    app.delete('/invites/:id', { preHandler: admin }, async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const result = ctx.db
        .update(invites)
        .set({ revokedAt: new Date(ctx.now()) })
        .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt)))
        .run();
      if (result.changes === 0) throw errors.notFound('Invite not found or already closed');
      return reply.code(204).send();
    });

    // Public: the invitee has no account yet.
    app.get('/invite/:token', { config: { auth: 'public' } }, async (request) => {
      enforceRateLimit(ctx, request);
      const { token } = parse(tokenParam, request.params);
      const row = findUsableInvite(token);
      return {
        valid: !!row,
        expiresAt: row?.expiresAt.toISOString() ?? null,
      } satisfies InviteCheck;
    });

    app.post('/invite/:token/accept', { config: { auth: 'public' } }, async (request, reply) => {
      enforceRateLimit(ctx, request);
      const { token } = parse(tokenParam, request.params);
      if (!findUsableInvite(token)) {
        throw errors.gone('invite_invalid', 'This invite link is invalid or has expired');
      }
      const body = parse(newAccountSchema, request.body);
      if (findUserByLoginName(ctx.db, body.loginName)) {
        throw errors.conflict('login_name_taken', 'That login name is already in use');
      }
      const passwordHash = await ctx.hasher.hash(body.password);
      const recoveryCode = generateRecoveryCode();
      const user = ctx.db.transaction((tx) => {
        // Re-check after the async hash: the invite must still be unused.
        const invite = tx
          .select()
          .from(invites)
          .where(eq(invites.tokenHash, sha256(token)))
          .get();
        if (!invite || inviteStatus(invite, ctx.now()) !== 'pending') {
          throw errors.gone('invite_invalid', 'This invite link is invalid or has expired');
        }
        if (tx.select().from(users).where(eq(users.loginName, body.loginName)).get()) {
          throw errors.conflict('login_name_taken', 'That login name is already in use');
        }
        const created = tx
          .insert(users)
          .values({
            loginName: body.loginName,
            displayName: body.displayName,
            role: invite.role,
            passwordHash,
            recoveryCodeHash: hashRecoveryCode(recoveryCode),
          })
          .returning()
          .get();
        tx.update(invites)
          .set({ usedAt: new Date(ctx.now()), usedByUserId: created.id })
          .where(eq(invites.id, invite.id))
          .run();
        return created;
      });
      const signedIn = startSession(ctx, request, reply, user);
      return reply
        .code(201)
        .send({ ...signedIn, recoveryCode } satisfies SignedIn & RecoveryCodeIssued);
    });
  };
}
