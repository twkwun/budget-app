import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthState, RecoveryCodeIssued, SignedIn } from '@budget/shared';
import { z } from 'zod';
import { currentAuth, enforceRateLimit } from '../auth/guard.ts';
import type { UserRow } from '../auth/sessions.ts';
import { generateRecoveryCode, hashRecoveryCode, safeEqual } from '../auth/tokens.ts';
import {
  canAttemptPassword,
  checkPassword,
  clearFailedAttempts,
  countUsers,
  findUserByLoginName,
  passwordSchema,
  recordFailedAttempt,
  toMe,
} from '../auth/users.ts';
import type { AppContext } from '../context.ts';
import { passkeys, users } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';

const passkeyAssertionSchema = z.object({
  challengeId: z.string().min(1).max(100),
  response: z.custom<AuthenticationResponseJSON>(
    (v) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string',
    'invalid passkey response',
  ),
});

export function startSession(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
): SignedIn {
  const { token } = ctx.sessions.create(user.id, {
    userAgent: request.headers['user-agent'],
    ip: request.ip,
  });
  ctx.sessions.setCookie(reply, token);
  return { user: toMe(user) };
}

/**
 * Verify a passkey assertion against a stored credential. Returns the user on
 * success; updates the signature counter and last-used time.
 */
export async function verifyPasskeyAssertion(
  ctx: AppContext,
  body: z.infer<typeof passkeyAssertionSchema>,
  purpose: 'login' | 'verify',
  bound?: { userId: number; sessionId: string },
): Promise<UserRow> {
  const challenge = ctx.challenges.consume(body.challengeId, purpose);
  if (!challenge) throw errors.gone('challenge_invalid', 'Passkey request expired. Try again.');
  if (bound && (challenge.userId !== bound.userId || challenge.sessionId !== bound.sessionId)) {
    throw errors.gone('challenge_invalid', 'Passkey request does not match this session.');
  }

  const row = ctx.db
    .select({ passkey: passkeys, user: users })
    .from(passkeys)
    .innerJoin(users, eq(passkeys.userId, users.id))
    .where(eq(passkeys.id, body.response.id))
    .get();
  if (!row || row.user.disabledAt) throw errors.invalidCredentials();
  if (bound && row.user.id !== bound.userId) throw errors.invalidCredentials();
  const userHandle = body.response.response.userHandle;
  if (userHandle && userHandle !== row.user.webauthnUserId) throw errors.invalidCredentials();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: ctx.webauthn.origin,
      expectedRPID: ctx.webauthn.rpID,
      requireUserVerification: true,
      credential: {
        id: row.passkey.id,
        publicKey: new Uint8Array(row.passkey.publicKey),
        counter: row.passkey.counter,
        transports: row.passkey.transports ?? undefined,
      },
    });
  } catch {
    // Includes signature-counter regressions (possible cloned authenticator).
    throw errors.invalidCredentials();
  }
  if (!verification.verified) throw errors.invalidCredentials();

  ctx.db
    .update(passkeys)
    .set({
      counter: verification.authenticationInfo.newCounter,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(ctx.now()),
    })
    .where(eq(passkeys.id, row.passkey.id))
    .run();
  return row.user;
}

export function authRoutes(ctx: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/session', { config: { auth: 'public' } }, async (request): Promise<AuthState> => {
      const auth = request.auth;
      return {
        setupRequired: countUsers(ctx.db) === 0,
        authenticated: !!auth,
        locked: auth?.locked ?? false,
        user: auth ? toMe(auth.user) : null,
      };
    });

    app.post('/login/password', { config: { auth: 'public' } }, async (request, reply) => {
      const body = parse(
        z.object({ loginName: z.string().max(100), password: z.string().max(1000) }),
        request.body,
      );
      const loginName = body.loginName.trim().toLowerCase();
      enforceRateLimit(ctx, request, loginName);
      const user = findUserByLoginName(ctx.db, loginName);
      if (!(await checkPassword(ctx, user, body.password)) || !user) {
        throw errors.invalidCredentials();
      }
      return startSession(ctx, request, reply, user);
    });

    app.post('/login/passkey/options', { config: { auth: 'public' } }, async (request) => {
      enforceRateLimit(ctx, request);
      // No allowCredentials: discoverable credentials, any authenticator
      // (including a phone via QR / hybrid transport).
      const options = await generateAuthenticationOptions({
        rpID: ctx.webauthn.rpID,
        userVerification: 'required',
      });
      const { challengeId } = ctx.challenges.create({
        challenge: options.challenge,
        purpose: 'login',
        userId: null,
        sessionId: null,
      });
      return { challengeId, options };
    });

    app.post('/login/passkey/verify', { config: { auth: 'public' } }, async (request, reply) => {
      enforceRateLimit(ctx, request);
      const body = parse(passkeyAssertionSchema, request.body);
      const user = await verifyPasskeyAssertion(ctx, body, 'login');
      // A passkey proves possession; it also clears any password lockout.
      clearFailedAttempts(ctx, user);
      return startSession(ctx, request, reply, user);
    });

    app.post('/recovery', { config: { auth: 'public' } }, async (request, reply) => {
      const body = parse(
        z.object({
          loginName: z.string().max(100),
          recoveryCode: z.string().max(100),
          newPassword: passwordSchema,
        }),
        request.body,
      );
      const loginName = body.loginName.trim().toLowerCase();
      enforceRateLimit(ctx, request, loginName);
      const user = findUserByLoginName(ctx.db, loginName);
      const usable = canAttemptPassword(user, ctx.now());
      const presented = hashRecoveryCode(body.recoveryCode);
      const matches =
        usable && !!user.recoveryCodeHash && safeEqual(presented, user.recoveryCodeHash);
      if (!usable || !matches) {
        if (usable) recordFailedAttempt(ctx, user);
        throw errors.invalidCredentials();
      }
      const recoveryCode = generateRecoveryCode();
      const passwordHash = await ctx.hasher.hash(body.newPassword);
      ctx.db
        .update(users)
        .set({
          passwordHash,
          recoveryCodeHash: hashRecoveryCode(recoveryCode),
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, user.id))
        .run();
      // Whoever knew the old password may hold sessions: end them all.
      ctx.sessions.revokeAllForUser(user.id);
      const signedIn = startSession(ctx, request, reply, user);
      return { ...signedIn, recoveryCode } satisfies SignedIn & RecoveryCodeIssued;
    });

    app.post('/logout', { config: { auth: 'public' } }, async (request, reply) => {
      if (request.auth) ctx.sessions.revoke(request.auth.session.id);
      ctx.sessions.clearCookie(reply);
      return reply.code(204).send();
    });

    app.post('/lock', { config: { auth: 'session-locked-ok' } }, async (request, reply) => {
      ctx.sessions.lock(currentAuth(request).session.id);
      return reply.code(204).send();
    });

    // Identity checks used both to unlock the app and for step-up re-auth.
    app.post(
      '/verify/password',
      { config: { auth: 'session-locked-ok' } },
      async (request, reply) => {
        enforceRateLimit(ctx, request);
        const auth = currentAuth(request);
        const body = parse(z.object({ password: z.string().max(1000) }), request.body);
        if (!(await checkPassword(ctx, auth.user, body.password))) {
          throw errors.invalidCredentials();
        }
        ctx.sessions.markVerified(auth.session.id);
        return reply.code(204).send();
      },
    );

    app.post(
      '/verify/passkey/options',
      { config: { auth: 'session-locked-ok' } },
      async (request) => {
        enforceRateLimit(ctx, request);
        const auth = currentAuth(request);
        const own = ctx.db
          .select({ id: passkeys.id, transports: passkeys.transports })
          .from(passkeys)
          .where(eq(passkeys.userId, auth.user.id))
          .all();
        if (own.length === 0) throw errors.notFound('No passkey registered');
        const options = await generateAuthenticationOptions({
          rpID: ctx.webauthn.rpID,
          userVerification: 'required',
          allowCredentials: own.map((p) => ({ id: p.id, transports: p.transports ?? undefined })),
        });
        const { challengeId } = ctx.challenges.create({
          challenge: options.challenge,
          purpose: 'verify',
          userId: auth.user.id,
          sessionId: auth.session.id,
        });
        return { challengeId, options };
      },
    );

    app.post(
      '/verify/passkey',
      { config: { auth: 'session-locked-ok' } },
      async (request, reply) => {
        enforceRateLimit(ctx, request);
        const auth = currentAuth(request);
        const body = parse(passkeyAssertionSchema, request.body);
        await verifyPasskeyAssertion(ctx, body, 'verify', {
          userId: auth.user.id,
          sessionId: auth.session.id,
        });
        ctx.sessions.markVerified(auth.session.id);
        return reply.code(204).send();
      },
    );
  };
}
