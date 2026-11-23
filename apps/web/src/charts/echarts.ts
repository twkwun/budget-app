/**
 * Tree-shaken ECharts build: only the pie, bar and line charts, tooltip and grid,
 * rendered as SVG. Loaded lazily (dynamic import) so 홈's first paint does
 * not wait for it.
 */
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

use([PieChart, BarChart, LineChart, GridComponent, TooltipComponent, SVGRenderer]);

export { init };
export type { EChartsCoreOption as ChartOption, ECharts } from 'echarts/core';
