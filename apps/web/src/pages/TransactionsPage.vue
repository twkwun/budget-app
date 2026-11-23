<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  formatKrw,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  type DayTotal,
  type TransactionInfo,
  type TransactionPage,
  type YearMonth,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import FilterSheet from '../components/FilterSheet.vue';
import MonthNav from '../components/MonthNav.vue';
import TransactionForm from '../components/TransactionForm.vue';
import TransactionRow from '../components/TransactionRow.vue';
import {
  activeFilterCount,
  filtersFromQuery,
  filtersToQuery,
  type ListFilters,
} from '../ledger/filters.ts';
import { dayLabel, signedAmount, timeLabel } from '../ledger/format.ts';
import { useInboxStore } from '../stores/inbox.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const route = useRoute();
const router = useRouter();
const ledger = useLedgerStore();
const inbox = useInboxStore();

const filters = computed(() => filtersFromQuery(route.query));
const items = ref<TransactionInfo[]>([]);
const days = ref<DayTotal[]>([]);
const totals = ref<TransactionPage['totals']>();
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const filterOpen = ref(false);
const editing = ref<TransactionInfo | null>(null);
const search = ref(filters.value.q ?? '');
const sentinel = ref<HTMLElement | null>(null);
const wide = ref(false);
let generation = 0;
let observer: IntersectionObserver | null = null;
const media = window.matchMedia('(min-width: 1024px)');
const onMedia = () => (wide.value = media.matches);

function query(f: ListFilters, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ ...filtersToQuery(f), ...extra }).toString();
}

async function loadFirst(): Promise<void> {
  const mine = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const page = await api.get<TransactionPage>(`/transactions?${query(filters.value)}`);
    if (mine !== generation) return;
    items.value = page.items;
    days.value = page.days ?? [];
    totals.value = page.totals;
    cursor.value = page.nextCursor;
  } catch (e) {
    if (mine === generation) error.value = errorMessage(e);
  } finally {
    if (mine === generation) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!cursor.value || loading.value) return;
  const mine = generation;
  loading.value = true;
  try {
    const page = await api.get<TransactionPage>(
      `/transactions?${query(filters.value, { cursor: cursor.value })}`,
    );
    if (mine !== generation) return;
    items.value.push(...page.items);
    cursor.value = page.nextCursor;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    if (mine === generation) loading.value = false;
  }
}

function setFilters(next: ListFilters): void {
  void router.replace({ query: filtersToQuery(next) });
}

const month = computed<YearMonth>({
  get: () => filters.value.month,
  set: (m) => setFilters({ ...filters.value, month: m }),
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (q) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setFilters({ ...filters.value, q: q.trim() || undefined }), 300);
});

watch(
  () => route.query,
  () => void loadFirst(),
);

onMounted(() => {
  onMedia();
  media.addEventListener('change', onMedia);
  void ledger.load().catch(() => {});
  void loadFirst();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    },
    { rootMargin: '400px' },
  );
  if (sentinel.value) observer.observe(sentinel.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  media.removeEventListener('change', onMedia);
});

const dayIndex = computed(() => new Map(days.value.map((d) => [d.date, d])));
const groups = computed(() => {
  const out: { date: string; items: TransactionInfo[] }[] = [];
  for (const tx of items.value) {
    const last = out.at(-1);
    if (last?.date === tx.occurredDate) last.items.push(tx);
    else out.push({ date: tx.occurredDate, items: [tx] });
  }
  return out;
});
const multipleMembers = computed(() => ledger.members.length > 1);
const filterCount = computed(() => activeFilterCount(filters.value));

const chips = computed(() => {
  const f = filters.value;
  const out: { key: keyof ListFilters; label: string }[] = [];
  if (f.type) out.push({ key: 'type', label: TRANSACTION_TYPE_LABELS[f.type] });
  if (f.category === 'none') out.push({ key: 'category', label: '미분류' });
  else if (f.category)
    out.push({ key: 'category', label: ledger.categoryIndex.get(f.category)?.label ?? '분류' });
  if (f.accountId)
    out.push({
      key: 'accountId',
      label: ledger.accounts.find((a) => a.id === f.accountId)?.name ?? '수단',
    });
  if (f.ownerId)
    out.push({
      key: 'ownerId',
      label: ledger.members.find((m) => m.id === f.ownerId)?.displayName ?? '구성원',
    });
  if (f.status) out.push({ key: 'status', label: TRANSACTION_STATUS_LABELS[f.status] });
  if (f.minAmount) out.push({ key: 'minAmount', label: `${formatKrw(f.minAmount)} 이상` });
  if (f.maxAmount) out.push({ key: 'maxAmount', label: `${formatKrw(f.maxAmount)} 이하` });
  return out;
});

function removeChip(key: keyof ListFilters): void {
  setFilters({ ...filters.value, [key]: undefined });
}

function changed(): void {
  editing.value = null;
  void loadFirst();
  void inbox.refresh();
}
</script>

<template>
  <section class="page wide-page" data-testid="transactions-page">
    <header class="head">
      <MonthNav v-model="month" />
      <div class="tools">
        <label class="search">
          <span class="sr-only">검색</span>
          <input
            v-model="search"
            type="search"
            placeholder="가맹점·메모 검색"
            data-testid="search"
          />
        </label>
        <button
          type="button"
          class="btn filter-btn"
          data-testid="open-filters"
          @click="filterOpen = true"
        >
          필터<span v-if="filterCount" class="badge badge-accent">{{ filterCount }}</span>
        </button>
      </div>
      <div v-if="chips.length" class="chips">
        <button
          v-for="c in chips"
          :key="c.key"
          type="button"
          class="chip"
          @click="removeChip(c.key)"
        >
          {{ c.label }} ✕
        </button>
      </div>
      <p v-if="totals" class="totals tabular muted" data-testid="list-totals">
        {{ totals.count }}건 · 지출 {{ formatKrw(totals.expense) }} · 수입
        {{ formatKrw(totals.income) }}
      </p>
    </header>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div
      v-if="!loading && items.length === 0 && !error"
      class="card empty"
      data-testid="empty-list"
    >
      <p v-if="chips.length || filters.q">조건에 맞는 거래가 없습니다.</p>
      <template v-else>
        <p>이 달에는 기록된 거래가 없습니다.</p>
        <RouterLink to="/add" class="btn btn-primary">거래 추가</RouterLink>
      </template>
    </div>

    <!-- Phone and tablet: grouped list -->
    <div v-else-if="!wide" class="groups">
      <section v-for="g in groups" :key="g.date" class="card group">
        <header class="day">
          <strong>{{ dayLabel(g.date) }}</strong>
          <span class="tabular muted">
            <template v-if="dayIndex.get(g.date)?.expense"
              >-{{ formatKrw(dayIndex.get(g.date)!.expense) }}</template
            >
            <template v-if="dayIndex.get(g.date)?.income">
              +{{ formatKrw(dayIndex.get(g.date)!.income) }}</template
            >
          </span>
        </header>
        <TransactionRow
          v-for="tx in g.items"
          :key="tx.id"
          :tx="tx"
          :show-owner="multipleMembers"
          @open="editing = tx"
        />
      </section>
    </div>

    <!-- Wide screens: table -->
    <div v-else class="card table-wrap">
      <table class="table" data-testid="tx-table">
        <thead>
          <tr>
            <th scope="col">시간</th>
            <th scope="col">내용</th>
            <th scope="col">분류</th>
            <th scope="col">수단</th>
            <th scope="col">구성원</th>
            <th scope="col">상태</th>
            <th scope="col" class="num">금액</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.date">
          <tr class="day-row">
            <th colspan="6" scope="rowgroup">{{ dayLabel(g.date) }}</th>
            <td class="num tabular muted">
              <template v-if="dayIndex.get(g.date)?.expense"
                >-{{ formatKrw(dayIndex.get(g.date)!.expense) }}</template
              >
              <template v-if="dayIndex.get(g.date)?.income">
                +{{ formatKrw(dayIndex.get(g.date)!.income) }}</template
              >
            </td>
          </tr>
          <tr
            v-for="tx in g.items"
            :key="tx.id"
            class="tx"
            :class="{ cancelled: tx.status === 'cancelled' }"
            tabindex="0"
            data-testid="tx-row"
            @click="editing = tx"
            @keydown.enter="editing = tx"
          >
            <td class="tabular muted">{{ timeLabel(tx.occurredAt) }}</td>
            <td>
              {{ tx.merchant || '—' }}<span v-if="tx.memo" class="muted"> · {{ tx.memo }}</span>
              <span v-if="tx.hasSms" class="source" title="카드 문자로 등록·확인됨">문자</span>
              <span v-if="tx.sources.includes('file')" class="source" title="파일로 가져옴"
                >파일</span
              >
              <span
                v-if="tx.confirmed"
                class="source confirmed"
                title="두 곳 이상에서 같은 거래가 확인됨"
                >확인됨</span
              >
            </td>
            <td :class="{ uncategorized: !tx.categoryName && tx.type !== 'transfer' }">
              {{ tx.type === 'transfer' ? '이체' : (tx.categoryName ?? '미분류') }}
            </td>
            <td>{{ tx.accountName ?? '—' }}</td>
            <td>{{ tx.ownerName }}</td>
            <td>{{ tx.status === 'confirmed' ? '' : TRANSACTION_STATUS_LABELS[tx.status] }}</td>
            <td class="num tabular amount" :class="tx.type">
              {{ signedAmount(tx.type, tx.amount) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div ref="sentinel" class="sentinel" aria-hidden="true" />
    <p v-if="loading" class="muted center">불러오는 중…</p>
    <button v-else-if="cursor" type="button" class="btn btn-block" @click="loadMore">
      더 보기
    </button>

    <FilterSheet
      v-if="filterOpen"
      :filters="filters"
      @close="filterOpen = false"
      @apply="
        (f) => {
          filterOpen = false;
          setFilters(f);
        }
      "
    />
    <TransactionForm
      v-if="editing"
      :transaction="editing"
      @close="editing = null"
      @changed="changed"
    />
  </section>
</template>

<style scoped>
.wide-page {
  max-width: 1100px;
}
.head {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}
.tools {
  display: flex;
  gap: 8px;
}
.search {
  flex: 1;
}
.filter-btn {
  flex: none;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.85rem;
  cursor: pointer;
}
.totals {
  margin: 0;
  font-size: 0.85rem;
}
.groups {
  display: grid;
  gap: 10px;
}
.group {
  padding: 4px 12px;
}
.day {
  display: flex;
  justify-content: space-between;
  padding: 10px 4px 6px;
  border-bottom: 1px solid var(--border);
  font-size: 0.9rem;
}
.group :deep(.row + .row) {
  border-top: 1px solid var(--border);
}
.empty {
  text-align: center;
  display: grid;
  gap: 8px;
  justify-items: center;
}
.table-wrap {
  padding: 0;
  overflow-x: auto;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.table th,
.table td {
  padding: 10px 12px;
  text-align: left;
  white-space: nowrap;
}
.table thead th {
  color: var(--text-muted);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.day-row th,
.day-row td {
  background: var(--surface-hover);
  font-weight: 600;
}
.tx {
  cursor: pointer;
  border-top: 1px solid var(--border);
}
.tx:hover {
  background: var(--surface-hover);
}
.num {
  text-align: right !important;
}
.amount {
  font-weight: 700;
}
.amount.income {
  color: var(--accent);
}
.cancelled td {
  color: var(--text-muted);
  text-decoration: line-through;
}
.uncategorized {
  color: var(--warn);
  font-weight: 600;
}
.source {
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 0.72rem;
  font-weight: 600;
}
.source.confirmed {
  border-color: var(--accent);
  color: var(--accent);
}
.sentinel {
  height: 1px;
}
.center {
  text-align: center;
}
</style>
