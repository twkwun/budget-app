import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    title: string;
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
    path: '/more',
    name: 'more',
    component: () => import('./pages/MorePage.vue'),
    meta: { title: '더보기' },
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

router.afterEach((to) => {
  document.title = to.name === 'home' ? '가계부' : `${to.meta.title} · 가계부`;
});
