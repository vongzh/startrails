<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { NodeView } from '../api';

echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);

const props = defineProps<{
  nodes: NodeView[];
  /** 节点 → 地区码；已含 Annotation 覆盖后的最终值。 */
  regionOf: (node: NodeView) => string;
  /** 节点 → 延迟（ms 或 null）。 */
  latencyOf: (node: NodeView) => number | null;
  /** 当前选中的地区码（'' 表示未筛选）；用于高亮回显。 */
  selected?: string;
}>();

const emit = defineEmits<{
  (event: 'select', region: string): void;
  (event: 'clear'): void;
}>();

/** 地区展示信息：旗帜 + 中文名 + 固定展示顺序（按地理直觉，而非节点数）。 */
interface RegionMeta {
  flag: string;
  label: string;
}

const REGION_META: Record<string, RegionMeta> = {
  HK: { flag: '🇭🇰', label: '中国香港' },
  TW: { flag: '🇹🇼', label: '中国台湾' },
  JP: { flag: '🇯🇵', label: '日本' },
  SG: { flag: '🇸🇬', label: '新加坡' },
  KR: { flag: '🇰🇷', label: '韩国' },
  CN: { flag: '🇨🇳', label: '中国大陆' },
  DE: { flag: '🇩🇪', label: '德国' },
  UK: { flag: '🇬🇧', label: '英国' },
  US: { flag: '🇺🇸', label: '美国' },
  OTHER: { flag: '🌐', label: '其他' },
};

/** 固定展示顺序：东亚 → 东南亚 → 欧洲 → 北美 → 其他。 */
const REGION_ORDER: readonly string[] = ['HK', 'TW', 'CN', 'JP', 'KR', 'SG', 'DE', 'UK', 'US', 'OTHER'];

const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

/** 地区 → { 节点数, 平均延迟 }；不在地图里的节点归入「其他」。 */
const buckets = computed(() => {
  const map = new Map<string, { count: number; latSum: number; latN: number }>();
  const bump = (region: string, latency: number | null) => {
    const entry = map.get(region) ?? { count: 0, latSum: 0, latN: 0 };
    entry.count += 1;
    if (latency !== null) {
      entry.latSum += latency;
      entry.latN += 1;
    }
    map.set(region, entry);
  };
  for (const node of props.nodes) {
    bump(props.regionOf(node), props.latencyOf(node));
  }
  return map;
});

/** 按固定顺序排列的非空地区桶；保留节点数用于面积。 */
const rows = computed(() => {
  const result: { code: string; count: number; avg: number | null }[] = [];
  for (const code of REGION_ORDER) {
    const entry = buckets.value.get(code);
    if (entry === undefined || entry.count === 0) continue;
    result.push({
      code,
      count: entry.count,
      avg: entry.latN > 0 ? Math.round(entry.latSum / entry.latN) : null,
    });
  }
  return result;
});

/** 是否有任何节点带可用延迟（用于决定是否显示色阶图例）。 */
const hasLatency = computed(() => rows.value.some((row) => row.avg !== null));

function render(): void {
  if (chart === null || el.value === null) return;

  const data = rows.value.map((row) => {
    const meta = REGION_META[row.code] ?? { flag: '🌐', label: row.code };
    return {
      name: row.code,
      value: row.count,
      avg: row.avg,
      label: `${meta.flag} ${meta.label}`,
    };
  });

  // 一次性读取主题色（echarts 部分字段走 canvas/inline，`var()` 不能直接给到 fillStyle）。
  const surface = cssVar('--surface', '#ffffff');
  const surface2 = cssVar('--surface-2', '#fafafb');
  const divider = cssVar('--divider', '#eff0f3');
  const text = cssVar('--text', '#141519');
  const accent = cssVar('--accent', '#5a5ad2');

  chart.setOption({
    tooltip: {
      backgroundColor: surface2,
      borderColor: divider,
      textStyle: { color: text, fontSize: 12 },
      formatter: (info: { name: string; value: number; data: { avg: number | null; label: string } }) => {
        const avg = info.data.avg === null ? '未测' : `${info.data.avg} ms`;
        const tip = info.name === 'OTHER' ? '' : '<br/><span style="opacity:.6">点击筛选该地区</span>';
        return `${info.data.label}<br/>节点 ${info.value} 个 · 平均延迟 ${avg}${tip}`;
      },
    },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        label: {
          show: true,
          formatter: (info: { data: { label: string; value: number } }) => `${info.data.label}\n${info.data.value} 节点`,
        },
        upperLabel: { show: false },
        itemStyle: {
          borderColor: surface,
          borderWidth: 2,
          gapWidth: 2,
        },
        emphasis: {
          label: { show: true, fontWeight: 700 },
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.25)' },
        },
        data: data.map((item) => ({
          ...item,
          itemStyle: {
            color: colorOf(item.avg),
            borderColor: props.selected === item.name ? accent : surface,
            borderWidth: props.selected === item.name ? 3 : 2,
          },
        })),
      },
    ],
  });
}

/** 延迟 → 色阶：绿(快 <100) → 橙(中 <250) → 红(慢) → 灰(未测)。
 *  echarts 用 canvas 绘制，`var(--x)` 字符串无法被 fillStyle 解析，故运行时读取 CSS 变量的
 *  计算值（跟随主题/配色），再喂给 echarts。语义色与延迟文字色（.lat-fast/ok/slow）同源。 */
function cssVar(name: string, fallback: string): string {
  if (el.value === null) return fallback;
  return getComputedStyle(el.value).getPropertyValue(name).trim() || fallback;
}

function colorOf(avg: number | null): string {
  if (avg === null) return cssVar('--text-3', '#9aa4b2');
  if (avg < 100) return cssVar('--ok', '#2fbf8f');
  if (avg < 250) return cssVar('--warn', '#e6a23c');
  return cssVar('--danger', '#e06c6c');
}

function onChartClick(params: { name?: string }): void {
  const code = params.name;
  if (code === undefined) return;
  if (props.selected === code) {
    emit('clear');
  } else {
    emit('select', code);
  }
}

onMounted(() => {
  if (el.value === null) return;
  chart = echarts.init(el.value);
  chart.on('click', onChartClick);
  render();
});

watch(() => [props.nodes, props.regionOf, props.latencyOf, props.selected], render, { deep: true });

onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="region-map-wrap">
    <div ref="el" class="region-map"></div>
    <div v-if="hasLatency" class="region-legend">
      <span class="legend-item"><i class="swatch" style="background: var(--ok)"></i>&lt;100ms</span>
      <span class="legend-item"><i class="swatch" style="background: var(--warn)"></i>100–250ms</span>
      <span class="legend-item"><i class="swatch" style="background: var(--danger)"></i>&gt;250ms</span>
      <span class="legend-item"><i class="swatch" style="background: var(--text-3)"></i>未测</span>
      <span class="legend-hint" v-if="selected">已筛选 {{ REGION_META[selected]?.label ?? selected }} · 点击清除</span>
    </div>
  </div>
</template>

<style scoped>
.region-map-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.region-map {
  width: 100%;
  height: 240px;
}
.region-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-3);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.legend-hint {
  margin-left: auto;
  color: var(--accent);
}
</style>
