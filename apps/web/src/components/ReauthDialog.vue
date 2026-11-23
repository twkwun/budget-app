<script setup lang="ts">
import { useAuthStore } from '../stores/auth.ts';
import { biometricName, withRo } from '../auth/platform.ts';
import VerifyIdentity from './VerifyIdentity.vue';

const auth = useAuthStore();
</script>

<template>
  <div class="backdrop" data-testid="reauth-dialog">
    <div class="dialog card" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
      <h2 id="reauth-title">본인 확인</h2>
      <p class="muted">중요한 설정을 바꾸기 전에 한 번 더 확인합니다.</p>
      <VerifyIdentity :passkey-label="`${withRo(biometricName())} 확인`" />
      <button type="button" class="btn btn-block cancel" @click="auth.cancelReauth()">취소</button>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(0 0 0 / 40%);
}
.dialog {
  width: 100%;
  max-width: 360px;
}
.dialog p {
  margin: 0 0 16px;
}
.cancel {
  margin-top: 12px;
}
</style>
