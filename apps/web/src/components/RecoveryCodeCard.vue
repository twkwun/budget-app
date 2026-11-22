<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ code: string }>();
const emit = defineEmits<{ done: [] }>();
const saved = ref(false);
const copied = ref(false);

async function copy(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div class="stack" data-testid="recovery-code">
    <div class="notice">
      패스키와 비밀번호를 모두 잃었을 때 쓰는 <strong>복구 코드</strong>입니다. 지금 한 번만 보여
      드립니다. 종이에 적거나 암호 관리 앱에 저장하세요.
    </div>
    <div class="code tabular" data-testid="recovery-code-value">{{ code }}</div>
    <button type="button" class="btn" @click="copy(code)">{{ copied ? '복사됨' : '복사' }}</button>
    <label class="check">
      <input v-model="saved" type="checkbox" />
      <span>복구 코드를 안전한 곳에 저장했습니다</span>
    </label>
    <button type="button" class="btn btn-primary" :disabled="!saved" @click="emit('done')">
      계속
    </button>
  </div>
</template>

<style scoped>
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.3rem;
  letter-spacing: 0.06em;
  text-align: center;
  padding: 16px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--surface);
  user-select: all;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 0.9rem;
}
.check input {
  width: auto;
}
</style>
