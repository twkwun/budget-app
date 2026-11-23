/**
 * Database schema (DESIGN.md 6.1).
 *
 * Conventions:
 * - Money is an integer number of KRW. Amounts are stored non-negative; the
 *   transaction `type` decides whether it is spending, income or a transfer.
 * - Instants are UTC epoch milliseconds (`timestamp_ms`). Calendar fields that
 *   must follow the household zone (Asia/Seoul) are stored as text computed by
 *   the helpers in @budget/shared, e.g. `transactions.occurred_date`.
 * - CHECK constraints use unqualified column names on purpose: drizzle-kit
 *   rebuilds SQLite tables under a temporary name, which breaks qualified ones.
 * - Enumerations are plain text validated in application code (see
 *   @budget/shared domain.ts), so adding a value needs no table rebuild.
 * - Secrets (session tokens, webhook tokens, passwords, recovery codes) are
 *   only ever stored as hashes.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import type {
  AccountKind,
  CategoryKind,
  ImportBatchStatus,
  RawRecordIssue,
  RecurringStatus,
  RawRecordSource,
  RawRecordStatus,
  RuleMatchType,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@budget/shared';

/** Current time in epoch ms, evaluated by SQLite so raw SQL inserts get it too. */
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const createdAt = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(nowMs);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(nowMs)
    .$onUpdateFn(() => new Date());
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Identifier for password login (fallback to passkeys); stored lowercase. */
  loginName: text('login_name').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<UserRole>().notNull().default('member'),
  /** Opaque WebAuthn user handle (base64url); never the numeric id. */
  webauthnUserId: text('webauthn_user_id')
    .notNull()
    .unique()
    .$defaultFn(() => randomBytes(32).toString('base64url')),
  passwordHash: text('password_hash'),
  recoveryCodeHash: text('recovery_code_hash'),
  /** App lock after inactivity: null = off, 0 = immediately, otherwise seconds. */
  lockTimeoutSeconds: integer('lock_timeout_seconds').default(300),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  disabledAt: timestamp('disabled_at'),
});

export const passkeys = sqliteTable(
  'passkeys',
  {
    /** WebAuthn credential id, base64url. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>(),
    deviceType: text('device_type'),
    backedUp: bool('backed_up').notNull().default(false),
    deviceName: text('device_name'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the session token; the token itself is only in the cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull().default(nowMs),
    /**
     * Last successful credential check in this session (sign-in, unlock or
     * step-up with a passkey or the password). Drives step-up re-auth.
     */
    lastVerifiedAt: timestamp('last_verified_at'),
    /** Set when the session was locked explicitly (app hidden, or "lock now"). */
    lockedAt: timestamp('locked_at'),
    userAgent: text('user_agent'),
    /** Client IP at the last request (as seen through TRUST_PROXY). */
    lastIp: text('last_ip'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const invites = sqliteTable(
  'invites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** SHA-256 of the invite token; the token only exists in the shared link. */
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role').$type<UserRole>().notNull().default('member'),
    createdByUserId: integer('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    usedByUserId: integer('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('invites_created_by_idx').on(t.createdByUserId)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Account holder (명의자). */
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Actual user for family cards, when different from the holder. */
    primaryUserId: integer('primary_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').$type<AccountKind>().notNull(),
    name: text('name').notNull(),
    /** Card issuer or bank code, e.g. `shinhan`, `kb`, `samsung`. */
    issuer: text('issuer'),
    /** Only the last four digits of a card or account number are ever stored. */
    last4: text('last4'),
    /** Card payment day of month (결제일). */
    billingDay: integer('billing_day'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('accounts_owner_idx').on(t.ownerUserId),
    index('accounts_issuer_last4_idx').on(t.issuer, t.last4),
    check('accounts_last4_check', sql`last4 is null or last4 glob '[0-9][0-9][0-9][0-9]'`),
    check('accounts_billing_day_check', sql`billing_day is null or billing_day between 1 and 31`),
  ],
);

export const webhookTokens = sqliteTable(
  'webhook_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceName: text('device_name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Last few characters of the token, to tell tokens apart in the UI. */
    tokenHint: text('token_hint'),
    createdAt: createdAt(),
    lastReceivedAt: timestamp('last_received_at'),
    /** Messages accepted as card notifications (stored). */
    receivedCount: integer('received_count').notNull().default(0),
    /** Messages discarded unstored because they were not card notifications. */
    ignoredCount: integer('ignored_count').notNull().default(0),
    lastIgnoredAt: timestamp('last_ignored_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('webhook_tokens_user_idx').on(t.userId)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Null for top-level categories; two levels only. */
    parentId: integer('parent_id').references((): AnySQLiteColumn => categories.id, {
      onDelete: 'restrict',
    }),
    kind: text('kind').$type<CategoryKind>().notNull(),
    name: text('name').notNull(),
    /** Stable key for seeded defaults; null for user-created categories. */
    systemKey: text('system_key').unique(),
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Categories are archived rather than deleted so history keeps its labels. */
    archivedAt: timestamp('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('categories_parent_idx').on(t.parentId)],
);

export const categoryRules = sqliteTable(
  'category_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pattern: text('pattern').notNull(),
    matchType: text('match_type').$type<RuleMatchType>().notNull().default('contains'),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** Higher wins. User rules are evaluated before built-in keyword rules. */
    priority: integer('priority').notNull().default(0),
    isSystem: bool('is_system').notNull().default(false),
    /** Stable key for built-in keyword rules (seeding stays idempotent). */
    systemKey: text('system_key').unique(),
    /** Built-in rules can be switched off instead of deleted. */
    disabledAt: timestamp('disabled_at'),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('category_rules_priority_idx').on(t.priority),
    index('category_rules_category_idx').on(t.categoryId),
  ],
);

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Parser/format id, e.g. `banksalad`, `shinhan-xlsx`. */
    format: text('format').notNull(),
    fileName: text('file_name'),
    fileSha256: text('file_sha256'),
    status: text('status').$type<ImportBatchStatus>().notNull().default('previewed'),
    newCount: integer('new_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    reviewCount: integer('review_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    /** Rows already imported by an earlier batch (skipped). */
    skippedCount: integer('skipped_count').notNull().default(0),
    rowCount: integer('row_count').notNull().default(0),
    /** Container read: xlsx, xls, csv or html. */
    container: text('container'),
    sheetName: text('sheet_name'),
    /** Header cells of the detected header row and their signature (for remembered mappings). */
    header: text('header', { mode: 'json' }).$type<string[]>(),
    headerSignature: text('header_signature'),
    columnMap: text('column_map', { mode: 'json' }).$type<Record<string, number>>(),
    /** Applied result: created/attached/cancelled/skipped counts. */
    result: text('result', { mode: 'json' }).$type<Record<string, number>>(),
    createdAt: createdAt(),
    appliedAt: timestamp('applied_at'),
    /** Previews not applied by this time are deleted with their rows. */
    expiresAt: timestamp('expires_at'),
    undoneAt: timestamp('undone_at'),
  },
  (t) => [
    index('import_batches_user_idx').on(t.userId),
    index('import_batches_file_idx').on(t.fileSha256),
  ],
);

/** Remembered column mapping per header signature (file layout). */
export const importProfiles = sqliteTable('import_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  headerSignature: text('header_signature').notNull().unique(),
  columnMap: text('column_map', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Remembered 결제수단 label → account (null = no account). */
export const importAccountMappings = sqliteTable('import_account_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull().unique(),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  createdByUserId: integer('created_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Remembered source category (e.g. 뱅크샐러드 대분류/소분류) → our category (null = 미분류). */
export const importCategoryMappings = sqliteTable('import_category_mappings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** `kind:대분류/소분류` */
  key: text('key').notNull().unique(),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    occurredAt: timestamp('occurred_at').notNull(),
    /** Household-zone (KST) calendar date of occurred_at, `YYYY-MM-DD`. */
    occurredDate: text('occurred_date').notNull(),
    type: text('type').$type<TransactionType>().notNull(),
    /** Integer KRW, never negative. */
    amount: integer('amount').notNull(),
    /** Amount before partial cancellations; null when never reduced. */
    originalAmount: integer('original_amount'),
    merchant: text('merchant'),
    /** normalizeMerchant(merchant), for rule matching and "same merchant" history. */
    merchantKey: text('merchant_key'),
    memo: text('memo'),
    /** Null means uncategorized (미분류). */
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /** Payment method (수단). */
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').$type<TransactionStatus>().notNull().default('confirmed'),
    /** Where the transaction was first created from; further sources link via raw_records. */
    source: text('source').$type<TransactionSource>().notNull(),
    /** Installment months; null for a lump-sum payment (일시불). */
    installmentMonths: integer('installment_months'),
    approvalNo: text('approval_no'),
    isPrivate: bool('is_private').notNull().default(false),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('transactions_occurred_at_idx').on(t.occurredAt),
    index('transactions_occurred_date_idx').on(t.occurredDate),
    index('transactions_owner_occurred_idx').on(t.ownerUserId, t.occurredAt),
    index('transactions_category_idx').on(t.categoryId),
    index('transactions_merchant_idx').on(t.merchant),
    index('transactions_merchant_key_idx').on(t.merchantKey, t.occurredAt),
    index('transactions_approval_idx').on(t.accountId, t.approvalNo),
    index('transactions_dedupe_idx').on(t.accountId, t.occurredDate, t.amount),
    check('transactions_amount_check', sql`amount >= 0`),
    check(
      'transactions_original_amount_check',
      sql`original_amount is null or original_amount >= amount`,
    ),
    check(
      'transactions_installment_check',
      sql`installment_months is null or installment_months >= 2`,
    ),
  ],
);

export const rawRecords = sqliteTable(
  'raw_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').$type<RawRecordSource>().notNull(),
    /** Who submitted it (token owner or uploader). */
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    webhookTokenId: integer('webhook_token_id').references(() => webhookTokens.id, {
      onDelete: 'set null',
    }),
    importBatchId: integer('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    receivedAt: timestamp('received_at').notNull().default(nowMs),
    /** Original SMS text, or the source spreadsheet row serialized as JSON. */
    rawText: text('raw_text').notNull(),
    /** Sender number/name as reported by the shortcut, if any. */
    sender: text('sender'),
    /** Receive time reported by the client, used for redelivery detection. */
    clientReceivedAt: timestamp('client_received_at'),
    /** SHA-256 of the normalized raw text, to detect exact re-deliveries. */
    contentHash: text('content_hash').notNull(),
    status: text('status').$type<RawRecordStatus>().notNull().default('received'),
    /** Parser id and version that produced `parsed`, so records can be reprocessed. */
    parser: text('parser'),
    parsed: text('parsed', { mode: 'json' }),
    error: text('error'),
    transactionId: integer('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    processedAt: timestamp('processed_at'),
    /**
     * Open 인박스 item for this record: `unparsed`, `unmatched_card`,
     * `unmatched_cancel` or `ambiguous_duplicate`; null when nothing is pending.
     */
    issue: text('issue').$type<RawRecordIssue>(),
    issueData: text('issue_data', { mode: 'json' }).$type<Record<string, unknown>>(),
    resolvedAt: timestamp('resolved_at'),
  },
  (t) => [
    index('raw_records_status_idx').on(t.status),
    index('raw_records_issue_idx').on(t.issue, t.resolvedAt),
    index('raw_records_token_hash_idx').on(t.webhookTokenId, t.contentHash),
    index('raw_records_source_hash_idx').on(t.source, t.contentHash),
    index('raw_records_transaction_idx').on(t.transactionId),
    index('raw_records_hash_idx').on(t.contentHash),
    index('raw_records_batch_idx').on(t.importBatchId),
  ],
);

export const budgets = sqliteTable(
  'budgets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Household-zone month, `YYYY-MM`. */
    month: text('month').notNull(),
    /** Null means the overall monthly budget. */
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    /**
     * In force from `month` until a later row for the same category. 0 means
     * "no budget" from this month on (a removal that keeps earlier months).
     */
    amount: integer('amount').notNull(),
    updatedByUserId: integer('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // SQLite treats NULLs as distinct in unique indexes, so the overall budget
    // (null category) gets its own partial index.
    uniqueIndex('budgets_month_category_unique')
      .on(t.month, t.categoryId)
      .where(sql`category_id is not null`),
    uniqueIndex('budgets_month_total_unique')
      .on(t.month)
      .where(sql`category_id is null`),
    check('budgets_amount_check', sql`amount >= 0`),
  ],
);

/** 고정지출: monthly payments the family expects (detected or added by hand). */
export const recurringExpenses = sqliteTable(
  'recurring_expenses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /** normalizeMerchant() text a payment's merchant must contain to match. */
    matchKey: text('match_key').notNull(),
    /** Expected amount (KRW); a payment within ±20% matches. */
    amount: integer('amount').notNull(),
    /** Expected day of month (1–31, clamped to the month length). */
    dayOfMonth: integer('day_of_month').notNull(),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    status: text('status').$type<RecurringStatus>().notNull().default('suggested'),
    source: text('source').$type<'detected' | 'manual'>().notNull().default('detected'),
    createdByUserId: integer('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('recurring_expenses_match_key_unique').on(t.matchKey),
    index('recurring_expenses_status_idx').on(t.status),
    check('recurring_day_check', sql`day_of_month between 1 and 31`),
    check('recurring_amount_check', sql`amount > 0`),
  ],
);
