import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { isStaleChunkError, registerServiceWorker } from './pwa.ts';
import { router } from './router.ts';
import { useAuthStore } from './stores/auth.ts';
import { useInboxStore } from './stores/inbox.ts';
import { useLedgerStore } from './stores/ledger.ts';
import './styles/base.css';

const app = createApp(App).use(createPinia());
useAuthStore().install({
  onSignedOut: (explicit) => {
    useLedgerStore().reset();
    const current = router.currentRoute.value;
    if (current.meta.public) return;
    // After an explicit logout start fresh; after an expired session come back here.
    const keep = !explicit && current.fullPath !== '/';
    void router.replace({ name: 'login', query: keep ? { redirect: current.fullPath } : {} });
  },
});
// Keep the 인박스 badge current as the person moves around.
router.afterEach((to) => {
  if (!to.meta.public && useAuthStore().authenticated) void useInboxStore().refresh();
});
// A screen from an older build that is no longer on the server: reload into the new build.
router.onError((error, to) => {
  if (isStaleChunkError(error)) window.location.assign(to.fullPath);
});
app.use(router).mount('#app');
registerServiceWorker();
