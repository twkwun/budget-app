<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  EDITABLE_STATUSES,
  isAggregatorMerchant,
  suggestRulePattern,
  TRANSACTION_STATUS_LABELS,
  type EditableStatus,
  type TransactionInfo,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import { fromLocalInput, toLocalInput } from '../ledger/format.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';
import AmountInput from './AmountInput.vue';
import BottomSheet from './BottomSheet.vue';
import CategorySelect from './CategorySelect.vue';
import TypeSwitch from './TypeSwitch.vue';

const props = defineProps<{ transaction: TransactionInfo }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const auth = useAuthStore();
const ledger = useLedgerStore();
const tx = props.transaction;

const type = ref(tx.type);
const amount = ref(tx.amount);
const categoryId = ref<number | null>(tx.categoryId);
const accountId = ref<number | null>(tx.accountId);
const ownerUserId = ref(tx.ownerUserId);
const occurredLocal = ref(toLocalInput(tx.occurredAt));
const merchant = ref(tx.merchant ?? '');
const memo = ref(tx.memo ?? '');
const status = ref<EditableStatus>(tx.status === 'pending' ? 'confirmed' : tx.status);
const remember = ref(false);
const busy = ref(false);
const error = ref('');

watch(type, (next, prev) => {
  if (next !== prev) categoryId.value = null;
});

/** DESIGN 6.4: after re-categorising an entry with a merchant, offer to remember it. */
const canRemember = computed(
  () =>
    type.value !== 'transfer' &&
    categoryId.value !== null &&
    categoryId.value !== tx.categoryId &&
    !!merchant.value.trim() &&
    !isAggregatorMerchant(merchant.value),
);
const rulePattern = computed(() => suggestRulePattern(merchant.value));

const accounts = computed(() =>
  ledger.accounts.filter((a) => !a.archived || a.id === tx.accountId),
);

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    emit('changed');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

const save = () =>
  run(async () => {
    await api.patch(`/transactions/${tx.id}`, {
      type: type.value,
      amount: amount.value,
      categoryId: type.value === 'transfer' ? null : categoryId.value,
      accountId: accountId.value,
      ownerUserId: ownerUserId.value,
      occurredAt: fromLocalInput(occurredLocal.value) ?? undefined,
      merchant: merchant.value,
      memo: memo.value,
      status: status.value,
    });
    if (remember.value && canRemember.value && categoryId.value) {
      await api.post('/rules', {
        pattern: rulePattern.value,
        categoryId: categoryId.value,
        applyToExisting: true,
      });
    }
  });

function remove(): void {
  if (!window.confirm('이 거래를 삭제할까요? 되돌릴 수 없습니다.')) return;
  void run(() => api.delete(`/transactions/${tx.id}`));
}
</script>

<template>
  <BottomSheet title="거래 수정" testid="edit-sheet" @close="emit('close')">
    <form id="tx-form" class="stack" @submit.prevent="save">
      <TypeSwitch v-model="type" />
      <label class="field">
        <span>금액</span>
        <AmountInput v-model="amount" testid="edit-amount" />
      </label>
      <label v-if="type !== 'transfer'" class="field">
        <span>분류</span>
        <CategorySelect
          v-model="categoryId"
          :kind="type === 'income' ? 'income' : 'expense'"
          :keep="tx.categoryId"
          testid="edit-category"
        />
      </label>
      <label v-if="canRemember" class="remember" data-testid="remember-rule">
        <input v-model="remember" type="checkbox" />
        <span>이 가맹점은 앞으로도 이렇게 (‘{{ rulePattern }}’이 들어간 가맹점은 자동 분류)</span>
      </label>
      <label class="field">
        <span>가맹점·내용</span>
        <input v-model="merchant" maxlength="100" />
      </label>
      <label class="field">
        <span>날짜·시간</span>
        <input v-model="occurredLocal" type="datetime-local" required />
      </label>
      <label class="field">
        <span>수단</span>
        <select v-model="accountId">
          <option :value="null">선택 안 함</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">
            {{ a.name }}{{ a.archived ? ' (보관됨)' : '' }}
          </option>
        </select>
      </label>
      <label v-if="auth.isAdmin && ledger.members.length > 1" class="field">
        <span>누구 것</span>
        <select v-model="ownerUserId">
          <option
            v-for="m in ledger.members.filter((m) => !m.disabled || m.id === tx.ownerUserId)"
            :key="m.id"
            :value="m.id"
          >
            {{ m.displayName }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>메모</span>
        <input v-model="memo" maxlength="500" />
      </label>
      <fieldset class="field status">
        <legend>상태</legend>
        <div class="status-options">
          <label
            v-for="s in EDITABLE_STATUSES"
            :key="s"
            class="status-option"
            :class="{ on: status === s }"
          >
            <input v-model="status" type="radio" :value="s" :data-testid="`status-${s}`" />
            {{ TRANSACTION_STATUS_LABELS[s] }}
          </label>
        </div>
        <p v-if="status === 'cancelled'" class="muted small">취소된 거래는 합계에서 빠집니다.</p>
      </fieldset>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button
        type="button"
        class="btn btn-danger"
        :disabled="busy"
        data-testid="edit-delete"
        @click="remove"
      >
        삭제
      </button>
      <button
        type="submit"
        form="tx-form"
        class="btn btn-primary grow"
        :disabled="busy || amount <= 0"
        data-testid="edit-save"
      >
        저장
      </button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.remember {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px;
  border-radius: 10px;
  background: var(--accent-soft);
  font-size: 0.85rem;
}
.remember input {
  width: auto;
  margin-top: 2px;
}
.grow {
  flex: 1;
}
.status {
  border: 0;
  padding: 0;
  margin: 0;
}
.status legend {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 0.9rem;
  margin-bottom: 4px;
}
.status-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.status-option {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  font-weight: 600;
}
.status-option input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}
.status-option.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.small {
  font-size: 0.8rem;
  margin: 4px 0 0;
}
</style>
