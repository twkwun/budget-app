<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import {
  addMonths,
  currentYearMonth,
  formatKrw,
  parseYearMonth,
  type BudgetMonthsReport,
  type ListBasis,
  type RangeStats,
  type YearMonth,
  type YearStats,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import { budgetLineSeries, excessItemStyle, splitOver } from '../charts/budget-marks.ts';
import type { ChartTheme } from '../charts/theme.ts';
import AppIcon from '../components/AppIcon.vue';
import BasisSwitch from '../components/BasisSwitch.vue';
import BudgetSpendView, { type BudgetSpendRow } from '../components/BudgetSpendView.vue';
import EChart from '../components/EChart.vue';
import ScopeSwitch from '../components/ScopeSwitch.vue';
import { basisFromQuery } from '../ledger/basis.ts';
import { changeRatio, compactKrw, monthLabel } from '../ledger/format.ts';
import { useAuthStore } from '../stores/auth.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ledger = useLedgerStore();

type Mode = 'months' | 'year';
const thisMonth = currentYearMonth();
const thisYear = parseYearMonth(thisMonth).year;

const mode = computed<Mode>({
  get: () => (route.query.mode === 'year' ? 'year' : 'months'),
  set: (m) =>
    void router.replace({ query: { ...route.query, mode: m === 'year' ? 'year' : undefined } }),
});
const year = computed<number>({
  get: () => {
    const y = Number(route.query.year);
    return Number.isInteger(y) && y >= 2001 && y <= thisYear ? y : thisYear;
  },
  set: (y) =>
    void router.replace({
      query: { ...route.query, year: y === thisYear ? undefined : String(y) },
    }),
});
const scope = computed<'all' | number>({
  get: () => {
    const o = Number(route.query.owner);
    return Number.isSafeInteger(o) && o > 0 ? o : 'all';
  },
  set: (o) =>
    void router.replace({ query: { ...route.query, owner: o === 'all' ? undefined : String(o) } }),
});

const basis = computed<ListBasis>({
  get: () => basisFromQuery(route.query),
  set: (b) => void router.replace({ query: { ...route.query, basis: b } }),
});

const stats = ref<RangeStats | YearStats | null>(null);
/** Overall budget per month of the shown period, from 예산 › 월별 비교. */
const budgetReport = ref<BudgetMonthsReport | null>(null);
const loading = ref(true);
const error = ref('');

/**
 * Budgets are personal: a member's own, or — for an admin — the picked
 * member's (the admin's own in 가족 전체, though not set against those bars).
 */
const budgetQuery = computed(() =>
  typeof scope.value === 'number' ? { user: String(scope.value) } : {},
);

/** Budgets are optional here: a failure only hides the budget marks. */
async function loadBudgets(): Promise<void> {
  const last = mode.value === 'year' ? `${year.value}-12` : thisMonth;
  const to = last > thisMonth ? thisMonth : last;
  const user = budgetQuery.value.user ? `&user=${budgetQuery.value.user}` : '';
  try {
    budgetReport.value = await api.get<BudgetMonthsReport>(
      `/budgets/months?to=${to}&count=12${user}`,
    );
  } catch {
    budgetReport.value = null;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  void loadBudgets();
  try {
    stats.value =
      mode.value === 'year'
        ? await api.get<YearStats>(
            `/stats/year?year=${year.value}&owner=${scope.value}&basis=${basis.value}`,
          )
        : await api.get<RangeStats>(
            `/stats/range?from=${addMonths(thisMonth, -11)}&to=${thisMonth}&owner=${scope.value}&basis=${basis.value}`,
          );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch([mode, year, scope, basis], () => void load());
onMounted(() => {
  void load();
  void ledger.load().catch(() => {});
});

const yearStats = computed(() =>
  stats.value && 'previous' in stats.value ? (stats.value as YearStats) : null,
);
const empty = computed(
  () => !!stats.value && stats.value.totals.expense === 0 && stats.value.totals.income === 0,
);
/** Months that have started (a year view of the current year stops at this month). */
const elapsedMonths = computed(
  () => stats.value?.months.filter((m) => m.month <= thisMonth).length ?? 0,
);
const average = computed(() =>
  stats.value && elapsedMonths.value
    ? Math.round(stats.value.totals.expense / elapsedMonths.value)
    : 0,
);

const shortMonth = (m: YearMonth) => {
  const { year: y, month } = parseYearMonth(m);
  return month === 1 && mode.value === 'months' ? `${String(y).slice(2)}년 1월` : `${month}월`;
};

function listLink(month: YearMonth, extra: Record<string, string> = {}): RouteLocationRaw {
  return {
    path: '/transactions',
    query: {
      month,
      basis: basis.value,
      ...(scope.value === 'all' ? {} : { ownerId: String(scope.value) }),
      ...extra,
    },
  };
}

/** `작년` for a finished year, `작년 1~11월` for the year in progress. */
const prevLabel = computed(() => {
  const through = yearStats.value?.previous.through;
  if (!through || through.endsWith('-12')) return '작년';
  return `작년 1~${parseYearMonth(through).month}월`;
});

function compare(current: number, previous: number): string {
  const ratio = changeRatio(current, previous);
  if (ratio === null) return '작년 기록 없음';
  const diff = current - previous;
  if (diff === 0) return '작년과 같음';
  return `${prevLabel.value}보다 ${formatKrw(Math.abs(diff))} ${diff > 0 ? '▲' : '▼'} ${Math.abs(Math.round(ratio * 100))}%`;
}

// ---- Monthly 지출·수입 ----
/**
 * A budget is one person's, counted on their spending by the day it happened,
 * so it is only set against bars of that person by date. An admin's 가족 전체
 * bars hold everyone's spending, so they need a member picked first.
 */
const familyScope = computed(() => auth.isAdmin && scope.value === 'all');
const budgetComparable = computed(() => !familyScope.value && basis.value === 'date');
/** Why budget marks are hidden, when they are. */
const budgetHiddenNote = computed(() =>
  familyScope.value
    ? '예산은 사람마다 따로 정합니다. 위에서 구성원을 고르고 「사용일 기준」으로 보면 그 사람의 예산과 견줘 볼 수 있습니다.'
    : '예산은 쓴 날 기준으로 셉니다. 「사용일 기준」으로 바꾸면 보입니다.',
);
const hasOverallBudget = computed(() => !!budgetReport.value?.overall);
/** Overall budget per shown month (null: none that month, or not comparable). */
const monthBudgets = computed<(number | null)[]>(() => {
  const months = stats.value?.months ?? [];
  const cells = budgetReport.value?.overall?.cells ?? [];
  if (!budgetComparable.value) return months.map(() => null);
  const byMonth = new Map(cells.map((c) => [c.month, c.budget]));
  return months.map((m) => byMonth.get(m.month) ?? null);
});
const budgetedMonths = computed(() => monthBudgets.value.filter((b) => b != null).length);
const overMonths = computed(
  () =>
    stats.value?.months.filter((m, i) => {
      const b = monthBudgets.value[i];
      return b != null && m.expense > b;
    }).length ?? 0,
);

const BAR_MAX_WIDTH = 12;
const BAR_GAP = '15%';

const monthly = computed(() => {
  const s = stats.value;
  if (!s) return null;
  const months = s.months;
  const previous = yearStats.value?.previous.months ?? null;
  const budgets = monthBudgets.value;
  const { within, excess } = splitOver(
    months.map((m) => m.expense),
    budgets,
  );
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const m = months[i];
        if (!m) return '';
        const lines = [monthLabel(m.month), `지출 ${formatKrw(m.expense)}`];
        const b = budgets[i];
        if (b != null) {
          lines.push(
            m.expense > b
              ? `예산 ${formatKrw(b)} · <b>${formatKrw(m.expense - b)} 초과</b>`
              : `예산 ${formatKrw(b)} · ${formatKrw(b - m.expense)} 남음`,
          );
        }
        lines.push(`수입 ${formatKrw(m.income)}`);
        if (previous?.[i]) lines.push(`작년 지출 ${formatKrw(previous[i].expense)}`);
        return lines.join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: months.map((m) => shortMonth(m.month)),
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
        stack: 'expense',
        barMaxWidth: BAR_MAX_WIDTH,
        barGap: BAR_GAP,
        itemStyle: { color: theme.series[0] },
        data: months.map((m, i) => ({
          value: within[i] ?? m.expense,
          itemStyle: { borderRadius: within[i] === null ? [4, 4, 0, 0] : 0 },
        })),
      },
      {
        // Spending past the budget, hatched like the budget bars.
        type: 'bar',
        name: '예산 초과',
        stack: 'expense',
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: excessItemStyle(theme),
        data: excess,
      },
      {
        type: 'bar',
        name: '수입',
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: { color: theme.series[2], borderRadius: [4, 4, 0, 0] },
        data: months.map((m) => m.income),
      },
      ...(previous
        ? [
            {
              type: 'line',
              name: '작년 지출',
              symbol: 'circle',
              symbolSize: 5,
              lineStyle: { color: theme.other, width: 2, type: 'dashed' },
              itemStyle: { color: theme.other },
              data: previous.map((m) => m.expense),
            },
          ]
        : []),
      // The budget line across the expense bar of each month that went over.
      budgetLineSeries(theme, within, { count: 2, barGap: BAR_GAP, barMaxWidth: BAR_MAX_WIDTH }),
    ],
  });
});

/** Series: 0 지출 (within budget), 1 예산 초과, 2 수입; the rest are lines and marks. */
function openMonth(item: { dataIndex: number; seriesIndex: number }): void {
  const m = stats.value?.months[item.dataIndex];
  if (!m || item.seriesIndex > 2) return;
  void router.push(listLink(m.month, { type: item.seriesIndex === 2 ? 'income' : 'expense' }));
}

// ---- Monthly 예산·지출 (overall and per category) ----
const budgetMonthRoute = (month: YearMonth): RouteLocationRaw => ({
  path: '/budgets',
  query: { month, ...budgetQuery.value },
});
const budgetMonthsRoute = computed<RouteLocationRaw>(() => ({
  path: '/budgets',
  query: { view: 'months', ...budgetQuery.value },
}));
const overallRows = computed<BudgetSpendRow[]>(() =>
  (stats.value?.months ?? []).map((m, i) => ({
    month: m.month,
    spent: m.expense,
    budget: monthBudgets.value[i] ?? null,
  })),
);
const showOverallBudget = computed(() => budgetComparable.value && budgetedMonths.value > 0);

/** Categories with a budget in the period, as 예산 › 월별 비교 lists them. */
const budgetCategories = computed(() => budgetReport.value?.categories ?? []);
const pickedCategory = ref<number | null>(null);
const budgetCategory = computed(
  () =>
    budgetCategories.value.find((c) => c.categoryId === pickedCategory.value) ??
    budgetCategories.value[0] ??
    null,
);
/** The picked category's budget and spending on the months the page shows. */
const categoryBudgetRows = computed<BudgetSpendRow[]>(() => {
  const row = budgetCategory.value;
  const cells = new Map((row?.cells ?? []).map((c) => [c.month, c]));
  return (stats.value?.months ?? []).map((m) => {
    const c = cells.get(m.month);
    return { month: m.month, spent: c?.spent ?? 0, budget: c?.budget ?? null };
  });
});
function categorySpendLink(month: YearMonth): RouteLocationRaw {
  const id = budgetCategory.value?.categoryId;
  return listLink(month, { type: 'expense', ...(id == null ? {} : { category: String(id) }) });
}
const expenseLink = (month: YearMonth) => listLink(month, { type: 'expense' });

// ---- Category trend ----
const TOP_CATEGORIES = 6;
interface CategoryRow {
  /** -1 = the folded 기타 row; null = 미분류. */
  categoryId: number | null;
  name: string;
  total: number;
  values: number[];
  colorIndex: number | null;
}
const categoryRows = computed<CategoryRow[]>(() => {
  const s = stats.value;
  if (!s) return [];
  const rows: CategoryRow[] = s.categories
    .slice(0, TOP_CATEGORIES)
    .map((c, i) => ({ ...c, colorIndex: i }));
  const rest = s.categories.slice(TOP_CATEGORIES);
  if (rest.length) {
    rows.push({
      categoryId: -1,
      name: `기타 (${rest.length}개 분류)`,
      total: rest.reduce((n, c) => n + c.total, 0),
      values: s.months.map((_, i) => rest.reduce((n, c) => n + (c.values[i] ?? 0), 0)),
      colorIndex: null,
    });
  }
  return rows;
});
const previousByCategory = (id: number | null): number | null => {
  const prev = yearStats.value?.previous.categories;
  if (!prev || id === -1) return null;
  return prev[id === null ? 'none' : String(id)] ?? 0;
};

const categoryChart = computed(() => {
  const s = stats.value;
  const rows = categoryRows.value;
  if (!s) return null;
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataIndex: number; seriesName: string; value: number }) =>
        `${monthLabel(s.months[p.dataIndex]?.month ?? thisMonth)}<br/>${p.seriesName} ${formatKrw(p.value)}`,
    },
    xAxis: {
      type: 'category',
      data: s.months.map((m) => shortMonth(m.month)),
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
    series: rows.map((c) => ({
      type: 'bar',
      name: c.name,
      stack: 'categories',
      barMaxWidth: 18,
      itemStyle: {
        color: c.colorIndex === null ? theme.other : theme.series[c.colorIndex],
        borderColor: theme.surface,
        borderWidth: 1,
      },
      data: c.values,
    })),
  });
});

function openCategory(item: { dataIndex: number; seriesIndex: number }): void {
  const m = stats.value?.months[item.dataIndex];
  const c = categoryRows.value[item.seriesIndex];
  if (!m || !c || c.categoryId === -1) return;
  void router.push(
    listLink(m.month, {
      type: 'expense',
      category: c.categoryId === null ? 'none' : String(c.categoryId),
    }),
  );
}
const lastMonth = computed<YearMonth>(() => {
  const months = stats.value?.months ?? [];
  return [...months].reverse().find((m) => m.month <= thisMonth)?.month ?? thisMonth;
});

// ---- Members ----
const members = computed(() => stats.value?.members.filter((m) => m.expense || m.income) ?? []);
const memberChart = computed(() => {
  const list = members.value;
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    grid: { left: 8, right: 16, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v: number) => formatKrw(v),
    },
    xAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => compactKrw(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: list.map((m) => m.name),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.text, fontSize: 12 },
    },
    series: [
      {
        type: 'bar',
        name: '지출',
        barMaxWidth: 16,
        itemStyle: { color: theme.series[0], borderRadius: [0, 4, 4, 0] },
        data: list.map((m) => m.expense),
      },
    ],
  });
});
const share = (amount: number) =>
  stats.value?.totals.expense
    ? `${Math.round((amount / stats.value.totals.expense) * 1000) / 10}%`
    : '—';

// ---- Merchants ----
const merchantMax = computed(() =>
  Math.max(1, ...(stats.value?.merchants.map((m) => m.amount) ?? [])),
);

const periodLabel = computed(() =>
  mode.value === 'year'
    ? `${year.value}년`
    : `${monthLabel(addMonths(thisMonth, -11))} ~ ${monthLabel(thisMonth)}`,
);
</script>

<template>
  <section class="page stats" data-testid="stats-page">
    <header class="head">
      <h1>통계</h1>
      <div class="controls">
        <div class="segmented" role="radiogroup" aria-label="기간">
          <button
            type="button"
            role="radio"
            :aria-checked="mode === 'months'"
            :class="{ on: mode === 'months' }"
            data-testid="mode-months"
            @click="mode = 'months'"
          >
            최근 12개월
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="mode === 'year'"
            :class="{ on: mode === 'year' }"
            data-testid="mode-year"
            @click="mode = 'year'"
          >
            연도
          </button>
        </div>
        <div v-if="mode === 'year'" class="year-nav">
          <button type="button" class="nav-btn" aria-label="이전 해" @click="year = year - 1">
            <AppIcon name="chevron" :size="20" class="flip" />
          </button>
          <strong aria-live="polite">{{ year }}년</strong>
          <button
            type="button"
            class="nav-btn"
            aria-label="다음 해"
            :disabled="year >= thisYear"
            @click="year = year + 1"
          >
            <AppIcon name="chevron" :size="20" />
          </button>
        </div>
      </div>
      <ScopeSwitch
        v-if="auth.isAdmin && ledger.activeMembers.length > 1"
        v-model="scope"
        :members="ledger.activeMembers"
      />
      <BasisSwitch v-model="basis" />
      <p class="muted small">
        {{ periodLabel }} · 이체와 취소된 거래는 빠집니다.<template v-if="basis === 'billing'">
          카드는 결제일에 돈이 나가는 달로 셉니다.</template
        >
      </p>
    </header>

    <p v-if="error" class="error-text" role="alert">
      {{ error }} <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <p v-if="loading && !stats" class="muted">불러오는 중…</p>

    <template v-if="stats">
      <div class="kpis" :aria-busy="loading">
        <div class="card kpi">
          <span class="muted">지출 합계</span>
          <strong class="value tabular" data-testid="stats-expense">{{
            formatKrw(stats.totals.expense)
          }}</strong>
          <span v-if="yearStats" class="delta muted">{{
            compare(stats.totals.expense, yearStats.previous.totals.expense)
          }}</span>
          <span v-else class="delta muted">월평균 {{ formatKrw(average) }}</span>
        </div>
        <div class="card kpi">
          <span class="muted">수입 합계</span>
          <strong class="value tabular">{{ formatKrw(stats.totals.income) }}</strong>
          <span v-if="yearStats" class="delta muted">{{
            compare(stats.totals.income, yearStats.previous.totals.income)
          }}</span>
          <span v-else class="delta muted"
            >남은 돈 {{ formatKrw(stats.totals.income - stats.totals.expense) }}</span
          >
        </div>
      </div>

      <div v-if="empty" class="card empty" data-testid="stats-empty">
        <p>{{ periodLabel }}에는 지출·수입 기록이 없습니다.</p>
        <RouterLink to="/add" class="btn btn-primary">거래 추가</RouterLink>
      </div>

      <div v-else class="grid">
        <section class="card wide" aria-labelledby="monthly-title">
          <h2 id="monthly-title">월별 지출·수입</h2>
          <ul class="legend-inline" aria-hidden="true">
            <li><span class="swatch" style="background: var(--series-1)" />지출</li>
            <li><span class="swatch" style="background: var(--series-3)" />수입</li>
            <li v-if="yearStats"><span class="swatch dashed" />{{ year - 1 }}년 지출</li>
            <li v-if="overMonths"><span class="swatch hatched" />예산 초과 (흰 선 = 예산)</li>
          </ul>
          <EChart
            v-if="monthly"
            :build="monthly"
            :height="200"
            label="월별 지출과 수입 막대 그래프. 전체 예산을 넘은 달은 지출 막대에 예산 자리 선과 넘은 부분 빗금이 있습니다. 막대를 누르면 그 달 내역이 열립니다. 아래 표와 같은 내용입니다. 예산과 견준 숫자는 월별 예산·지출에 있습니다."
            data-testid="monthly-chart"
            @select="openMonth"
          />
          <details class="table-toggle" data-testid="monthly-table">
            <summary>표로 보기</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">달</th>
                  <th scope="col" class="num">지출</th>
                  <th scope="col" class="num">수입</th>
                  <th v-if="yearStats" scope="col" class="num">작년 지출</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, i) in stats.months" :key="m.month">
                  <th scope="row">
                    <RouterLink :to="listLink(m.month, { type: 'expense' })">{{
                      monthLabel(m.month)
                    }}</RouterLink>
                  </th>
                  <td class="num tabular">{{ formatKrw(m.expense) }}</td>
                  <td class="num tabular">{{ formatKrw(m.income) }}</td>
                  <td v-if="yearStats" class="num tabular muted">
                    {{ formatKrw(yearStats.previous.months[i]?.expense ?? 0) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </section>

        <section
          class="card wide"
          aria-labelledby="budget-monthly-title"
          data-testid="budget-monthly"
        >
          <div class="card-head">
            <h2 id="budget-monthly-title">월별 예산·지출</h2>
            <RouterLink :to="budgetMonthsRoute" class="link-button"> 분류별 보기 </RouterLink>
          </div>
          <BudgetSpendView
            v-if="showOverallBudget"
            :rows="overallRows"
            budget-name="전체 예산"
            :this-month="thisMonth"
            :short-month="shortMonth"
            :spend-link="expenseLink"
            :budget-link="budgetMonthRoute"
            testid="budget-monthly"
          />
          <p
            v-else-if="hasOverallBudget || familyScope"
            class="muted small"
            data-testid="budget-monthly-hidden"
          >
            {{ budgetHiddenNote }}
          </p>
          <p v-else class="muted small" data-testid="budget-monthly-none">
            이 기간에는 전체 예산이 없습니다.
            <RouterLink to="/budgets">예산 화면</RouterLink>에서 정하면 달마다 예산과 지출을 견줘 볼
            수 있습니다.
          </p>
        </section>

        <section
          class="card wide"
          aria-labelledby="category-budget-title"
          data-testid="category-budget-monthly"
        >
          <div class="card-head">
            <h2 id="category-budget-title">월별 분류 예산·지출</h2>
            <RouterLink :to="budgetMonthsRoute" class="link-button"> 한눈에 비교 </RouterLink>
          </div>
          <template v-if="budgetComparable && budgetCategory">
            <div
              class="pick-category"
              role="radiogroup"
              aria-label="분류 고르기"
              data-testid="category-budget-pick"
            >
              <button
                v-for="c in budgetCategories"
                :key="c.categoryId ?? 0"
                type="button"
                role="radio"
                :aria-checked="c.categoryId === budgetCategory.categoryId"
                :class="{ on: c.categoryId === budgetCategory.categoryId }"
                @click="pickedCategory = c.categoryId"
              >
                {{ c.name }}
              </button>
            </div>
            <BudgetSpendView
              :key="budgetCategory.categoryId ?? 0"
              :rows="categoryBudgetRows"
              :budget-name="`${budgetCategory.name} 예산`"
              :this-month="thisMonth"
              :short-month="shortMonth"
              :spend-link="categorySpendLink"
              :budget-link="budgetMonthRoute"
              testid="category-budget"
            />
          </template>
          <p
            v-else-if="budgetCategories.length || familyScope"
            class="muted small"
            data-testid="category-budget-hidden"
          >
            {{ budgetHiddenNote }}
          </p>
          <p v-else class="muted small" data-testid="category-budget-none">
            이 기간에는 분류 예산이 없습니다.
            <RouterLink to="/budgets">예산 화면</RouterLink>에서 식비·쇼핑처럼 분류마다 예산을
            정하면 달마다 견줘 볼 수 있습니다.
          </p>
        </section>

        <section class="card wide" aria-labelledby="category-title">
          <div class="card-head">
            <h2 id="category-title">분류별 지출 추이</h2>
            <RouterLink :to="budgetMonthsRoute" class="link-button" data-testid="to-budget-months">
              예산 대비 보기
            </RouterLink>
          </div>
          <p v-if="categoryRows.length === 0" class="muted small">이 기간에는 지출이 없습니다.</p>
          <template v-else>
            <EChart
              v-if="categoryChart"
              :build="categoryChart"
              :height="200"
              label="달마다 분류별 지출을 쌓은 막대 그래프. 조각을 누르면 그 달 그 분류의 내역이 열립니다. 아래 목록과 같은 내용입니다."
              @select="openCategory"
            />
            <table class="cat-table" data-testid="category-table">
              <thead>
                <tr>
                  <th scope="col">분류</th>
                  <th scope="col" class="num">합계</th>
                  <th v-if="yearStats" scope="col" class="num">{{ prevLabel }}</th>
                  <th v-else scope="col" class="num">월평균</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in categoryRows" :key="c.categoryId ?? 'none'">
                  <th scope="row">
                    <span
                      class="swatch"
                      :style="{
                        background:
                          c.colorIndex === null
                            ? 'var(--series-other)'
                            : `var(--series-${c.colorIndex + 1})`,
                      }"
                      aria-hidden="true"
                    />
                    <RouterLink
                      v-if="c.categoryId !== -1"
                      :to="
                        listLink(lastMonth, {
                          type: 'expense',
                          category: c.categoryId === null ? 'none' : String(c.categoryId),
                        })
                      "
                      >{{ c.name }}</RouterLink
                    >
                    <span v-else>{{ c.name }}</span>
                  </th>
                  <td class="num tabular">{{ formatKrw(c.total) }}</td>
                  <td v-if="yearStats" class="num tabular muted">
                    {{
                      previousByCategory(c.categoryId) === null
                        ? '—'
                        : formatKrw(previousByCategory(c.categoryId)!)
                    }}
                  </td>
                  <td v-else class="num tabular muted">
                    {{ formatKrw(Math.round(c.total / Math.max(1, elapsedMonths))) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <details class="table-toggle">
              <summary>달마다 보기</summary>
              <div class="scroll">
                <table class="matrix">
                  <thead>
                    <tr>
                      <th scope="col">분류</th>
                      <th v-for="m in stats.months" :key="m.month" scope="col" class="num">
                        {{ shortMonth(m.month) }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in categoryRows" :key="c.categoryId ?? 'none'">
                      <th scope="row">{{ c.name }}</th>
                      <td v-for="(v, i) in c.values" :key="i" class="num tabular">
                        <RouterLink
                          v-if="v && c.categoryId !== -1"
                          :to="
                            listLink(stats.months[i]!.month, {
                              type: 'expense',
                              category: c.categoryId === null ? 'none' : String(c.categoryId),
                            })
                          "
                          >{{ compactKrw(v) }}</RouterLink
                        >
                        <template v-else>{{ v ? compactKrw(v) : '·' }}</template>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
          </template>
        </section>

        <section
          v-if="scope === 'all' && members.length > 1"
          class="card"
          aria-labelledby="member-title"
          data-testid="member-section"
        >
          <h2 id="member-title">구성원별 지출</h2>
          <p class="muted small">거래의 ‘누구 것’ 기준입니다.</p>
          <EChart
            :build="memberChart"
            :height="Math.max(80, members.length * 44)"
            label="구성원별 지출 가로 막대 그래프. 아래 표와 같은 내용입니다."
          />
          <table>
            <thead>
              <tr>
                <th scope="col">구성원</th>
                <th scope="col" class="num">지출</th>
                <th scope="col" class="num">비율</th>
                <th scope="col" class="num">수입</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in members" :key="m.userId">
                <th scope="row">
                  <button type="button" class="link-button" @click="scope = m.userId">
                    {{ m.name }}
                  </button>
                </th>
                <td class="num tabular">{{ formatKrw(m.expense) }}</td>
                <td class="num tabular muted">{{ share(m.expense) }}</td>
                <td class="num tabular">{{ formatKrw(m.income) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="card" aria-labelledby="merchant-title">
          <h2 id="merchant-title">많이 쓴 가맹점</h2>
          <p v-if="stats.merchants.length === 0" class="muted small">가맹점 기록이 없습니다.</p>
          <ol v-else class="merchants" data-testid="merchant-list">
            <li v-for="m in stats.merchants" :key="m.merchant">
              <div class="m-head">
                <span class="m-name">{{ m.merchant }}</span>
                <span class="tabular">{{ formatKrw(m.amount) }}</span>
              </div>
              <div class="m-bar" aria-hidden="true">
                <span :style="{ width: `${(m.amount / merchantMax) * 100}%` }" />
              </div>
              <span class="muted tiny">{{ m.count }}건</span>
            </li>
          </ol>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.stats {
  display: grid;
  gap: 12px;
  max-width: 1100px;
}
.head {
  display: grid;
  gap: 10px;
}
.head h1,
.head p {
  margin: 0;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
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
.year-nav {
  display: flex;
  align-items: center;
  gap: 4px;
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
.small {
  font-size: 0.85rem;
  margin: 0;
}
.tiny {
  font-size: 0.75rem;
}
.kpis {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.kpi {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.kpi .value {
  font-size: 1.3rem;
}
.delta {
  font-size: 0.78rem;
}
.grid {
  display: grid;
  gap: 12px;
}
.grid > .card {
  display: grid;
  gap: 10px;
  align-content: start;
  min-width: 0;
}
.grid h2 {
  margin: 0;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.empty {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.empty p {
  margin: 0;
}
.legend-inline {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
  padding: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}
.legend-inline li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.swatch {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  margin-right: 6px;
  vertical-align: -1px;
}
.legend-inline .swatch {
  margin-right: 0;
}
.pick-category {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.pick-category button {
  flex: none;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 600;
  cursor: pointer;
}
.pick-category .on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.swatch.hatched {
  background: repeating-linear-gradient(
    -45deg,
    var(--error) 0 3px,
    color-mix(in srgb, var(--error) 60%, var(--surface)) 3px 6px
  );
  box-shadow: inset 0 2px 0 var(--text);
}
.swatch.dashed {
  height: 0;
  border-top: 2px dashed var(--series-other);
  border-radius: 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th,
td {
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
  font-weight: normal;
}
thead th {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.num {
  text-align: right;
  padding-left: 8px;
  white-space: nowrap;
}
tbody th a,
tbody td a {
  color: var(--text);
}
.table-toggle summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 0.85rem;
  min-height: 44px;
  display: flex;
  align-items: center;
}
.scroll {
  overflow-x: auto;
}
.matrix th[scope='row'] {
  white-space: nowrap;
  padding-right: 8px;
  position: sticky;
  left: 0;
  background: var(--surface);
}
.merchants {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.merchants li {
  display: grid;
  gap: 3px;
}
.m-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9rem;
}
.m-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-hover);
  overflow: hidden;
}
.m-bar span {
  display: block;
  height: 100%;
  background: var(--series-1);
  border-radius: 999px;
}
@media (min-width: 1024px) {
  .grid {
    grid-template-columns: 1fr 1fr;
  }
  .grid > .wide {
    grid-column: 1 / -1;
  }
}
</style>
