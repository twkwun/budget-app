<script setup lang="ts">
import { computed } from 'vue';
import { formatKrw, type BudgetPace, type BudgetProgress } from '@budget/shared';

/**
 * One budget's progress. Over-budget is said in words and marked with a
 * hatched bar and an icon, never by colour alone. When over, the bar is
 * rescaled to the amount spent: a line marks the budget, the solid part up
 * to it is what the budget covered, and the hatched part past it is the excess.
 */
const props = defineProps<{
  budget: BudgetProgress & { pace: BudgetPace | null };
  /** Larger type for the overall budget. */
  primary?: boolean;
}>();

const fill = computed(() => Math.min(100, Math.max(0, props.budget.percent)));
/**
 * Where the budget line sits (0–100) once spending passes it; null when not
 * over. Capped so even a small excess shows a visible hatched sliver.
 */
const MAX_PLAN_AT = 96;
const planAt = computed(() => {
  const { over, amount, spent } = props.budget;
  if (!over || spent <= 0) return null;
  return Math.round(Math.min(MAX_PLAN_AT, Math.max(0, (amount / spent) * 100)) * 10) / 10;
});
const paceText = computed(() => {
  const pace = props.budget.pace;
  if (!pace || props.budget.over) return '';
  const expected = Math.round(pace.elapsed * 100);
  return pace.status === 'ahead'
    ? `예상보다 빠름 · 이달 ${expected}% 지남, ${props.budget.percent}% 사용`
    : `예상 범위 · 이달 ${expected}% 지남, ${props.budget.percent}% 사용`;
});
</script>

<template>
  <div
    class="meter"
    :class="{ over: budget.over, ahead: budget.pace?.status === 'ahead', primary }"
    :data-state="budget.over ? 'over' : (budget.pace?.status ?? 'ok')"
    data-testid="budget-meter"
  >
    <div class="head">
      <span class="name">{{ budget.name }}</span>
      <span class="tabular amounts">
        <strong>{{ formatKrw(budget.spent) }}</strong>
        <span class="muted"> / {{ formatKrw(budget.amount) }}</span>
      </span>
    </div>
    <div class="bar" aria-hidden="true">
      <div class="track">
        <template v-if="planAt !== null">
          <div class="fill within" :style="{ width: `${planAt}%` }" />
          <div class="fill excess" />
        </template>
        <div v-else class="fill" :style="{ width: `${fill}%` }" />
      </div>
      <div
        v-if="budget.pace && !budget.over"
        class="mark"
        :style="{ left: `${Math.round(budget.pace.elapsed * 1000) / 10}%` }"
      />
      <div
        v-if="planAt !== null"
        class="plan"
        data-testid="budget-plan-line"
        :style="{ left: `${planAt}%` }"
      />
    </div>
    <div class="foot">
      <span v-if="budget.over" class="state over-text">
        <span class="icon" aria-hidden="true">!</span>
        {{ formatKrw(Math.abs(budget.remaining)) }} 초과
      </span>
      <span v-else class="state">{{ formatKrw(budget.remaining) }} 남음</span>
      <span class="tabular muted">{{ budget.percent }}%</span>
    </div>
    <p v-if="paceText" class="pace" :class="{ warn: budget.pace?.status === 'ahead' }">
      {{ paceText }}
    </p>
  </div>
</template>

<style scoped>
.meter {
  display: grid;
  gap: 6px;
}
.head,
.foot {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.primary .name {
  font-size: 1.05rem;
}
.amounts {
  font-size: 0.9rem;
  white-space: nowrap;
}
.bar {
  position: relative;
}
.track {
  display: flex;
  height: 10px;
  border-radius: 999px;
  background: var(--surface-hover);
  border: 1px solid var(--border);
  overflow: hidden;
}
.primary .track {
  height: 14px;
}
.fill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
}
.ahead .fill {
  background: var(--warn);
}
.over .fill {
  border-radius: 0;
}
.over .within {
  background: color-mix(in srgb, var(--error) 45%, var(--surface-hover));
}
.over .excess {
  flex: 1;
  background: repeating-linear-gradient(
    -45deg,
    var(--error) 0 6px,
    color-mix(in srgb, var(--error) 60%, var(--surface)) 6px 12px
  );
}
.plan {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: var(--text);
  box-shadow: 0 0 0 1.5px var(--surface);
}
.mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: var(--text);
  opacity: 0.55;
}
.foot {
  font-size: 0.85rem;
}
.over-text {
  color: var(--error);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.icon {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--error);
  color: var(--surface);
  font-size: 0.7rem;
  font-weight: 800;
}
.pace {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.pace.warn {
  color: var(--warn);
  font-weight: 600;
}
</style>
