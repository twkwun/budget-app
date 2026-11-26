<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  DISPLAY_NAME_MAX_LENGTH,
  LOGIN_NAME_PATTERN,
  PASSWORD_MIN_LENGTH,
  normalizeLoginName,
} from '@budget/shared';
import type { NewAccount } from '../auth/types.ts';

defineProps<{ submitLabel: string; busy: boolean }>();
const emit = defineEmits<{ submit: [account: NewAccount] }>();

const displayName = ref('');
const loginName = ref('');
const password = ref('');
const confirm = ref('');

const problem = computed(() => {
  if (loginName.value && !LOGIN_NAME_PATTERN.test(normalizeLoginName(loginName.value))) {
    return '아이디는 영문 소문자·숫자·. _ - 로 3~32자여야 합니다.';
  }
  if (password.value && password.value.length < PASSWORD_MIN_LENGTH) {
    return `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`;
  }
  if (confirm.value && confirm.value !== password.value) return '비밀번호가 서로 다릅니다.';
  return '';
});

function submit(): void {
  if (problem.value || confirm.value !== password.value) return;
  emit('submit', {
    displayName: displayName.value.trim(),
    loginName: normalizeLoginName(loginName.value),
    password: password.value,
  });
}
</script>

<template>
  <form class="stack" @submit.prevent="submit">
    <label class="field">
      <span>이름 (목록에 보이는 이름)</span>
      <input
        v-model="displayName"
        :maxlength="DISPLAY_NAME_MAX_LENGTH"
        autocomplete="nickname"
        required
        data-testid="account-display-name"
      />
    </label>
    <label class="field">
      <span>아이디</span>
      <input
        v-model="loginName"
        autocomplete="username"
        autocapitalize="none"
        spellcheck="false"
        required
        data-testid="account-login-name"
      />
    </label>
    <label class="field">
      <span>비밀번호 ({{ PASSWORD_MIN_LENGTH }}자 이상)</span>
      <input
        v-model="password"
        type="password"
        autocomplete="new-password"
        required
        data-testid="account-password"
      />
    </label>
    <label class="field">
      <span>비밀번호 확인</span>
      <input
        v-model="confirm"
        type="password"
        autocomplete="new-password"
        required
        data-testid="account-password-confirm"
      />
    </label>
    <p v-if="problem" class="error-text">{{ problem }}</p>
    <button type="submit" class="btn btn-primary btn-block" :disabled="busy || !!problem">
      {{ submitLabel }}
    </button>
  </form>
</template>
