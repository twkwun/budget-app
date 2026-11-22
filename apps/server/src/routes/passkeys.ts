import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { PASSKEY_NAME_MAX_LENGTH, type PasskeyInfo } from '@budget/shared';
import { z } from 'zod';
import { currentAuth, requireRecentVerification } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { passkeys } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';

type PasskeyRow = typeof passkeys.$inferSelect;

function toInfo(row: PasskeyRow): PasskeyInfo {
  return {
    id: row.id,
    deviceName: row.deviceName ?? '패스키',
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    backedUp: row.backedUp,
  };
}

const deviceNameSchema = z.string().trim().min(1).max(PASSKEY_NAME_MAX_LENGTH);

export function passkeyRoutes(ctx: AppContext): FastifyPluginAsync {
  const reauth = requireRecentVerification(ctx);

  return async (app) => {
    app.get('/me/passkeys', async (request): Promise<PasskeyInfo[]> => {
      const auth = currentAuth(request);
      return ctx.db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, auth.user.id))
        .all()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toInfo);
    });

    // Adding a credential is as sensitive as removing one, so it needs a recent check too.
    app.post('/me/passkeys/options', { preHandler: reauth }, async (request) => {
      const { user, session } = currentAuth(request);
      const existing = ctx.db
        .select({ id: passkeys.id, transports: passkeys.transports })
        .from(passkeys)
        .where(eq(passkeys.userId, user.id))
        .all();
      const options = await generateRegistrationOptions({
        rpName: ctx.webauthn.rpName,
        rpID: ctx.webauthn.rpID,
        userName: user.loginName,
        userDisplayName: user.displayName,
        userID: new Uint8Array(Buffer.from(user.webauthnUserId, 'base64url')),
        attestationType: 'none',
        excludeCredentials: existing.map((p) => ({
          id: p.id,
          transports: p.transports ?? undefined,
        })),
        // Discoverable (username-less login) and biometric/PIN verified.
        // No authenticatorAttachment: platform or roaming are both fine.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      const { challengeId } = ctx.challenges.create({
        challenge: options.challenge,
        purpose: 'register',
        userId: user.id,
        sessionId: session.id,
      });
      return { challengeId, options };
    });

    app.post('/me/passkeys', async (request, reply) => {
      const { user, session } = currentAuth(request);
      const body = parse(
        z.object({
          challengeId: z.string().min(1).max(100),
          deviceName: deviceNameSchema.optional(),
          response: z.custom<RegistrationResponseJSON>(
            (v) => typeof v === 'object' && v !== null && 'response' in v,
            'invalid passkey response',
          ),
        }),
        request.body,
      );
      const challenge = ctx.challenges.consume(body.challengeId, 'register');
      if (!challenge || challenge.userId !== user.id || challenge.sessionId !== session.id) {
        throw errors.gone('challenge_invalid', 'Passkey request expired. Try again.');
      }
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: ctx.webauthn.origin,
          expectedRPID: ctx.webauthn.rpID,
          requireUserVerification: true,
        });
      } catch (error) {
        request.log.warn({ err: error }, 'passkey registration rejected');
        throw errors.validation('Passkey registration failed');
      }
      if (!verification.verified) throw errors.validation('Passkey registration failed');
      const info = verification.registrationInfo;
      const providerName =
        info.passkeyProviderMetadata?.friendlyNames?.['ko'] ??
        info.passkeyProviderMetadata?.friendlyNames?.['en'];
      const row = ctx.db
        .insert(passkeys)
        .values({
          id: info.credential.id,
          userId: user.id,
          publicKey: Buffer.from(info.credential.publicKey),
          counter: info.credential.counter,
          transports: info.credential.transports ?? null,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
          deviceName: (body.deviceName ?? providerName ?? '패스키').slice(
            0,
            PASSKEY_NAME_MAX_LENGTH,
          ),
          createdAt: new Date(ctx.now()),
        })
        .onConflictDoNothing()
        .returning()
        .get();
      if (!row) throw errors.conflict('passkey_invalid', 'This passkey is already registered');
      return reply.code(201).send(toInfo(row));
    });

    app.patch('/me/passkeys/:id', async (request): Promise<PasskeyInfo> => {
      const { user } = currentAuth(request);
      const { id } = parse(z.object({ id: z.string().min(1).max(1024) }), request.params);
      const { deviceName } = parse(z.object({ deviceName: deviceNameSchema }), request.body);
      const row = ctx.db
        .update(passkeys)
        .set({ deviceName })
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
        .returning()
        .get();
      if (!row) throw errors.notFound('Passkey not found');
      return toInfo(row);
    });

    app.delete('/me/passkeys/:id', { preHandler: reauth }, async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(z.object({ id: z.string().min(1).max(1024) }), request.params);
      const remaining =
        ctx.db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, user.id)).get()?.n ??
        0;
      // Never strand an account: without a password the last passkey must stay.
      if (!user.passwordHash && remaining <= 1) {
        throw errors.conflict('passkey_invalid', 'Cannot remove the only way to sign in');
      }
      const result = ctx.db
        .delete(passkeys)
        .where(and(eq(passkeys.id, id), eq(passkeys.userId, user.id)))
        .run();
      if (result.changes === 0) throw errors.notFound('Passkey not found');
      return reply.code(204).send();
    });
  };
}
