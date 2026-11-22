<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { InviteCheck, RecoveryCodeIssued, SignedIn } from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import AuthLayout from '../../components/AuthLayout.vue';
import type { NewAccount } from '../../auth/types.ts';
import NewAccountForm from '../../components/NewAccountForm.vue';
import PasskeyPrompt from '../../components/PasskeyPrompt.vue';
import RecoveryCodeCard from '../../components/RecoveryCodeCard.vue';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const token = String(route.params.token ?? '');
const step = ref<'checking' | 'invalid' | 'signed-in' | 'account' | 'recovery' | 'passkey'>(
  'checking',
);
const recoveryCode = ref('');
const busy = ref(false);
const error = ref('');

onMounted(async () => {
  if (auth.authenticated) {
    step.value = 'signed-in';
    return;
  }
  try {
    const check = await api.get<InviteCheck>(`/invite/${encodeURIComponent(token)}`, { raw: true });
    step.value = check.valid ? 'account' : 'invalid';
  } catch {
    step.value = 'invalid';
  }
});

async function accept(account: NewAccount): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.post<SignedIn & RecoveryCodeIssued>(
      `/invite/${encodeURIComponent(token)}/accept`,
      account,
      { raw: true },
    );
    auth.signedIn(result);
    recoveryCode.value = result.recoveryCode;
    step.value = 'recovery';
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function logoutAndContinue(): Promise<void> {
  await auth.logout();
  step.value = 'checking';
  const check = await api.get<InviteCheck>(`/invite/${encodeURIComponent(token)}`, { raw: true });
  step.value = check.valid ? 'account' : 'invalid';
}
</script>

<template>
  <AuthLayout title="가계부에 초대받았습니다">
    <p v-if="step === 'checking'" class="muted">초대 링크를 확인하는 중…</p>
    <div v-else-if="step === 'invalid'" class="stack">
      <p class="error-text">초대 링크가 만료되었거나 이미 사용되었습니다.</p>
      <p class="muted">관리자에게 새 초대 링크를 요청하세요.</p>
    </div>
    <div v-else-if="step === 'signed-in'" class="stack">
      <p>
        이미 {{ auth.user?.displayName }}님으로 로그인되어 있습니다. 새 계정을 만들려면 먼저
        로그아웃하세요.
      </p>
      <button type="button" class="btn btn-primary" @click="logoutAndContinue">
        로그아웃하고 계속
      </button>
      <RouterLink to="/" class="btn">홈으로</RouterLink>
    </div>
    <template v-else-if="step === 'account'">
      <p class="muted intro">사용할 이름과 아이디, 비밀번호를 정하세요.</p>
      <NewAccountForm submit-label="가입하기" :busy="busy" @submit="accept" />
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </template>
    <RecoveryCodeCard
      v-else-if="step === 'recovery'"
      :code="recoveryCode"
      @done="step = 'passkey'"
    />
    <PasskeyPrompt v-else @done="router.replace('/')" />
  </AuthLayout>
</template>

<style scoped>
.intro {
  margin-top: -8px;
}
</style>
