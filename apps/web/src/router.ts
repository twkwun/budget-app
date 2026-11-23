import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from './stores/auth.ts';

declare module 'vue-router' {
  interface RouteMeta {
    title: string;
    /** Reachable without signing in (setup, login, recovery, invite). */
    public?: boolean;
    /** Full-screen layout without the navigation shell. */
    bare?: boolean;
    adminOnly?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./pages/HomePage.vue'),
    meta: { title: '홈' },
  },
  {
    path: '/transactions',
    name: 'transactions',
    component: () => import('./pages/TransactionsPage.vue'),
    meta: { title: '내역' },
  },
  {
    path: '/inbox',
    name: 'inbox',
    component: () => import('./pages/InboxPage.vue'),
    meta: { title: '인박스' },
  },
  {
    path: '/add',
    name: 'add',
    component: () => import('./pages/AddPage.vue'),
    meta: { title: '추가' },
  },
  {
    path: '/import',
    name: 'import',
    component: () => import('./pages/ImportPage.vue'),
    meta: { title: '가져오기' },
  },
  {
    path: '/stats',
    name: 'stats',
    component: () => import('./pages/StatsPage.vue'),
    meta: { title: '통계' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('./pages/SettingsPage.vue'),
    meta: { title: '설정' },
  },
  {
    path: '/settings/security',
    name: 'settings-security',
    component: () => import('./pages/settings/SecurityPage.vue'),
    meta: { title: '보안' },
  },
  {
    path: '/settings/accounts',
    name: 'settings-accounts',
    component: () => import('./pages/settings/AccountsPage.vue'),
    meta: { title: '카드·계좌' },
  },
  {
    path: '/settings/categories',
    name: 'settings-categories',
    component: () => import('./pages/settings/CategoriesPage.vue'),
    meta: { title: '분류' },
  },
  {
    path: '/settings/sms',
    name: 'settings-sms',
    component: () => import('./pages/settings/SmsPage.vue'),
    meta: { title: '문자 전달' },
  },
  {
    path: '/settings/rules',
    name: 'settings-rules',
    component: () => import('./pages/settings/RulesPage.vue'),
    meta: { title: '분류 규칙' },
  },
  {
    path: '/settings/members',
    name: 'settings-members',
    component: () => import('./pages/settings/MembersPage.vue'),
    meta: { title: '구성원', adminOnly: true },
  },
  {
    path: '/more',
    name: 'more',
    component: () => import('./pages/MorePage.vue'),
    meta: { title: '더보기' },
  },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('./pages/auth/SetupPage.vue'),
    meta: { title: '처음 설정', public: true, bare: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('./pages/auth/LoginPage.vue'),
    meta: { title: '로그인', public: true, bare: true },
  },
  {
    path: '/recovery',
    name: 'recovery',
    component: () => import('./pages/auth/RecoveryPage.vue'),
    meta: { title: '비밀번호 재설정', public: true, bare: true },
  },
  {
    path: '/invite/:token',
    name: 'invite',
    component: () => import('./pages/auth/InvitePage.vue'),
    meta: { title: '초대 수락', public: true, bare: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('./pages/NotFoundPage.vue'),
    meta: { title: '페이지 없음' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  try {
    await auth.ensureLoaded();
  } catch {
    // Server unreachable: let public pages render; protected ones go to login,
    // which shows the connection problem.
    if (!to.meta.public) return { name: 'login' };
    return true;
  }
  if (auth.setupRequired) return to.name === 'setup' ? true : { name: 'setup' };
  if (to.name === 'setup') return { name: auth.authenticated ? 'home' : 'login' };
  if (to.meta.public) {
    if (auth.authenticated && (to.name === 'login' || to.name === 'recovery')) {
      return { name: 'home' };
    }
    return true;
  }
  if (!auth.authenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }
  if (to.meta.adminOnly && !auth.isAdmin) return { name: 'settings' };
  return true;
});

router.afterEach((to) => {
  document.title = to.name === 'home' ? '가계부' : `${to.meta.title} · 가계부`;
});

/** Only same-app paths are accepted as post-login redirects. */
export function safeRedirect(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}
