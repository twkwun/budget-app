<script setup lang="ts">
import { TRANSACTION_STATUS_LABELS, monthLabel, type TransactionInfo } from '@budget/shared';
import { signedAmount, timeLabel } from '../ledger/format.ts';
import AccountTag from './AccountTag.vue';

defineProps<{
  tx: TransactionInfo;
  showOwner: boolean;
  /** Selection mode: the row toggles a checkbox instead of opening the editor. */
  selectable?: boolean;
  selected?: boolean;
}>();
defineEmits<{ open: [event: MouseEvent] }>();
</script>

<template>
  <button
    type="button"
    class="row"
    :class="{ cancelled: tx.status === 'cancelled', selected }"
    :aria-pressed="selectable ? selected : undefined"
    data-testid="tx-row"
    @click="$emit('open', $event)"
  >
    <span v-if="selectable" class="check" :class="{ on: selected }" aria-hidden="true">
      <svg v-if="selected" viewBox="0 0 16 16" width="12" height="12">
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2" />
      </svg>
    </span>
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
        <template v-if="showOwner"> · {{ tx.ownerName }}</template>
      </span>
      <span v-if="tx.accountName" class="sub pay">
        <AccountTag :name="tx.accountName" :kind="tx.accountKind" />
        <span
          v-if="tx.billingMonth"
          class="billing"
          :class="{ later: tx.billingMonth !== tx.occurredDate.slice(0, 7) }"
          data-testid="billing-month"
          >{{ monthLabel(tx.billingMonth, tx.occurredDate.slice(0, 7)) }} 결제</span
        >
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
.row.selected {
  background: var(--accent-soft);
  border-radius: 8px;
}
.check {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-radius: 6px;
  color: var(--on-accent);
}
.check.on {
  border-color: var(--accent);
  background: var(--accent);
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
.pay {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.billing {
  flex: none;
  font-size: 0.75rem;
}
.billing.later {
  color: var(--accent);
  font-weight: 600;
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
