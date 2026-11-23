<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { ECharts } from '../charts/echarts.ts';
import { readChartTheme, type ChartTheme } from '../charts/theme.ts';

/**
 * Lazily loads ECharts and renders `build(theme)`. Re-renders when the data
 * or the color scheme changes. The chart is decorative for screen readers:
 * every chart on the page has a text equivalent next to it.
 */
const props = defineProps<{
  build: (theme: ChartTheme) => object;
  height: number;
  label: string;
}>();
const emit = defineEmits<{
  /** A data item was clicked or tapped (bars, points, slices). */
  select: [item: { dataIndex: number; seriesIndex: number; name: string }];
}>();
const el = ref<HTMLDivElement | null>(null);
const failed = ref(false);
const chart = shallowRef<ECharts | null>(null);
let resize: ResizeObserver | null = null;
const scheme = window.matchMedia('(prefers-color-scheme: dark)');

function render(): void {
  chart.value?.setOption(props.build(readChartTheme()) as Record<string, unknown>, {
    notMerge: true,
  });
}

onMounted(async () => {
  try {
    const { init } = await import('../charts/echarts.ts');
    if (!el.value) return;
    chart.value = init(el.value, null, { renderer: 'svg', locale: 'EN' });
    render();
    chart.value.on('click', (p) => {
      const item = p as { dataIndex: number; seriesIndex?: number; name: string };
      emit('select', {
        dataIndex: item.dataIndex,
        seriesIndex: item.seriesIndex ?? 0,
        name: item.name,
      });
    });
    resize = new ResizeObserver(() => chart.value?.resize());
    resize.observe(el.value);
    scheme.addEventListener('change', render);
  } catch {
    failed.value = true;
  }
});

watch(() => props.build, render);

onBeforeUnmount(() => {
  resize?.disconnect();
  scheme.removeEventListener('change', render);
  chart.value?.dispose();
});
</script>

<template>
  <div class="echart" role="img" :aria-label="label" :style="{ height: `${height}px` }">
    <div ref="el" class="canvas" aria-hidden="true" />
    <p v-if="failed" class="muted">그래프를 불러오지 못했습니다.</p>
  </div>
</template>

<style scoped>
.echart {
  position: relative;
  width: 100%;
  /* Keep ECharts' tooltip (z-index 9999999) below the privacy cover and sheets. */
  isolation: isolate;
}
.canvas {
  position: absolute;
  inset: 0;
}
</style>
