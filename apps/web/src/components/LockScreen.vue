<script setup lang="ts">
import { useAuthStore } from '../stores/auth.ts';
import VerifyIdentity from './VerifyIdentity.vue';

const auth = useAuthStore();
</script>

<template>
  <div
    class="lock"
    role="dialog"
    aria-modal="true"
    aria-labelledby="lock-title"
    data-testid="lock-screen"
  >
    <div class="lock-card">
      <img src="/favicon.svg" alt="" width="56" height="56" />
      <h1 id="lock-title">잠겨 있습니다</h1>
      <p class="muted">{{ auth.user?.displayName }}님, 본인 확인 후 계속하세요.</p>
      <VerifyIdentity passkey-label="Face ID로 잠금 해제" />
      <button type="button" class="link-button logout" @click="auth.logout()">로그아웃</button>
    </div>
  </div>
</template>

<style scoped>
.lock {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: calc(24px + var(--safe-top)) 16px calc(24px + var(--safe-bottom));
  background: var(--bg);
}
.lock-card {
  width: 100%;
  max-width: 360px;
  text-align: center;
}
.lock-card h1 {
  margin: 12px 0 4px;
}
.lock-card p {
  margin: 0 0 20px;
}
.logout {
  margin-top: 20px;
}
</style>
