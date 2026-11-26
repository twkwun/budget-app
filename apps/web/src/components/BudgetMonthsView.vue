<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import {
  addMonths,
  currentYearMonth,
  formatKrw,
  isYearMonth,
  parseYearMonth,
  type BudgetMonthCell,
  type BudgetMonthRow,
  type BudgetMonthsReport,
  type YearMonth,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import { budgetLineSeries, excessItemStyle, splitOver } from '../charts/budget-marks.ts';
import type { ChartTheme } from '../charts/theme.ts';
import { compactKrw, monthLabel } from '../ledger/format.ts';
import { usePlanUser } from '../ledger/plan-user.ts';
import AppIcon from './AppIcon.vue';
import BottomSheet from './BottomSheet.vue';
import EChart from './EChart.vue';

/**
 * 월별 비교: budgets against spending for 6 or 12 months, one row per budget.
 * Over-budget cells carry an icon and a hatched background, not colour alone.
 */
const route = useRoute();
const router = useRouter();
const plan = usePlanUser();
const thisMonth = currentYearMonth();

const COUNTS = [6, 12] as const;
type Count = (typeof COUNTS)[number];

const count = computed<Count>({
  get: () => (route.query.count === '6' ? 6 : 12),
  set: (c) =>
    void router.replace({ query: { ...route.query, count: c === 12 ? undefined : String(c) } }),
});
const to = computed<YearMonth>({
  get: () => {
    const m = route.query.to;
    return typeof m === 'string' && isYearMonth(m) && m < thisMonth ? m : thisMonth;
  },
  set: (m) =>
    void router.replace({ query: { ...route.query, to: m >= thisMonth ? undefined : m } }),
});
const from = computed(() => addMonths(to.value, 1 - count.value));
const isLatest = computed(() => to.value >= thisMonth);
function shift(direction: -1 | 1): void {
  const next = addMonths(to.value, direction * count.value);
  to.value = next > thisMonth ? thisMonth : next;
}

const data = ref<BudgetMonthsReport | null>(null);
const loading = ref(true);
const error = ref('');
const scroller = ref<HTMLDivElement | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.get<BudgetMonthsReport>(
      `/budgets/months?to=${to.value}&count=${count.value}${plan.param.value}`,
    );
    // On a phone the latest months are the ones to see first.
    await nextTick();
    if (scroller.value) scroller.value.scrollLeft = scroller.value.scrollWidth;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch([to, count, plan.userId], () => void load());
onMounted(() => void load());

const rows = computed<BudgetMonthRow[]>(() =>
  data.value ? [...(data.value.overall ? [data.value.overall] : []), ...data.value.categories] : [],
);
const hasBudgets = computed(() => rows.value.length > 0);
const anyUnbudgeted = computed(() => data.value?.unbudgetedSpent.some((v) => v > 0) ?? false);

const shortMonth = (m: YearMonth, i: number) => {
  const { year, month } = parseYearMonth(m);
  return i === 0 || month === 1 ? `${String(year).slice(2)}.${month}월` : `${month}월`;
};
const rangeLabel = computed(() => `${monthLabel(from.value)} – ${monthLabel(to.value)}`);

/** Most-often-over category, for the summary line. */
const worst = computed(() => {
  const list = data.value?.categories.filter((c) => c.summary.overMonths > 0) ?? [];
  return (
    [...list].sort(
      (a, b) =>
        b.summary.overMonths / b.summary.budgetedMonths -
          a.summary.overMonths / a.summary.budgetedMonths ||
        b.summary.overMonths - a.summary.overMonths,
    )[0] ?? null
  );
});

function cellClass(c: BudgetMonthCell): Record<string, boolean> {
  const p = c.percent ?? 0;
  return {
    none: c.budget === null,
    over: c.over,
    high: !c.over && c.budget !== null && p >= 80,
    ahead: !c.over && c.pace?.status === 'ahead',
    current: c.current,
  };
}
function cellText(c: BudgetMonthCell): string {
  return c.percent === null ? '—' : `${c.percent}%`;
}
function cellLabel(row: BudgetMonthRow, c: BudgetMonthCell): string {
  const head = `${row.name} ${monthLabel(c.month)}${c.current ? '(진행 중)' : ''}`;
  if (c.budget === null) return `${head}: 예산 없음, ${formatKrw(c.spent)} 지출`;
  const state = c.over
    ? `${formatKrw(c.spent - c.budget)} 초과`
    : c.pace?.status === 'ahead'
      ? '예상보다 빠름'
      : `${formatKrw(c.budget - c.spent)} 남음`;
  return `${head}: 예산 ${formatKrw(c.budget)} 중 ${formatKrw(c.spent)} 사용, ${c.percent}%, ${state}`;
}
function cellLink(row: BudgetMonthRow, month: YearMonth): RouteLocationRaw {
  return {
    path: '/transactions',
    query: {
      month,
      type: 'expense',
      ...(row.categoryId === null ? {} : { category: String(row.categoryId) }),
      ...plan.ownerFilter.value,
    },
  };
}
function overText(row: BudgetMonthRow): string {
  const s = row.summary;
  return s.overMonths
    ? `${s.budgetedMonths}달 중 ${s.overMonths}번 초과`
    : `${s.budgetedMonths}달 모두 넘지 않음`;
}

// ---- Detail sheet ----
const selected = ref<BudgetMonthRow | null>(null);
const DETAIL_BAR_MAX_WIDTH = 18;
const detailChart = computed(() => {
  const row = selected.value;
  if (!row) return null;
  const { within, excess } = splitOver(
    row.cells.map((c) => c.spent),
    row.cells.map((c) => c.budget),
  );
  /** The month in progress is drawn lighter. */
  const dim = (i: number) => (row.cells[i]?.current ? { opacity: 0.6 } : {});
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: { dataIndex: number }[]) => {
        const c = row.cells[params[0]?.dataIndex ?? 0];
        if (!c) return '';
        return [
          monthLabel(c.month),
          `지출 ${formatKrw(c.spent)}`,
          c.budget === null ? '예산 없음' : `예산 ${formatKrw(c.budget)} (${c.percent}%)`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: row.cells.map((c, i) => shortMonth(c.month, i)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, fontSize: 11, interval: 0, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => compactKrw(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        type: 'bar',
        name: '지출',
        stack: 'spent',
        barMaxWidth: DETAIL_BAR_MAX_WIDTH,
        data: row.cells.map((c, i) => ({
          value: within[i] ?? c.spent,
          itemStyle: {
            color: theme.series[0],
            borderRadius: within[i] === null ? [4, 4, 0, 0] : 0,
            ...dim(i),
          },
        })),
      },
      {
        // Spending past the budget, hatched.
        type: 'bar',
        name: '예산 초과',
        stack: 'spent',
        barMaxWidth: DETAIL_BAR_MAX_WIDTH,
        itemStyle: excessItemStyle(theme),
        data: excess.map((v, i) => (v === '-' ? v : { value: v, itemStyle: dim(i) })),
      },
      {
        type: 'line',
        name: '예산',
        step: 'middle',
        symbol: 'none',
        connectNulls: false,
        lineStyle: { color: theme.text, width: 2, type: 'dashed' },
        data: row.cells.map((c) => c.budget),
      },
      // A solid line where the budget sits on each bar that went over.
      budgetLineSeries(theme, within, { count: 1, barMaxWidth: DETAIL_BAR_MAX_WIDTH }),
    ],
  });
});
function openMonth(item: { dataIndex: number; seriesIndex: number }): void {
  const row = selected.value;
  const c = row?.cells[item.dataIndex];
  if (!row || !c) return;
  void router.push(cellLink(row, c.month));
}
function editBudget(): void {
  selected.value = null;
  void router.push({ path: '/budgets', query: { month: thisMonth, ...plan.query.value } });
}
</script>

<template>
  <div class="budget-months" data-testid="budget-months">
    <div class="controls">
      <div class="range-nav">
        <button type="button" class="nav-btn" aria-label="이전 기간" @click="shift(-1)">
          <AppIcon name="chevron" :size="20" class="flip" />
        </button>
        <h1 class="range" aria-live="polite">{{ rangeLabel }}</h1>
        <button
          type="button"
          class="nav-btn"
          aria-label="다음 기간"
          :disabled="isLatest"
          @click="shift(1)"
        >
          <AppIcon name="chevron" :size="20" />
        </button>
      </div>
      <div class="segmented" role="radiogroup" aria-label="기간 길이">
        <button
          v-for="c in COUNTS"
          :key="c"
          type="button"
          role="radio"
          :aria-checked="count === c"
          :class="{ on: count === c }"
          :data-testid="`count-${c}`"
          @click="count = c"
        >
          {{ c }}개월
        </button>
      </div>
    </div>
    <p class="muted small">
      칸의 숫자는 그 달 예산 중 쓴 비율입니다. 칸을 누르면 그 달 내역, 분류 이름을 누르면 자세한
      그래프가 나옵니다.
    </p>

    <p v-if="error" class="error-text" role="alert">
      {{ error }} <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <p v-if="loading && !data" class="muted">불러오는 중…</p>

    <template v-if="data">
      <div v-if="!hasBudgets" class="card empty" data-testid="budget-months-empty">
        <p>{{ rangeLabel }}에는 정해 둔 예산이 없습니다.</p>
        <RouterLink
          :to="{ path: '/budgets', query: { month: thisMonth, ...plan.query.value } }"
          class="btn btn-primary"
        >
          예산 정하기
        </RouterLink>
      </div>

      <template v-else>
        <section class="card summary" aria-labelledby="summary-title" :aria-busy="loading">
          <h2 id="summary-title" class="sr-only">요약</h2>
          <p v-if="data.overall" data-testid="months-summary">
            <strong>전체 예산</strong>은 {{ overText(data.overall)
            }}<template v-if="data.overall.summary.avgPercent !== null"
              >, 지난 달들 평균 {{ data.overall.summary.avgPercent }}% 썼습니다.</template
            ><template v-else>입니다.</template>
          </p>
          <p v-if="worst">
            가장 자주 넘은 분류는 <strong>{{ worst.name }}</strong> ({{
              worst.summary.budgetedMonths
            }}달 중 {{ worst.summary.overMonths }}번)입니다.
          </p>
          <p v-else-if="data.categories.length">이 기간에 넘은 분류 예산은 없습니다.</p>
        </section>

        <section class="card matrix-card" aria-labelledby="matrix-title">
          <h2 id="matrix-title">분류별 예산 사용률</h2>
          <div
            ref="scroller"
            class="scroller"
            tabindex="0"
            aria-label="월별 예산 표, 옆으로 밀어 보기"
          >
            <table class="matrix" data-testid="budget-matrix">
              <thead>
                <tr>
                  <th scope="col" class="name-col">예산</th>
                  <th v-for="(m, i) in data.months" :key="m" scope="col" class="month-col">
                    {{ shortMonth(m, i) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="row.categoryId ?? 'all'"
                  :class="{ total: row.categoryId === null }"
                >
                  <th scope="row" class="name-col">
                    <button
                      type="button"
                      class="row-btn"
                      :data-testid="`row-${row.categoryId ?? 'all'}`"
                      @click="selected = row"
                    >
                      <span class="row-name">{{ row.name }}</span>
                      <span class="row-sub" :class="{ warn: row.summary.overMonths > 0 }">
                        {{
                          row.summary.overMonths
                            ? `초과 ${row.summary.overMonths}/${row.summary.budgetedMonths}`
                            : `초과 없음`
                        }}
                      </span>
                    </button>
                  </th>
                  <td v-for="c in row.cells" :key="c.month" class="cell" :class="cellClass(c)">
                    <RouterLink
                      :to="cellLink(row, c.month)"
                      :aria-label="cellLabel(row, c)"
                      :data-state="c.over ? 'over' : c.budget === null ? 'none' : 'ok'"
                    >
                      <span v-if="c.over" class="over-icon" aria-hidden="true">!</span>
                      <span class="tabular">{{ cellText(c) }}</span>
                    </RouterLink>
                  </td>
                </tr>
                <tr v-if="anyUnbudgeted" class="rest">
                  <th scope="row" class="name-col">
                    <span class="rest-name">
                      <span class="row-name">예산 없는 지출</span>
                      <span class="row-sub">다른 분류·미분류</span>
                    </span>
                  </th>
                  <td
                    v-for="(v, i) in data.unbudgetedSpent"
                    :key="data.months[i]"
                    class="num tabular muted"
                    :aria-label="`예산 없는 지출 ${monthLabel(data.months[i] ?? thisMonth)}: ${formatKrw(v)}`"
                  >
                    {{ v ? compactKrw(v) : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="legend" aria-label="표 읽는 법">
            <li>
              <span class="key over"><span class="over-icon">!</span></span
              >예산 초과
            </li>
            <li><span class="key high" />80% 이상</li>
            <li><span class="key current" />진행 중인 달</li>
            <li><span class="key none">—</span>그 달엔 예산 없음</li>
          </ul>
        </section>
      </template>
    </template>

    <BottomSheet
      v-if="selected"
      :title="`${selected.name} · 월별`"
      testid="budget-month-sheet"
      @close="selected = null"
    >
      <div class="stack detail">
        <EChart
          v-if="detailChart"
          :build="detailChart"
          :height="200"
          :label="`${selected.name} 월별 지출과 예산`"
          @select="openMonth"
        />
        <ul class="legend" aria-hidden="true">
          <li><span class="key bar" />지출</li>
          <li><span class="key dash" />예산</li>
          <li><span class="key bar over-bar" />예산을 넘은 만큼</li>
        </ul>
        <dl class="facts">
          <div>
            <dt>초과</dt>
            <dd>{{ overText(selected) }}</dd>
          </div>
          <div v-if="selected.summary.avgPercent !== null">
            <dt>평균 사용률</dt>
            <dd class="tabular">{{ selected.summary.avgPercent }}% (진행 중인 달 빼고)</dd>
          </div>
          <div v-if="selected.summary.budgetTotal">
            <dt>지난 달들 합계</dt>
            <dd class="tabular">
              {{ formatKrw(selected.summary.spentTotal) }} /
              {{ formatKrw(selected.summary.budgetTotal) }}
            </dd>
          </div>
        </dl>
        <ul class="row-list months-list">
          <li v-for="c in [...selected.cells].reverse()" :key="c.month">
            <RouterLink :to="cellLink(selected, c.month)" class="month-link">
              <span
                >{{ monthLabel(c.month)
                }}<span v-if="c.current" class="muted"> · 진행 중</span></span
              >
              <span class="tabular">
                <strong :class="{ 'over-text': c.over }">{{ formatKrw(c.spent) }}</strong>
                <span class="muted">
                  / {{ c.budget === null ? '예산 없음' : formatKrw(c.budget) }}
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>
        <button type="button" class="btn btn-block" @click="editBudget">
          이번 달 예산 보기·바꾸기
        </button>
      </div>
    </BottomSheet>
  </div>
</template>

<style scoped>
.budget-months {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.range-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}
.range {
  margin: 0;
  font-size: 1.05rem;
  text-align: center;
}
.nav-btn {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.nav-btn:disabled {
  opacity: 0.3;
}
.flip {
  transform: rotate(180deg);
}
.segmented {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.segmented button {
  min-height: 40px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.segmented .on {
  background: var(--accent-soft);
  color: var(--accent);
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.empty {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.empty p,
.summary p {
  margin: 0;
}
.summary {
  display: grid;
  gap: 6px;
  font-size: 0.92rem;
}
.matrix-card {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.matrix-card h2 {
  margin: 0;
}
.scroller {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.matrix {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.82rem;
  min-width: 100%;
}
.matrix thead th {
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: normal;
  white-space: nowrap;
  padding: 0 2px 4px;
}
.num {
  text-align: right;
}
.month-col {
  text-align: center;
}
.name-col {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--surface);
  text-align: left;
  font-weight: normal;
  min-width: 84px;
  max-width: 110px;
  padding: 0 8px 0 0;
  box-shadow: 1px 0 0 var(--border);
}
.row-btn {
  display: grid;
  width: 100%;
  min-height: 44px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.row-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.total .row-name {
  font-weight: 700;
}
.row-sub {
  font-size: 0.72rem;
  color: var(--text-muted);
}
.row-sub.warn {
  color: var(--error);
}
.rest-name {
  display: grid;
  min-height: 44px;
  align-content: center;
}
.rest td {
  padding: 0 6px;
  text-align: center;
  font-size: 0.75rem;
}
.cell {
  padding: 2px;
  min-width: 56px;
}
.cell a {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 44px;
  padding: 0 4px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  color: var(--text);
  text-decoration: none;
  font-weight: 600;
  white-space: nowrap;
}
.cell.high a {
  background: color-mix(in srgb, var(--warn) 18%, var(--surface));
}
.cell.ahead a {
  color: var(--warn);
}
.cell.over a {
  color: var(--error);
  background: repeating-linear-gradient(
    -45deg,
    color-mix(in srgb, var(--error) 20%, var(--surface)) 0 5px,
    color-mix(in srgb, var(--error) 8%, var(--surface)) 5px 10px
  );
}
.cell.none a {
  background: transparent;
  color: var(--text-muted);
  font-weight: normal;
}
.cell.current a {
  border: 1.5px dashed var(--text-muted);
}
.over-icon {
  display: inline-grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--error);
  color: var(--surface);
  font-size: 0.68rem;
  font-weight: 800;
  flex: none;
}
.legend {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 0;
  padding: 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.legend li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.key {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 14px;
  border-radius: 4px;
  font-size: 0.7rem;
}
.key.over {
  background: color-mix(in srgb, var(--error) 18%, var(--surface));
}
.key.over .over-icon {
  width: 11px;
  height: 11px;
  font-size: 0.55rem;
}
.key.high {
  background: color-mix(in srgb, var(--warn) 18%, var(--surface));
}
.key.current {
  border: 1.5px dashed var(--text-muted);
}
.key.bar {
  background: var(--series-1);
}
.key.over-bar {
  background: repeating-linear-gradient(
    -45deg,
    var(--error) 0 3px,
    color-mix(in srgb, var(--error) 60%, var(--surface)) 3px 6px
  );
  box-shadow: inset 0 2px 0 var(--text);
}
.key.dash {
  height: 0;
  border-top: 2px dashed var(--text);
  border-radius: 0;
}
.detail {
  display: grid;
  gap: 12px;
}
.facts {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 0.9rem;
}
.facts div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.facts dt {
  color: var(--text-muted);
}
.facts dd {
  margin: 0;
  text-align: right;
}
.months-list .month-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  width: 100%;
  color: var(--text);
  text-decoration: none;
  font-size: 0.9rem;
}
.over-text {
  color: var(--error);
}
</style>
