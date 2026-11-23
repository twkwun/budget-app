/**
 * Loads 20,000 invented transactions (about 30 months, two members) and checks
 * that the month list and summary stay fast and use indexes.
 * Timings are printed; thresholds are generous so slow CI machines pass.
 */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { addMonths, toLocalDate, zonedTimeToUtc } from '@budget/shared';
import type { AppDatabase } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';
import { seedDefaultCategories } from '../src/db/seed.ts';
import { listTransactions, monthSummary } from '../src/ledger/queries.ts';
import { migratedDatabase } from './helpers.ts';

const COUNT = 20_000;
const MONTHS = 30;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

function time<T>(fn: () => T): { result: T; ms: number } {
  // Warm once, then take the best of five to reduce noise.
  fn();
  let best = Infinity;
  let result!: T;
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    result = fn();
    best = Math.min(best, performance.now() - start);
  }
  return { result, ms: Math.round(best * 100) / 100 };
}

describe('performance with 20,000 transactions', () => {
  it('lists and summarizes a month quickly using indexes', () => {
    const { db, sqlite } = migratedDatabase();
    seedDefaultCategories(db);
    const userA = db
      .insert(schema.users)
      .values({ loginName: 'perf-a', displayName: 'A', role: 'admin' })
      .returning()
      .get();
    const userB = db
      .insert(schema.users)
      .values({ loginName: 'perf-b', displayName: 'B' })
      .returning()
      .get();
    const account = db
      .insert(schema.accounts)
      .values({ ownerUserId: userA.id, kind: 'card', name: '카드' })
      .returning()
      .get();
    const expenseCats = db
      .select()
      .from(schema.categories)
      .all()
      .filter((c) => c.kind === 'expense')
      .map((c) => c.id);

    const random = rng(42);
    const insert = sqlite.prepare(
      `insert into transactions (occurred_at, occurred_date, type, amount, merchant, category_id, account_id, owner_user_id, status, source, is_private)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    );
    const firstMonth = '2024-06';
    sqlite.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        const month = addMonths(firstMonth, Math.floor(random() * MONTHS));
        const [y, m] = month.split('-').map(Number) as [number, number];
        const at = zonedTimeToUtc({
          year: y,
          month: m,
          day: 1 + Math.floor(random() * 28),
          hour: Math.floor(random() * 24),
          minute: Math.floor(random() * 60),
        });
        const r = random();
        const type = r < 0.88 ? 'expense' : r < 0.95 ? 'income' : 'transfer';
        insert.run(
          at,
          toLocalDate(at),
          type,
          1000 + Math.floor(random() * 200_000),
          `가맹점${Math.floor(random() * 300)}`,
          type === 'expense' && random() > 0.05
            ? expenseCats[Math.floor(random() * expenseCats.length)]
            : null,
          account.id,
          random() < 0.5 ? userA.id : userB.id,
          random() < 0.03 ? 'cancelled' : 'confirmed',
          random() < 0.02 ? 1 : 0,
        );
      }
    })();
    sqlite.exec('analyze');

    // Capture the SQL drizzle issues so the plans can be checked.
    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = drizzle({
      client: sqlite,
      schema,
      logger: { logQuery: (q, params) => queries.push({ sql: q, params }) },
    }) as unknown as AppDatabase;

    const month = '2025-11';
    const list = time(() => listTransactions(logged, userA.id, { month }, { limit: 50 }));
    const next = time(() =>
      listTransactions(logged, userA.id, { month }, { cursor: list.result.nextCursor!, limit: 50 }),
    );
    const filtered = time(() =>
      listTransactions(
        logged,
        userA.id,
        { month, category: expenseCats[0], q: '가맹점1' },
        { limit: 50 },
      ),
    );
    const summary = time(() => monthSummary(logged, userA.id, month, null));
    const memberSummary = time(() => monthSummary(logged, userA.id, month, userB.id));

    const timings = {
      'list first page (50 + day totals)': list.ms,
      'list next page': next.ms,
      'list with category + text filter': filtered.ms,
      'month summary (family)': summary.ms,
      'month summary (one member)': memberSummary.ms,
    };
    console.log(`transactions in month ${month}: ${list.result.totals?.count}`);
    console.table(timings);

    expect(list.result.items).toHaveLength(50);
    expect(summary.result.transactionCount).toBeGreaterThan(500);
    for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(150);

    // No query may scan the whole transactions table.
    const plans = new Set<string>();
    for (const q of queries.filter((q) => q.sql.includes('"transactions"'))) {
      const plan = sqlite
        .prepare(`explain query plan ${q.sql}`)
        .all(...(q.params as unknown[]))
        .map((r) => (r as { detail: string }).detail);
      for (const step of plan) {
        if (/\btransactions\b/.test(step)) plans.add(step);
        expect(step, q.sql).not.toMatch(/^SCAN transactions(?! USING)/);
      }
    }
    console.log([...plans].join('\n'));
  });
});
