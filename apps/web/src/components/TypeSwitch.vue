<script setup lang="ts">
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type TransactionType } from '@budget/shared';

const type = defineModel<TransactionType>({ required: true });
</script>

<template>
  <div class="segmented" role="radiogroup" aria-label="거래 유형">
    <button
      v-for="t in TRANSACTION_TYPES"
      :key="t"
      type="button"
      role="radio"
      :aria-checked="type === t"
      :class="{ on: type === t }"
      :data-testid="`type-${t}`"
      @click="type = t"
    >
      {{ TRANSACTION_TYPE_LABELS[t] }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  border-radius: 10px;
  background: var(--surface-hover);
}
.segmented button {
  min-height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.segmented .on {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}
</style>
