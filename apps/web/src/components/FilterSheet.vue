<script setup lang="ts">
import { reactive } from 'vue';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS,
} from '@budget/shared';
import type { ListFilters } from '../ledger/filters.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';
import AmountInput from './AmountInput.vue';
import BottomSheet from './BottomSheet.vue';

const props = defineProps<{ filters: ListFilters }>();
const emit = defineEmits<{ close: []; apply: [filters: ListFilters] }>();
const auth = useAuthStore();
const ledger = useLedgerStore();

const draft = reactive({
  type: props.filters.type ?? '',
  category: props.filters.category ?? '',
  accountId: props.filters.accountId ?? '',
  ownerId: props.filters.ownerId ?? '',
  status: props.filters.status ?? '',
  minAmount: props.filters.minAmount ?? 0,
  maxAmount: props.filters.maxAmount ?? 0,
});

function apply(): void {
  emit('apply', {
    month: props.filters.month,
    q: props.filters.q,
    type: draft.type || undefined,
    category: draft.category === '' ? undefined : (draft.category as number | 'none'),
    accountId: draft.accountId === '' ? undefined : Number(draft.accountId),
    ownerId: draft.ownerId === '' ? undefined : Number(draft.ownerId),
    status: draft.status || undefined,
    minAmount: draft.minAmount || undefined,
    maxAmount: draft.maxAmount || undefined,
  } as ListFilters);
}

function clear(): void {
  Object.assign(draft, {
    type: '',
    category: '',
    accountId: '',
    ownerId: '',
    status: '',
    minAmount: 0,
    maxAmount: 0,
  });
}
</script>

<template>
  <BottomSheet title="필터" testid="filter-sheet" @close="emit('close')">
    <div class="stack">
      <label class="field">
        <span>유형</span>
        <select v-model="draft.type" data-testid="filter-type">
          <option value="">전체</option>
          <option v-for="t in TRANSACTION_TYPES" :key="t" :value="t">
            {{ TRANSACTION_TYPE_LABELS[t] }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>분류</span>
        <select v-model="draft.category" data-testid="filter-category">
          <option value="">전체</option>
          <option value="none">미분류</option>
          <optgroup
            v-for="kind in ['expense', 'income'] as const"
            :key="kind"
            :label="kind === 'expense' ? '지출' : '수입'"
          >
            <template v-for="root in ledger.tree[kind]" :key="root.id">
              <option :value="root.id">{{ root.name }} (하위 포함)</option>
              <option v-for="c in root.children" :key="c.id" :value="c.id">· {{ c.name }}</option>
            </template>
          </optgroup>
        </select>
      </label>
      <label class="field">
        <span>수단</span>
        <select v-model="draft.accountId">
          <option value="">전체</option>
          <option v-for="a in ledger.accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label v-if="auth.isAdmin && ledger.members.length > 1" class="field">
        <span>구성원</span>
        <select v-model="draft.ownerId">
          <option value="">전체</option>
          <option v-for="m in ledger.members" :key="m.id" :value="m.id">{{ m.displayName }}</option>
        </select>
      </label>
      <label class="field">
        <span>상태</span>
        <select v-model="draft.status" data-testid="filter-status">
          <option value="">전체</option>
          <option v-for="s in TRANSACTION_STATUSES" :key="s" :value="s">
            {{ TRANSACTION_STATUS_LABELS[s] }}
          </option>
        </select>
      </label>
      <div class="range">
        <label class="field">
          <span>최소 금액</span>
          <AmountInput v-model="draft.minAmount" />
        </label>
        <label class="field">
          <span>최대 금액</span>
          <AmountInput v-model="draft.maxAmount" />
        </label>
      </div>
    </div>
    <template #footer>
      <button type="button" class="btn" @click="clear">초기화</button>
      <button type="button" class="btn btn-primary grow" data-testid="filter-apply" @click="apply">
        적용
      </button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.grow {
  flex: 1;
}
</style>
