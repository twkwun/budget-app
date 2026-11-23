<script setup lang="ts">
import { TRANSACTION_STATUS_LABELS, type TransactionInfo } from '@budget/shared';
import { signedAmount, timeLabel } from '../ledger/format.ts';

defineProps<{ tx: TransactionInfo; showOwner: boolean }>();
defineEmits<{ open: [] }>();
</script>

<template>
  <button
    type="button"
    class="row"
    :class="{ cancelled: tx.status === 'cancelled' }"
    data-testid="tx-row"
    @click="$emit('open')"
  >
    <span class="main">
      <span class="title">
        {{ tx.merchant || tx.categoryName || (tx.type === 'transfer' ? '이체' : '미분류') }}
        <span
          v-if="tx.hasSms"
          class="source"
          data-testid="source-sms"
          title="카드 문자로 등록·확인됨"
          >문자</span
        >
        <span v-if="tx.sources.includes('file')" class="source" title="파일로 가져옴">파일</span>
        <span
          v-if="tx.confirmed"
          class="source confirmed"
          data-testid="confirmed"
          title="두 곳 이상에서 같은 거래가 확인됨"
          >확인됨</span
        >
      </span>
      <span class="sub">
        <span v-if="tx.type !== 'transfer'" :class="{ uncategorized: !tx.categoryName }">{{
          tx.categoryName ?? '미분류'
        }}</span>
        <span v-else>이체</span>
        · {{ timeLabel(tx.occurredAt) }}
        <template v-if="tx.accountName"> · {{ tx.accountName }}</template>
        <template v-if="showOwner"> · {{ tx.ownerName }}</template>
      </span>
    </span>
    <span class="right">
      <span class="amount tabular" :class="tx.type">{{ signedAmount(tx.type, tx.amount) }}</span>
      <span
        v-if="tx.status === 'cancelled' || tx.status === 'needs_review'"
        class="badge"
        :class="{ warn: tx.status === 'needs_review' }"
      >
        {{ TRANSACTION_STATUS_LABELS[tx.status] }}
      </span>
    </span>
  </button>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 4px;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.main {
  flex: 1;
  min-width: 0;
  display: grid;
}
.title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  color: var(--text-muted);
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 0.7rem;
  font-weight: 600;
  vertical-align: 2px;
}
.source.confirmed {
  border-color: var(--accent);
  color: var(--accent);
}
.uncategorized {
  color: var(--warn);
  font-weight: 600;
}
.right {
  display: grid;
  justify-items: end;
  gap: 2px;
}
.amount {
  font-weight: 700;
}
.amount.income {
  color: var(--accent);
}
.cancelled .amount,
.cancelled .title {
  text-decoration: line-through;
  color: var(--text-muted);
}
.badge.warn {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn);
}
</style>
