import type { FastifyPluginAsync } from 'fastify';
import type { RecoveryCodeIssued, SignedIn } from '@budget/shared';
import { z } from 'zod';
import { enforceRateLimit } from '../auth/guard.ts';
import { generateRecoveryCode, hashRecoveryCode } from '../auth/tokens.ts';
import { countUsers, displayNameSchema, loginNameSchema, passwordSchema } from '../auth/users.ts';
import type { AppContext } from '../context.ts';
import { users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { startSession } from './auth.ts';

export const newAccountSchema = z.object({
  displayName: displayNameSchema,
  loginName: loginNameSchema,
  password: passwordSchema,
});

/** First-run setup: creates the first admin while no user exists, then closes for good. */
export function setupRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.post('/setup', { config: { auth: 'public' } }, async (request, reply) => {
      enforceRateLimit(ctx, request);
      if (countUsers(ctx.db) > 0) throw errors.conflict('setup_closed', 'Setup already completed');
      const body = parse(newAccountSchema, request.body);
      const passwordHash = await ctx.hasher.hash(body.password);
      const recoveryCode = generateRecoveryCode();
      // Re-check inside the write transaction so two racing requests cannot both succeed.
      const user = ctx.db.transaction((tx) => {
        if (countUsers(tx) > 0) {
          throw errors.conflict('setup_closed', 'Setup already completed');
        }
        return tx
          .insert(users)
          .values({
            loginName: body.loginName,
            displayName: body.displayName,
            role: 'admin',
            passwordHash,
            recoveryCodeHash: hashRecoveryCode(recoveryCode),
          })
          .returning()
          .get();
      });
      const signedIn = startSession(ctx, request, reply, user);
      return reply
        .code(201)
        .send({ ...signedIn, recoveryCode } satisfies SignedIn & RecoveryCodeIssued);
    });
  };
}
