import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type {
  CreatedWebhookToken,
  SmsPreview,
  WebhookResponse,
  WebhookTokenInfo,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth, requireAdmin, requireRecentVerification } from '../auth/guard.ts';
import { randomToken, sha256 } from '../auth/tokens.ts';
import type { AppContext } from '../context.ts';
import { users, webhookTokens } from '../db/schema.ts';
import { errors, HttpError } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { ingestSms, previewSms, reprocessRawRecords } from '../sms/ingest.ts';

/** Card messages are short; anything near this is not one. */
export const WEBHOOK_BODY_LIMIT = 8 * 1024;
const TOKEN_PREFIX = 'bgt_';

type TokenRow = typeof webhookTokens.$inferSelect;

function toInfo(row: TokenRow): WebhookTokenInfo {
  return {
    id: row.id,
    deviceName: row.deviceName,
    hint: row.tokenHint,
    createdAt: row.createdAt.toISOString(),
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    receivedCount: row.receivedCount,
    ignoredCount: row.ignoredCount,
    lastIgnoredAt: row.lastIgnoredAt?.toISOString() ?? null,
    revoked: row.revokedAt !== null,
  };
}

const bodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  sender: z.string().max(100).optional().nullable(),
  receivedAt: z.iso.datetime({ offset: true }).optional().nullable(),
});

export function webhookRoutes(ctx: AppContext): FastifyPluginAsync {
  const reauth = requireRecentVerification(ctx);

  return async (app) => {
    /**
     * Called by the iOS Shortcuts automation. Authenticated only by the
     * per-device bearer token: no session, no Origin (Shortcuts sends none).
     */
    app.post(
      '/webhook/sms',
      { config: { auth: 'public', checkOrigin: false }, bodyLimit: WEBHOOK_BODY_LIMIT },
      async (request, reply): Promise<WebhookResponse> => {
        const byIp = ctx.limits.webhookByIp.hit(`ip:${request.ip}`);
        if (!byIp.allowed) throw errors.rateLimited(byIp.retryAfterSeconds);

        const header = request.headers.authorization ?? '';
        const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
        const row = token.startsWith(TOKEN_PREFIX)
          ? ctx.db
              .select({ token: webhookTokens, disabledAt: users.disabledAt })
              .from(webhookTokens)
              .innerJoin(users, eq(webhookTokens.userId, users.id))
              .where(eq(webhookTokens.tokenHash, sha256(token)))
              .get()
          : undefined;
        if (!row || row.token.revokedAt || row.disabledAt) {
          throw new HttpError(401, 'invalid_token', 'Invalid or revoked token', {
            'www-authenticate': 'Bearer',
          });
        }
        const byToken = ctx.limits.webhookByToken.hit(`token:${row.token.id}`);
        if (!byToken.allowed) throw errors.rateLimited(byToken.retryAfterSeconds);

        // Shortcuts may send JSON or plain text.
        const raw = typeof request.body === 'string' ? { text: request.body } : request.body;
        const body = parse(bodySchema, raw);
        const outcome = ingestSms(ctx.db, ctx.now(), {
          tokenId: row.token.id,
          userId: row.token.userId,
          text: body.text,
          sender: body.sender ?? null,
          clientReceivedAt: body.receivedAt ? Date.parse(body.receivedAt) : null,
        });
        request.log.info(
          { result: outcome.result, rawRecordId: outcome.rawRecordId },
          'sms received',
        );
        reply.code(outcome.result === 'created' ? 201 : 200);
        return {
          ok: true,
          result: outcome.result,
          ...(outcome.transactionId ? { transactionId: outcome.transactionId } : {}),
          message: outcome.message,
        };
      },
    );

    app.get('/me/webhook-tokens', async (request) => {
      const { user } = currentAuth(request);
      return ctx.db
        .select()
        .from(webhookTokens)
        .where(eq(webhookTokens.userId, user.id))
        .orderBy(desc(webhookTokens.createdAt))
        .all()
        .map(toInfo);
    });

    app.post('/me/webhook-tokens', { preHandler: reauth }, async (request, reply) => {
      const { user } = currentAuth(request);
      const { deviceName } = parse(
        z.object({ deviceName: z.string().trim().min(1).max(40) }),
        request.body,
      );
      const token = `${TOKEN_PREFIX}${randomToken(32)}`;
      const row = ctx.db
        .insert(webhookTokens)
        .values({
          userId: user.id,
          deviceName,
          tokenHash: sha256(token),
          tokenHint: token.slice(-4),
          createdAt: new Date(ctx.now()),
        })
        .returning()
        .get();
      const result: CreatedWebhookToken = {
        token,
        info: toInfo(row),
        url: `${ctx.config.publicOrigin}/api/webhook/sms`,
      };
      return reply.code(201).send(result);
    });

    app.delete('/me/webhook-tokens/:id', async (request, reply) => {
      const { user } = currentAuth(request);
      const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), request.params);
      const res = ctx.db
        .update(webhookTokens)
        .set({ revokedAt: new Date(ctx.now()) })
        .where(
          and(
            eq(webhookTokens.id, id),
            eq(webhookTokens.userId, user.id),
            isNull(webhookTokens.revokedAt),
          ),
        )
        .run();
      if (res.changes === 0) throw errors.notFound('Token not found');
      return reply.code(204).send();
    });

    /** 문자 붙여넣기 테스트: parse and preview without storing anything. */
    app.post('/sms/test', async (request): Promise<SmsPreview> => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          text: z.string().max(2000),
          receivedAt: z.iso.datetime({ offset: true }).optional(),
        }),
        request.body,
      );
      const at = body.receivedAt ? Date.parse(body.receivedAt) : ctx.now();
      return previewSms(ctx.db, body.text, at, user.id) as SmsPreview;
    });

    /** Re-run parsers over failed or outdated SMS records (admin). */
    app.post('/admin/reprocess', { preHandler: [requireAdmin, reauth] }, async () =>
      reprocessRawRecords(ctx.db, ctx.now()),
    );
  };
}
