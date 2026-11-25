<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  currentYearMonth,
  formatKrw,
  isYearMonth,
  type CategoryShare,
  type HomeSummary,
  type ListBasis,
  type YearMonth,
} from '@budget/shared';
import { api } from '../api/client.ts';
import { errorMessage } from '../auth/messages.ts';
import type { ChartTheme } from '../charts/theme.ts';
import BasisSwitch from '../components/BasisSwitch.vue';
import BudgetMeter from '../components/BudgetMeter.vue';
import EChart from '../components/EChart.vue';
import MonthNav from '../components/MonthNav.vue';
import ScopeSwitch from '../components/ScopeSwitch.vue';
import { basisFromQuery } from '../ledger/basis.ts';
import { changeRatio, compactKrw, dayLabel, monthLabel } from '../ledger/format.ts';
import { useHealthStore } from '../stores/health.ts';
import { useLedgerStore } from '../stores/ledger.ts';

const route = useRoute();
const router = useRouter();
const ledger = useLedgerStore();
const health = useHealthStore();

const month = computed<YearMonth>({
  get: () => {
    const m = route.query.month;
    return typeof m === 'string' && isYearMonth(m) ? m : currentYearMonth();
  },
  set: (m) => void router.replace({ query: { ...route.query, month: m } }),
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

const summary = ref<HomeSummary | null>(null);
const loading = ref(true);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    summary.value = await api.get<HomeSummary>(
      `/summary?month=${month.value}&owner=${scope.value}&basis=${basis.value}`,
    );
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

watch([month, scope, basis], () => void load());
onMounted(() => {
  void load();
  void ledger.load().catch(() => {});
  void health.check();
});

/** Donut slices: the seven largest categories, the rest folded into 기타. */
const MAX_SLICES = 7;
const slices = computed(() => {
  const shares = summary.value?.expenseByCategory ?? [];
  const head = shares.slice(0, MAX_SLICES);
  const rest = shares.slice(MAX_SLICES);
  const out: (CategoryShare & { colorIndex: number | null; link: object | null })[] = head.map(
    (s, i) => ({
      ...s,
      colorIndex: i,
      link: {
        path: '/transactions',
        query: {
          month: month.value,
          basis: basis.value,
          type: 'expense',
          category: s.categoryId ?? 'none',
          ...(scope.value === 'all' ? {} : { ownerId: scope.value }),
        },
      },
    }),
  );
  if (rest.length) {
    out.push({
      categoryId: -1,
      name: `기타 (${rest.length}개 분류)`,
      amount: rest.reduce((n, s) => n + s.amount, 0),
      count: rest.reduce((n, s) => n + s.count, 0),
      colorIndex: null,
      link: null,
    });
  }
  return out;
});

const pct = (amount: number) =>
  summary.value?.expense ? `${Math.round((amount / summary.value.expense) * 1000) / 10}%` : '';

const donut = computed(() => {
  const data = slices.value;
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    tooltip: {
      trigger: 'item',
      valueFormatter: (v: number) => formatKrw(v),
    },
    series: [
      {
        type: 'pie',
        radius: ['58%', '88%'],
        avoidLabelOverlap: true,
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
        data: data.map((s) => ({
          name: s.name,
          value: s.amount,
          itemStyle: { color: s.colorIndex === null ? theme.other : theme.series[s.colorIndex] },
        })),
      },
    ],
  });
});

const daily = computed(() => {
  const days = summary.value?.daily ?? [];
  return (theme: ChartTheme) => ({
    animationDuration: 300,
    grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: { dataIndex: number }[]) => {
        const d = days[params[0]?.dataIndex ?? 0];
        if (!d) return '';
        const [, m, day] = d.date.split('-').map(Number);
        return `${m}월 ${day}일<br/>지출 ${formatKrw(d.expense)}`;
      },
    },
    xAxis: {
      type: 'category',
      data: days.map((d) => String(Number(d.date.slice(8)))),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, interval: 4, fontSize: 11 },
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
        barMaxWidth: 10,
        itemStyle: { color: theme.series[0], borderRadius: [4, 4, 0, 0] },
        data: days.map((d) => d.expense),
      },
    ],
  });
});

function change(current: number, previous: number): string {
  const diff = current - previous;
  const ratio = changeRatio(current, previous);
  if (previous === 0 && current === 0) return '지난달과 같음';
  if (ratio === null) return '지난달 기록 없음';
  if (diff === 0) return '지난달과 같음';
  const arrow = diff > 0 ? '▲' : '▼';
  return `지난달보다 ${formatKrw(Math.abs(diff))} ${arrow} ${Math.abs(Math.round(ratio * 100))}%`;
}

/** 홈 shows the overall budget and up to three category budgets, the fullest first. */
const budgetRows = computed(() => {
  const b = summary.value?.budgets;
  if (!b) return null;
  const cats = [...b.categories].sort((x, y) => y.percent - x.percent);
  return { overall: b.overall, top: cats.slice(0, 3), more: Math.max(0, cats.length - 3) };
});
const hasBudgets = computed(
  () => !!budgetRows.value && (!!budgetRows.value.overall || budgetRows.value.top.length > 0),
);
const recurring = computed(() => summary.value?.recurring ?? null);
const RECURRING_STATE = {
  paid: '결제됨',
  upcoming: '예정',
  late: '아직 없음',
} as const;

const spendingDays = computed(() => (summary.value?.daily ?? []).filter((d) => d.expense > 0));
const newHousehold = computed(() => ledger.loaded && ledger.accounts.length === 0);
const listLink = (extra: Record<string, string>) => ({
  path: '/transactions',
  query: {
    month: month.value,
    basis: basis.value,
    ...(scope.value === 'all' ? {} : { ownerId: String(scope.value) }),
    ...extra,
  },
});
</script>

<template>
  <section class="page home" data-testid="home-page">
    <header class="head">
      <MonthNav v-model="month" />
      <ScopeSwitch
        v-if="ledger.activeMembers.length > 1"
        v-model="scope"
        :members="ledger.activeMembers"
      />
      <BasisSwitch v-model="basis" />
      <p v-if="basis === 'billing'" class="muted small basis-note" data-testid="basis-note">
        카드는 결제일에 돈이 나가는 달로 셉니다({{ monthLabel(month) }} 결제분). 일별 지출에서
        카드값은 결제일에 모여 보이고, 예산은 그대로 쓴 날 기준입니다.
      </p>
    </header>

    <p v-if="error" class="error-text" role="alert">
      {{ error }} <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>

    <div v-if="newHousehold" class="card notice-card" data-testid="welcome">
      <strong>가계부를 시작해 볼까요?</strong>
      <p class="muted">카드·계좌를 등록하고, ‘추가’에서 첫 거래를 기록하세요.</p>
      <div class="actions">
        <RouterLink to="/settings/accounts" class="btn">카드·계좌 등록</RouterLink>
        <RouterLink to="/add" class="btn btn-primary">거래 추가</RouterLink>
      </div>
    </div>

    <div class="kpis">
      <RouterLink :to="listLink({ type: 'expense' })" class="card kpi" data-testid="kpi-expense">
        <span class="muted"
          >{{ monthLabel(month) }} {{ basis === 'billing' ? '나가는 돈' : '지출' }}</span
        >
        <strong class="value tabular">{{ summary ? formatKrw(summary.expense) : '—' }}</strong>
        <span v-if="summary" class="delta muted">{{
          change(summary.expense, summary.previous.expense)
        }}</span>
      </RouterLink>
      <RouterLink :to="listLink({ type: 'income' })" class="card kpi" data-testid="kpi-income">
        <span class="muted">{{ monthLabel(month) }} 수입</span>
        <strong class="value tabular">{{ summary ? formatKrw(summary.income) : '—' }}</strong>
        <span v-if="summary" class="delta muted">{{
          change(summary.income, summary.previous.income)
        }}</span>
      </RouterLink>
    </div>

    <div
      v-if="summary && (summary.uncategorizedCount || summary.needsReviewCount)"
      class="attention"
    >
      <RouterLink
        v-if="summary.uncategorizedCount"
        :to="listLink({ category: 'none' })"
        class="card attention-item"
        data-testid="uncategorized-link"
      >
        <span>미분류</span><strong class="tabular">{{ summary.uncategorizedCount }}건</strong>
      </RouterLink>
      <RouterLink
        v-if="summary.needsReviewCount"
        :to="listLink({ status: 'needs_review' })"
        class="card attention-item"
      >
        <span>확인 필요</span><strong class="tabular">{{ summary.needsReviewCount }}건</strong>
      </RouterLink>
    </div>

    <div class="plan">
      <section
        v-if="summary && budgetRows && !newHousehold"
        class="card budgets"
        aria-labelledby="home-budget"
        data-testid="home-budgets"
      >
        <div class="card-head">
          <h2 id="home-budget">예산</h2>
          <RouterLink :to="{ path: '/budgets', query: { month } }" class="link-button">
            {{ hasBudgets ? '예산 관리' : '예산 설정' }}
          </RouterLink>
        </div>
        <template v-if="hasBudgets">
          <BudgetMeter v-if="budgetRows.overall" :budget="budgetRows.overall" primary />
          <BudgetMeter v-for="b in budgetRows.top" :key="b.categoryId ?? 0" :budget="b" />
          <RouterLink
            v-if="budgetRows.more"
            :to="{ path: '/budgets', query: { month } }"
            class="muted small"
          >
            분류 예산 {{ budgetRows.more }}개 더 보기
          </RouterLink>
        </template>
        <p v-else class="muted small">
          한 달 예산을 정해 두면 얼마나 썼는지, 이 속도면 괜찮은지 여기서 볼 수 있습니다.
        </p>
      </section>
      <p v-else-if="summary && !summary.budgets && scope !== 'all'" class="muted small scope-note">
        예산과 고정지출은 ‘가족 전체’에서 볼 수 있습니다.
      </p>

      <section
        v-if="recurring && (recurring.items.length || recurring.suggestionCount)"
        class="card recurring"
        aria-labelledby="home-recurring"
        data-testid="home-recurring"
      >
        <div class="card-head">
          <h2 id="home-recurring">고정지출</h2>
          <RouterLink to="/settings/recurring" class="link-button">관리</RouterLink>
        </div>
        <p v-if="recurring.items.length" class="muted small">
          <template v-if="recurring.remainingAmount">
            아직 나가지 않은 금액
            <strong class="tabular">{{ formatKrw(recurring.remainingAmount) }}</strong>
          </template>
          <template v-else>이번 달 고정지출이 모두 결제됐습니다.</template>
        </p>
        <ul v-if="recurring.items.length" class="recurring-list">
          <li
            v-for="item in recurring.items"
            :key="item.id"
            :data-state="item.state"
            data-testid="home-recurring-item"
          >
            <span class="r-name">{{ item.name }}</span>
            <span class="muted r-date">{{
              item.paid ? dayLabel(item.paid.date) : dayLabel(item.expectedDate)
            }}</span>
            <span class="tabular r-amount">{{
              formatKrw(item.paid ? item.paid.amount : item.amount)
            }}</span>
            <span class="badge r-state" :class="`state-${item.state}`">
              <span aria-hidden="true">{{
                item.state === 'paid' ? '✓' : item.state === 'late' ? '!' : '·'
              }}</span>
              {{ RECURRING_STATE[item.state] }}
            </span>
          </li>
        </ul>
        <RouterLink
          v-if="recurring.suggestionCount"
          to="/settings/recurring"
          class="suggest"
          data-testid="recurring-suggestions-link"
        >
          매달 나가는 것 같은 지출 {{ recurring.suggestionCount }}건 확인하기
        </RouterLink>
      </section>
    </div>

    <p v-if="loading && !summary" class="muted">불러오는 중…</p>

    <div
      v-else-if="summary && summary.transactionCount === 0"
      class="card empty"
      data-testid="empty-month"
    >
      <p>{{ monthLabel(month) }}에는 아직 기록이 없습니다.</p>
      <RouterLink to="/add" class="btn btn-primary">거래 추가</RouterLink>
    </div>

    <div v-else-if="summary" class="charts">
      <section class="card" aria-labelledby="by-category">
        <h2 id="by-category">분류별 지출</h2>
        <p v-if="slices.length === 0" class="muted">이 달에는 지출이 없습니다.</p>
        <div v-else class="donut-wrap">
          <EChart
            :build="donut"
            :height="180"
            label="분류별 지출 도넛 그래프. 옆의 목록과 같은 내용입니다."
            class="donut"
          />
          <ol class="legend" data-testid="category-list">
            <li v-for="s in slices" :key="s.categoryId ?? 'none'">
              <span
                class="swatch"
                :style="{
                  background:
                    s.colorIndex === null
                      ? 'var(--series-other)'
                      : `var(--series-${s.colorIndex + 1})`,
                }"
                aria-hidden="true"
              />
              <RouterLink v-if="s.link" :to="s.link" class="name">{{ s.name }}</RouterLink>
              <span v-else class="name">{{ s.name }}</span>
              <span class="tabular amount">{{ formatKrw(s.amount) }}</span>
              <span class="tabular muted pct">{{ pct(s.amount) }}</span>
            </li>
          </ol>
        </div>
      </section>

      <section class="card" aria-labelledby="by-day">
        <h2 id="by-day">{{ basis === 'billing' ? '일별 나가는 돈' : '일별 지출' }}</h2>
        <EChart
          :build="daily"
          :height="170"
          label="일별 지출 막대 그래프. 아래 표로도 볼 수 있습니다."
        />
        <details class="table-toggle">
          <summary>표로 보기</summary>
          <table class="day-table">
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col" class="num">지출</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in spendingDays" :key="d.date">
                <td>{{ Number(d.date.slice(5, 7)) }}월 {{ Number(d.date.slice(8)) }}일</td>
                <td class="num tabular">{{ formatKrw(d.expense) }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </section>
    </div>

    <div class="card status" data-testid="health-status" :data-state="health.state" role="status">
      <span class="dot" :class="health.state" aria-hidden="true" />
      <span class="muted">
        {{
          health.state === 'online'
            ? '서버 연결됨'
            : health.state === 'offline'
              ? '서버에 연결할 수 없습니다'
              : health.state === 'degraded'
                ? '데이터베이스 확인 필요'
                : '서버 확인 중…'
        }}
        <template v-if="health.health"> · 버전 {{ health.health.version }}</template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.home {
  display: grid;
  gap: 12px;
  max-width: 1100px;
}
.head {
  display: grid;
  gap: 10px;
}
.basis-note {
  margin: 0;
}
.kpis {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.kpi {
  display: grid;
  gap: 2px;
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.kpi .value {
  font-size: 1.35rem;
}
.delta {
  font-size: 0.78rem;
}
.attention {
  display: flex;
  gap: 10px;
}
.attention-item {
  flex: 1;
  display: flex;
  justify-content: space-between;
  padding: 12px 16px;
  color: inherit;
  text-decoration: none;
  border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
}
.charts {
  display: grid;
  gap: 12px;
}
.plan {
  display: grid;
  gap: 12px;
}
.plan:empty {
  display: none;
}
.budgets,
.recurring {
  display: grid;
  gap: 12px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.card-head h2 {
  margin: 0;
}
.card-head .link-button {
  min-height: 44px;
  padding: 0 4px;
}
.small {
  font-size: 0.85rem;
  margin: 0;
}
.scope-note {
  padding: 0 4px;
}
.recurring-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.recurring-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    'name amount'
    'date state';
  gap: 2px 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.r-name {
  grid-area: name;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.r-date {
  grid-area: date;
  font-size: 0.8rem;
}
.r-amount {
  grid-area: amount;
  text-align: right;
}
.r-state {
  grid-area: state;
  justify-self: end;
}
[data-state='paid'] .r-name,
[data-state='paid'] .r-amount {
  color: var(--text-muted);
}
.state-paid {
  color: var(--ok);
}
.state-late {
  color: var(--warn);
}
.suggest {
  font-size: 0.85rem;
  color: var(--accent);
  min-height: 44px;
  display: flex;
  align-items: center;
}
.donut-wrap {
  display: grid;
  gap: 12px;
}
.donut {
  max-width: 220px;
  margin: 0 auto;
}
.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
  font-size: 0.9rem;
}
.legend li {
  display: grid;
  grid-template-columns: 12px 1fr auto 3.5em;
  align-items: center;
  gap: 8px;
}
.swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}
.name {
  color: var(--text);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amount {
  font-weight: 600;
}
.pct {
  text-align: right;
  font-size: 0.8rem;
}
.table-toggle summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 0.85rem;
  margin-top: 6px;
}
.day-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-top: 6px;
}
.day-table td,
.day-table th {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.num {
  text-align: right !important;
}
.empty,
.notice-card {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.notice-card p,
.empty p {
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  font-size: 0.8rem;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}
.dot.online {
  background: var(--ok);
}
.dot.offline {
  background: var(--error);
}
.dot.degraded {
  background: var(--warn);
}
@media (min-width: 720px) {
  .donut-wrap {
    grid-template-columns: 200px 1fr;
    align-items: center;
  }
}
@media (min-width: 1024px) {
  .plan {
    grid-template-columns: 1fr 1fr;
    align-items: start;
  }
  .charts {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
