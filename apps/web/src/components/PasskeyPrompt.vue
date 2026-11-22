<script setup lang="ts">
import { ref } from 'vue';
import { errorMessage, isPasskeyCancel } from '../auth/messages.ts';
import { passkeysSupported, registerPasskey } from '../auth/passkey.ts';

const emit = defineEmits<{ done: [added: boolean] }>();
const busy = ref(false);
const error = ref('');
const added = ref<{ synced: boolean } | null>(null);
const supported = passkeysSupported();

async function add(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const passkey = await registerPasskey();
    added.value = { synced: passkey.backedUp };
  } catch (e) {
    if (!isPasskeyCancel(e)) error.value = errorMessage(e);
    else error.value = '패스키 등록이 취소되었습니다.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="stack" data-testid="passkey-prompt">
    <template v-if="added">
      <div class="notice" data-testid="passkey-added">
        패스키를 등록했습니다. 다음부터 Face ID·Touch ID·Windows Hello로 로그인할 수 있습니다.
        <template v-if="added.synced">
          이 패스키는 iCloud 키체인으로 같은 Apple 계정의 아이폰·아이패드·맥에 자동으로
          동기화됩니다.
        </template>
      </div>
      <button type="button" class="btn btn-primary" @click="emit('done', true)">시작하기</button>
    </template>
    <template v-else-if="supported">
      <p>비밀번호 대신 <strong>Face ID</strong>로 로그인하려면 이 기기에 패스키를 추가하세요.</p>
      <button type="button" class="btn btn-primary" :disabled="busy" @click="add">
        패스키 추가
      </button>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <button type="button" class="btn" @click="emit('done', false)">나중에</button>
    </template>
    <template v-else>
      <p class="muted">이 브라우저는 패스키를 지원하지 않습니다. 비밀번호로 로그인하세요.</p>
      <button type="button" class="btn btn-primary" @click="emit('done', false)">시작하기</button>
    </template>
  </div>
</template>
