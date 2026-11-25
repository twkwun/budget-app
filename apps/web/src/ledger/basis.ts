/**
 * 사용일 기준 / 결제월 기준, shared by 내역, 홈 and 통계. The choice travels in
 * the URL (`basis=billing`) so links keep it, and the last one picked is
 * remembered on this device for pages opened without it.
 */
import type { LocationQuery } from 'vue-router';
import type { ListBasis } from '@budget/shared';

const KEY = 'budget:basis';

export function storedBasis(): ListBasis {
  try {
    return localStorage.getItem(KEY) === 'billing' ? 'billing' : 'date';
  } catch {
    return 'date';
  }
}

export function rememberBasis(basis: ListBasis): void {
  try {
    localStorage.setItem(KEY, basis);
  } catch {
    // Private mode or storage disabled: the URL still carries the choice.
  }
}

export function basisFromQuery(query: LocationQuery): ListBasis {
  const value = query.basis;
  if (value === 'billing' || value === 'date') return value;
  return storedBasis();
}
