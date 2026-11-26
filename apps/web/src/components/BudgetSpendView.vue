<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import { formatKrw, type YearMonth } from '@budget/shared';
import { budgetLineSeries, excessItemStyle, splitOver } from '../charts/budget-marks.ts';
import type { ChartTheme } from '../charts/theme.ts';
import { movingAverage, trendSentences, type TrendMonth } from '../ledger/budget-trend.ts';
import { compactKrw, monthLabel } from '../ledger/format.ts';
import EChart from './EChart.vue';

/**
 * One budget against its spending, month by month (통계 › 월별 예산·지출 and
 * 월별 분류 예산·지출): budget and spending bars side by side, the excess
 * hatched above a budget line, a dashed 3-month average of spending, a few
 * rule-based trend sentences and the same figures as a table.
 */
export interface BudgetSpendRow {
  month: YearMonth;
  spent: number;
  /** Budget in force that month; null when there was none. */
  budget: number | null;
}

const props = defineProps<{
  rows: BudgetSpendRow[];
  /** e.g. 전체 예산, 식비 예산: used in the summary and the chart label. */
  budgetName: string;
  thisMonth: YearMonth;
  shortMonth: (month: YearMonth) => string;
  spendLink: (month: YearMonth) => RouteLocationRaw;
  budgetLink: (month: YearMonth) => RouteLocationRaw;
  /** Prefix for data-testid: `-summary`, `-trend-notes`, `-chart`, `-table`. */
  testid: string;
}>();

const router = useRouter();

const BAR_MAX_WIDTH = 12;
const BAR_GAP = '15%';

const budgetedMonths = computed(() => props.rows.filter((r) => r.budget !== null).length);
const overMonths = computed(
  () => props.rows.filter((r) => r.budget !== null && r.spent > r.budget).length,
);
/** The month in progress and later ones stay out of the trend. */
const trendMonths = computed<TrendMonth[]>(() =>
  props.rows.map((r) => ({
    month: r.month,
    expense: r.spent,
    budget: r.budget,
    open: r.month >= props.thisMonth,
  })),
);
const trend = computed(() => movingAverage(trendMonths.value));
const hasTrendLine = computed(() => trend.value.some((v) => v !== null));
const notes = computed(() => trendSentences(trendMonths.value));

const chart = computed(() => {
  const rows = props.rows;
  const budgets = rows.map((r) => r.budget);
  const average = trend.value;
  const { within, excess } = splitOver(
    rows.map((r) => r.spent),
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
        const r = rows[i];
        if (!r) return '';
        const lines = [
          monthLabel(r.month),
          r.budget === null ? '예산 없음' : `예산 ${formatKrw(r.budget)}`,
          `지출 ${formatKrw(r.spent)}`,
        ];
        if (r.budget !== null) {
          lines.push(
            r.spent > r.budget
              ? `<b>${formatKrw(r.spent - r.budget)} 초과</b>`
              : `${formatKrw(r.budget - r.spent)} 남음`,
          );
        }
        const t = average[i];
        if (t != null) lines.push(`최근 3달 평균 ${formatKrw(t)}`);
        return lines.join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => props.shortMonth(r.month)),
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
        name: '예산',
        barMaxWidth: BAR_MAX_WIDTH,
        barGap: BAR_GAP,
        itemStyle: { color: theme.other, borderRadius: [4, 4, 0, 0] },
        data: budgets.map((b) => b ?? '-'),
      },
      {
        type: 'bar',
        name: '지출',
        stack: 'spent',
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: { color: theme.series[0] },
        data: rows.map((r, i) => ({
          value: within[i] ?? r.spent,
          itemStyle: { borderRadius: within[i] === null ? [4, 4, 0, 0] : 0 },
        })),
      },
      {
        type: 'bar',
        name: '예산 초과',
        stack: 'spent',
        barMaxWidth: BAR_MAX_WIDTH,
        itemStyle: excessItemStyle(theme),
        data: excess,
      },
      budgetLineSeries(theme, within, {
        count: 2,
        barGap: BAR_GAP,
        barMaxWidth: BAR_MAX_WIDTH,
        column: 1,
      }),
      {
        // Spending trend: the average of each finished month and the two before.
        type: 'line',
        name: '최근 3달 평균',
        z: 6,
        symbol: 'circle',
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { color: theme.series[3], width: 2, type: 'dashed' },
        itemStyle: { color: theme.series[3] },
        data: average.map((v) => v ?? '-'),
      },
    ],
  });
});

/** Series: 0 예산 opens that month's budgets; 1–2 지출 open its spending; the rest are marks. */
function open(item: { dataIndex: number; seriesIndex: number }): void {
  const r = props.rows[item.dataIndex];
  if (!r || item.seriesIndex > 2) return;
  void router.push(item.seriesIndex === 0 ? props.budgetLink(r.month) : props.spendLink(r.month));
}
</script>

<template>
  <div class="budget-spend">
    <ul class="legend-inline" aria-hidden="true">
      <li><span class="swatch" style="background: var(--series-other)" />예산</li>
      <li><span class="swatch" style="background: var(--series-1)" />지출</li>
      <li v-if="overMonths"><span class="swatch hatched" />예산 초과</li>
      <li v-if="hasTrendLine"><span class="swatch dashed" />최근 3달 평균</li>
    </ul>
    <p class="muted small" :data-testid="`${testid}-summary`">
      {{ budgetName }}이 있던 {{ budgetedMonths }}달 중
      {{ overMonths ? `${overMonths}달 넘었습니다.` : '넘은 달이 없습니다.' }}
    </p>
    <ul v-if="notes.length" class="trend-notes" :data-testid="`${testid}-trend-notes`">
      <li v-for="note in notes" :key="note">{{ note }}</li>
    </ul>
    <EChart
      :build="chart"
      :height="200"
      :label="`월별 ${budgetName}과 지출 막대 그래프, 지출의 최근 3달 평균 점선. 예산을 넘은 달은 지출 막대에 예산 자리 선과 넘은 부분 빗금이 있습니다. 예산 막대를 누르면 그 달 예산이, 지출 막대를 누르면 그 달 내역이 열립니다. 아래 표와 같은 내용입니다.`"
      :data-testid="`${testid}-chart`"
      @select="open"
    />
    <details class="table-toggle" :data-testid="`${testid}-table`">
      <summary>표로 보기</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">달</th>
            <th scope="col" class="num">예산</th>
            <th scope="col" class="num">지출</th>
            <th scope="col" class="num">예산 대비</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.month">
            <th scope="row">
              <RouterLink :to="spendLink(r.month)">{{ monthLabel(r.month) }}</RouterLink>
            </th>
            <td class="num tabular">{{ r.budget === null ? '—' : formatKrw(r.budget) }}</td>
            <td class="num tabular">{{ formatKrw(r.spent) }}</td>
            <td class="num tabular">
              <template v-if="r.budget === null">—</template>
              <span v-else-if="r.spent > r.budget" class="over-text">
                {{ formatKrw(r.spent - r.budget) }} 초과
              </span>
              <span v-else class="muted">{{ formatKrw(r.budget - r.spent) }} 남음</span>
            </td>
          </tr>
        </tbody>
      </table>
    </details>
  </div>
</template>

<style scoped>
.budget-spend {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.small {
  font-size: 0.85rem;
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
}
.swatch.dashed {
  height: 0;
  border-top: 2px dashed var(--series-4);
  border-radius: 0;
}
.swatch.hatched {
  background: repeating-linear-gradient(
    -45deg,
    var(--error) 0 3px,
    color-mix(in srgb, var(--error) 60%, var(--surface)) 3px 6px
  );
  box-shadow: inset 0 2px 0 var(--text);
}
.trend-notes {
  margin: 0;
  padding: 0 0 0 1.1em;
  display: grid;
  gap: 2px;
  font-size: 0.85rem;
}
.over-text {
  color: var(--error);
  font-weight: 700;
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
tbody th a {
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
</style>
