<script setup lang="ts">
import { MAX_AMOUNT } from '@budget/shared';

/** On-screen numeric keypad for one-handed entry. The model is the amount in won. */
const amount = defineModel<number>({ required: true });

function press(key: string): void {
  if (key === 'back') {
    amount.value = Math.floor(amount.value / 10);
    return;
  }
  const next = Number(`${amount.value === 0 ? '' : amount.value}${key}`);
  if (Number.isSafeInteger(next) && next <= MAX_AMOUNT) amount.value = next;
}

const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];
defineExpose({ press });
</script>

<template>
  <div class="keypad" role="group" aria-label="금액 입력">
    <button
      v-for="key in keys"
      :key="key"
      type="button"
      class="key"
      :aria-label="key === 'back' ? '지우기' : key"
      :data-testid="`key-${key}`"
      @click="press(key)"
    >
      {{ key === 'back' ? '⌫' : key }}
    </button>
  </div>
</template>

<style scoped>
.keypad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.key {
  min-height: 56px;
  border: 0;
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font-size: 1.4rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.key:active {
  background: var(--surface-hover);
}
</style>
