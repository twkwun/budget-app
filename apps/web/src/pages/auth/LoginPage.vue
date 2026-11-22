<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AuthLayout from '../../components/AuthLayout.vue';
import { errorMessage, isPasskeyCancel } from '../../auth/messages.ts';
import { passkeysSupported } from '../../auth/passkey.ts';
import { safeRedirect } from '../../router.ts';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const loginName = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const supported = passkeysSupported();

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    await router.replace(safeRedirect(route.query.redirect));
  } catch (e) {
    error.value = isPasskeyCancel(e) ? '' : errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout title="가계부" subtitle="가족이 함께 쓰는 가계부">
    <div class="stack">
      <button
        v-if="supported"
        type="button"
        class="btn btn-primary btn-block"
        :disabled="busy"
        data-testid="login-passkey"
        @click="run(auth.loginWithPasskey)"
      >
        패스키로 로그인 (Face ID)
      </button>
      <p v-if="supported" class="muted hint">
        다른 기기의 패스키는 QR 코드를 아이폰으로 찍어 로그인할 수 있습니다.
      </p>
      <div class="divider">또는 비밀번호로</div>
      <form class="stack" @submit.prevent="run(() => auth.loginWithPassword(loginName, password))">
        <label class="field">
          <span>아이디</span>
          <input
            v-model="loginName"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            required
            data-testid="login-name"
          />
        </label>
        <label class="field">
          <span>비밀번호</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            data-testid="login-password"
          />
        </label>
        <button type="submit" class="btn btn-block" :disabled="busy">비밀번호로 로그인</button>
      </form>
      <p v-if="error" class="error-text" role="alert" data-testid="login-error">{{ error }}</p>
      <RouterLink to="/recovery" class="center small"
        >비밀번호를 잊으셨나요? 복구 코드로 재설정</RouterLink
      >
    </div>
  </AuthLayout>
</template>

<style scoped>
.hint {
  font-size: 0.8rem;
  text-align: center;
  margin: -4px 0 4px;
}
.center {
  text-align: center;
}
.small {
  font-size: 0.85rem;
  color: var(--accent);
}
</style>
