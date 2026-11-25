/**
 * Enumerations shared by the database schema, the API and the UI.
 * Stored as text in SQLite; keep values stable once data exists.
 */

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** `pay` is a simple-payment wallet (카카오페이, 네이버페이 …). */
export const ACCOUNT_KINDS = ['card', 'bank', 'pay', 'cash', 'other'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Transfers (card bill payments, moves between own accounts) are excluded from spending totals. */
export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['pending', 'confirmed', 'needs_review', 'cancelled'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTION_SOURCES = ['sms', 'file', 'manual'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const RAW_RECORD_SOURCES = ['sms', 'file'] as const;
export type RawRecordSource = (typeof RAW_RECORD_SOURCES)[number];

export const RAW_RECORD_STATUSES = ['received', 'parsed', 'linked', 'failed', 'ignored'] as const;
export type RawRecordStatus = (typeof RAW_RECORD_STATUSES)[number];

/** Open 인박스 items attached to a raw record. */
export const RAW_RECORD_ISSUES = [
  'unparsed',
  'unmatched_card',
  'unmatched_cancel',
  'ambiguous_duplicate',
] as const;
export type RawRecordIssue = (typeof RAW_RECORD_ISSUES)[number];

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const RULE_MATCH_TYPES = ['contains', 'exact', 'prefix'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export const IMPORT_BATCH_STATUSES = [
  'needs_mapping',
  'previewed',
  'applying',
  'applied',
  'undone',
  'discarded',
  'failed',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const RECURRING_STATUSES = ['suggested', 'confirmed', 'dismissed'] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];
