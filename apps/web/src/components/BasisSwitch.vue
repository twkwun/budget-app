<script setup lang="ts">
import type { ListBasis } from '@budget/shared';
import { rememberBasis } from '../ledger/basis.ts';

/** 사용일 기준 / 결제월 기준 toggle; the choice is remembered on this device. */
const basis = defineModel<ListBasis>({ required: true });

function pick(next: ListBasis): void {
  rememberBasis(next);
  basis.value = next;
}
</script>

<template>
  <div class="basis" role="radiogroup" aria-label="월 기준" data-testid="basis">
    <button
      type="button"
      role="radio"
      :aria-checked="basis === 'date'"
      :class="{ on: basis === 'date' }"
      data-testid="basis-date"
      @click="pick('date')"
    >
      사용일 기준
    </button>
    <button
      type="button"
      role="radio"
      :aria-checked="basis === 'billing'"
      :class="{ on: basis === 'billing' }"
      data-testid="basis-billing"
      @click="pick('billing')"
    >
      결제월 기준
    </button>
  </div>
</template>

<style scoped>
.basis {
  display: inline-flex;
  align-self: start;
  justify-self: start;
  padding: 2px;
  border-radius: 8px;
  background: var(--surface-hover);
}
.basis button {
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}
.basis .on {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}
</style>
