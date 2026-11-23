/**
 * Tree-shaken ECharts build: only the pie and bar charts, tooltip and grid,
 * rendered as SVG. Loaded lazily (dynamic import) so 홈's first paint does
 * not wait for it.
 */
import { BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

use([PieChart, BarChart, GridComponent, TooltipComponent, SVGRenderer]);

export { init };
export type { EChartsCoreOption as ChartOption, ECharts } from 'echarts/core';
