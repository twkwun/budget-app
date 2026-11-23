import type { IconName } from './icons.ts';

export interface NavItem {
  /** Route name. */
  name: string;
  path: string;
  label: string;
  icon: IconName;
}

/** Every top-level screen (DESIGN.md 7), in sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { name: 'home', path: '/', label: '홈', icon: 'home' },
  { name: 'transactions', path: '/transactions', label: '내역', icon: 'list' },
  { name: 'inbox', path: '/inbox', label: '인박스', icon: 'inbox' },
  { name: 'add', path: '/add', label: '추가', icon: 'plus' },
  { name: 'import', path: '/import', label: '가져오기', icon: 'upload' },
  { name: 'stats', path: '/stats', label: '통계', icon: 'chart' },
  { name: 'budgets', path: '/budgets', label: '예산', icon: 'target' },
  { name: 'settings', path: '/settings', label: '설정', icon: 'gear' },
];

/** Phone tab bar: five slots; the rest live under 더보기. */
export const TAB_ITEMS: readonly NavItem[] = [
  { name: 'home', path: '/', label: '홈', icon: 'home' },
  { name: 'transactions', path: '/transactions', label: '내역', icon: 'list' },
  { name: 'add', path: '/add', label: '추가', icon: 'plus' },
  { name: 'inbox', path: '/inbox', label: '인박스', icon: 'inbox' },
  { name: 'more', path: '/more', label: '더보기', icon: 'more' },
];

const TAB_NAMES = new Set(TAB_ITEMS.map((item) => item.name));

/** Screens reached from the 더보기 tab on phones. */
export const MORE_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) => !TAB_NAMES.has(item.name));

/** Which tab should look active for the given route name. */
export function activeTabFor(routeName: string | null | undefined): string {
  if (!routeName) return '';
  if (routeName.startsWith('settings-')) return 'more';
  if (TAB_NAMES.has(routeName)) return routeName;
  return MORE_ITEMS.some((item) => item.name === routeName) ? 'more' : '';
}
