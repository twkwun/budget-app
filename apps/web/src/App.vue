<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppSidebar from './components/AppSidebar.vue';
import AppTabBar from './components/AppTabBar.vue';
import LockScreen from './components/LockScreen.vue';
import PrivacyCover from './components/PrivacyCover.vue';
import ReauthDialog from './components/ReauthDialog.vue';
import { applyUpdate, updateReady } from './pwa.ts';
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
  <div
    v-if="updateReady && !route.meta.bare"
    class="update"
    role="status"
    data-testid="update-banner"
  >
    <span>새 버전이 준비됐습니다.</span>
    <button type="button" class="btn btn-small btn-primary" @click="applyUpdate">
      지금 업데이트
    </button>
    <button
      type="button"
      class="btn btn-small"
      aria-label="나중에 (다음에 앱을 열 때 적용)"
      @click="updateReady = false"
    >
      나중에
    </button>
  </div>
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
.update {
  position: fixed;
  z-index: 40;
  left: calc(12px + var(--safe-left));
  right: calc(12px + var(--safe-right));
  bottom: calc(var(--tabbar-height) + var(--safe-bottom) + 10px);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.15);
  font-size: 0.9rem;
}
.update span {
  flex: 1 1 140px;
}
@media (min-width: 720px) {
  .update {
    left: auto;
    right: 24px;
    bottom: 24px;
    max-width: 420px;
  }
  .main {
    padding: calc(32px + var(--safe-top)) calc(40px + var(--safe-right))
      calc(32px + var(--safe-bottom)) 40px;
  }
}
</style>
