<script setup lang="ts">
import { ACCOUNT_KIND_LABELS, type AccountKind } from '@budget/shared';

/** Payment method with its kind (카드·계좌·간편결제·현금) as a small colored label. */
defineProps<{ name: string | null; kind: AccountKind | null }>();
</script>

<template>
  <span v-if="name" class="account">
    <span v-if="kind" class="kind" :class="`kind-${kind}`">{{ ACCOUNT_KIND_LABELS[kind] }}</span>
    <span class="name">{{ name }}</span>
  </span>
  <span v-else class="muted">—</span>
</template>

<style scoped>
.account {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  flex: none;
  padding: 0 5px;
  border-radius: 5px;
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 1.5;
  color: var(--kind-color, var(--text-muted));
  background: color-mix(in srgb, var(--kind-color, var(--text-muted)) 14%, transparent);
}
.kind-card {
  --kind-color: var(--series-1);
}
.kind-bank {
  --kind-color: var(--series-3);
}
.kind-pay {
  --kind-color: var(--series-4);
}
.kind-cash,
.kind-other {
  --kind-color: var(--text-muted);
}
</style>
