<script setup lang="ts">
import { computed } from 'vue';
import type { CategoryKind } from '@budget/shared';
import { useLedgerStore } from '../stores/ledger.ts';

/** `<select>` of categories of one kind, grouped by parent; keeps an archived current value. */
const model = defineModel<number | null>({ required: true });
const props = defineProps<{ kind: CategoryKind; keep?: number | null; testid?: string }>();
const ledger = useLedgerStore();

const groups = computed(() =>
  ledger.tree[props.kind]
    .filter(
      (root) =>
        !root.archived || root.id === props.keep || root.children.some((c) => c.id === props.keep),
    )
    .map((root) => ({
      root,
      children: root.children.filter((c) => !c.archived || c.id === props.keep),
    })),
);
</script>

<template>
  <select v-model="model" :data-testid="testid">
    <option :value="null">미분류</option>
    <optgroup v-for="g in groups" :key="g.root.id" :label="g.root.name">
      <option :value="g.root.id">{{ g.root.name }} (전체)</option>
      <option v-for="c in g.children" :key="c.id" :value="c.id">{{ c.name }}</option>
    </optgroup>
  </select>
</template>
