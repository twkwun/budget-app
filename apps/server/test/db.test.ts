import { eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../src/db/default-categories.ts';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/client.ts';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.ts';
import {
  accounts,
  budgets,
  categories,
  recurringExpenses,
  transactions,
  users,
} from '../src/db/schema.ts';
import { seedDefaultCategories } from '../src/db/seed.ts';
import { migratedDatabase, tempDir } from './helpers.ts';

const EXPECTED_TABLES = [
  'accounts',
  'budgets',
  'categories',
  'category_rules',
  'import_account_mappings',
  'import_batches',
  'import_category_mappings',
  'import_profiles',
  'invites',
  'passkeys',
  'raw_records',
  'recurring_expenses',
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

  it('allows one overall and one per-category budget per member and month', () => {
    const { db } = migratedDatabase();
    seedDefaultCategories(db);
    const food = db.select().from(categories).where(eq(categories.systemKey, 'expense.food')).get();
    const [a, b] = ['a', 'b'].map(
      (n) => db.insert(users).values({ loginName: n, displayName: n }).returning().get().id,
    ) as [number, number];
    db.insert(budgets).values({ userId: a, month: '2026-11', amount: 2_000_000 }).run();
    db.insert(budgets)
      .values({ userId: a, month: '2026-11', categoryId: food!.id, amount: 500_000 })
      .run();
    // Another member has budgets of their own for the same month.
    db.insert(budgets).values({ userId: b, month: '2026-11', amount: 1_000_000 }).run();
    db.insert(budgets)
      .values({ userId: b, month: '2026-11', categoryId: food!.id, amount: 300_000 })
      .run();
    expect(() =>
      db.insert(budgets).values({ userId: a, month: '2026-11', amount: 1 }).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .insert(budgets)
        .values({ userId: a, month: '2026-11', categoryId: food!.id, amount: 1 })
        .run(),
    ).toThrow(/UNIQUE/);
  });
});

describe('0006 personal budgets and 고정지출', () => {
  it('gives what the family set up so far to the first active admin', () => {
    // Migrate up to 0005, add family-wide rows, then run the rest.
    const old = tempDir();
    cpSync(MIGRATIONS_DIR, old, { recursive: true });
    const journalFile = path.join(old, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag < '0006');
    writeFileSync(journalFile, JSON.stringify(journal));
    const { db, sqlite } = openDatabase(path.join(tempDir(), 'app.db'));
    runMigrations(db, old);
    sqlite.exec(`
      insert into users (login_name, display_name, role, webauthn_user_id) values
        ('kid', '아이', 'member', 'w1'), ('old', '전관리자', 'admin', 'w2'), ('mom', '엄마', 'admin', 'w3');
      update users set disabled_at = 1 where login_name = 'old';
      insert into budgets (month, category_id, amount) values ('2026-10', null, 900000);
      insert into recurring_expenses (name, match_key, amount, day_of_month, status, source)
        values ('관리비', '관리비', 250000, 5, 'confirmed', 'manual');
    `);
    runMigrations(db);
    const mom = db.select().from(users).where(eq(users.loginName, 'mom')).get()!;
    expect(db.select().from(budgets).all()).toMatchObject([
      { userId: mom.id, month: '2026-10', categoryId: null, amount: 900_000 },
    ]);
    expect(db.select().from(recurringExpenses).all()).toMatchObject([
      { userId: mom.id, name: '관리비', status: 'confirmed' },
    ]);
    sqlite.close();
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
