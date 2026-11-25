import type { ChartTheme } from './theme.ts';

/**
 * Over-budget marks shared by the monthly bar charts (통계 월별 지출·수입,
 * 예산 › 월별 비교). A bar that went over is drawn in two stacked parts: up to
 * the budget in its usual colour, then the excess hatched in the error
 * colour, with a solid line where the budget sits (like BudgetMeter).
 */

/** Hatching for the excess part, so over-budget is not told by colour alone. */
export function excessItemStyle(theme: ChartTheme) {
  return {
    color: theme.error,
    borderRadius: [4, 4, 0, 0],
    decal: {
      symbol: 'rect',
      color: 'rgba(0, 0, 0, 0.28)',
      dashArrayX: [1, 0],
      dashArrayY: [3, 3],
      rotation: -Math.PI / 4,
    },
  };
}

/**
 * Splits spending against budgets: `within` is the budget where spending went
 * over it (null otherwise), `excess` the amount past it ('-' = no bar).
 */
export function splitOver(spent: number[], budgets: (number | null)[]) {
  const within = spent.map((s, i) => {
    const b = budgets[i];
    return b != null && s > b ? b : null;
  });
  const excess = spent.map((s, i) => {
    const w = within[i];
    return w == null ? '-' : s - w;
  });
  return { within, excess };
}

interface MarkApi {
  value: (dim: number) => number;
  coord: (point: number[]) => number[];
  barLayout: (opt: object) => { offsetCenter: number; width: number }[] | undefined;
}

/**
 * A custom series drawing the budget line across the bar of each month that
 * went over. `layout` must match the bar series (how many bars stand side by
 * side per month, their gap and max width) and `column` picks which of them.
 */
export function budgetLineSeries(
  theme: ChartTheme,
  within: (number | null)[],
  layout: { count: number; barGap?: string; barMaxWidth: number; column?: number },
) {
  const { column = 0, ...barOpt } = layout;
  return {
    type: 'custom',
    name: '예산',
    silent: true,
    z: 5,
    tooltip: { show: false },
    data: within.map((b, i) => [i, b ?? '-']),
    renderItem: (_params: unknown, api: MarkApi) => {
      const budget = api.value(1);
      if (!Number.isFinite(budget)) return null;
      const [x = 0, y = 0] = api.coord([api.value(0), budget]);
      const bar = api.barLayout(barOpt)?.[column];
      if (!bar) return null;
      const width = bar.width + 6;
      return {
        type: 'rect',
        shape: { x: x + bar.offsetCenter - width / 2, y: y - 1.5, width, height: 3, r: 1.5 },
        style: { fill: theme.text, stroke: theme.surface, lineWidth: 1.5 },
      };
    },
  };
}
