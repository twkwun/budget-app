<script setup lang="ts">
import type { MemberInfo } from '@budget/shared';

/** 가족 전체 / one member. The model is 'all' or a member id. */
const scope = defineModel<'all' | number>({ required: true });
const { withAll = true, label = '보기 범위' } = defineProps<{
  members: MemberInfo[];
  /** Offer 가족 전체 (off where only one member's data makes sense). */
  withAll?: boolean;
  label?: string;
}>();
</script>

<template>
  <div class="scope" role="radiogroup" :aria-label="label" data-testid="scope-switch">
    <button
      v-if="withAll"
      type="button"
      role="radio"
      :aria-checked="scope === 'all'"
      :class="{ on: scope === 'all' }"
      @click="scope = 'all'"
    >
      가족 전체
    </button>
    <button
      v-for="m in members"
      :key="m.id"
      type="button"
      role="radio"
      :aria-checked="scope === m.id"
      :class="{ on: scope === m.id }"
      @click="scope = m.id"
    >
      {{ m.displayName }}
    </button>
  </div>
</template>

<style scoped>
.scope {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.scope button {
  flex: none;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.scope .on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
