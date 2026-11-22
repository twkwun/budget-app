import { eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../src/db/default-categories.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { accounts, budgets, categories, transactions, users } from '../src/db/schema.ts';
import { seedDefaultCategories } from '../src/db/seed.ts';
import { migratedDatabase } from './helpers.ts';

const EXPECTED_TABLES = [
  'accounts',
  'budgets',
  'categories',
  'category_rules',
  'import_batches',
  'passkeys',
  'raw_records',
  'sessions',
  'transactions',
  'users',
  'webhook_tokens',
];

describe('database', () => {
  it('opens in WAL mode with foreign keys on', () => {
    const { sqlite } = migratedDatabase();
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates every table from DESIGN.md 6.1 and migrations are re-runnable', () => {
    const { db, sqlite } = migratedDatabase();
    runMigrations(db);
    const tables = sqlite
      .prepare(
        `select name from sqlite_master where type = 'table'
         and name not like 'sqlite_%' and name not like '__drizzle%' order by name`,
      )
      .pluck()
      .all();
    expect(tables).toEqual(EXPECTED_TABLES);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces foreign keys and integrity checks', () => {
    const { db } = migratedDatabase();
    const base = {
      occurredAt: new Date('2026-11-01T03:00:00Z'),
      occurredDate: '2026-11-01',
      type: 'expense' as const,
      source: 'manual' as const,
    };
    expect(() =>
      db
        .insert(transactions)
        .values({ ...base, amount: 1000, ownerUserId: 999 })
        .run(),
    ).toThrow(/FOREIGN KEY/);

    const user = db
      .insert(users)
      .values({ loginName: 'tester', displayName: '테스트' })
      .returning()
      .get();
    expect(user.webauthnUserId).toMatch(/^[\w-]{43}$/);
    expect(user.createdAt).toBeInstanceOf(Date);

    expect(() =>
      db
        .insert(transactions)
        .values({ ...base, amount: -1, ownerUserId: user.id })
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(accounts)
        .values({ ownerUserId: user.id, kind: 'card', name: '테스트카드', last4: '12345' })
        .run(),
    ).toThrow(/CHECK/);

    const tx = db
      .insert(transactions)
      .values({ ...base, amount: 12000, ownerUserId: user.id })
      .returning()
      .get();
    expect(tx.amount).toBe(12000);
    expect(tx.status).toBe('confirmed');
  });

  it('allows one overall and one per-category budget per month', () => {
    const { db } = migratedDatabase();
    seedDefaultCategories(db);
    const food = db.select().from(categories).where(eq(categories.systemKey, 'expense.food')).get();
    db.insert(budgets).values({ month: '2026-11', amount: 2_000_000 }).run();
    db.insert(budgets).values({ month: '2026-11', categoryId: food!.id, amount: 500_000 }).run();
    expect(() => db.insert(budgets).values({ month: '2026-11', amount: 1 }).run()).toThrow(
      /UNIQUE/,
    );
    expect(() =>
      db.insert(budgets).values({ month: '2026-11', categoryId: food!.id, amount: 1 }).run(),
    ).toThrow(/UNIQUE/);
  });
});

describe('seedDefaultCategories', () => {
  const expectedCount = Object.values(DEFAULT_CATEGORIES)
    .flat()
    .reduce((n, parent) => n + 1 + parent.children.length, 0);

  it('seeds two-level expense and income categories', () => {
    const { db } = migratedDatabase();
    expect(seedDefaultCategories(db)).toBe(expectedCount);
    const roots = db.select().from(categories).where(isNull(categories.parentId)).all();
    expect(roots.map((c) => c.name)).toContain('식비');
    expect(roots.map((c) => c.name)).toContain('근로소득');
    const children = db
      .select()
      .from(categories)
      .all()
      .filter((c) => c.parentId !== null);
    const rootIds = new Set(roots.map((r) => r.id));
    expect(children.every((c) => rootIds.has(c.parentId!))).toBe(true);
    const byId = new Map(roots.map((r) => [r.id, r]));
    expect(children.every((c) => byId.get(c.parentId!)?.kind === c.kind)).toBe(true);
  });

  it('is idempotent and keeps user edits', () => {
    const { db } = migratedDatabase();
    seedDefaultCategories(db);
    db.update(categories)
      .set({ name: '먹거리' })
      .where(eq(categories.systemKey, 'expense.food'))
      .run();
    expect(seedDefaultCategories(db)).toBe(0);
    expect(db.select().from(categories).all()).toHaveLength(expectedCount);
    const food = db.select().from(categories).where(eq(categories.systemKey, 'expense.food')).get();
    expect(food?.name).toBe('먹거리');
  });

  it('uses unique system keys', () => {
    const keys = Object.entries(DEFAULT_CATEGORIES).flatMap(([kind, parents]) =>
      parents.flatMap((p) => [
        `${kind}.${p.key}`,
        ...p.children.map((c) => `${kind}.${p.key}.${c.key}`),
      ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
