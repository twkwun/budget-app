<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ACCOUNT_KINDS,
  ACCOUNT_KIND_LABELS,
  EDITABLE_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_LABELS,
  isAggregatorMerchant,
  suggestRulePattern,
  type BulkTransactionResult,
  type BulkTransactionUpdate,
  type EditableStatus,
  type TransactionInfo,
  type TransactionType,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import { useLedgerStore } from '../stores/ledger.ts';
import BottomSheet from './BottomSheet.vue';

/**
 * 일괄 수정: change the category, payment method, type or status of many
 * transactions at once. `known` holds the selected rows already on screen,
 * used for the preview and for offering classification rules.
 */
const props = defineProps<{ ids: number[]; known: TransactionInfo[] }>();
const emit = defineEmits<{ close: []; done: [updated: number] }>();
const ledger = useLedgerStore();

const KEEP = '';
const category = ref<string>(KEEP); // '', 'none' or a category id
const account = ref<string>(KEEP); // '', 'none' or an account id
const type = ref<TransactionType | ''>(KEEP);
const status = ref<EditableStatus | ''>(KEEP);
const remember = ref(false);
const busy = ref(false);
const error = ref('');

const categoryId = computed(() =>
  category.value === KEEP ? undefined : category.value === 'none' ? null : Number(category.value),
);
const categoryKind = computed(() =>
  typeof categoryId.value === 'number'
    ? ledger.categoryIndex.get(categoryId.value)?.node.kind
    : undefined,
);

const groups = computed(() =>
  (['expense', 'income'] as const).map((kind) => ({
    kind,
    label: kind === 'expense' ? '지출 분류' : '수입 분류',
    options: ledger.tree[kind]
      .filter((root) => !root.archived)
      .flatMap((root) => [
        { id: root.id, label: root.name },
        ...root.children
          .filter((c) => !c.archived)
          .map((c) => ({ id: c.id, label: `${root.name} > ${c.name}` })),
      ]),
  })),
);

const accountGroups = computed(() =>
  ACCOUNT_KINDS.map((kind) => ({
    kind,
    label: ACCOUNT_KIND_LABELS[kind],
    accounts: ledger.activeAccounts.filter((a) => a.kind === kind),
  })).filter((g) => g.accounts.length),
);

/** Type each row ends up with, by the same rule as the server. */
const nextType = (tx: TransactionInfo): TransactionType =>
  categoryKind.value ?? (type.value || tx.type);

const typeChanges = computed(() => {
  const counts = new Map<string, number>();
  for (const tx of props.known) {
    const next = nextType(tx);
    if (next === tx.type) continue;
    const key = `${TRANSACTION_TYPE_LABELS[tx.type]} → ${TRANSACTION_TYPE_LABELS[next]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${label} ${n}건`);
});

/** Rule patterns for "앞으로도 이 분류로" (only when every selected row is on screen). */
const rulePatterns = computed(() => {
  if (typeof categoryId.value !== 'number' || props.known.length !== props.ids.length) return [];
  const set = new Set<string>();
  for (const tx of props.known) {
    if (!tx.merchant || isAggregatorMerchant(tx.merchant)) continue;
    const p = suggestRulePattern(tx.merchant);
    if (p) set.add(p);
  }
  return [...set];
});
const canRemember = computed(
  () => rulePatterns.value.length > 0 && rulePatterns.value.length <= 10,
);

const nothing = computed(
  () => category.value === KEEP && account.value === KEEP && type.value === KEEP && !status.value,
);

async function submit(): Promise<void> {
  if (nothing.value) return;
  const body: BulkTransactionUpdate = { ids: props.ids };
  if (categoryId.value !== undefined) body.categoryId = categoryId.value;
  if (account.value !== KEEP)
    body.accountId = account.value === 'none' ? null : Number(account.value);
  if (type.value && categoryKind.value === undefined) body.type = type.value;
  if (status.value) body.status = status.value;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post<BulkTransactionResult>('/transactions/bulk', body);
    if (remember.value && canRemember.value && typeof categoryId.value === 'number') {
      for (const pattern of rulePatterns.value) {
        await api.post('/rules', { pattern, categoryId: categoryId.value, applyToExisting: true });
      }
    }
    emit('done', res.updated);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <BottomSheet
    :title="`${ids.length}건 한꺼번에 고치기`"
    testid="bulk-sheet"
    @close="emit('close')"
  >
    <form id="bulk-form" class="stack" @submit.prevent="submit">
      <p class="muted small">바꿀 항목만 고르세요. 「그대로 두기」인 항목은 바뀌지 않습니다.</p>
      <label class="field">
        <span>분류</span>
        <select v-model="category" data-testid="bulk-category">
          <option :value="KEEP">그대로 두기</option>
          <option value="none">미분류로</option>
          <optgroup v-for="g in groups" :key="g.kind" :label="g.label">
            <option v-for="o in g.options" :key="o.id" :value="String(o.id)">
              {{ o.label }}
            </option>
          </optgroup>
        </select>
      </label>
      <label class="field">
        <span>결제수단</span>
        <select v-model="account" data-testid="bulk-account">
          <option :value="KEEP">그대로 두기</option>
          <option value="none">없음</option>
          <optgroup v-for="g in accountGroups" :key="g.kind" :label="g.label">
            <option v-for="a in g.accounts" :key="a.id" :value="String(a.id)">
              {{ a.name }}{{ a.last4 ? ` ····${a.last4}` : '' }}
            </option>
          </optgroup>
        </select>
      </label>
      <label class="field">
        <span>유형</span>
        <select v-model="type" :disabled="categoryKind !== undefined" data-testid="bulk-type">
          <option :value="KEEP">
            {{
              categoryKind ? `분류에 맞게 ${TRANSACTION_TYPE_LABELS[categoryKind]}` : '그대로 두기'
            }}
          </option>
          <option v-for="t in TRANSACTION_TYPES" :key="t" :value="t">
            {{ TRANSACTION_TYPE_LABELS[t] }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>상태</span>
        <select v-model="status" data-testid="bulk-status">
          <option :value="KEEP">그대로 두기</option>
          <option v-for="s in EDITABLE_STATUSES" :key="s" :value="s">
            {{ TRANSACTION_STATUS_LABELS[s] }}
          </option>
        </select>
      </label>

      <p v-if="typeChanges.length" class="notice" data-testid="bulk-type-changes">
        유형도 함께 바뀝니다: {{ typeChanges.join(', ') }}
        <template v-if="type === 'transfer'"> (이체는 분류가 지워집니다)</template>
      </p>
      <label v-if="canRemember" class="remember">
        <input v-model="remember" type="checkbox" data-testid="bulk-remember" />
        <span>
          이 가맹점들은 앞으로도 이 분류로 자동 분류 ({{ rulePatterns.slice(0, 3).join(', ')
          }}{{ rulePatterns.length > 3 ? ` 외 ${rulePatterns.length - 3}곳` : '' }})
        </span>
      </label>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button type="button" class="btn" @click="emit('close')">취소</button>
      <button
        type="submit"
        form="bulk-form"
        class="btn btn-primary grow"
        :disabled="busy || nothing"
        data-testid="bulk-save"
      >
        {{ ids.length }}건 바꾸기
      </button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.small {
  margin: 0;
  font-size: 0.85rem;
}
.remember {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.9rem;
}
.remember input {
  width: auto;
  margin-top: 3px;
}
.grow {
  flex: 1;
}
</style>
