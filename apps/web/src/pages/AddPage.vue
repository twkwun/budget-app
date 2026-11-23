<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  formatKrw,
  ACCOUNT_KIND_LABELS,
  type AccountInfo,
  type EntryDefaults,
  type TransactionInfo,
  type TransactionType,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import AmountKeypad from '../components/AmountKeypad.vue';
import CategoryPicker from '../components/CategoryPicker.vue';
import TypeSwitch from '../components/TypeSwitch.vue';
import { fromLocalInput, signedAmount, toLocalInput } from '../ledger/format.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const auth = useAuthStore();
const ledger = useLedgerStore();

type Step = 'amount' | 'category' | 'details';
const step = ref<Step>('amount');
const type = ref<TransactionType>('expense');
const amount = ref(0);
const categoryId = ref<number | null>(null);
const accountId = ref<number | null>(null);
const ownerUserId = ref<number | null>(auth.user?.id ?? null);
const merchant = ref('');
const memo = ref('');
const occurredLocal = ref('');
const timeEdited = ref(false);
const defaults = ref<EntryDefaults | null>(null);
const busy = ref(false);
const error = ref('');
const saved = ref<TransactionInfo | null>(null);
const keypad = ref<InstanceType<typeof AmountKeypad> | null>(null);

const categoryLabel = computed(() =>
  categoryId.value === null ? '미분류' : (ledger.categoryIndex.get(categoryId.value)?.label ?? ''),
);
const accountOptions = computed<AccountInfo[]>(() => ledger.activeAccounts);

async function loadDefaults(): Promise<void> {
  defaults.value = await api.get<EntryDefaults>('/entry-defaults');
  if (accountId.value === null) accountId.value = defaults.value.accountId;
}

onMounted(async () => {
  try {
    await Promise.all([ledger.load(), loadDefaults()]);
  } catch (e) {
    error.value = errorMessage(e);
  }
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// Desktop keyboard: digits, Backspace and Enter on the amount step.
function onKey(event: KeyboardEvent): void {
  if (step.value !== 'amount' || event.target instanceof HTMLInputElement) return;
  if (/^\d$/.test(event.key)) keypad.value?.press(event.key);
  else if (event.key === 'Backspace') keypad.value?.press('back');
  else if (event.key === 'Enter' && amount.value > 0) next();
}

watch(type, () => {
  categoryId.value = null;
});

function next(): void {
  if (amount.value <= 0) return;
  if (!timeEdited.value) occurredLocal.value = toLocalInput(Date.now());
  step.value = type.value === 'transfer' ? 'details' : 'category';
}

function pickCategory(id: number | null): void {
  categoryId.value = id;
  step.value = 'details';
}

async function createCash(): Promise<void> {
  try {
    const cash = await api.post<AccountInfo>('/accounts', { kind: 'cash', name: '현금' });
    await ledger.load(true);
    accountId.value = cash.id;
    await loadDefaults();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function save(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const occurredAt = fromLocalInput(occurredLocal.value) ?? undefined;
    saved.value = await api.post<TransactionInfo>('/transactions', {
      type: type.value,
      amount: amount.value,
      occurredAt,
      categoryId: type.value === 'transfer' ? null : categoryId.value,
      accountId: accountId.value,
      ownerUserId: ownerUserId.value ?? undefined,
      merchant: merchant.value,
      memo: memo.value,
    });
    // Ready for the next entry: keep type, account and owner.
    amount.value = 0;
    categoryId.value = null;
    merchant.value = '';
    memo.value = '';
    timeEdited.value = false;
    step.value = 'amount';
    void loadDefaults();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page add" data-testid="add-page">
    <div class="top">
      <TypeSwitch v-model="type" />
    </div>

    <p v-if="saved" class="notice saved" role="status" data-testid="saved-notice">
      저장했습니다 · {{ saved.categoryName ?? '미분류' }}
      {{ signedAmount(saved.type, saved.amount) }}
      <RouterLink :to="{ path: '/transactions', query: { month: saved.occurredDate.slice(0, 7) } }"
        >내역 보기</RouterLink
      >
    </p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <!-- Step 1: amount -->
    <template v-if="step === 'amount'">
      <p class="step muted">1 / {{ type === 'transfer' ? 2 : 3 }} · 금액</p>
      <output
        class="amount tabular"
        :class="{ empty: amount === 0 }"
        data-testid="amount-display"
        aria-live="polite"
      >
        {{ formatKrw(amount) }}
      </output>
      <AmountKeypad ref="keypad" v-model="amount" />
      <button
        type="button"
        class="btn btn-primary btn-block next"
        :disabled="amount <= 0"
        data-testid="amount-next"
        @click="next"
      >
        다음
      </button>
    </template>

    <!-- Step 2: category -->
    <template v-else-if="step === 'category'">
      <p class="step muted">
        2 / 3 · 분류
        <button type="button" class="link-button" @click="step = 'amount'">
          {{ formatKrw(amount) }}
        </button>
      </p>
      <CategoryPicker
        :kind="type === 'income' ? 'income' : 'expense'"
        :recent="
          type === 'income'
            ? (defaults?.recentCategoryIds.income ?? [])
            : (defaults?.recentCategoryIds.expense ?? [])
        "
        :selected="categoryId"
        @pick="pickCategory"
      />
    </template>

    <!-- Step 3: details and save -->
    <template v-else>
      <p class="step muted">{{ type === 'transfer' ? '2 / 2' : '3 / 3' }} · 저장</p>
      <div class="card summary">
        <button type="button" class="link-button big tabular" @click="step = 'amount'">
          {{ signedAmount(type, amount) }}
        </button>
        <button
          v-if="type !== 'transfer'"
          type="button"
          class="link-button"
          @click="step = 'category'"
        >
          {{ categoryLabel }}
        </button>
      </div>
      <form class="stack" @submit.prevent="save">
        <label class="field">
          <span>가맹점·내용 (선택)</span>
          <input
            v-model="merchant"
            maxlength="100"
            autocomplete="off"
            data-testid="entry-merchant"
          />
        </label>
        <label class="field">
          <span>수단</span>
          <select v-model="accountId" data-testid="entry-account">
            <option :value="null">선택 안 함</option>
            <option v-for="a in accountOptions" :key="a.id" :value="a.id">
              {{ a.name }}{{ a.last4 ? ` ····${a.last4}` : '' }} ({{ ACCOUNT_KIND_LABELS[a.kind] }})
            </option>
          </select>
        </label>
        <p v-if="defaults && !defaults.hasOwnAccount" class="muted small">
          등록한 카드·계좌가 없습니다.
          <button type="button" class="link-button" data-testid="create-cash" @click="createCash">
            현금 수단 만들기
          </button>
          또는 <RouterLink to="/settings/accounts">카드·계좌 관리</RouterLink>
        </p>
        <label class="field">
          <span>날짜·시간</span>
          <input
            v-model="occurredLocal"
            type="datetime-local"
            required
            @input="timeEdited = true"
          />
        </label>
        <label v-if="ledger.activeMembers.length > 1" class="field">
          <span>누구 것</span>
          <select v-model="ownerUserId">
            <option v-for="m in ledger.activeMembers" :key="m.id" :value="m.id">
              {{ m.displayName }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>메모 (선택)</span>
          <input v-model="memo" maxlength="500" autocomplete="off" />
        </label>
        <button
          type="submit"
          class="btn btn-primary btn-block save"
          :disabled="busy"
          data-testid="entry-save"
        >
          저장
        </button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.add {
  max-width: 480px;
  margin: 0 auto;
}
.top {
  margin-bottom: 12px;
}
.step {
  font-size: 0.85rem;
  margin: 4px 0 8px;
}
.amount {
  display: block;
  font-size: 2.4rem;
  font-weight: 700;
  text-align: right;
  padding: 12px 4px 20px;
}
.amount.empty {
  color: var(--text-muted);
}
.next,
.save {
  margin-top: 12px;
  min-height: 52px;
}
.summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.big {
  font-size: 1.5rem;
  color: var(--text);
}
.saved {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.small {
  font-size: 0.85rem;
  margin: -4px 0 0;
}
</style>
