<script setup lang="ts">
import { addMonths, currentYearMonth, type YearMonth } from '@budget/shared';
import { computed } from 'vue';
import { monthLabel } from '../ledger/format.ts';
import AppIcon from './AppIcon.vue';

const month = defineModel<YearMonth>({ required: true });
/** Latest month reachable with 다음 달 (default: this month). */
const props = defineProps<{ max?: YearMonth }>();
const isCurrent = computed(() => month.value >= (props.max ?? currentYearMonth()));
</script>

<template>
  <div class="month-nav" data-testid="month-nav">
    <button
      type="button"
      class="nav-btn"
      aria-label="이전 달"
      @click="month = addMonths(month, -1)"
    >
      <AppIcon name="chevron" :size="20" class="flip" />
    </button>
    <h1 class="label" aria-live="polite">{{ monthLabel(month) }}</h1>
    <button
      type="button"
      class="nav-btn"
      aria-label="다음 달"
      :disabled="isCurrent"
      @click="month = addMonths(month, 1)"
    >
      <AppIcon name="chevron" :size="20" />
    </button>
  </div>
</template>

<style scoped>
.month-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}
.label {
  margin: 0;
  font-size: 1.35rem;
  min-width: 7.5em;
  text-align: center;
}
.nav-btn {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.nav-btn:disabled {
  opacity: 0.3;
}
.flip {
  transform: rotate(180deg);
}
</style>
