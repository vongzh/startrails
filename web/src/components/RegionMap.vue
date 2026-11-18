<script setup lang="ts">
import { computed } from 'vue';
import type { NodeView } from '../api';

/* 地区分布：一条横条，段宽 = 该地区节点占比，点击分段即筛选。
   刻意不用地图/色块面积：面积比在 3:2:1 时读不出结论，而延迟是可选操作的结果，
   拿它决定填充色会让「默认状态」变成一堵同色墙。这里延迟降级为段底 2px 状态线，
   颜色只出现在结论上，符合「中性底 + 单一强调色，颜色只用于结论」。 */

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

interface RegionMeta {
  flag: string;
  /** 分段内短名：条宽有限，全名放不下。 */
  short: string;
  /** tooltip 与筛选回显用的全名。 */
  label: string;
}

const REGION_META: Record<string, RegionMeta> = {
  HK: { flag: '🇭🇰', short: '香港', label: '中国香港' },
  TW: { flag: '🇹🇼', short: '台湾', label: '中国台湾' },
  JP: { flag: '🇯🇵', short: '日本', label: '日本' },
  SG: { flag: '🇸🇬', short: '新加坡', label: '新加坡' },
  KR: { flag: '🇰🇷', short: '韩国', label: '韩国' },
  CN: { flag: '🇨🇳', short: '大陆', label: '中国大陆' },
  DE: { flag: '🇩🇪', short: '德国', label: '德国' },
  UK: { flag: '🇬🇧', short: '英国', label: '英国' },
  US: { flag: '🇺🇸', short: '美国', label: '美国' },
  OTHER: { flag: '🌐', short: '其他', label: '其他' },
};

/** 固定展示顺序：东亚 → 东南亚 → 欧洲 → 北美 → 其他；不按节点数排，避免筛选后段位跳动。 */
const REGION_ORDER: readonly string[] = ['HK', 'TW', 'CN', 'JP', 'KR', 'SG', 'DE', 'UK', 'US', 'OTHER'];

function metaOf(code: string): RegionMeta {
  return REGION_META[code] ?? { flag: '🌐', short: code, label: code };
}

interface Row {
  code: string;
  flag: string;
  short: string;
  label: string;
  count: number;
  avg: number | null;
}

/** 按地区聚合；未测延迟的节点不参与平均（不把「没测过」当成「快」）。 */
const rows = computed<Row[]>(() => {
  const map = new Map<string, { count: number; latSum: number; latN: number }>();
  for (const node of props.nodes) {
    const region = props.regionOf(node);
    const entry = map.get(region) ?? { count: 0, latSum: 0, latN: 0 };
    entry.count += 1;
    const latency = props.latencyOf(node);
    if (latency !== null) {
      entry.latSum += latency;
      entry.latN += 1;
    }
    map.set(region, entry);
  }
  const result: Row[] = [];
  const push = (code: string, entry: { count: number; latSum: number; latN: number }): void => {
    if (entry.count === 0) return;
    const meta = metaOf(code);
    result.push({
      code,
      flag: meta.flag,
      short: meta.short,
      label: meta.label,
      count: entry.count,
      avg: entry.latN > 0 ? Math.round(entry.latSum / entry.latN) : null,
    });
  };
  // 已知地区按固定顺序，「其他」永远收尾。
  for (const code of REGION_ORDER) {
    if (code === 'OTHER') continue;
    const entry = map.get(code);
    if (entry !== undefined) push(code, entry);
  }
  // 兜底：注解接口不校验地区码，UI 下拉之外的值（例如通过 API 写入的 'FR'）也必须画出来。
  // 否则这些节点会在分布条上静默消失，而表格里还在，用户只会觉得数字对不上。
  const extra = [...map.entries()]
    .filter(([code]) => !REGION_ORDER.includes(code))
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  for (const [code, entry] of extra) push(code, entry);
  const other = map.get('OTHER');
  if (other !== undefined) push('OTHER', other);
  return result;
});

const totalNodes = computed(() => rows.value.reduce((sum, row) => sum + row.count, 0));

/** 段间距；算段宽时要从 100% 里扣掉，否则最后一条会溢出。 */
const SEG_GAP = 4;

const hasLatency = computed(() => rows.value.some((row) => row.avg !== null));
const selectedLabel = computed(() => (props.selected === undefined || props.selected === '' ? '' : metaOf(props.selected).label));

/** 延迟 → 段底状态线；未测则透明，让条本身不靠颜色也成立。 */
function toneOf(avg: number | null): string {
  if (avg === null) return 'transparent';
  if (avg < 100) return 'var(--ok)';
  if (avg < 250) return 'var(--warn)';
  return 'var(--danger)';
}

function tipOf(row: Row): string {
  const latency = row.avg === null ? '延迟未测' : `平均 ${row.avg} ms`;
  const action = props.selected === row.code ? '点击取消筛选' : '点击筛选该地区';
  return `${row.label} · ${row.count} 个节点 · ${latency} · ${action}`;
}

/* 段宽按占比显式算，不用 flex-grow：
   `flex-grow` + 水平内边距时，padding 会成为每条的基础宽度（10px×2），
   10 条 1 节点的段各白拿 20px，3:2:1 就被拉成 2.65:1.83:1。
   这里把 gap 先扣掉再乘占比，比例严格成立，内边距只影响文字不再影响宽度。 */
function segStyle(row: Row): Record<string, string> {
  const gap = Math.max(rows.value.length - 1, 0) * SEG_GAP;
  const share = totalNodes.value === 0 ? 0 : row.count / totalNodes.value;
  return { flex: `0 0 calc((100% - ${gap}px) * ${share})`, '--lat': toneOf(row.avg) };
}

function pick(code: string): void {
  if (props.selected === code) emit('clear');
  else emit('select', code);
}
</script>

<template>
  <div class="rst">
    <div class="rst-head">
      <b>地区分布</b>
      <em>{{ rows.length }} 个地区 · {{ totalNodes }} 个节点</em>
      <span class="spacer"></span>
      <span v-if="hasLatency" class="rst-legend">
        <span><i class="lg-fast"></i>快</span>
        <span><i class="lg-mid"></i>一般</span>
        <span><i class="lg-slow"></i>慢</span>
      </span>
      <span v-if="hasLatency && selectedLabel === ''" class="rst-sep"></span>
      <button v-if="selectedLabel !== ''" type="button" class="rst-clear" @click="emit('clear')">
        <span class="dot"></span>已筛选 {{ selectedLabel }} · 清除
      </button>
      <span v-else class="rst-hint">点击分段筛选</span>
    </div>

    <div class="rst-segs">
      <button
        v-for="row in rows"
        :key="row.code"
        type="button"
        class="seg"
        :class="{ on: selected === row.code }"
        :style="segStyle(row)"
        :title="tipOf(row)"
        :aria-pressed="selected === row.code"
        @click="pick(row.code)"
      >
        <span class="r"><span class="fl">{{ row.flag }}</span><span class="nm">{{ row.short }}</span></span>
        <span class="n">{{ row.count }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.rst {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.rst-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-3);
}
.rst-head b {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
}
.rst-head em {
  font: 500 11px/1 var(--mono);
  font-style: normal;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.rst-hint {
  color: var(--text-3);
}

/* 图例画的是一段 2px 线，不是色块——编码方式本身要能对上。 */
.rst-legend {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.rst-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rst-legend i {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}
/* 图例与「点击分段筛选」之间需要一道分隔，否则「慢 点击…」连成一句话。 */
.rst-sep {
  width: 1px;
  height: 10px;
  background: var(--divider);
}
.lg-fast {
  background: var(--ok);
}
.lg-mid {
  background: var(--warn);
}
.lg-slow {
  background: var(--danger);
}

.rst-clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--accent);
  cursor: pointer;
}
.rst-clear:hover {
  text-decoration: underline;
}
.rst-clear .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.rst-segs {
  display: flex;
  /* 与脚本里的 SEG_GAP 保持一致：算段宽时要按这个值扣掉间距。 */
  gap: 4px;
  height: 42px;
  min-width: 0;
}

.seg {
  position: relative;
  /* 宽度由脚本按占比算（见 segStyle），这里不参与伸缩。 */
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 0 10px;
  background: var(--surface-2);
  border: 0;
  border-radius: var(--radius-sm);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.12s ease;
}
.seg:hover {
  background: var(--surface-hover);
}
.seg.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
}
.seg:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* 延迟只占段底 2px，不挤文字、不决定填充色。 */
.seg::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--lat, transparent);
}

.seg .r {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.2;
  color: var(--text-2);
}
.seg .fl {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 1;
}
.seg .nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg .n {
  font: 600 14px/1.1 var(--mono);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.seg.on .n {
  color: var(--accent);
}

/* 窄屏：允许横滑并保证最小段宽（46px），防止仅 1-2 个节点的地区被压缩成点不开的细条。 */
@media (max-width: 620px) {
  .rst-segs {
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 2px;
  }
  .rst-segs::-webkit-scrollbar {
    display: none;
  }
  .seg {
    min-width: 46px;
    padding: 0 6px;
    align-items: center;
  }
  .seg .nm {
    display: none;
  }
  .seg .r {
    gap: 0;
    font-size: 11px;
  }
  .seg .n {
    font-size: 13px;
  }
}
</style>
