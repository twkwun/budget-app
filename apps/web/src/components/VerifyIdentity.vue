<script setup lang="ts">
import { ref } from 'vue';
import { errorMessage } from '../auth/messages.ts';
import { passkeysSupported } from '../auth/passkey.ts';
import { useAuthStore } from '../stores/auth.ts';

/** Passkey-first identity check with a password fallback (unlock and step-up). */
const props = defineProps<{ passkeyLabel: string }>();
const auth = useAuthStore();
const password = ref('');
const busy = ref(false);
const error = ref('');
const showPassword = ref(!passkeysSupported());

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    password.value = '';
  } catch (e) {
    error.value = errorMessage(e);
    if ((e as { code?: string }).code === 'not_found') {
      error.value = '등록된 패스키가 없습니다. 비밀번호를 입력하세요.';
      showPassword.value = true;
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <button
      v-if="passkeysSupported()"
      type="button"
      class="btn btn-primary btn-block"
      :disabled="busy"
      data-testid="verify-passkey"
      @click="run(auth.verifyPasskey)"
    >
      {{ props.passkeyLabel }}
    </button>
    <button v-if="!showPassword" type="button" class="link-button" @click="showPassword = true">
      비밀번호로 확인
    </button>
    <form v-else class="stack" @submit.prevent="run(() => auth.verifyPassword(password))">
      <label class="field">
        <span>비밀번호</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          data-testid="verify-password"
        />
      </label>
      <button type="submit" class="btn btn-block" :disabled="busy || !password">확인</button>
    </form>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
  </div>
</template>
