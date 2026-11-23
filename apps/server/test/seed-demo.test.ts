import { describe, expect, it } from 'vitest';
import { toLocalDate } from '@budget/shared';
import { TEST_SCRYPT_PARAMS, PasswordHasher } from '../src/auth/password.ts';
import { prepareForDemo, seedDemo, SeedRefused } from '../src/cli/seed-demo.ts';
import { transactions, users } from '../src/db/schema.ts';
import { migratedDatabase } from './helpers.ts';

describe('seed:demo', () => {
  it('creates two members, accounts and three months of invented transactions', async () => {
    const { db } = migratedDatabase();
    const now = Date.parse('2026-11-22T03:00:00Z');
    expect(prepareForDemo(db, false)).toBe(false);
    const result = await seedDemo(db, now, new PasswordHasher(TEST_SCRYPT_PARAMS));
    expect(result.users.map((u) => u.loginName)).toEqual(['demo-sujin', 'demo-junho']);
    const rows = db.select().from(transactions).all();
    expect(rows.length).toBeGreaterThan(150);
    expect(rows.every((r) => r.occurredAt.getTime() <= now)).toBe(true);
    expect(rows.every((r) => r.occurredDate === toLocalDate(r.occurredAt))).toBe(true);
    expect(new Set(rows.map((r) => r.occurredDate.slice(0, 7)))).toEqual(
      new Set(['2026-09', '2026-10', '2026-11']),
    );
    for (const status of ['cancelled', 'needs_review'] as const) {
      expect(rows.some((r) => r.status === status)).toBe(true);
    }
    expect(rows.some((r) => r.type === 'transfer')).toBe(true);
    expect(rows.some((r) => r.isPrivate)).toBe(true);
    expect(rows.some((r) => r.categoryId === null && r.type === 'expense')).toBe(true);
  });

  it('refuses a database with users unless forced, and then replaces everything', async () => {
    const { db } = migratedDatabase();
    const hasher = new PasswordHasher(TEST_SCRYPT_PARAMS);
    await seedDemo(db, Date.now(), hasher);
    expect(() => prepareForDemo(db, false)).toThrow(SeedRefused);
    expect(prepareForDemo(db, true)).toBe(true);
    expect(db.select().from(users).all()).toEqual([]);
    expect(db.select().from(transactions).all()).toEqual([]);
    await seedDemo(db, Date.now(), hasher);
    expect(db.select().from(users).all()).toHaveLength(2);
  });
});
