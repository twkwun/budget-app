<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { PASSWORD_MIN_LENGTH, type RecoveryCodeIssued, type SignedIn } from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import AuthLayout from '../../components/AuthLayout.vue';
import RecoveryCodeCard from '../../components/RecoveryCodeCard.vue';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const router = useRouter();
const loginName = ref('');
const recoveryCode = ref('');
const newPassword = ref('');
const confirm = ref('');
const issued = ref('');
const busy = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  if (newPassword.value !== confirm.value) {
    error.value = '비밀번호가 서로 다릅니다.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await api.post<SignedIn & RecoveryCodeIssued>(
      '/auth/recovery',
      {
        loginName: loginName.value,
        recoveryCode: recoveryCode.value,
        newPassword: newPassword.value,
      },
      { raw: true },
    );
    auth.signedIn(result);
    issued.value = result.recoveryCode;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout
    title="비밀번호 재설정"
    :subtitle="issued ? undefined : '복구 코드로 새 비밀번호를 정합니다.'"
  >
    <template v-if="issued">
      <p class="notice">
        비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 해제되었습니다. 이전 복구 코드는 더 이상 쓸
        수 없으니 새 코드를 저장하세요.
      </p>
      <RecoveryCodeCard :code="issued" @done="router.replace('/')" />
    </template>
    <form v-else class="stack" @submit.prevent="submit">
      <label class="field">
        <span>아이디</span>
        <input v-model="loginName" autocomplete="username" autocapitalize="none" required />
      </label>
      <label class="field">
        <span>복구 코드</span>
        <input
          v-model="recoveryCode"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          required
        />
      </label>
      <label class="field">
        <span>새 비밀번호 ({{ PASSWORD_MIN_LENGTH }}자 이상)</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          :minlength="PASSWORD_MIN_LENGTH"
          required
        />
      </label>
      <label class="field">
        <span>새 비밀번호 확인</span>
        <input v-model="confirm" type="password" autocomplete="new-password" required />
      </label>
      <button type="submit" class="btn btn-primary btn-block" :disabled="busy">재설정</button>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <RouterLink to="/login" class="back">로그인으로 돌아가기</RouterLink>
    </form>
  </AuthLayout>
</template>

<style scoped>
.back {
  text-align: center;
  font-size: 0.85rem;
  color: var(--accent);
}
</style>
