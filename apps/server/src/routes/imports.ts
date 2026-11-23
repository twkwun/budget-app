import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  COLUMN_ROLES,
  type ColumnMap,
  type ImportBatchInfo,
  type ImportOutcome,
  type ImportPreview,
  type ImportRowInfo,
  type ImportRowsPage,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { importBatches, rawRecords } from '../db/schema.ts';
import { errors, HttpError } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { missingRoles } from '../importer/layout.ts';
import type { ParsedRow } from '../importer/rows.ts';
import {
  accountMappings,
  analyzeBatch,
  applyBatch,
  batchCounts,
  categoryMappings,
  createImport,
  discardBatch,
  ImportStateError,
  saveAccountMappings,
  saveCategoryMappings,
  setColumnMap,
  setDecisions,
  undoBatch,
  type RowState,
} from '../importer/service.ts';
import { ImportFileError, LIMITS, type Cell } from '../importer/types.ts';
import { getTransaction } from '../ledger/queries.ts';

type Batch = typeof importBatches.$inferSelect;

function info(db: AppContext['db'], b: Batch): ImportBatchInfo {
  const { counts, transfers, undecided } = batchCounts(db, b.id);
  return {
    id: b.id,
    fileName: b.fileName,
    format: b.format,
    container: b.container,
    status: b.status,
    rowCount: b.rowCount,
    counts,
    transferSuggestions: transfers,
    undecided,
    result: b.result ?? null,
    createdAt: b.createdAt.toISOString(),
    appliedAt: b.appliedAt?.toISOString() ?? null,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    undoneAt: b.undoneAt?.toISOString() ?? null,
  };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const columnMapSchema = z
  .partialRecord(z.enum(COLUMN_ROLES), z.number().int().min(0).max(LIMITS.columns))
  .transform((m) => m as ColumnMap);
const decisionSchema = z
  .union([
    z.literal('create'),
    z.literal('skip'),
    z.object({ attach: z.number().int().positive() }),
  ])
  .nullable();

function stateError(error: unknown): never {
  if (error instanceof ImportStateError) {
    if (error.message === 'not_found') throw errors.notFound('Import not found');
    if (error.message === 'undecided')
      throw errors.conflict('import_invalid', 'Decide every 확인 필요 row first');
    throw errors.conflict('import_invalid', `Import is not in the right state (${error.message})`);
  }
  throw error;
}

export function importRoutes(ctx: AppContext): FastifyPluginAsync {
  const own = (userId: number, id: number): Batch => {
    const b = ctx.db.select().from(importBatches).where(eq(importBatches.id, id)).get();
    if (!b || b.userId !== userId || b.status === 'discarded')
      throw errors.notFound('Import not found');
    return b;
  };
  const editable = (b: Batch) => {
    if (b.status !== 'previewed' && b.status !== 'needs_mapping')
      throw errors.conflict('import_invalid', 'Already applied');
  };

  const preview = (b: Batch): ImportPreview => {
    const header = b.header ?? [];
    const map = (b.columnMap ?? {}) as ColumnMap;
    const sample = ctx.db
      .select({ t: rawRecords.rawText })
      .from(rawRecords)
      .where(eq(rawRecords.importBatchId, b.id))
      .orderBy(rawRecords.id)
      .limit(5)
      .all()
      .map((r) => JSON.parse(r.t) as Cell[]);
    return {
      batch: info(ctx.db, b),
      sheetName: b.sheetName,
      header,
      columnMap: map,
      sample,
      missing: missingRoles(map),
      accounts: b.status === 'needs_mapping' ? [] : accountMappings(ctx.db, b.id),
      categories: b.status === 'needs_mapping' ? [] : categoryMappings(ctx.db, b.id),
    };
  };

  return async (app) => {
    // Uploads arrive as the raw file body; the original is never stored.
    app.addContentTypeParser(
      [
        'application/octet-stream',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv',
      ],
      { parseAs: 'buffer', bodyLimit: LIMITS.fileBytes },
      (_req, body, done) => done(null, body),
    );

    app.get('/imports', async (request): Promise<ImportBatchInfo[]> => {
      const { user } = currentAuth(request);
      return ctx.db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.userId, user.id), ne(importBatches.status, 'discarded')))
        .orderBy(desc(importBatches.createdAt))
        .limit(50)
        .all()
        .map((b) => info(ctx.db, b));
    });

    app.post('/imports', { bodyLimit: LIMITS.fileBytes + 1024 }, async (request, reply) => {
      const { user } = currentAuth(request);
      const limit = ctx.limits.importsByUser.hit(`user:${user.id}`);
      if (!limit.allowed) throw errors.rateLimited(limit.retryAfterSeconds);
      if (!Buffer.isBuffer(request.body))
        throw errors.validation('Send the file as the request body');
      const decode = (v: unknown) => {
        if (typeof v !== 'string' || v === '') return undefined;
        try {
          return decodeURIComponent(v);
        } catch {
          return undefined;
        }
      };
      try {
        const batch = await createImport(ctx.db, {
          userId: user.id,
          fileName: decode(request.headers['x-file-name']) ?? null,
          bytes: request.body,
          password: decode(request.headers['x-file-password']),
          now: ctx.now(),
        });
        return reply.code(201).send(preview(batch));
      } catch (error) {
        if (error instanceof ImportFileError) {
          const code = error.message === 'no_rows' ? 'no_rows' : error.code;
          throw new HttpError(error.code === 'file_too_large' ? 413 : 422, code, error.message);
        }
        throw error;
      }
    });

    app.get('/imports/:id', async (request) => {
      const { user } = currentAuth(request);
      return preview(own(user.id, parse(idParam, request.params).id));
    });

    app.get('/imports/:id/rows', async (request): Promise<ImportRowsPage> => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      const q = parse(
        z.object({
          outcome: z
            .enum([
              'new',
              'duplicate',
              'review',
              'already',
              'cancel',
              'cancel_duplicate',
              'error',
              'transfer',
            ])
            .optional(),
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      const all = ctx.db
        .select()
        .from(rawRecords)
        .where(eq(rawRecords.importBatchId, b.id))
        .orderBy(rawRecords.id)
        .all()
        .filter((r) => {
          const s = (r.issueData ?? {}) as unknown as RowState;
          if (!q.outcome) return true;
          if (q.outcome === 'transfer')
            return !!s.suggestedTransfer && ['new', 'review', 'duplicate'].includes(s.outcome);
          return s.outcome === (q.outcome as ImportOutcome);
        });
      const tx = (id: number | null | undefined) =>
        id ? getTransaction(ctx.db, user.id, id) : null;
      const rows: ImportRowInfo[] = all.slice(q.offset, q.offset + q.limit).map((r) => {
        const p = r.parsed as ParsedRow;
        const s = (r.issueData ?? {}) as unknown as RowState;
        return {
          id: r.id,
          row: p.row,
          date: p.date ?? '',
          time: p.time,
          type: p.type,
          amount: p.amount,
          refund: p.refund,
          merchant: p.merchant,
          paymentLabel: p.paymentLabel,
          sourceCategory: p.categoryMajor
            ? [p.categoryMajor, p.categoryMinor].filter(Boolean).join(' > ')
            : null,
          outcome: s.outcome ?? 'error',
          cancel: !!s.cancel,
          error: p.error,
          match: tx(r.transactionId ?? s.transactionId),
          candidates: (s.candidateIds ?? []).map((id) => tx(id)).filter((t) => t !== null),
          suggestedTransfer: !!s.suggestedTransfer,
          transfer: s.transfer ?? !!s.suggestedTransfer,
          decision: s.decision ?? null,
        };
      });
      return { rows, total: all.length };
    });

    app.put('/imports/:id/columns', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      editable(b);
      const { columnMap } = parse(z.object({ columnMap: columnMapSchema }), request.body);
      if (missingRoles(columnMap).length) throw errors.validation('날짜와 금액 열을 지정하세요');
      await setColumnMap(ctx.db, b.id, columnMap, ctx.now());
      return preview(own(user.id, b.id));
    });

    app.put('/imports/:id/accounts', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      editable(b);
      const { mappings } = parse(
        z.object({
          mappings: z
            .array(
              z.object({
                label: z.string().max(100),
                accountId: z.number().int().positive().nullable(),
              }),
            )
            .max(500),
        }),
        request.body,
      );
      saveAccountMappings(ctx.db, mappings, user.id, ctx.now());
      await analyzeBatch(ctx.db, b.id, ctx.now());
      return preview(own(user.id, b.id));
    });

    app.put('/imports/:id/categories', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      editable(b);
      const { mappings } = parse(
        z.object({
          mappings: z
            .array(
              z.object({
                key: z.string().max(200),
                categoryId: z.number().int().positive().nullable(),
              }),
            )
            .max(1000),
        }),
        request.body,
      );
      saveCategoryMappings(ctx.db, mappings, ctx.now());
      return preview(own(user.id, b.id));
    });

    app.put('/imports/:id/decisions', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      editable(b);
      const body = parse(
        z.object({
          items: z
            .array(
              z.object({
                id: z.number().int().positive(),
                decision: decisionSchema.optional(),
                transfer: z.boolean().nullable().optional(),
              }),
            )
            .max(20_000)
            .default([]),
          bulk: z
            .object({
              outcome: z.enum(['review', 'new', 'transfer']),
              decision: z.enum(['create', 'skip']).optional(),
              transfer: z.boolean().optional(),
            })
            .optional(),
        }),
        request.body,
      );
      const items = [...body.items];
      if (body.bulk) {
        for (const r of ctx.db
          .select({ id: rawRecords.id, d: rawRecords.issueData })
          .from(rawRecords)
          .where(eq(rawRecords.importBatchId, b.id))
          .all()) {
          const s = (r.d ?? {}) as unknown as RowState;
          const match =
            body.bulk.outcome === 'transfer'
              ? !!s.suggestedTransfer
              : s.outcome === body.bulk.outcome && !(body.bulk.decision === 'create' && s.cancel);
          if (!match) continue;
          items.push({
            id: r.id,
            ...(body.bulk.decision ? { decision: body.bulk.decision } : {}),
            ...(body.bulk.transfer !== undefined ? { transfer: body.bulk.transfer } : {}),
          });
        }
      }
      setDecisions(ctx.db, b.id, items);
      return { batch: info(ctx.db, own(user.id, b.id)) };
    });

    app.post('/imports/:id/apply', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      try {
        const result = await applyBatch(ctx.db, b.id, user.id, ctx.now());
        return { result, batch: info(ctx.db, own(user.id, b.id)) };
      } catch (error) {
        return stateError(error);
      }
    });

    app.post('/imports/:id/undo', async (request) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      const { confirm } = parse(z.object({ confirm: z.boolean().default(false) }), request.body);
      try {
        const report = undoBatch(ctx.db, b.id, user.id, ctx.now(), confirm);
        if (!confirm && report.edited > 0) {
          throw new HttpError(
            409,
            'undo_conflict',
            `${report.edited} transactions were changed after the import`,
          );
        }
        return { report, batch: info(ctx.db, own(user.id, b.id)) };
      } catch (error) {
        if (error instanceof HttpError) throw error;
        return stateError(error);
      }
    });

    app.delete('/imports/:id', async (request, reply) => {
      const { user } = currentAuth(request);
      const b = own(user.id, parse(idParam, request.params).id);
      editable(b);
      discardBatch(ctx.db, b.id);
      return reply.code(204).send();
    });
  };
}
