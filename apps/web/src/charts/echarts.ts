/**
 * Tree-shaken ECharts build: only the pie, bar, line and custom charts (custom
 * draws marks such as the budget line on a bar), tooltip and grid,
 * rendered as SVG. Loaded lazily (dynamic import) so 홈's first paint does
 * not wait for it.
 */
import { BarChart, CustomChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

use([PieChart, BarChart, CustomChart, LineChart, GridComponent, TooltipComponent, SVGRenderer]);

export { init };
export type { EChartsCoreOption as ChartOption, ECharts } from 'echarts/core';
