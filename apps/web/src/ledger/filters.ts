import type { LocationQuery } from 'vue-router';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  currentYearMonth,
  isYearMonth,
  type TransactionStatus,
  type TransactionType,
  type YearMonth,
} from '@budget/shared';

/** List filters, mirrored in the URL query so links (e.g. 미분류 on 홈) open a filtered list. */
export interface ListFilters {
  month: YearMonth;
  type?: TransactionType;
  category?: number | 'none';
  accountId?: number;
  ownerId?: number;
  status?: TransactionStatus;
  minAmount?: number;
  maxAmount?: number;
  q?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const int = (v: unknown) => {
  const n = Number(str(v));
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

export function filtersFromQuery(q: LocationQuery): ListFilters {
  const month = str(q.month);
  const type = str(q.type) as TransactionType | undefined;
  const status = str(q.status) as TransactionStatus | undefined;
  const category = str(q.category);
  return {
    month: month && isYearMonth(month) ? month : currentYearMonth(),
    type: type && TRANSACTION_TYPES.includes(type) ? type : undefined,
    status: status && TRANSACTION_STATUSES.includes(status) ? status : undefined,
    category: category === 'none' ? 'none' : int(category) || undefined,
    accountId: int(q.accountId) || undefined,
    ownerId: int(q.ownerId) || undefined,
    minAmount: int(q.minAmount),
    maxAmount: int(q.maxAmount),
    q: str(q.q),
  };
}

export function filtersToQuery(f: ListFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(f)) {
    if (value !== undefined && value !== '') out[key] = String(value);
  }
  return out;
}

/** Number of active filters besides month and search text. */
export function activeFilterCount(f: ListFilters): number {
  return (
    ['type', 'category', 'accountId', 'ownerId', 'status', 'minAmount', 'maxAmount'] as const
  ).filter((k) => f[k] !== undefined).length;
}
