<script setup lang="ts">
import { computed } from 'vue';
import { MAX_AMOUNT } from '@budget/shared';

/** Text input that shows thousands separators while typing; the model is integer won. */
const amount = defineModel<number>({ required: true });
defineProps<{ testid?: string }>();

const display = computed(() => (amount.value ? amount.value.toLocaleString('ko-KR') : ''));

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const digits = input.value.replace(/\D/g, '').replace(/^0+/, '');
  const value = Math.min(Number(digits || '0'), MAX_AMOUNT);
  amount.value = value;
  input.value = value ? value.toLocaleString('ko-KR') : '';
}
</script>

<template>
  <div class="amount-input">
    <input
      :value="display"
      inputmode="numeric"
      autocomplete="off"
      :data-testid="testid"
      @input="onInput"
    />
    <span class="unit">원</span>
  </div>
</template>

<style scoped>
.amount-input {
  position: relative;
}
.amount-input input {
  padding-right: 32px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.unit {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
}
</style>
