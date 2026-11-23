/** Ledger DTOs and labels shared by the server and the web app (stage 3). */
import type {
  AccountKind,
  CategoryKind,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from './domain.ts';
import type { LocalDate, YearMonth } from './date.ts';

/** Largest single amount accepted (1천억 원); guards against typos and overflow. */
export const MAX_AMOUNT = 100_000_000_000;
export const MERCHANT_MAX_LENGTH = 100;
export const MEMO_MAX_LENGTH = 500;
export const ACCOUNT_NAME_MAX_LENGTH = 40;
export const CATEGORY_NAME_MAX_LENGTH = 30;

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  expense: '지출',
  income: '수입',
  transfer: '이체',
};

/** Statuses a person can set by hand. `pending` is reserved for automatic import. */
export const EDITABLE_STATUSES = ['confirmed', 'cancelled', 'needs_review'] as const;
export type EditableStatus = (typeof EDITABLE_STATUSES)[number];

export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  confirmed: '정상',
  pending: '자동 등록',
  cancelled: '취소',
  needs_review: '확인 필요',
};

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  card: '카드',
  bank: '계좌',
  cash: '현금',
  other: '기타',
};

/** Common issuers; stored by code. Unknown issuers use `other`. */
export const ISSUERS = [
  { code: 'shinhan', name: '신한' },
  { code: 'kb', name: 'KB국민' },
  { code: 'samsung', name: '삼성' },
  { code: 'hyundai', name: '현대' },
  { code: 'lotte', name: '롯데' },
  { code: 'hana', name: '하나' },
  { code: 'woori', name: '우리' },
  { code: 'nh', name: 'NH농협' },
  { code: 'ibk', name: 'IBK기업' },
  { code: 'bc', name: 'BC' },
  { code: 'kakaobank', name: '카카오뱅크' },
  { code: 'toss', name: '토스뱅크' },
  { code: 'other', name: '기타' },
] as const;
export type IssuerCode = (typeof ISSUERS)[number]['code'];

export function issuerName(code: string | null): string | null {
  if (!code) return null;
  return ISSUERS.find((i) => i.code === code)?.name ?? code;
}

export interface AccountInfo {
  id: number;
  kind: AccountKind;
  name: string;
  issuer: string | null;
  last4: string | null;
  billingDay: number | null;
  sortOrder: number;
  archived: boolean;
  ownerUserId: number;
  ownerName: string;
  primaryUserId: number | null;
  primaryUserName: string | null;
  /** Whether the requesting user may edit or archive it (owner or admin). */
  canEdit: boolean;
}

export interface CategoryNode {
  id: number;
  kind: CategoryKind;
  name: string;
  parentId: number | null;
  sortOrder: number;
  archived: boolean;
  /** Seeded default (kept by its system key; may still be renamed or archived). */
  isDefault: boolean;
  children: CategoryNode[];
}

export interface CategoryTree {
  expense: CategoryNode[];
  income: CategoryNode[];
}

export interface TransactionInfo {
  id: number;
  occurredAt: string;
  occurredDate: LocalDate;
  type: TransactionType;
  amount: number;
  originalAmount: number | null;
  merchant: string | null;
  memo: string | null;
  categoryId: number | null;
  /** "상위 > 하위" or the single name; null when uncategorized. */
  categoryName: string | null;
  topCategoryId: number | null;
  accountId: number | null;
  accountName: string | null;
  ownerUserId: number;
  ownerName: string;
  status: TransactionStatus;
  source: TransactionSource;
  installmentMonths: number | null;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DayTotal {
  date: LocalDate;
  expense: number;
  income: number;
  count: number;
}

export interface TransactionPage {
  items: TransactionInfo[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /** Per-day totals for the whole filtered month (first page only). */
  days?: DayTotal[];
  /** Totals for the whole filtered month (first page only). */
  totals?: { expense: number; income: number; count: number };
}

export interface CategoryShare {
  categoryId: number | null;
  name: string;
  amount: number;
  count: number;
}

export interface MonthSummary {
  month: YearMonth;
  /** `all` for the family, or a member id. */
  owner: 'all' | number;
  expense: number;
  income: number;
  previous: { month: YearMonth; expense: number; income: number };
  /** Spending by top-level category, largest first; null id = 미분류. */
  expenseByCategory: CategoryShare[];
  incomeByCategory: CategoryShare[];
  /** Every day of the month, zero-filled. */
  daily: DayTotal[];
  uncategorizedCount: number;
  needsReviewCount: number;
  transactionCount: number;
}

export interface EntryDefaults {
  accountId: number | null;
  hasOwnAccount: boolean;
  recentCategoryIds: { expense: number[]; income: number[] };
}
