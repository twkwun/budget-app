<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  addMonths,
  currentYearMonth,
  formatKrw,
  isYearMonth,
  type BudgetOverview,
  type YearMonth,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import AmountInput from '../components/AmountInput.vue';
import BottomSheet from '../components/BottomSheet.vue';
import BudgetMeter from '../components/BudgetMeter.vue';
import MonthNav from '../components/MonthNav.vue';
import { monthLabel } from '../ledger/format.ts';

const route = useRoute();
const router = useRouter();

const month = computed<YearMonth>({
  get: () => {
    const m = route.query.month;
    return typeof m === 'string' && isYearMonth(m) ? m : currentYearMonth();
  },
  set: (m) => void router.replace({ query: { ...route.query, month: m } }),
});
/** Budgets can be planned up to a year ahead. */
const maxMonth = addMonths(currentYearMonth(), 12);

const data = ref<BudgetOverview | null>(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get<BudgetOverview>(`/budgets?month=${month.value}`);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch(month, () => void load());
onMounted(() => void load());

/** Categories without a budget this month, for 분류 예산 추가. */
const unbudgeted = computed(() => {
  const set = new Set(data.value?.categories.map((c) => c.categoryId));
  return (data.value?.categoryOptions ?? []).filter((c) => !set.has(c.id));
});

interface Editing {
  categoryId: number | null;
  name: string;
  amount: number;
  current: number;
}
const editing = ref<Editing | null>(null);
const pickCategory = ref<number | null>(null);

function edit(categoryId: number | null, name: string, current: number): void {
  editing.value = { categoryId, name, amount: current, current };
}
function addCategory(): void {
  const option = unbudgeted.value.find((c) => c.id === pickCategory.value);
  if (option) edit(option.id, option.name, 0);
}

async function save(amount: number): Promise<void> {
  if (!editing.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.put('/budgets', {
      month: month.value,
      categoryId: editing.value.categoryId,
      amount,
    });
    notice.value =
      amount === 0
        ? `${monthLabel(month.value)}부터 ‘${editing.value.name}’ 예산을 없앴습니다.`
        : `${monthLabel(month.value)}부터 ‘${editing.value.name}’ 예산을 ${formatKrw(amount)}으로 정했습니다.`;
    editing.value = null;
    pickCategory.value = null;
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

const historyLabel = (amount: number) => (amount === 0 ? '예산 없앰' : formatKrw(amount));
const changedAt = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
};
</script>

<template>
  <section class="page budgets-page" data-testid="budgets-page">
    <header class="head">
      <MonthNav v-model="month" :max="maxMonth" />
      <p class="muted small">
        예산은 정한 달부터 다시 바꿀 때까지 매달 그대로 적용됩니다. 바꿔도 지난 달은 그대로입니다.
        분류 예산에는 하위 분류의 지출도 포함되고, 이체는 빠집니다.
      </p>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error-text" role="alert">
      {{ error }} <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <p v-if="loading && !data" class="muted">불러오는 중…</p>

    <template v-if="data">
      <section class="card block" aria-labelledby="overall-title">
        <div class="block-head">
          <h2 id="overall-title">전체 예산</h2>
          <button
            type="button"
            class="btn btn-small"
            data-testid="edit-overall"
            @click="edit(null, '전체 예산', data.overall?.amount ?? 0)"
          >
            {{ data.overall ? '변경' : '정하기' }}
          </button>
        </div>
        <BudgetMeter v-if="data.overall" :budget="data.overall" primary />
        <p v-else class="muted small">
          {{ monthLabel(month) }}에는 전체 예산이 없습니다. 한 달 동안 쓸 금액을 정해 보세요.
        </p>
        <p v-if="data.overall" class="muted tiny">
          {{ monthLabel(data.overall.since) }}에 정한 금액
        </p>
      </section>

      <section class="card block" aria-labelledby="category-title">
        <h2 id="category-title">분류 예산</h2>
        <ul v-if="data.categories.length" class="meters">
          <li v-for="b in data.categories" :key="b.categoryId ?? 0">
            <BudgetMeter :budget="b" />
            <div class="meter-actions">
              <span class="muted tiny">{{ monthLabel(b.since) }}부터</span>
              <RouterLink
                :to="{
                  path: '/transactions',
                  query: { month, type: 'expense', category: String(b.categoryId) },
                }"
                class="link-button"
              >
                내역
              </RouterLink>
              <button
                type="button"
                class="btn btn-small"
                :aria-label="`${b.name} 예산 변경`"
                @click="edit(b.categoryId, b.name, b.amount)"
              >
                변경
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="muted small">식비처럼 신경 쓰이는 분류에만 따로 정할 수 있습니다.</p>
        <div v-if="unbudgeted.length" class="add-row">
          <label class="sr-only" for="budget-category">분류 선택</label>
          <select id="budget-category" v-model="pickCategory" data-testid="budget-category">
            <option :value="null" disabled>분류 선택</option>
            <option v-for="c in unbudgeted" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button
            type="button"
            class="btn"
            :disabled="pickCategory === null"
            data-testid="add-category-budget"
            @click="addCategory"
          >
            분류 예산 추가
          </button>
        </div>
      </section>

      <section class="card block" aria-labelledby="history-title">
        <h2 id="history-title">바꾼 기록</h2>
        <ul v-if="data.history.length" class="row-list history" data-testid="budget-history">
          <li v-for="h in data.history" :key="h.id">
            <div class="row-main">
              <strong>{{ monthLabel(h.month) }}부터</strong> · {{ h.name }}
              <div class="row-sub">
                {{ h.updatedByName ?? '알 수 없음' }} · {{ changedAt(h.updatedAt) }}
              </div>
            </div>
            <span class="tabular">{{ historyLabel(h.amount) }}</span>
          </li>
        </ul>
        <p v-else class="muted small">아직 정한 예산이 없습니다.</p>
      </section>
    </template>

    <BottomSheet
      v-if="editing"
      :title="`${editing.name} · ${monthLabel(month)}부터`"
      testid="budget-sheet"
      @close="editing = null"
    >
      <form class="stack" @submit.prevent="save(editing.amount)">
        <label class="field">
          <span>한 달 예산</span>
          <AmountInput v-model="editing.amount" testid="budget-amount" />
        </label>
        <p class="muted small">
          {{ monthLabel(month) }}과 그 뒤의 달에 적용됩니다. 그 전 달은 바뀌지 않습니다.
        </p>
        <button
          type="submit"
          class="btn btn-primary btn-block"
          :disabled="busy || editing.amount <= 0"
          data-testid="save-budget"
        >
          저장
        </button>
        <button
          v-if="editing.current > 0"
          type="button"
          class="btn btn-danger btn-block"
          :disabled="busy"
          @click="save(0)"
        >
          이 달부터 예산 없애기
        </button>
      </form>
    </BottomSheet>
  </section>
</template>

<style scoped>
.budgets-page {
  display: grid;
  gap: 12px;
  max-width: 720px;
}
.head {
  display: grid;
  gap: 6px;
}
.head p {
  margin: 0;
}
.block {
  display: grid;
  gap: 12px;
}
.block h2 {
  margin: 0;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.meters {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 16px;
}
.meter-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.meter-actions .tiny {
  margin-right: auto;
}
.meter-actions .link-button {
  min-height: 44px;
  padding: 0 8px;
}
.add-row {
  display: flex;
  gap: 8px;
}
.add-row select {
  flex: 1;
  min-width: 0;
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.tiny {
  font-size: 0.78rem;
  margin: 0;
}
.history .tabular {
  white-space: nowrap;
}
</style>
