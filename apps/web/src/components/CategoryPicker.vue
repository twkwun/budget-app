<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CategoryKind, CategoryNode } from '@budget/shared';
import { useLedgerStore } from '../stores/ledger.ts';

/** Recent categories first, then top-level categories that expand to their children. */
const props = defineProps<{ kind: CategoryKind; recent: number[]; selected: number | null }>();
const emit = defineEmits<{ pick: [id: number | null] }>();
const ledger = useLedgerStore();
const open = ref<number | null>(null);

const roots = computed(() => ledger.tree[props.kind].filter((c) => !c.archived));
const recentEntries = computed(() =>
  props.recent
    .map((id) => ledger.categoryIndex.get(id))
    .filter((e) => e && !e.node.archived && e.node.kind === props.kind)
    .slice(0, 6),
);

function choose(node: CategoryNode): void {
  const children = node.children.filter((c) => !c.archived);
  if (children.length && open.value !== node.id) {
    open.value = node.id;
    return;
  }
  emit('pick', node.id);
}
</script>

<template>
  <div class="picker">
    <section v-if="recentEntries.length" aria-label="최근 분류">
      <h3 class="muted small">최근</h3>
      <div class="chips">
        <button
          v-for="entry in recentEntries"
          :key="entry!.node.id"
          type="button"
          class="chip"
          :class="{ on: selected === entry!.node.id }"
          @click="emit('pick', entry!.node.id)"
        >
          {{ entry!.label }}
        </button>
      </div>
    </section>
    <h3 class="muted small">전체</h3>
    <div class="grid">
      <template v-for="root in roots" :key="root.id">
        <button
          type="button"
          class="tile"
          :class="{ on: selected === root.id, open: open === root.id }"
          :aria-expanded="root.children.length ? open === root.id : undefined"
          @click="choose(root)"
        >
          {{ root.name }}
        </button>
        <div v-if="open === root.id" class="children">
          <button
            type="button"
            class="chip"
            :class="{ on: selected === root.id }"
            @click="emit('pick', root.id)"
          >
            {{ root.name }} 전체
          </button>
          <button
            v-for="child in root.children.filter((c) => !c.archived)"
            :key="child.id"
            type="button"
            class="chip"
            :class="{ on: selected === child.id }"
            @click="emit('pick', child.id)"
          >
            {{ child.name }}
          </button>
        </div>
      </template>
    </div>
    <button type="button" class="link-button skip" @click="emit('pick', null)">
      분류 없이 저장 (미분류)
    </button>
  </div>
</template>

<style scoped>
.small {
  font-size: 0.8rem;
  margin: 12px 0 6px;
  font-weight: 600;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.9rem;
  cursor: pointer;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.tile {
  min-height: 52px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
}
.tile.open {
  border-color: var(--accent);
}
.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.children {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  border-radius: 12px;
  background: var(--surface-hover);
}
.skip {
  display: block;
  margin: 16px auto 0;
}
</style>
