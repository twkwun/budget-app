<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  formatKrw,
  normalizeMerchant,
  parseYearMonth,
  type RecurringItem,
  type RecurringMonthItem,
  type RecurringOverview,
} from '@budget/shared';
import { api } from '../../api/client.ts';
import { errorMessage } from '../../auth/messages.ts';
import AmountInput from '../../components/AmountInput.vue';
import BottomSheet from '../../components/BottomSheet.vue';
import CategorySelect from '../../components/CategorySelect.vue';
import { dayLabel } from '../../ledger/format.ts';
import { useLedgerStore } from '../../stores/ledger.ts';

const ledger = useLedgerStore();
const data = ref<RecurringOverview | null>(null);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref(false);

async function run(action: () => Promise<void>): Promise<boolean> {
  busy.value = true;
  error.value = '';
  try {
    await action();
    return true;
  } catch (e) {
    error.value = errorMessage(e);
    return false;
  } finally {
    busy.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  await run(async () => {
    [data.value] = await Promise.all([api.get<RecurringOverview>('/recurring'), ledger.load()]);
  });
  loading.value = false;
}
onMounted(() => void load());

const STATE = { paid: '이번 달 결제됨', upcoming: '이번 달 예정', late: '이번 달 아직 없음' };
const seenText = (item: RecurringItem) =>
  item.seenMonths
    .slice(0, 4)
    .map((m) => `${parseYearMonth(m).month}월`)
    .reverse()
    .join('·');

const editing = ref<RecurringMonthItem | RecurringItem | 'new' | null>(null);
const form = reactive({
  name: '',
  matchKey: '',
  amount: 0,
  dayOfMonth: 1,
  categoryId: null as number | null,
  accountId: null as number | null,
});
const matchPreview = computed(() => normalizeMerchant(form.matchKey || form.name));

function open(target: RecurringItem | 'new'): void {
  editing.value = target;
  const item = target === 'new' ? null : target;
  Object.assign(form, {
    name: item?.name ?? '',
    matchKey: item?.matchKey ?? '',
    amount: item?.amount ?? 0,
    dayOfMonth: item?.dayOfMonth ?? 1,
    categoryId: item?.categoryId ?? null,
    accountId: item?.accountId ?? null,
  });
}

async function save(): Promise<void> {
  const target = editing.value;
  if (!target) return;
  const body = {
    name: form.name,
    amount: form.amount,
    dayOfMonth: form.dayOfMonth,
    categoryId: form.categoryId,
    accountId: form.accountId,
    matchKey: form.matchKey || form.name,
  };
  const ok = await run(async () => {
    if (target === 'new') {
      await api.post('/recurring', body);
      notice.value = `‘${form.name}’을 고정지출로 추가했습니다.`;
    } else {
      await api.patch(`/recurring/${target.id}`, body);
      notice.value = `‘${form.name}’을 저장했습니다.`;
    }
    data.value = await api.get<RecurringOverview>('/recurring');
  });
  if (ok) editing.value = null;
}

const setStatus = (item: RecurringItem, status: RecurringItem['status'], message: string) =>
  run(async () => {
    await api.patch(`/recurring/${item.id}`, { status });
    notice.value = message;
    data.value = await api.get<RecurringOverview>('/recurring');
  });

const remove = (item: RecurringItem) =>
  run(async () => {
    if (!window.confirm(`‘${item.name}’을 고정지출에서 뺄까요?`)) return;
    await api.delete(`/recurring/${item.id}`);
    notice.value = `‘${item.name}’을 뺐습니다.`;
    data.value = await api.get<RecurringOverview>('/recurring');
  });
</script>

<template>
  <section class="page recurring-page" data-testid="recurring-page">
    <h1>고정지출</h1>
    <p class="muted small">
      매달 나가는 돈을 등록해 두면 홈에서 이번 달에 아직 안 나간 것을 볼 수 있습니다. 같은
      가맹점에서 비슷한 금액이 석 달 이상 매달 한 번씩 나가면 후보로 찾아 드립니다. 금액이 ±20%
      안이면 결제된 것으로 봅니다.
    </p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="error-text" role="alert">
      {{ error }} <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <p v-if="loading && !data" class="muted">불러오는 중…</p>

    <template v-if="data">
      <section v-if="data.suggestions.length" aria-labelledby="suggest-title">
        <h2 id="suggest-title" class="section-title">
          확인할 후보 {{ data.suggestions.length }}건
        </h2>
        <div class="card">
          <ul class="row-list" data-testid="recurring-suggestions">
            <li v-for="s in data.suggestions" :key="s.id" class="item">
              <div class="row-main">
                <strong>{{ s.name }}</strong>
                <div class="row-sub">
                  매달 {{ s.dayOfMonth }}일쯤 ·
                  <span class="tabular">{{ formatKrw(s.amount) }}</span>
                  <template v-if="s.seenMonths.length"> · {{ seenText(s) }}에 결제</template>
                </div>
              </div>
              <div class="actions">
                <button
                  type="button"
                  class="btn btn-small btn-primary"
                  :disabled="busy"
                  data-testid="confirm-recurring"
                  @click="setStatus(s, 'confirmed', `‘${s.name}’을 고정지출로 등록했습니다.`)"
                >
                  등록
                </button>
                <button
                  type="button"
                  class="btn btn-small"
                  :disabled="busy"
                  @click="setStatus(s, 'dismissed', `‘${s.name}’은 다시 제안하지 않습니다.`)"
                >
                  아니에요
                </button>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="confirmed-title">
        <h2 id="confirmed-title" class="section-title">등록된 고정지출</h2>
        <div class="card">
          <ul class="row-list" data-testid="recurring-items">
            <li v-for="item in data.items" :key="item.id" class="item" :data-state="item.state">
              <div class="row-main">
                <strong>{{ item.name }}</strong>
                <div class="row-sub">
                  매달 {{ item.dayOfMonth }}일 ·
                  <span class="tabular">{{ formatKrw(item.amount) }}</span>
                  <template v-if="item.categoryName"> · {{ item.categoryName }}</template>
                </div>
                <div class="row-sub state">
                  <span aria-hidden="true">{{
                    item.state === 'paid' ? '✓' : item.state === 'late' ? '!' : '·'
                  }}</span>
                  {{ STATE[item.state] }}
                  <template v-if="item.paid">
                    ({{ dayLabel(item.paid.date) }}, {{ formatKrw(item.paid.amount) }})
                  </template>
                </div>
              </div>
              <div class="actions">
                <button
                  type="button"
                  class="btn btn-small"
                  :aria-label="`${item.name} 수정`"
                  @click="open(item)"
                >
                  수정
                </button>
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  :aria-label="`${item.name} 빼기`"
                  :disabled="busy"
                  @click="remove(item)"
                >
                  빼기
                </button>
              </div>
            </li>
            <li v-if="data.items.length === 0" class="muted">
              등록된 고정지출이 없습니다. 위의 후보를 등록하거나 직접 추가하세요.
            </li>
          </ul>
        </div>
        <button
          type="button"
          class="btn btn-primary add"
          data-testid="add-recurring"
          @click="open('new')"
        >
          직접 추가
        </button>
      </section>

      <details v-if="data.dismissed.length" class="card dismissed">
        <summary>제안하지 않기로 한 항목 {{ data.dismissed.length }}건</summary>
        <ul class="row-list">
          <li v-for="d in data.dismissed" :key="d.id" class="item">
            <div class="row-main">
              {{ d.name }}
              <div class="row-sub tabular">{{ formatKrw(d.amount) }}</div>
            </div>
            <button
              type="button"
              class="btn btn-small"
              :disabled="busy"
              @click="setStatus(d, 'confirmed', `‘${d.name}’을 고정지출로 등록했습니다.`)"
            >
              등록
            </button>
          </li>
        </ul>
      </details>
    </template>

    <BottomSheet
      v-if="editing"
      :title="editing === 'new' ? '고정지출 추가' : '고정지출 수정'"
      testid="recurring-sheet"
      @close="editing = null"
    >
      <form class="stack" @submit.prevent="save">
        <label class="field">
          <span>이름</span>
          <input v-model="form.name" maxlength="100" required data-testid="recurring-name" />
        </label>
        <label class="field">
          <span>금액 (±20%까지 같은 것으로 봅니다)</span>
          <AmountInput v-model="form.amount" testid="recurring-amount" />
        </label>
        <label class="field">
          <span>매달 결제일</span>
          <select v-model.number="form.dayOfMonth">
            <option v-for="d in 31" :key="d" :value="d">
              {{ d }}일{{ d >= 29 ? ' (말일)' : '' }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>분류</span>
          <CategorySelect
            v-model="form.categoryId"
            kind="expense"
            :keep="form.categoryId"
            empty-label="정하지 않음"
          />
        </label>
        <label class="field">
          <span>결제 수단</span>
          <select v-model="form.accountId">
            <option :value="null">정하지 않음</option>
            <option v-for="a in ledger.activeAccounts" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>가맹점 이름에 들어 있는 글자</span>
          <input v-model="form.matchKey" maxlength="100" :placeholder="form.name" />
          <small class="muted">
            결제 내역의 가맹점 이름에 ‘{{ matchPreview || '…' }}’가 들어 있으면 이 항목으로 봅니다.
          </small>
        </label>
        <button
          type="submit"
          class="btn btn-primary btn-block"
          :disabled="busy || !form.name.trim() || form.amount <= 0 || matchPreview.length < 2"
          data-testid="save-recurring"
        >
          저장
        </button>
      </form>
    </BottomSheet>
  </section>
</template>

<style scoped>
.recurring-page {
  display: grid;
  gap: 12px;
  max-width: 720px;
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.item {
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.state {
  margin-top: 2px;
}
[data-state='paid'] .state {
  color: var(--ok);
}
[data-state='late'] .state {
  color: var(--warn);
}
.add {
  margin-top: 10px;
}
.dismissed summary {
  cursor: pointer;
  min-height: 44px;
  display: flex;
  align-items: center;
}
</style>
