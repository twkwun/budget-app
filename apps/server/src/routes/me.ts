import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { isLockTimeout, type Me, type RecoveryCodeIssued, type SessionInfo } from '@budget/shared';
import { z } from 'zod';
import { currentAuth, requireRecentVerification } from '../auth/guard.ts';
import { generateRecoveryCode, hashRecoveryCode } from '../auth/tokens.ts';
import { displayNameSchema, passwordSchema, toMe } from '../auth/users.ts';
import type { AppContext } from '../context.ts';
import { users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';

export function meRoutes(ctx: AppContext): FastifyPluginAsync {
  const reauth = requireRecentVerification(ctx);

  return async (app) => {
    app.get('/me', async (request): Promise<Me> => toMe(currentAuth(request).user));

    app.patch('/me', async (request): Promise<Me> => {
      const auth = currentAuth(request);
      const body = parse(
        z
          .object({
            displayName: displayNameSchema.optional(),
            lockTimeoutSeconds: z
              .unknown()
              .refine(isLockTimeout, 'must be one of 0, 300, 3600, null')
              .optional(),
          })
          .strict(),
        request.body,
      );
      const updated = ctx.db
        .update(users)
        .set({
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.lockTimeoutSeconds !== undefined && {
            lockTimeoutSeconds: body.lockTimeoutSeconds,
          }),
        })
        .where(eq(users.id, auth.user.id))
        .returning()
        .get();
      return toMe(updated ?? auth.user);
    });

    app.post('/me/password', { preHandler: reauth }, async (request, reply) => {
      const auth = currentAuth(request);
      const body = parse(z.object({ newPassword: passwordSchema }), request.body);
      const passwordHash = await ctx.hasher.hash(body.newPassword);
      ctx.db
        .update(users)
        .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, auth.user.id))
        .run();
      ctx.sessions.revokeAllForUser(auth.user.id, auth.session.id);
      return reply.code(204).send();
    });

    app.post(
      '/me/recovery-code',
      { preHandler: reauth },
      async (request): Promise<RecoveryCodeIssued> => {
        const auth = currentAuth(request);
        const recoveryCode = generateRecoveryCode();
        ctx.db
          .update(users)
          .set({ recoveryCodeHash: hashRecoveryCode(recoveryCode) })
          .where(eq(users.id, auth.user.id))
          .run();
        return { recoveryCode };
      },
    );

    app.get('/me/sessions', async (request): Promise<SessionInfo[]> => {
      const auth = currentAuth(request);
      return ctx.sessions
        .listForUser(auth.user.id)
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map((s) => ({
          id: s.id,
          current: s.id === auth.session.id,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          userAgent: s.userAgent,
          ip: s.lastIp,
        }));
    });

    app.delete('/me/sessions/:id', async (request, reply) => {
      const auth = currentAuth(request);
      const { id } = parse(z.object({ id: z.string().min(1).max(100) }), request.params);
      const own = ctx.sessions.listForUser(auth.user.id).some((s) => s.id === id);
      if (!own) throw errors.notFound('Session not found');
      ctx.sessions.revoke(id);
      if (id === auth.session.id) ctx.sessions.clearCookie(reply);
      return reply.code(204).send();
    });

    app.post('/me/sessions/revoke-others', async (request) => {
      const auth = currentAuth(request);
      return { revoked: ctx.sessions.revokeAllForUser(auth.user.id, auth.session.id) };
    });
  };
}
