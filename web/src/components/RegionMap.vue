<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { NodeView } from '../api';
import {
  WORLD_COUNTRY_ANCHORS,
  WORLD_MAP_BOUNDS,
  WORLD_MAP_COLS,
  WORLD_MAP_ROWS,
  decodeWorldGrid,
} from '../data/world-dot-map';

const props = defineProps<{
  nodes: NodeView[];
  /** 视图形态：世界点阵地图（map）或紧凑地区筛选列表（list）。 */
  mode: 'map' | 'list';
  /** 节点 → 地区码；已含 Annotation 覆盖与离线 IP 识别后的最终值。 */
  regionOf: (node: NodeView) => string;
  /** 节点 → 延迟（ms 或 null）。 */
  latencyOf: (node: NodeView) => number | null;
  /** 当前选中的地区码（'' 表示未筛选）；用于高亮回显。 */
  selected?: string;
}>();

const emit = defineEmits<{
  (event: 'select', region: string): void;
  (event: 'clear'): void;
  (event: 'open-list'): void;
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
  FR: { flag: '🇫🇷', short: '法国', label: '法国' },
  NL: { flag: '🇳🇱', short: '荷兰', label: '荷兰' },
  CA: { flag: '🇨🇦', short: '加拿大', label: '加拿大' },
  AU: { flag: '🇦🇺', short: '澳大利亚', label: '澳大利亚' },
  RU: { flag: '🇷🇺', short: '俄罗斯', label: '俄罗斯' },
  IN: { flag: '🇮🇳', short: '印度', label: '印度' },
  TR: { flag: '🇹🇷', short: '土耳其', label: '土耳其' },
  MY: { flag: '🇲🇾', short: '马来西亚', label: '马来西亚' },
  TH: { flag: '🇹🇭', short: '泰国', label: '泰国' },
  VN: { flag: '🇻🇳', short: '越南', label: '越南' },
  PH: { flag: '🇵🇭', short: '菲律宾', label: '菲律宾' },
  ID: { flag: '🇮🇩', short: '印度尼西亚', label: '印度尼西亚' },
  OTHER: { flag: '🌐', short: '其他', label: '其他' },
};

/** 固定展示顺序：东亚 → 东南亚 → 欧洲 → 北美 → 其他；不按节点数排，避免筛选后段位跳动。 */
const REGION_ORDER: readonly string[] = ['HK', 'TW', 'CN', 'JP', 'KR', 'SG', 'DE', 'UK', 'US', 'OTHER'];

function flagOfCode(code: string): string {
  const iso = code === 'UK' ? 'GB' : code;
  if (!/^[A-Z]{2}$/.test(iso)) return '🌐';
  return String.fromCodePoint(0x1f1e6 + iso.charCodeAt(0) - 65, 0x1f1e6 + iso.charCodeAt(1) - 65);
}

function metaOf(code: string): RegionMeta {
  return REGION_META[code] ?? { flag: flagOfCode(code), short: code, label: code };
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
  for (const code of REGION_ORDER) {
    if (code === 'OTHER') continue;
    const entry = map.get(code);
    if (entry !== undefined) push(code, entry);
  }
  const extra = [...map.entries()]
    .filter(([code]) => !REGION_ORDER.includes(code))
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  for (const [code, entry] of extra) push(code, entry);
  const other = map.get('OTHER');
  if (other !== undefined) push('OTHER', other);
  return result;
});

const totalNodes = computed(() => rows.value.reduce((sum, row) => sum + row.count, 0));

const hasLatency = computed(() => rows.value.some((row) => row.avg !== null));
const selectedLabel = computed(() =>
  props.selected === undefined || props.selected === '' ? '' : metaOf(props.selected).label,
);

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

function sharePct(row: Row): number {
  if (totalNodes.value === 0) return 0;
  return Math.round((row.count / totalNodes.value) * 100);
}

function pick(code: string): void {
  if (props.selected === code) emit('clear');
  else emit('select', code);
}

/* ---------------- 世界点阵地图（HiDPI Canvas + 静态底图） ---------------- */

const WORLD_GRID = decodeWorldGrid();
const LAND_CELLS: number[] = [];
const COUNTRY_CELLS = new Map<string, number[]>();
for (let i = 0; i < WORLD_GRID.length; i += 1) {
  const cell = WORLD_GRID[i]!;
  if (cell === '.') continue;
  LAND_CELLS.push(i);
  if (cell !== '#') {
    const list = COUNTRY_CELLS.get(cell);
    if (list === undefined) COUNTRY_CELLS.set(cell, [i]);
    else list.push(i);
  }
}

function mercatorY(latDeg: number): number {
  const clamped = Math.min(Math.max(latDeg, -85), 85);
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

const MERC_TOP = mercatorY(WORLD_MAP_BOUNDS.maxLat);
const MERC_BOTTOM = mercatorY(WORLD_MAP_BOUNDS.minLat);

function projectAnchorUnit(lat: number, lon: number): { x: number; y: number } {
  const x = (lon - WORLD_MAP_BOUNDS.minLon) / (WORLD_MAP_BOUNDS.maxLon - WORLD_MAP_BOUNDS.minLon);
  const y = (MERC_TOP - mercatorY(lat)) / (MERC_TOP - MERC_BOTTOM);
  return {
    x: Math.min(Math.max(x, 0.01), 0.99),
    y: Math.min(Math.max(y, 0.02), 0.98),
  };
}

function nearestLandCell(xUnit: number, yUnit: number): number | undefined {
  const targetCol = xUnit * WORLD_MAP_COLS - 0.5;
  const targetRow = yUnit * WORLD_MAP_ROWS - 0.5;
  let bestIdx: number | undefined;
  let bestDist = Infinity;
  for (const idx of LAND_CELLS) {
    const col = idx % WORLD_MAP_COLS;
    const row = Math.floor(idx / WORLD_MAP_COLS);
    const dx = col - targetCol;
    const dy = row - targetRow;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

const rowByCode = computed(() => new Map(rows.value.map((r) => [r.code, r])));

interface MapAnchor {
  readonly row: Row;
  readonly xUnit: number;
  readonly yUnit: number;
}

const activeAnchors = computed<readonly MapAnchor[]>(() => {
  const out: MapAnchor[] = [];
  for (const row of rows.value) {
    if (row.code === 'OTHER') continue;
    const coords = WORLD_COUNTRY_ANCHORS[row.code];
    if (coords === undefined) continue;
    const unit = projectAnchorUnit(coords[0], coords[1]);
    out.push({ row, xUnit: unit.x, yUnit: unit.y });
  }
  return out;
});

/** 有归属节点的网格高亮表：网格 idx -> 对应地区码（小微地区无原生格点时挂到最近陆地格点）。 */
const coveredCellCountry = computed(() => {
  const out = new Map<number, string>();
  for (const row of rows.value) {
    if (row.code === 'OTHER') continue;
    const owned = COUNTRY_CELLS.get(row.code);
    if (owned !== undefined && owned.length > 0) {
      for (const idx of owned) out.set(idx, row.code);
    } else {
      const coords = WORLD_COUNTRY_ANCHORS[row.code];
      if (coords !== undefined) {
        const unit = projectAnchorUnit(coords[0], coords[1]);
        const nearest = nearestLandCell(unit.x, unit.y);
        if (nearest !== undefined && !out.has(nearest)) out.set(nearest, row.code);
      }
    }
  }
  return out;
});

const mapCanvasRef = ref<HTMLCanvasElement | null>(null);
const mapBoxRef = ref<HTMLDivElement | null>(null);
const hoveredCode = ref('');
const pointerPos = ref<{ x: number; y: number } | null>(null);

interface PaletteColors {
  land: string;
  accent: string;
  ok: string;
  warn: string;
  danger: string;
  surface: string;
}

function readPaletteColors(): PaletteColors {
  const target = mapBoxRef.value ?? document.documentElement;
  const styles = getComputedStyle(target);
  return {
    land: styles.getPropertyValue('--border-strong').trim() || '#c7c2b4',
    accent: styles.getPropertyValue('--accent').trim() || '#b05430',
    ok: styles.getPropertyValue('--ok').trim() || '#3f6b4a',
    warn: styles.getPropertyValue('--warn').trim() || '#8a5a12',
    danger: styles.getPropertyValue('--danger').trim() || '#a93b2c',
    surface: styles.getPropertyValue('--surface').trim() || '#faf9f5',
  };
}

function colorForRow(row: Row, colors: PaletteColors): string {
  if (row.avg === null) return colors.accent;
  if (row.avg < 100) return colors.ok;
  if (row.avg < 250) return colors.warn;
  return colors.danger;
}

function drawMap(): void {
  const canvas = mapCanvasRef.value;
  if (canvas === null || props.mode !== 'map') return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pixelWidth = Math.round(rect.width * dpr);
  const pixelHeight = Math.round(rect.height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const colors = readPaletteColors();
  const cellW = rect.width / WORLD_MAP_COLS;
  const cellH = rect.height / WORLD_MAP_ROWS;
  const baseRadius = Math.max(1.05, Math.min(cellW, cellH) * 0.34);
  const covered = coveredCellCountry.value;
  const selectedCode = props.selected ?? '';
  const focusCode = hoveredCode.value || selectedCode;
  const hasFocus = focusCode !== '';

  // 1) 未归属陆地底图点阵
  ctx.fillStyle = colors.land;
  ctx.globalAlpha = 0.72;
  ctx.beginPath();
  for (const idx of LAND_CELLS) {
    if (covered.has(idx)) continue;
    const col = idx % WORLD_MAP_COLS;
    const row = Math.floor(idx / WORLD_MAP_COLS);
    const cx = (col + 0.5) * cellW;
    const cy = (row + 0.5) * cellH;
    ctx.moveTo(cx + baseRadius, cy);
    ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
  }
  ctx.fill();

  // 2) 有节点的国家/地区覆盖点阵
  const rowMap = rowByCode.value;
  for (const [idx, code] of covered) {
    const rowData = rowMap.get(code);
    if (rowData === undefined) continue;
    const col = idx % WORLD_MAP_COLS;
    const row = Math.floor(idx / WORLD_MAP_COLS);
    const cx = (col + 0.5) * cellW;
    const cy = (row + 0.5) * cellH;
    const isFocused = focusCode === code;
    const r = isFocused ? baseRadius * 1.45 : baseRadius * 1.22;
    ctx.globalAlpha = hasFocus && !isFocused ? 0.35 : 0.96;
    ctx.fillStyle = colorForRow(rowData, colors);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3) 国家信标圆点：保证香港 / 新加坡 / 台湾等小微地区始终清晰可点
  for (const anchor of activeAnchors.value) {
    const cx = anchor.xUnit * rect.width;
    const cy = anchor.yUnit * rect.height;
    const isSelected = selectedCode === anchor.row.code;
    const isHovered = hoveredCode.value === anchor.row.code;
    const fill = colorForRow(anchor.row, colors);
    const dotR = isSelected || isHovered ? 4.2 : 3.1;

    ctx.globalAlpha = hasFocus && !isSelected && !isHovered ? 0.45 : 1;
    if (isSelected || isHovered) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(cx, cy, dotR + 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = hasFocus && !isSelected && !isHovered ? 0.55 : 1;
    ctx.fillStyle = fill;
    ctx.strokeStyle = colors.surface;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function hitTestCanvas(clientX: number, clientY: number): string {
  const canvas = mapCanvasRef.value;
  if (canvas === null) return '';
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return '';

  // 1) 优先命中精确地区信标（解决 HK / TW / SG 等小面积地区相邻点选）
  let nearestCode = '';
  let nearestDist = 14 * 14;
  for (const anchor of activeAnchors.value) {
    const ax = anchor.xUnit * rect.width;
    const ay = anchor.yUnit * rect.height;
    const d2 = (x - ax) ** 2 + (y - ay) ** 2;
    if (d2 <= nearestDist) {
      nearestDist = d2;
      nearestCode = anchor.row.code;
    }
  }
  if (nearestCode !== '') return nearestCode;

  // 2) 回退格点命中（检查当前格点及其直接邻域）
  const col = Math.floor((x / rect.width) * WORLD_MAP_COLS);
  const row = Math.floor((y / rect.height) * WORLD_MAP_ROWS);
  const direct = coveredCellCountry.value.get(row * WORLD_MAP_COLS + col);
  if (direct !== undefined) return direct;

  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= WORLD_MAP_ROWS || nc < 0 || nc >= WORLD_MAP_COLS) continue;
      const hit = coveredCellCountry.value.get(nr * WORLD_MAP_COLS + nc);
      if (hit !== undefined) return hit;
    }
  }
  return '';
}

function onMapPointerMove(event: PointerEvent): void {
  const box = mapBoxRef.value;
  if (box !== null) {
    const rect = box.getBoundingClientRect();
    pointerPos.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  hoveredCode.value = hitTestCanvas(event.clientX, event.clientY);
}

function onMapPointerLeave(): void {
  hoveredCode.value = '';
  pointerPos.value = null;
}

function onMapClick(event: MouseEvent): void {
  const hit = hitTestCanvas(event.clientX, event.clientY);
  if (hit !== '') pick(hit);
}

const hoveredRow = computed(() => (hoveredCode.value === '' ? null : (rowByCode.value.get(hoveredCode.value) ?? null)));

const tooltipStyle = computed((): Record<string, string> => {
  if (pointerPos.value === null || mapBoxRef.value === null) return { display: 'none' };
  const rect = mapBoxRef.value.getBoundingClientRect();
  const left = Math.min(Math.max(pointerPos.value.x + 12, 8), Math.max(8, rect.width - 170));
  const top = Math.max(8, pointerPos.value.y - 34);
  return { left: `${left}px`, top: `${top}px` };
});

const selectedRow = computed(() =>
  props.selected !== undefined && props.selected !== '' ? (rowByCode.value.get(props.selected) ?? null) : null,
);

let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;

watch([rows, () => props.selected, hoveredCode, () => props.mode], () => {
  void nextTick(() => drawMap());
});

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => drawMap());
    if (mapBoxRef.value !== null) resizeObserver.observe(mapBoxRef.value);
  }
  if (typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => drawMap());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
  }
  void nextTick(() => drawMap());
});

watch(mapBoxRef, (el, prev) => {
  if (resizeObserver === null) return;
  if (prev !== null) resizeObserver.unobserve(prev);
  if (el !== null) resizeObserver.observe(el);
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
});
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
      <span v-else class="rst-hint">{{ mode === 'map' ? '点击地图或右侧地区高亮筛选' : '点击地区筛选下方表格' }}</span>
    </div>

    <div v-if="mode === 'map'" class="rst-map-wrap">
      <div ref="mapBoxRef" class="rst-map-box">
        <canvas
          ref="mapCanvasRef"
          class="rst-map-canvas"
          :style="{ cursor: hoveredCode !== '' ? 'pointer' : 'default' }"
          @pointermove="onMapPointerMove"
          @pointerleave="onMapPointerLeave"
          @click="onMapClick"
        ></canvas>
        <div v-if="hoveredRow !== null" class="rst-map-tip" :style="tooltipStyle">
          <span>{{ hoveredRow.flag }} {{ hoveredRow.label }}</span>
          <b>{{ hoveredRow.count }}</b>
          <span v-if="hoveredRow.avg !== null" class="mono text-3">{{ hoveredRow.avg }} ms</span>
        </div>
      </div>

      <div class="rst-map-side">
        <div class="rst-map-chips">
          <button
            v-for="row in rows"
            :key="row.code"
            type="button"
            class="map-chip"
            :class="{ on: selected === row.code }"
            :title="tipOf(row)"
            :style="{ '--lat': toneOf(row.avg) }"
            @mouseenter="hoveredCode = row.code"
            @mouseleave="hoveredCode = ''"
            @click="pick(row.code)"
          >
            <span class="fl">{{ row.flag }}</span>
            <span class="nm">{{ row.short }}</span>
            <span class="n">{{ row.count }}</span>
          </button>
        </div>

        <div v-if="selectedRow !== null" class="rst-map-focus">
          <div class="rst-focus-info">
            <span>{{ selectedRow.flag }} {{ selectedRow.label }}</span>
            <b>{{ selectedRow.count }} 个节点</b>
            <span v-if="selectedRow.avg !== null" class="mono text-3">{{ selectedRow.avg }} ms</span>
          </div>
          <button type="button" class="rst-focus-btn" @click="emit('open-list')">
            切到列表查看明细 →
          </button>
        </div>
      </div>
    </div>

    <div v-else class="rst-list">
      <button
        v-for="row in rows"
        :key="row.code"
        type="button"
        class="rst-list-item"
        :class="{ on: selected === row.code }"
        :title="tipOf(row)"
        :style="{ '--lat': toneOf(row.avg) }"
        @click="pick(row.code)"
      >
        <span class="fl">{{ row.flag }}</span>
        <span class="nm">{{ row.label }}</span>
        <span class="cd">{{ row.code }}</span>
        <span class="spacer"></span>
        <span v-if="row.avg !== null" class="lat">{{ row.avg }} ms</span>
        <span class="cnt">{{ row.count }}</span>
        <span class="pct">{{ sharePct(row) }}%</span>
        <span class="bar" aria-hidden="true"><i :style="{ width: `${Math.max(sharePct(row), 4)}%` }"></i></span>
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

/* ---------------- 世界点阵地图样式 ---------------- */

.rst-map-wrap {
  display: grid;
  grid-template-columns: minmax(0, 560px) minmax(180px, 1fr);
  gap: 14px;
  align-items: start;
}

.rst-map-box {
  position: relative;
  width: 100%;
  aspect-ratio: 160 / 88;
  border-radius: var(--radius);
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow: hidden;
}

.rst-map-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.rst-map-tip {
  position: absolute;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-sm);
  font-size: 11.5px;
  color: var(--text);
  white-space: nowrap;
  z-index: 2;
}
.rst-map-tip b {
  font: 600 12px/1 var(--mono);
  font-variant-numeric: tabular-nums;
}

.rst-map-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.rst-map-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-content: flex-start;
}

.rst-map-focus {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  border: 1px solid var(--accent-ring);
  font-size: 12px;
}

.rst-focus-info {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}

.rst-focus-btn {
  border: 0;
  background: var(--surface);
  color: var(--accent);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent-ring);
  cursor: pointer;
}
.rst-focus-btn:hover {
  background: var(--surface-hover);
}

.map-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.12s ease;
}
.map-chip:hover {
  background: var(--surface-hover);
}
.map-chip.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
  color: var(--text);
}
.map-chip::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--lat, transparent);
}
.map-chip .n {
  font: 600 12px/1 var(--mono);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.map-chip.on .n {
  color: var(--accent);
}

/* ---------------- 地区列表视图样式 ---------------- */

.rst-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 6px;
}

.rst-list-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.12s ease;
}
.rst-list-item:hover {
  background: var(--surface-hover);
}
.rst-list-item.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-ring);
  color: var(--text);
}
.rst-list-item .fl {
  flex: 0 0 auto;
  font-size: 14px;
  line-height: 1;
}
.rst-list-item .nm {
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rst-list-item .cd {
  font: 500 10.5px/1 var(--mono);
  color: var(--text-3);
}
.rst-list-item .lat {
  font: 500 11px/1 var(--mono);
  color: var(--lat, var(--text-3));
  font-variant-numeric: tabular-nums;
}
.rst-list-item .cnt {
  font: 600 13px/1 var(--mono);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.rst-list-item.on .cnt {
  color: var(--accent);
}
.rst-list-item .pct {
  min-width: 30px;
  text-align: right;
  font: 500 11px/1 var(--mono);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.rst-list-item .bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: transparent;
}
.rst-list-item .bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  opacity: 0.45;
  transition: width 0.2s ease;
}
.rst-list-item.on .bar i {
  opacity: 0.9;
}

@media (max-width: 820px) {
  .rst-map-wrap {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
}
</style>
