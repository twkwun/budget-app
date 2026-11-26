/**
 * Fill a development database with clearly invented demo data:
 * two members, a few accounts, two years of transactions, budgets and 고정지출.
 *
 *   pnpm seed:demo            refuses if the database already has users
 *   pnpm seed:demo --force    DELETES all users, accounts and transactions first
 *
 * Every name, merchant and amount here is made up.
 */
import { eq } from 'drizzle-orm';
import {
  addDays,
  addMonths,
  currentYearMonth,
  normalizeMerchant,
  parseLocalDate,
  toLocalDate,
  zonedTimeToUtc,
} from '@budget/shared';
import { PasswordHasher } from '../auth/password.ts';
import { generateRecoveryCode, hashRecoveryCode } from '../auth/tokens.ts';
import { countUsers } from '../auth/users.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { openDatabase, type AppDatabase } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import * as s from '../db/schema.ts';
import { seedDefaultCategories } from '../db/seed.ts';
import { seedKeywordRules } from '../ledger/categorize.ts';

export const DEMO_PASSWORD = 'demo-pass-1234';

interface Pattern {
  category: string;
  merchants: string[];
  min: number;
  max: number;
  /** Expected occurrences per day. */
  perDay: number;
}

const DAILY: Pattern[] = [
  {
    category: 'expense.food.dining',
    merchants: ['달빛분식', '소담한식당', '골목국수', '바삭치킨'],
    min: 7000,
    max: 38000,
    perDay: 0.6,
  },
  {
    category: 'expense.food.groceries',
    merchants: ['행복마트', '싱싱청과', '동네정육점'],
    min: 8000,
    max: 95000,
    perDay: 0.35,
  },
  {
    category: 'expense.food.delivery',
    merchants: ['한끼배달'],
    min: 15000,
    max: 42000,
    perDay: 0.2,
  },
  {
    category: 'expense.food.cafe',
    merchants: ['구름카페', '몽글베이커리'],
    min: 3500,
    max: 14000,
    perDay: 0.5,
  },
  {
    category: 'expense.living.convenience',
    merchants: ['편의점 별빛점'],
    min: 1500,
    max: 12000,
    perDay: 0.3,
  },
  {
    category: 'expense.living.household',
    merchants: ['생활잡화 한빛'],
    min: 5000,
    max: 40000,
    perDay: 0.08,
  },
  {
    category: 'expense.transport.public',
    merchants: ['교통카드 충전'],
    min: 10000,
    max: 30000,
    perDay: 0.1,
  },
  {
    category: 'expense.transport.fuel',
    merchants: ['바다주유소'],
    min: 40000,
    max: 80000,
    perDay: 0.07,
  },
  {
    category: 'expense.transport.taxi',
    merchants: ['하늘택시'],
    min: 5800,
    max: 24000,
    perDay: 0.08,
  },
  {
    category: 'expense.shopping.online',
    merchants: ['초록온라인몰'],
    min: 9000,
    max: 120000,
    perDay: 0.12,
  },
  {
    category: 'expense.shopping.clothing',
    merchants: ['모노의류'],
    min: 19000,
    max: 89000,
    perDay: 0.04,
  },
  {
    category: 'expense.health.pharmacy',
    merchants: ['초록약국'],
    min: 3000,
    max: 18000,
    perDay: 0.05,
  },
  {
    category: 'expense.health.hospital',
    merchants: ['튼튼의원'],
    min: 5000,
    max: 45000,
    perDay: 0.03,
  },
  {
    category: 'expense.education.books',
    merchants: ['별빛서점'],
    min: 12000,
    max: 35000,
    perDay: 0.04,
  },
  {
    category: 'expense.leisure.hobby',
    merchants: ['솔방울 공방'],
    min: 15000,
    max: 60000,
    perDay: 0.03,
  },
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

export class SeedRefused extends Error {}

/** Refuse when users exist unless forced; with force, wipe first. Returns whether data was wiped. */
export function prepareForDemo(db: AppDatabase, force: boolean): boolean {
  if (countUsers(db) === 0) return false;
  if (!force) {
    throw new SeedRefused(
      'Refusing to seed: the database already has users.\n' +
        'Run with --force to DELETE all users, accounts and transactions and replace them with demo data.',
    );
  }
  wipe(db);
  return true;
}

function wipe(db: AppDatabase): void {
  db.transaction((tx) => {
    for (const table of [
      s.rawRecords,
      s.transactions,
      s.budgets,
      s.recurringExpenses,
      s.categoryRules,
      s.importBatches,
      s.invites,
      s.webhookTokens,
      s.passkeys,
      s.sessions,
      s.accounts,
      s.users,
    ]) {
      tx.delete(table).run();
    }
  });
}

export async function seedDemo(db: AppDatabase, now = Date.now(), hasher = new PasswordHasher()) {
  seedDefaultCategories(db);
  seedKeywordRules(db);
  const catId = new Map(
    db
      .select({ id: s.categories.id, key: s.categories.systemKey })
      .from(s.categories)
      .all()
      .flatMap((c) => (c.key ? [[c.key, c.id] as const] : [])),
  );
  const cat = (key: string) => {
    const id = catId.get(key);
    if (!id) throw new Error(`missing category ${key}`);
    return id;
  };
  const passwordHash = await hasher.hash(DEMO_PASSWORD);
  const user = (loginName: string, displayName: string, role: 'admin' | 'member') =>
    db
      .insert(s.users)
      .values({
        loginName,
        displayName,
        role,
        passwordHash,
        recoveryCodeHash: hashRecoveryCode(generateRecoveryCode()),
        lockTimeoutSeconds: null,
      })
      .returning()
      .get();
  const sujin = user('demo-sujin', '수진', 'admin');
  const junho = user('demo-junho', '준호', 'member');

  const account = (values: Omit<typeof s.accounts.$inferInsert, 'sortOrder'>, sortOrder: number) =>
    db
      .insert(s.accounts)
      .values({ ...values, sortOrder })
      .returning()
      .get();
  const sujinCard = account(
    {
      ownerUserId: sujin.id,
      kind: 'card',
      name: '신한카드',
      issuer: 'shinhan',
      last4: '0001',
      billingDay: 14,
      cutoffDay: 31,
    },
    0,
  );
  const familyCard = account(
    {
      ownerUserId: sujin.id,
      primaryUserId: junho.id,
      kind: 'card',
      name: '삼성 가족카드',
      issuer: 'samsung',
      last4: '0003',
      billingDay: 25,
      cutoffDay: 11,
    },
    1,
  );
  const junhoCard = account(
    { ownerUserId: junho.id, kind: 'card', name: 'KB국민 체크카드', issuer: 'kb', last4: '0002' },
    2,
  );
  const bank = account(
    { ownerUserId: sujin.id, kind: 'bank', name: '생활비 통장', issuer: 'woori', last4: '0004' },
    3,
  );
  const cash = account({ ownerUserId: junho.id, kind: 'cash', name: '현금' }, 4);

  const random = rng(20261122);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const round100 = (n: number) => Math.round(n / 100) * 100;
  const rows: (typeof s.transactions.$inferInsert)[] = [];
  const add = (
    date: string,
    hour: number,
    values: Omit<typeof s.transactions.$inferInsert, 'occurredAt' | 'occurredDate' | 'source'>,
  ) => {
    const at = new Date(
      zonedTimeToUtc({ ...parseLocalDate(date), hour, minute: Math.floor(random() * 60) }),
    );
    if (at.getTime() > now) return;
    rows.push({
      ...values,
      merchantKey: values.merchant ? normalizeMerchant(values.merchant) : null,
      occurredAt: at,
      occurredDate: toLocalDate(at),
      source: 'manual',
      createdByUserId: values.ownerUserId,
      createdAt: at,
      updatedAt: at,
    });
  };

  const thisMonth = currentYearMonth(now);
  const today = toLocalDate(now);
  // Two years so 통계 can compare a year with the one before.
  for (let offset = -23; offset <= 0; offset += 1) {
    const month = addMonths(thisMonth, offset);
    // Seasonal swing so the charts are not flat: more in Dec/Jan and summer.
    const monthNo = Number(month.slice(5));
    const season =
      [1.25, 1.1, 0.95, 0.9, 1.0, 0.95, 1.1, 1.15, 1.0, 0.95, 0.9, 1.2][monthNo - 1] ?? 1;
    // Fixed monthly items.
    add(`${month}-25`, 9, {
      type: 'income',
      amount: 3_850_000,
      merchant: '급여',
      categoryId: cat('income.salary.wage'),
      accountId: bank.id,
      ownerUserId: sujin.id,
      status: 'confirmed',
    });
    add(`${month}-25`, 9, {
      type: 'income',
      amount: 3_420_000,
      merchant: '급여',
      categoryId: cat('income.salary.wage'),
      accountId: bank.id,
      ownerUserId: junho.id,
      status: 'confirmed',
    });
    add(`${month}-05`, 10, {
      type: 'expense',
      amount: 268_400,
      merchant: '아파트 관리비',
      categoryId: cat('expense.housing.maintenance'),
      accountId: bank.id,
      ownerUserId: sujin.id,
      status: 'confirmed',
    });
    add(`${month}-10`, 8, {
      type: 'expense',
      amount: 89_000,
      merchant: '통신요금',
      categoryId: cat('expense.housing.telecom'),
      accountId: sujinCard.id,
      ownerUserId: sujin.id,
      status: 'confirmed',
    });
    add(`${month}-12`, 7, {
      type: 'expense',
      amount: 13_900,
      merchant: '영상 구독',
      categoryId: cat('expense.leisure.subscription'),
      accountId: familyCard.id,
      ownerUserId: junho.id,
      status: 'confirmed',
    });
    add(`${month}-14`, 6, {
      type: 'transfer',
      amount: 1_240_000,
      merchant: '카드대금',
      accountId: bank.id,
      ownerUserId: sujin.id,
      status: 'confirmed',
    });
    add(`${month}-20`, 11, {
      type: 'income',
      amount: 12_430,
      merchant: '예금 이자',
      categoryId: cat('income.financial.interest'),
      accountId: bank.id,
      ownerUserId: sujin.id,
      status: 'confirmed',
    });

    for (
      let date = `${month}-01`;
      date.startsWith(month) && date <= today;
      date = addDays(date, 1)
    ) {
      for (const p of DAILY) {
        let n = p.perDay;
        while (n > 0) {
          if (random() < Math.min(n, 1)) {
            const owner = random() < 0.55 ? sujin : junho;
            const accountId =
              owner === sujin
                ? pick([sujinCard.id, familyCard.id])
                : pick([junhoCard.id, junhoCard.id, cash.id]);
            add(date, 8 + Math.floor(random() * 14), {
              type: 'expense',
              amount: round100((p.min + random() * (p.max - p.min)) * season),
              merchant: pick(p.merchants),
              categoryId: cat(p.category),
              accountId,
              ownerUserId: owner.id,
              status: 'confirmed',
            });
          }
          n -= 1;
        }
      }
    }
    // A few entries that need attention.
    add(`${month}-08`, 19, {
      type: 'expense',
      amount: 23_500,
      merchant: '간편결제',
      accountId: junhoCard.id,
      ownerUserId: junho.id,
      status: 'confirmed',
    });
    add(`${month}-17`, 13, {
      type: 'expense',
      amount: 41_000,
      merchant: '간편결제',
      accountId: sujinCard.id,
      ownerUserId: sujin.id,
      status: 'needs_review',
    });
    add(`${month}-21`, 15, {
      type: 'expense',
      amount: 59_000,
      merchant: '모노의류',
      categoryId: cat('expense.shopping.clothing'),
      accountId: sujinCard.id,
      ownerUserId: sujin.id,
      status: 'cancelled',
      memo: '반품',
    });
  }
  add(addDays(today, -3), 20, {
    type: 'expense',
    amount: 75_000,
    merchant: '깜짝 선물',
    categoryId: cat('expense.events.gifts'),
    accountId: junhoCard.id,
    ownerUserId: junho.id,
    status: 'confirmed',
    isPrivate: true,
  });

  // Budgets (each member keeps their own): a year of history for 월별 비교.
  // 수진's overall budget was set a year ago, raised three months ago and
  // lowered this month, with a 식비 budget; 준호 budgets 쇼핑 and 생활.
  db.insert(s.budgets)
    .values([
      {
        month: addMonths(thisMonth, -11),
        categoryId: null,
        amount: 2_700_000,
        userId: sujin.id,
        updatedByUserId: sujin.id,
      },
      {
        month: addMonths(thisMonth, -11),
        categoryId: cat('expense.food'),
        amount: 950_000,
        userId: sujin.id,
        updatedByUserId: sujin.id,
      },
      {
        month: addMonths(thisMonth, -3),
        categoryId: null,
        amount: 3_000_000,
        userId: sujin.id,
        updatedByUserId: sujin.id,
      },
      {
        userId: sujin.id,
        month: thisMonth,
        categoryId: null,
        amount: 2_800_000,
        updatedByUserId: sujin.id,
      },
      {
        month: addMonths(thisMonth, -3),
        categoryId: cat('expense.food'),
        amount: 1_100_000,
        userId: sujin.id,
        updatedByUserId: sujin.id,
      },
      {
        month: addMonths(thisMonth, -1),
        categoryId: cat('expense.shopping'),
        amount: 150_000,
        userId: junho.id,
        updatedByUserId: junho.id,
      },
      {
        month: addMonths(thisMonth, -1),
        categoryId: cat('expense.living'),
        amount: 250_000,
        userId: junho.id,
        updatedByUserId: junho.id,
      },
    ])
    .run();
  // 수진's 고정지출: two confirmed from the monthly items above, two added by hand.
  db.insert(s.recurringExpenses)
    .values([
      {
        userId: sujin.id,
        name: '아파트 관리비',
        matchKey: normalizeMerchant('아파트 관리비'),
        amount: 268_400,
        dayOfMonth: 5,
        categoryId: cat('expense.housing.maintenance'),
        accountId: bank.id,
        status: 'confirmed',
        source: 'detected',
      },
      {
        userId: sujin.id,
        name: '통신요금',
        matchKey: normalizeMerchant('통신요금'),
        amount: 89_000,
        dayOfMonth: 10,
        categoryId: cat('expense.housing.telecom'),
        accountId: sujinCard.id,
        status: 'confirmed',
        source: 'detected',
      },
      {
        userId: sujin.id,
        name: '정수기 렌탈',
        matchKey: normalizeMerchant('정수기 렌탈'),
        amount: 29_900,
        dayOfMonth: 15,
        categoryId: cat('expense.living.household'),
        accountId: sujinCard.id,
        status: 'confirmed',
        source: 'manual',
        createdByUserId: sujin.id,
      },
      {
        userId: sujin.id,
        name: '실손 보험료',
        matchKey: normalizeMerchant('보험료'),
        amount: 132_000,
        dayOfMonth: 27,
        categoryId: null,
        accountId: bank.id,
        status: 'confirmed',
        source: 'manual',
        createdByUserId: sujin.id,
      },
    ])
    .run();

  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 200)
      tx.insert(s.transactions)
        .values(rows.slice(i, i + 200))
        .run();
  });
  return { users: [sujin, junho], accounts: 5, transactions: rows.length };
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const config = loadConfig();
  const { db, sqlite } = openDatabase(config.dbFile);
  try {
    runMigrations(db);
    try {
      if (prepareForDemo(db, force)) {
        console.warn('--force: deleted existing users, accounts and transactions');
      }
    } catch (error) {
      if (error instanceof SeedRefused) {
        console.error(`${config.dbFile}: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    const result = await seedDemo(db);
    const remaining = db.select().from(s.users).where(eq(s.users.loginName, 'demo-sujin')).get();
    console.log(
      JSON.stringify({
        dbFile: config.dbFile,
        transactions: result.transactions,
        accounts: result.accounts,
        logins: [
          { loginName: 'demo-sujin', role: 'admin' },
          { loginName: 'demo-junho', role: 'member' },
        ],
        password: DEMO_PASSWORD,
        ok: !!remaining,
      }),
    );
  } finally {
    sqlite.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
}
