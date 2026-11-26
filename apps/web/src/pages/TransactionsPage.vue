<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  BULK_MAX,
  formatKrw,
  monthLabel,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  type DayTotal,
  type ListBasis,
  type TransactionInfo,
  type TransactionPage,
  type YearMonth,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import AccountTag from '../components/AccountTag.vue';
import BasisSwitch from '../components/BasisSwitch.vue';
import BulkEditSheet from '../components/BulkEditSheet.vue';
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
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
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
/** Selection mode for 일괄 수정. */
const selecting = ref(false);
const selected = ref(new Set<number>());
const bulkOpen = ref(false);
const notice = ref('');
let lastPicked: number | null = null;
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

const basis = computed<ListBasis>({
  get: () => filters.value.basis,
  set: (b) => setFilters({ ...filters.value, basis: b }),
});

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
  () => {
    selected.value = new Set();
    lastPicked = null;
    void loadFirst();
  },
);

// ------------------------------------------------------------ selection

function startSelecting(): void {
  selecting.value = true;
  notice.value = '';
}

function stopSelecting(): void {
  selecting.value = false;
  selected.value = new Set();
  lastPicked = null;
}

/** Click on a row: open it, or toggle it while selecting (Shift selects a range). */
function pick(tx: TransactionInfo, event?: MouseEvent | KeyboardEvent): void {
  if (!selecting.value) {
    editing.value = tx;
    return;
  }
  const next = new Set(selected.value);
  const index = items.value.findIndex((i) => i.id === tx.id);
  if (event?.shiftKey && lastPicked !== null) {
    const from = items.value.findIndex((i) => i.id === lastPicked);
    if (from >= 0) {
      const on = !next.has(tx.id);
      const [a, b] = from < index ? [from, index] : [index, from];
      for (const i of items.value.slice(a, b + 1)) {
        if (on) next.add(i.id);
        else next.delete(i.id);
      }
    }
  } else if (next.has(tx.id)) next.delete(tx.id);
  else next.add(tx.id);
  lastPicked = tx.id;
  selected.value = next;
}

function dayState(list: TransactionInfo[]): 'all' | 'some' | 'none' {
  const n = list.filter((t) => selected.value.has(t.id)).length;
  return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
}

function toggleDay(list: TransactionInfo[]): void {
  const next = new Set(selected.value);
  const on = dayState(list) !== 'all';
  for (const t of list) {
    if (on) next.add(t.id);
    else next.delete(t.id);
  }
  selected.value = next;
}

const allSelected = computed(
  () => !!totals.value && selected.value.size >= totals.value.count && totals.value.count > 0,
);

async function selectAll(): Promise<void> {
  error.value = '';
  try {
    const res = await api.get<{ ids: number[]; truncated: boolean }>(
      `/transactions/ids?${query(filters.value)}`,
    );
    selected.value = new Set(res.ids);
    if (res.truncated)
      notice.value = `한 번에 ${BULK_MAX.toLocaleString()}건까지 고를 수 있습니다.`;
  } catch (e) {
    error.value = errorMessage(e);
  }
}

const selectedKnown = computed(() => items.value.filter((t) => selected.value.has(t.id)));

function bulkDone(updated: number): void {
  bulkOpen.value = false;
  stopSelecting();
  notice.value = `${updated.toLocaleString()}건을 고쳤습니다.`;
  void loadFirst();
  void inbox.refresh();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && selecting.value && !bulkOpen.value) stopSelecting();
}

onMounted(() => {
  document.addEventListener('keydown', onKey);
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
  document.removeEventListener('keydown', onKey);
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
/** Only an admin sees other members' entries, so only an admin needs names on them. */
const multipleMembers = computed(() => auth.isAdmin && ledger.members.length > 1);
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
  <section class="page wide-page" :class="{ selecting }" data-testid="transactions-page">
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
        <button
          type="button"
          class="btn select-btn"
          :class="{ 'btn-primary': selecting }"
          data-testid="select-mode"
          @click="selecting ? stopSelecting() : startSelecting()"
        >
          {{ selecting ? '선택 끝' : '선택' }}
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
      <div class="summary-row">
        <p v-if="totals" class="totals tabular muted" data-testid="list-totals">
          {{ totals.count }}건 · 지출
          <span class="money-expense">{{ formatKrw(totals.expense) }}</span> · 수입
          <span class="money-income">{{ formatKrw(totals.income) }}</span>
        </p>
        <BasisSwitch v-model="basis" />
      </div>
      <p v-if="basis === 'billing'" class="hint muted">
        카드는 결제일에 돈이 빠져나가는 달({{ monthLabel(month) }} 결제분)로, 나머지는 쓴 날로
        모았습니다. 카드에 결제일이 없으면 쓴 날 기준입니다.
      </p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
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
          <button
            v-if="selecting"
            type="button"
            class="day-check"
            :aria-label="`${dayLabel(g.date)} 모두 선택`"
            @click="toggleDay(g.items)"
          >
            <span class="box" :class="dayState(g.items)" />
          </button>
          <strong>{{ dayLabel(g.date) }}</strong>
          <span class="tabular muted">
            <span v-if="dayIndex.get(g.date)?.expense" class="money-expense"
              >-{{ formatKrw(dayIndex.get(g.date)!.expense) }}</span
            >
            <span v-if="dayIndex.get(g.date)?.income" class="money-income">
              +{{ formatKrw(dayIndex.get(g.date)!.income) }}</span
            >
          </span>
        </header>
        <TransactionRow
          v-for="tx in g.items"
          :key="tx.id"
          :tx="tx"
          :show-owner="multipleMembers"
          :selectable="selecting"
          :selected="selected.has(tx.id)"
          @open="(e) => pick(tx, e)"
        />
      </section>
    </div>

    <!-- Wide screens: table -->
    <div v-else class="card table-wrap">
      <table class="table" data-testid="tx-table">
        <thead>
          <tr>
            <th v-if="selecting" scope="col" class="sel">
              <span class="sr-only">선택</span>
            </th>
            <th scope="col">시간</th>
            <th scope="col">내용</th>
            <th scope="col">분류</th>
            <th scope="col">수단</th>
            <th scope="col">결제월</th>
            <th scope="col">구성원</th>
            <th scope="col">상태</th>
            <th scope="col" class="num">금액</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.date">
          <tr class="day-row">
            <td v-if="selecting" class="sel">
              <button
                type="button"
                class="day-check"
                :aria-label="`${dayLabel(g.date)} 모두 선택`"
                @click="toggleDay(g.items)"
              >
                <span class="box" :class="dayState(g.items)" />
              </button>
            </td>
            <th colspan="7" scope="rowgroup">{{ dayLabel(g.date) }}</th>
            <td class="num tabular muted">
              <span v-if="dayIndex.get(g.date)?.expense" class="money-expense"
                >-{{ formatKrw(dayIndex.get(g.date)!.expense) }}</span
              >
              <span v-if="dayIndex.get(g.date)?.income" class="money-income">
                +{{ formatKrw(dayIndex.get(g.date)!.income) }}</span
              >
            </td>
          </tr>
          <tr
            v-for="tx in g.items"
            :key="tx.id"
            class="tx"
            :class="{ cancelled: tx.status === 'cancelled', selected: selected.has(tx.id) }"
            tabindex="0"
            data-testid="tx-row"
            :aria-selected="selecting ? selected.has(tx.id) : undefined"
            @click="pick(tx, $event)"
            @keydown.enter="pick(tx, $event)"
            @keydown.space.prevent="selecting && pick(tx, $event)"
          >
            <td v-if="selecting" class="sel">
              <span class="box" :class="{ all: selected.has(tx.id) }" aria-hidden="true" />
            </td>
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
            <td class="pay"><AccountTag :name="tx.accountName" :kind="tx.accountKind" /></td>
            <td
              class="tabular"
              :class="{ later: tx.billingMonth && tx.billingMonth !== tx.occurredDate.slice(0, 7) }"
            >
              <template v-if="tx.billingMonth">{{
                monthLabel(tx.billingMonth, tx.occurredDate.slice(0, 7))
              }}</template>
              <span v-else class="muted">—</span>
            </td>
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

    <div v-if="selecting" class="select-bar" role="toolbar" data-testid="select-bar">
      <span class="count tabular"
        ><strong>{{ selected.size.toLocaleString() }}</strong
        >건 선택</span
      >
      <button
        v-if="totals && !allSelected"
        type="button"
        class="btn btn-small"
        data-testid="select-all"
        @click="selectAll"
      >
        {{ totals.count.toLocaleString() }}건 모두
      </button>
      <button
        v-if="selected.size"
        type="button"
        class="btn btn-small"
        @click="selected = new Set()"
      >
        해제
      </button>
      <span class="grow" />
      <button
        type="button"
        class="btn btn-primary"
        :disabled="!selected.size"
        data-testid="bulk-edit"
        @click="bulkOpen = true"
      >
        한꺼번에 고치기
      </button>
    </div>

    <BulkEditSheet
      v-if="bulkOpen"
      :ids="[...selected]"
      :known="selectedKnown"
      @close="bulkOpen = false"
      @done="bulkDone"
    />
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
.filter-btn,
.select-btn {
  flex: none;
}
.summary-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hint {
  margin: 0;
  font-size: 0.8rem;
}
.sel {
  width: 28px;
  padding-right: 0 !important;
}
.day-check {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 28px;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}
.box {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  vertical-align: middle;
}
.box.all {
  border-color: var(--accent);
  background: var(--accent)
    url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="white" stroke-width="2.2"/></svg>')
    center / 12px no-repeat;
}
.box.some {
  border-color: var(--accent);
  background: linear-gradient(var(--accent), var(--accent)) center / 8px 2px no-repeat;
}
.day .day-check {
  margin: -8px 6px -8px -4px;
}
.day {
  align-items: center;
}
.day strong {
  flex: 1;
}
.tx.selected {
  background: var(--accent-soft);
}
/* Shift-click selects a range of rows, not text. */
.selecting .tx,
.selecting .group {
  user-select: none;
}
.pay {
  max-width: 260px;
  overflow: hidden;
}
.later {
  color: var(--accent);
  font-weight: 600;
}
.select-bar {
  position: sticky;
  bottom: calc(var(--tabbar-height) + var(--safe-bottom) + 8px);
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
}
@media (min-width: 720px) {
  .select-bar {
    bottom: 16px;
  }
}
.select-bar .grow {
  flex: 1;
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
.cancelled td,
.cancelled .amount {
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
