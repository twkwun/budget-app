<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { RecoveryCodeIssued, SignedIn } from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import AuthLayout from '../../components/AuthLayout.vue';
import type { NewAccount } from '../../auth/types.ts';
import NewAccountForm from '../../components/NewAccountForm.vue';
import PasskeyPrompt from '../../components/PasskeyPrompt.vue';
import RecoveryCodeCard from '../../components/RecoveryCodeCard.vue';
import { useAuthStore } from '../../stores/auth.ts';

const auth = useAuthStore();
const router = useRouter();
const step = ref<'account' | 'recovery' | 'passkey'>('account');
const recoveryCode = ref('');
const busy = ref(false);
const error = ref('');

async function create(account: NewAccount): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = await api.post<SignedIn & RecoveryCodeIssued>('/setup', account, { raw: true });
    auth.signedIn(result);
    recoveryCode.value = result.recoveryCode;
    step.value = 'recovery';
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthLayout
    title="처음 설정"
    :subtitle="
      step === 'account' ? '관리자 계정을 만듭니다. 이 화면은 한 번만 나타납니다.' : undefined
    "
  >
    <template v-if="step === 'account'">
      <NewAccountForm submit-label="관리자 계정 만들기" :busy="busy" @submit="create" />
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
