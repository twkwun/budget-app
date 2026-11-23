<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './components/AppSidebar.vue';
import AppTabBar from './components/AppTabBar.vue';
import LockScreen from './components/LockScreen.vue';
import PrivacyCover from './components/PrivacyCover.vue';
import ReauthDialog from './components/ReauthDialog.vue';
import { useAuthStore } from './stores/auth.ts';

const route = useRoute();
const auth = useAuthStore();

/**
 * 화면 가리기 (DESIGN 4.1): cover the UI whenever the page is hidden so the
 * iOS app switcher snapshot shows no amounts. With the 즉시 lock setting the
 * session is also locked right away.
 */
const hidden = ref(document.visibilityState === 'hidden');

function onHide(): void {
  hidden.value = true;
  if (auth.authenticated && auth.user?.lockTimeoutSeconds === 0) auth.lock({ keepalive: true });
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    onHide();
  } else {
    hidden.value = false;
    // The server may have locked the session by inactivity while we were away.
    if (auth.authenticated) void auth.refresh().catch(() => {});
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onVisibility);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onHide);
  window.removeEventListener('pageshow', onVisibility);
});
</script>

<template>
  <RouterView v-if="route.meta.bare" />
  <div v-else class="shell">
    <AppSidebar class="only-wide" />
    <main class="main">
      <RouterView />
    </main>
    <AppTabBar class="only-narrow" />
  </div>
  <LockScreen v-if="auth.authenticated && auth.locked && !route.meta.bare" />
  <ReauthDialog v-else-if="auth.reauthPending" />
  <PrivacyCover v-if="hidden && auth.authenticated" />
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100dvh;
}
.main {
  flex: 1;
  min-width: 0;
  padding: calc(16px + var(--safe-top)) calc(16px + var(--safe-right))
    calc(var(--tabbar-height) + var(--safe-bottom) + 32px) calc(16px + var(--safe-left));
}
@media (min-width: 720px) {
  .main {
    padding: calc(32px + var(--safe-top)) calc(40px + var(--safe-right))
      calc(32px + var(--safe-bottom)) 40px;
  }
}
</style>
