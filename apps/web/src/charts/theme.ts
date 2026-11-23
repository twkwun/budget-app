/** Chart colors are read from CSS variables so light and dark mode stay in sync with the app. */
export interface ChartTheme {
  series: string[];
  other: string;
  text: string;
  muted: string;
  grid: string;
  surface: string;
}

export function readChartTheme(el: Element = document.documentElement): ChartTheme {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series: [1, 2, 3, 4, 5, 6, 7].map((i) => v(`--series-${i}`)),
    other: v('--series-other'),
    text: v('--text'),
    muted: v('--text-muted'),
    grid: v('--chart-grid'),
    surface: v('--surface'),
  };
}
