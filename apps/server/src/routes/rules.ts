import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { alias } from 'drizzle-orm/sqlite-core';
import { RULE_MATCH_TYPES, normalizeMerchant, type RuleInfo, type RuleList } from '@budget/shared';
import { z } from 'zod';
import { currentAuth } from '../auth/guard.ts';
import type { AppContext } from '../context.ts';
import { categories, categoryRules } from '../db/schema.ts';
import { errors } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { applyRuleToUncategorized } from '../ledger/categorize.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const patternSchema = z
  .string()
  .max(60)
  .transform((v) => normalizeMerchant(v))
  .pipe(z.string().min(1, 'pattern is empty after normalisation'));

/** Rules are shared by the family, like categories. */
export function ruleRoutes(ctx: AppContext): FastifyPluginAsync {
  const parent = alias(categories, 'parent_category');

  const list = (): RuleList => {
    const rows = ctx.db
      .select({
        rule: categoryRules,
        name: categories.name,
        kind: categories.kind,
        parentName: parent.name,
      })
      .from(categoryRules)
      .innerJoin(categories, eq(categoryRules.categoryId, categories.id))
      .leftJoin(parent, eq(categories.parentId, parent.id))
      .orderBy(desc(categoryRules.priority), asc(categoryRules.id))
      .all();
    const info = (r: (typeof rows)[number]): RuleInfo => ({
      id: r.rule.id,
      pattern: r.rule.pattern,
      matchType: r.rule.matchType,
      categoryId: r.rule.categoryId,
      categoryLabel: r.parentName ? `${r.parentName} > ${r.name}` : r.name,
      kind: r.kind,
      priority: r.rule.priority,
      isSystem: r.rule.isSystem,
      disabled: r.rule.disabledAt !== null,
    });
    return {
      user: rows.filter((r) => !r.rule.isSystem).map(info),
      system: rows.filter((r) => r.rule.isSystem).map(info),
    };
  };

  const requireCategory = (id: number) => {
    const cat = ctx.db.select().from(categories).where(eq(categories.id, id)).get();
    if (!cat || cat.archivedAt)
      throw errors.conflict('category_invalid', 'Unknown or archived category');
    return cat;
  };

  const loadUserRule = (id: number) => {
    const rule = ctx.db.select().from(categoryRules).where(eq(categoryRules.id, id)).get();
    if (!rule) throw errors.notFound('Rule not found');
    return rule;
  };

  return async (app) => {
    app.get('/rules', async () => list());

    /** New rules go to the top. `applyToExisting` also fills matching 미분류 entries. */
    app.post('/rules', async (request, reply) => {
      const { user } = currentAuth(request);
      const body = parse(
        z.object({
          pattern: patternSchema,
          matchType: z.enum(RULE_MATCH_TYPES).default('contains'),
          categoryId: z.number().int().positive(),
          applyToExisting: z.boolean().default(false),
        }),
        request.body,
      );
      requireCategory(body.categoryId);
      const top = ctx.db
        .select({ p: categoryRules.priority })
        .from(categoryRules)
        .where(eq(categoryRules.isSystem, false))
        .orderBy(desc(categoryRules.priority))
        .get();
      const rule = ctx.db
        .insert(categoryRules)
        .values({
          pattern: body.pattern,
          matchType: body.matchType,
          categoryId: body.categoryId,
          priority: (top?.p ?? 0) + 1,
          isSystem: false,
          createdByUserId: user.id,
        })
        .returning()
        .get();
      const applied = body.applyToExisting ? applyRuleToUncategorized(ctx.db, rule, user.id) : 0;
      return reply.code(201).send({ id: rule.id, applied, rules: list() });
    });

    /** Edit a user rule; built-in rules can only be switched on or off. */
    app.patch('/rules/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      const rule = loadUserRule(id);
      const body = parse(
        z
          .object({
            pattern: patternSchema.optional(),
            matchType: z.enum(RULE_MATCH_TYPES).optional(),
            categoryId: z.number().int().positive().optional(),
            disabled: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      if (rule.isSystem && (body.pattern || body.matchType || body.categoryId)) {
        throw errors.conflict('rule_invalid', 'Built-in rules can only be turned on or off');
      }
      if (body.categoryId) requireCategory(body.categoryId);
      ctx.db
        .update(categoryRules)
        .set({
          pattern: body.pattern ?? rule.pattern,
          matchType: body.matchType ?? rule.matchType,
          categoryId: body.categoryId ?? rule.categoryId,
          disabledAt:
            body.disabled === undefined
              ? rule.disabledAt
              : body.disabled
                ? (rule.disabledAt ?? new Date(ctx.now()))
                : null,
        })
        .where(eq(categoryRules.id, id))
        .run();
      return list();
    });

    app.delete('/rules/:id', async (request, reply) => {
      const { id } = parse(idParam, request.params);
      const rule = loadUserRule(id);
      if (rule.isSystem)
        throw errors.conflict('rule_invalid', 'Built-in rules can only be turned off');
      ctx.db.delete(categoryRules).where(eq(categoryRules.id, id)).run();
      return reply.code(204).send();
    });

    /** Order of the family's rules, first wins. */
    app.put('/rules/order', async (request) => {
      const { ids } = parse(
        z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000) }),
        request.body,
      );
      const userRules = ctx.db
        .select({ id: categoryRules.id })
        .from(categoryRules)
        .where(eq(categoryRules.isSystem, false))
        .all();
      const known = new Set(userRules.map((r) => r.id));
      if (
        ids.length !== known.size ||
        new Set(ids).size !== ids.length ||
        !ids.every((i) => known.has(i))
      ) {
        throw errors.validation('ids must list every rule exactly once');
      }
      ctx.db.transaction((tx) => {
        ids.forEach((ruleId, index) => {
          tx.update(categoryRules)
            .set({ priority: ids.length - index })
            .where(and(eq(categoryRules.id, ruleId), inArray(categoryRules.id, ids)))
            .run();
        });
      });
      return list();
    });

    app.post('/rules/:id/apply', async (request) => {
      const { user } = currentAuth(request);
      const { id } = parse(idParam, request.params);
      const rule = loadUserRule(id);
      return { applied: applyRuleToUncategorized(ctx.db, rule, user.id) };
    });
  };
}
