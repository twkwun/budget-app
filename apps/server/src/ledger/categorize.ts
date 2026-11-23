/**
 * Automatic categorisation (DESIGN 6.4), in order:
 *   1. the family's own rules (highest priority first)
 *   2. the category most recently used for the same merchant
 *   3. built-in keyword rules
 *   4. none (미분류)
 * Payment intermediaries (네이버페이 etc.) are always left 미분류.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { isAggregatorMerchant, normalizeMerchant, type RuleMatchType } from '@budget/shared';
import type { AppDatabase } from '../db/client.ts';
import { categories, categoryRules, transactions } from '../db/schema.ts';
import { KEYWORD_RULES } from './keyword-rules.ts';

type Db = Pick<AppDatabase, 'select' | 'insert' | 'update'>;
export type CategorizeReason = 'rule' | 'history' | 'keyword';

export interface CategorizeResult {
  categoryId: number | null;
  reason: CategorizeReason | null;
  ruleId?: number;
}

export function ruleMatches(matchType: RuleMatchType, pattern: string, key: string): boolean {
  const p = normalizeMerchant(pattern);
  if (!p || !key) return false;
  if (matchType === 'exact') return key === p;
  if (matchType === 'prefix') return key.startsWith(p);
  return key.includes(p);
}

function activeRules(db: Db, kind: 'expense' | 'income', system: boolean) {
  return db
    .select({
      id: categoryRules.id,
      pattern: categoryRules.pattern,
      matchType: categoryRules.matchType,
      categoryId: categoryRules.categoryId,
    })
    .from(categoryRules)
    .innerJoin(categories, eq(categoryRules.categoryId, categories.id))
    .where(
      and(
        eq(categoryRules.isSystem, system),
        isNull(categoryRules.disabledAt),
        isNull(categories.archivedAt),
        eq(categories.kind, kind),
      ),
    )
    .orderBy(desc(categoryRules.priority), asc(categoryRules.id))
    .all();
}

export function categorize(
  db: Db,
  input: { merchant: string | null | undefined; type: string; viewerId: number },
): CategorizeResult {
  const none: CategorizeResult = { categoryId: null, reason: null };
  if (!input.merchant || (input.type !== 'expense' && input.type !== 'income')) return none;
  if (isAggregatorMerchant(input.merchant)) return none;
  const key = normalizeMerchant(input.merchant);
  if (!key) return none;
  const kind = input.type;

  for (const rule of activeRules(db, kind, false)) {
    if (ruleMatches(rule.matchType, rule.pattern, key)) {
      return { categoryId: rule.categoryId, reason: 'rule', ruleId: rule.id };
    }
  }

  const previous = db
    .select({ categoryId: transactions.categoryId })
    .from(transactions)
    .innerJoin(categories, eq(transactions.categoryId, categories.id))
    .where(
      and(
        eq(transactions.merchantKey, key),
        eq(transactions.type, kind),
        isNull(categories.archivedAt),
        or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, input.viewerId)),
      ),
    )
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(1)
    .get();
  if (previous?.categoryId) return { categoryId: previous.categoryId, reason: 'history' };

  for (const rule of activeRules(db, kind, true)) {
    if (ruleMatches(rule.matchType, rule.pattern, key)) {
      return { categoryId: rule.categoryId, reason: 'keyword', ruleId: rule.id };
    }
  }
  return none;
}

/** Insert missing built-in keyword rules (idempotent, by system key). */
export function seedKeywordRules(db: AppDatabase): number {
  const ids = new Map(
    db
      .select({ id: categories.id, key: categories.systemKey })
      .from(categories)
      .all()
      .flatMap((c) => (c.key ? [[c.key, c.id] as const] : [])),
  );
  let inserted = 0;
  db.transaction((tx) => {
    for (const group of KEYWORD_RULES) {
      const categoryId = ids.get(group.category);
      if (!categoryId) continue;
      for (const p of group.patterns) {
        const exact = typeof p === 'object';
        const pattern = normalizeMerchant(exact ? p.exact : p);
        const res = tx
          .insert(categoryRules)
          .values({
            pattern,
            matchType: exact ? 'exact' : 'contains',
            categoryId,
            priority: pattern.length,
            isSystem: true,
            systemKey: `kw.${group.category}.${pattern}`,
          })
          .onConflictDoNothing({ target: categoryRules.systemKey })
          .run();
        inserted += res.changes;
      }
    }
  });
  return inserted;
}

/** Fill merchant_key for rows created before stage 4 (cheap, runs at startup). */
export function backfillMerchantKeys(db: AppDatabase): number {
  const rows = db
    .select({ id: transactions.id, merchant: transactions.merchant })
    .from(transactions)
    .where(and(isNull(transactions.merchantKey), sql`${transactions.merchant} is not null`))
    .all();
  db.transaction((tx) => {
    for (const r of rows) {
      tx.update(transactions)
        .set({ merchantKey: normalizeMerchant(r.merchant ?? '') })
        .where(eq(transactions.id, r.id))
        .run();
    }
  });
  return rows.length;
}

/**
 * Apply a rule to existing 미분류 transactions the viewer can see.
 * Returns how many were categorised.
 */
export function applyRuleToUncategorized(
  db: AppDatabase,
  rule: { pattern: string; matchType: RuleMatchType; categoryId: number },
  viewerId: number,
): number {
  const cat = db.select().from(categories).where(eq(categories.id, rule.categoryId)).get();
  if (!cat) return 0;
  const rows = db
    .select({ id: transactions.id, key: transactions.merchantKey, merchant: transactions.merchant })
    .from(transactions)
    .where(
      and(
        isNull(transactions.categoryId),
        eq(transactions.type, cat.kind),
        sql`${transactions.status} <> 'cancelled'`,
        sql`${transactions.merchantKey} is not null`,
        or(eq(transactions.isPrivate, false), eq(transactions.ownerUserId, viewerId)),
      ),
    )
    .all()
    .filter(
      (r) =>
        !isAggregatorMerchant(r.merchant) && ruleMatches(rule.matchType, rule.pattern, r.key ?? ''),
    );
  if (rows.length === 0) return 0;
  db.update(transactions)
    .set({ categoryId: rule.categoryId, updatedAt: new Date() })
    .where(
      inArray(
        transactions.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  return rows.length;
}
