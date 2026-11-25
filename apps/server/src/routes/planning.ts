/** Budgets, 고정지출, statistics, CSV export and backup status. */
import { eq } from 'drizzle-orm';
import { stat } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import {
  BUDGET_MONTHS_DEFAULT,
  BUDGET_MONTHS_MAX,
  BUDGET_MONTHS_MIN,
  MAX_AMOUNT,
  addMonths,
  LIST_BASES,
  MERCHANT_MAX_LENGTH,
  currentYearMonth,
  isLocalDate,
  isYearMonth,
  normalizeMerchant,
  type BackupStatus,
  type BudgetMonthsReport,
  type BudgetOverview,
  type RangeStats,
  type RecurringOverview,
  type YearStats,
} from '@budget/shared';
import { z } from 'zod';
import { currentAuth, requireAdmin, requireRecentVerification } from '../auth/guard.ts';
import { createBackup, listBackups, pruneBackups } from '../backup/backup.ts';
import { nextRunAt } from '../backup/scheduler.ts';
import type { AppContext } from '../context.ts';
import { accounts, categories, recurringExpenses } from '../db/schema.ts';
import { HttpError, errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { monthSummary } from '../ledger/queries.ts';
import {
  budgetCategoryOptions,
  budgetHistory,
  budgetMonths,
  monthBudgets,
  setBudget,
} from '../planning/budgets.ts';
import { exportTransactionsCsv } from '../planning/export.ts';
import { recurringOverview, refreshSuggestions } from '../planning/recurring.ts';
import { isValidRange, rangeStats, yearStats } from '../planning/stats.ts';

const monthSchema = z
  .string()
  .refine(isYearMonth, 'must be YYYY-MM')
  .refine((m) => m >= '2000-01' && m <= '2099-12', 'out of range');
const basisSchema = z.enum(LIST_BASES).default('date');
const ownerSchema = z
  .union([z.literal('all'), z.coerce.number().int().positive()])
  .default('all')
  .transform((v) => (v === 'all' ? null : v));
const idParam = z.object({ id: z.coerce.number().int().positive() });

const recurringFields = {
  name: z.string().trim().min(1).max(MERCHANT_MAX_LENGTH),
  matchKey: z
    .string()
    .max(MERCHANT_MAX_LENGTH)
    .transform((v) => normalizeMerchant(v))
    .pipe(z.string().min(2, 'match text too short')),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  dayOfMonth: z.number().int().min(1).max(31),
  categoryId: z.number().int().positive().nullable(),
  accountId: z.number().int().positive().nullable(),
};

/** Something that can take a backup now (the scheduler when it runs). */
export interface BackupRunner {
  runNow(): Promise<{ bytes: number } | null>;
  nextRun(): number | null;
}

export function planningRoutes(
  ctx: AppContext,
  options: { backups?: () => BackupRunner | null } = {},
): FastifyPluginAsync {
  const assertRecurringRefs = (categoryId: number | null, accountId: number | null) => {
    if (categoryId !== null) {
      const cat = ctx.db.select().from(categories).where(eq(categories.id, categoryId)).get();
      if (!cat || cat.kind !== 'expense' || cat.archivedAt) {
        throw errors.conflict('recurring_invalid', 'Category must be an active expense category');
      }
    }
    if (accountId !== null) {
      const acc = ctx.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
      if (!acc) throw errors.conflict('recurring_invalid', 'Unknown account');
    }
  };
  const assertKeyFree = (matchKey: string, exceptId?: number) => {
    const other = ctx.db
      .select({ id: recurringExpenses.id })
      .from(recurringExpenses)
      .where(eq(recurringExpenses.matchKey, matchKey))
      .get();
    if (other && other.id !== exceptId) {
      throw errors.conflict('recurring_exists', 'An item with this match text already exists');
    }
  };

  let manualBackup: Promise<{ bytes: number }> | null = null;

  return async (app) => {
    // ---- Budgets (shared by the family; any member may set them) ----

    app.get('/budgets', async (request): Promise<BudgetOverview> => {
      const { user } = currentAuth(request);
      const q = parse(
        z.object({ month: monthSchema.default(currentYearMonth(ctx.now())) }),
        request.query,
      );
      const summary = monthSummary(ctx.db, user.id, q.month, null);
      return {
        ...monthBudgets(ctx.db, q.month, ctx.now(), summary.expense, summary.expenseByCategory),
        categoryOptions: budgetCategoryOptions(ctx.db),
        history: budgetHistory(ctx.db),
      };
    });

    // 월별 비교: `count` months ending at `to` (never past the current month).
    app.get('/budgets/months', async (request): Promise<BudgetMonthsReport> => {
      const { user } = currentAuth(request);
      const current = currentYearMonth(ctx.now());
      const q = parse(
        z.object({
          to: monthSchema.default(current),
          count: z.coerce
            .number()
            .int()
            .min(BUDGET_MONTHS_MIN)
            .max(BUDGET_MONTHS_MAX)
            .default(BUDGET_MONTHS_DEFAULT),
        }),
        request.query,
      );
      const to = q.to > current ? current : q.to;
      return budgetMonths(ctx.db, user.id, addMonths(to, 1 - q.count), to, ctx.now());
    });

    app.put('/budgets', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          month: monthSchema,
          categoryId: z.number().int().positive().nullable(),
          amount: z.number().int().min(0).max(MAX_AMOUNT),
        }),
        request.body,
      );
      setBudget(ctx.db, body, user.id);
      return reply.code(204).send();
    });

    // ---- 고정지출 ----

    app.get('/recurring', async (request): Promise<RecurringOverview> => {
      const { user } = currentAuth(request);
      const q = parse(
        z.object({ month: monthSchema.default(currentYearMonth(ctx.now())) }),
        request.query,
      );
      refreshSuggestions(ctx.db, ctx.now());
      return recurringOverview(ctx.db, user.id, q.month, ctx.now());
    });

    app.post('/recurring', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({ ...recurringFields, matchKey: recurringFields.matchKey.optional() }),
        request.body,
      );
      const matchKey = body.matchKey ?? normalizeMerchant(body.name);
      if (matchKey.length < 2) throw errors.validation('Name is too short to match payments');
      assertRecurringRefs(body.categoryId, body.accountId);
      assertKeyFree(matchKey);
      const row = ctx.db
        .insert(recurringExpenses)
        .values({
          ...body,
          matchKey,
          status: 'confirmed',
          source: 'manual',
          createdByUserId: user.id,
        })
        .returning({ id: recurringExpenses.id })
        .get();
      return reply.code(201).send({ id: row.id });
    });

    app.patch('/recurring/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const body = parse(
        z
          .object({
            ...recurringFields,
            status: z.enum(['suggested', 'confirmed', 'dismissed']),
          })
          .partial(),
        request.body,
      );
      const row = ctx.db.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get();
      if (!row) throw errors.notFound();
      assertRecurringRefs(
        body.categoryId === undefined ? null : body.categoryId,
        body.accountId === undefined ? null : body.accountId,
      );
      if (body.matchKey !== undefined) assertKeyFree(body.matchKey, id);
      if (body.status === 'suggested' && row.source === 'manual') {
        throw errors.conflict('recurring_invalid', 'Items added by hand cannot be suggestions');
      }
      if (Object.keys(body).length) {
        ctx.db.update(recurringExpenses).set(body).where(eq(recurringExpenses.id, id)).run();
      }
      return reply.code(204).send();
    });

    // A detected item is kept as dismissed so it is not suggested again.
    app.delete('/recurring/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const row = ctx.db.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get();
      if (!row) throw errors.notFound();
      if (row.source === 'manual') {
        ctx.db.delete(recurringExpenses).where(eq(recurringExpenses.id, id)).run();
      } else {
        ctx.db
          .update(recurringExpenses)
          .set({ status: 'dismissed' })
          .where(eq(recurringExpenses.id, id))
          .run();
      }
      return reply.code(204).send();
    });

    // ---- Statistics ----

    app.get('/stats/range', async (request): Promise<RangeStats> => {
      const { user } = currentAuth(request);
      const q = parse(
        z.object({ from: monthSchema, to: monthSchema, owner: ownerSchema, basis: basisSchema }),
        request.query,
      );
      if (!isValidRange(q.from, q.to)) throw errors.validation('Range must be 1–36 months');
      return rangeStats(ctx.db, user.id, q.from, q.to, q.owner, q.basis);
    });

    app.get('/stats/year', async (request): Promise<YearStats> => {
      const { user } = currentAuth(request);
      const q = parse(
        z.object({
          year: z.coerce.number().int().min(2001).max(2099),
          owner: ownerSchema,
          basis: basisSchema,
        }),
        request.query,
      );
      return yearStats(ctx.db, user.id, q.year, q.owner, currentYearMonth(ctx.now()), q.basis);
    });

    // ---- Export (re-auth: it hands over the whole visible ledger) ----

    app.get(
      '/export/transactions.csv',
      { preHandler: requireRecentVerification(ctx) },
      async (request, reply) => {
        const { user } = currentAuth(request);
        const q = parse(
          z
            .object({
              from: z.string().refine(isLocalDate, 'must be YYYY-MM-DD'),
              to: z.string().refine(isLocalDate, 'must be YYYY-MM-DD'),
            })
            .refine((v) => v.from <= v.to, 'from must not be after to')
            .refine((v) => v.from >= '2000-01-01' && v.to <= '2099-12-31', 'out of range'),
          request.query,
        );
        const { csv } = exportTransactionsCsv(ctx.db, user.id, q.from, q.to);
        const name = `budget-${q.from}_${q.to}.csv`;
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${name}"`)
          .header('cache-control', 'no-store')
          .send(csv);
      },
    );

    // ---- Backups (admins) ----

    const backupStatus = async (): Promise<BackupStatus> => {
      const files = await listBackups(ctx.config.backupDir);
      const sizes = await Promise.all(
        files.map((f) =>
          stat(f.file)
            .then((s) => s.size)
            .catch(() => 0),
        ),
      );
      const last = files.at(-1);
      const runner = options.backups?.() ?? null;
      const next = runner?.nextRun() ?? null;
      return {
        enabled: ctx.config.backup.enabled,
        time: ctx.config.backup.time,
        retentionDays: ctx.config.backup.retentionDays,
        nextRunAt:
          next !== null
            ? new Date(next).toISOString()
            : ctx.config.backup.enabled
              ? new Date(nextRunAt(ctx.now(), ctx.config.backup.time)).toISOString()
              : null,
        count: files.length,
        totalBytes: sizes.reduce((a, b) => a + b, 0),
        last: last ? { takenAt: last.takenAt.toISOString(), bytes: sizes.at(-1) ?? 0 } : null,
      };
    };

    app.get('/admin/backup', { preHandler: requireAdmin }, backupStatus);

    app.post('/admin/backup', { preHandler: requireAdmin }, async (request) => {
      const runner = options.backups?.() ?? null;
      if (runner) {
        const result = await runner.runNow();
        if (!result) throw new HttpError(500, 'backup_failed', 'Backup failed; see the server log');
      } else {
        manualBackup ??= (async () => {
          const at = new Date(ctx.now());
          const result = await createBackup(ctx.db.$client, ctx.config.backupDir, at);
          await pruneBackups(ctx.config.backupDir, ctx.config.backup.retentionDays, at);
          return result;
        })().finally(() => {
          manualBackup = null;
        });
        try {
          await manualBackup;
        } catch (error) {
          request.log.error({ err: error }, 'manual backup failed');
          throw new HttpError(500, 'backup_failed', 'Backup failed; see the server log');
        }
      }
      return backupStatus();
    });
  };
}
