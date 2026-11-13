<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { NButton, NEmpty, NInput, NRadioButton, NRadioGroup, NSelect, NSwitch, NTag, NTooltip } from 'naive-ui';
import { Activity, ArrowDown, ArrowUp, ChevronDown, Copy, LayoutGrid, Pencil, Search, Server } from 'lucide-vue-next';
import type { NodeView } from '../api';
import RegionMap from '../components/RegionMap.vue';
import {
  annotationMap,
  busy,
  copyText,
  excludedCount,
  latencies,
  moveNode,
  nodes,
  probeLatency,
  probing,
  saveAlias,
  saveRegion,
  tab,
  toggleExcluded,
} from '../workspace';

const search = ref('');
const kind = ref('');
const scope = ref<'all' | 'active' | 'excluded'>('all');
const expanded = ref<string[]>([]);
const editing = ref('');
const aliasDraft = ref('');
const showRegionMap = ref(false);
const regionFilter = ref('');

/** 与后端 REGION_CODES 对齐的地区码及显示名；手动覆盖时供下拉选择。 */
const REGION_OPTIONS = [
  { label: '中国香港 · HK', value: 'HK' },
  { label: '中国台湾 · TW', value: 'TW' },
  { label: '日本 · JP', value: 'JP' },
  { label: '新加坡 · SG', value: 'SG' },
  { label: '美国 · US', value: 'US' },
  { label: '英国 · UK', value: 'UK' },
  { label: '德国 · DE', value: 'DE' },
  { label: '韩国 · KR', value: 'KR' },
  { label: '中国大陆 · CN', value: 'CN' },
];

const kinds = computed(() => {
  const counters = new Map<string, number>();
  for (const node of nodes.value) counters.set(node.kind, (counters.get(node.kind) ?? 0) + 1);
  return [...counters.entries()].sort((left, right) => right[1] - left[1]);
});

const kindOptions = computed(() => [
  { label: '全部协议', value: '' },
  ...kinds.value.map((entry) => ({ label: `${entry[0]} · ${entry[1]}`, value: entry[0] })),
]);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return nodes.value.filter((node) => {
    const annotation = annotationMap.value.get(node.nodeKey);
    const isExcluded = annotation?.excluded === true;
    if (scope.value === 'active' && isExcluded) return false;
    if (scope.value === 'excluded' && !isExcluded) return false;
    if (kind.value !== '' && node.kind !== kind.value) return false;
    if (regionFilter.value !== '' && effectiveRegion(node) !== regionFilter.value) return false;
    if (needle.length === 0) return true;
    const alias = annotation?.alias ?? '';
    return (
      node.name.toLowerCase().includes(needle) ||
      node.address.toLowerCase().includes(needle) ||
      alias.toLowerCase().includes(needle)
    );
  });
});

const hiddenCount = computed(() => nodes.value.length - filtered.value.length);
const sortable = computed(
  () => scope.value === 'all' && kind.value === '' && regionFilter.value === '' && search.value.trim() === '',
);

function aliasOf(node: NodeView): string {
  return annotationMap.value.get(node.nodeKey)?.alias ?? '';
}

function regionOf(node: NodeView): string {
  return annotationMap.value.get(node.nodeKey)?.region ?? '';
}

const regionLabel = (code: string): string => REGION_OPTIONS.find((item) => item.value === code)?.label ?? code;

/** 名字关键词推断地区（与后端 regionOf 同口径）；覆盖值优先。 */
const NAME_REGION: readonly { code: string; re: RegExp }[] = [
  { code: 'HK', re: /香港|港|HK|HKG|HongKong/i },
  { code: 'TW', re: /中国台湾|台湾|台灣|TW|TWN|Taiwan/i },
  { code: 'JP', re: /日本|东京|大阪|JP|JPN|Japan/i },
  { code: 'SG', re: /新加坡|狮城|SG|SGP|Singapore/i },
  { code: 'US', re: /\bUS\b|\bUSA\b|UnitedStates|美国|洛杉矶|圣何塞|西雅图|America/i },
  { code: 'UK', re: /英国|伦敦|\bUK\b|\bGB\b|GBR|London/i },
  { code: 'DE', re: /德国|法兰克福|\bDE\b|DEU|Germany/i },
  { code: 'KR', re: /韩国|首尔|\bKR\b|KOR|Korea/i },
  { code: 'CN', re: /中国|回国|上海|北京|广州|深圳|\bCN\b|CHN|China/i },
];

function effectiveRegion(node: NodeView): string {
  const override = regionOf(node);
  if (override !== '') return override;
  for (const item of NAME_REGION) if (item.re.test(node.name)) return item.code;
  return 'OTHER';
}

function latencyMs(node: NodeView): number | null {
  const value = latencies.value[node.nodeKey];
  if (value === undefined || value.ms === null || value.intercepted) return null;
  return value.ms;
}

function featuresOf(node: NodeView): string[] {
  return Object.entries(node.options)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}=${String(value)}`));
}

/** 延迟色调：<100ms 正常、<250ms 一般、其余偏慢；未测为 undefined。 */
function latencyClass(nodeKey: string): string {
  const value = latencies.value[nodeKey];
  if (value === undefined || value.ms === null) return 'text-3';
  // 解析到内网 / 本机假 IP 的数字不可比，一律灰掉，不用颜色暗示「快」。
  if (value.intercepted) return 'text-3';
  if (value.ms < 100) return 'lat-fast';
  if (value.ms < 250) return 'lat-ok';
  return 'lat-slow';
}

function latencyText(nodeKey: string): string {
  const value = latencies.value[nodeKey];
  if (value === undefined) return '—';
  if (value.ms === null) return '不可达';
  return `${value.ms} ms`;
}

/** 被本机 TUN / DNS 劫持或本身是内网地址：数字旁边标一下，避免被当成节点质量。 */
function latencyIntercepted(nodeKey: string): boolean {
  return latencies.value[nodeKey]?.intercepted === true;
}

function isOpen(nodeKey: string): boolean {
  return expanded.value.includes(nodeKey);
}

function toggleDetail(nodeKey: string): void {
  expanded.value = isOpen(nodeKey)
    ? expanded.value.filter((item) => item !== nodeKey)
    : [...expanded.value, nodeKey];
}

async function startEdit(node: NodeView): Promise<void> {
  editing.value = node.nodeKey;
  aliasDraft.value = aliasOf(node);
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('[data-alias-input] input');
  input?.focus();
  input?.select();
}

async function commitAlias(node: NodeView): Promise<void> {
  if (editing.value !== node.nodeKey) return;
  const value = aliasDraft.value.trim();
  editing.value = '';
  if (value === aliasOf(node)) return;
  await saveAlias(node, value);
}
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="card-head filters">
        <h2>节点清单</h2>
        <span class="count">{{ filtered.length }}</span>
        <n-input v-model:value="search" size="small" placeholder="搜索名称、别名或地址" clearable style="flex: 1; min-width: 150px; max-width: 320px">
          <template #prefix><Search :size="14" /></template>
        </n-input>
        <n-select v-model:value="kind" :options="kindOptions" size="small" style="width: 160px" />
        <span v-if="hiddenCount > 0" class="badge outline">已过滤 {{ hiddenCount }}</span>
        <div class="spacer"></div>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button size="small" quaternary :type="showRegionMap ? 'primary' : 'default'" @click="showRegionMap = !showRegionMap">
              <template #icon><LayoutGrid :size="14" /></template>
              地区分布
            </n-button>
          </template>
          按地区聚合节点（抽象色块，非真实地图）
        </n-tooltip>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button size="small" quaternary :loading="probing" @click="probeLatency()">
              <template #icon><Activity :size="14" /></template>
              测延迟
            </n-button>
          </template>
          TCP 握手往返（主控机 → 节点服务器），不是代理链路测速
        </n-tooltip>
        <n-radio-group v-model:value="scope" size="small">
          <n-radio-button value="all">全部 {{ nodes.length }}</n-radio-button>
          <n-radio-button value="active">参与构建</n-radio-button>
          <n-radio-button value="excluded">已排除 {{ excludedCount }}</n-radio-button>
        </n-radio-group>
      </div>

      <div v-if="showRegionMap && nodes.length > 0" class="region-map-card">
        <RegionMap
          :nodes="nodes"
          :region-of="effectiveRegion"
          :latency-of="latencyMs"
          :selected="regionFilter"
          @select="regionFilter = $event"
          @clear="regionFilter = ''"
        />
      </div>

      <n-empty v-if="nodes.length === 0" description="还没有节点：先添加订阅源，并把它加入 Profile 构成" style="padding: 40px 0">
        <template #icon><Server :size="30" /></template>
        <template #extra>
          <n-button size="small" type="primary" @click="tab = 'sources'">去订阅源页配置</n-button>
        </template>
      </n-empty>

      <n-empty v-else-if="filtered.length === 0" description="没有匹配的节点" style="padding: 40px 0">
        <template #icon><Search :size="30" /></template>
        <template #extra>
          <n-button size="small" quaternary @click="search = ''; kind = ''; scope = 'all'; regionFilter = ''">清除筛选</n-button>
        </template>
      </n-empty>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 42px">#</th>
              <th>名称</th>
              <th style="width: 98px">协议</th>
              <th class="col-wide-only">地址</th>
              <th class="col-optional" style="width: 76px">延迟</th>
              <th class="col-optional">传输特性</th>
              <th style="width: 70px">排除</th>
              <th class="col-optional" style="width: 76px">排序</th>
              <th style="width: 40px"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(node, index) in filtered" :key="node.nodeKey">
              <tr :class="{ expanded: isOpen(node.nodeKey) }">
                <td class="num">{{ index + 1 }}</td>
                <td>
                  <div v-if="editing === node.nodeKey" class="row tight">
                    <n-input
                      v-model:value="aliasDraft"
                      size="small"
                      placeholder="留空恢复原名"
                      style="width: 160px"
                      data-alias-input
                      @keyup.enter="commitAlias(node)"
                      @keyup.esc="editing = ''"
                      @blur="commitAlias(node)"
                    />
                  </div>
                  <div v-else class="row tight" style="gap: 5px">
                    <span :class="annotationMap.get(node.nodeKey)?.excluded ? 'text-3' : 'strong'">{{ aliasOf(node) || node.name }}</span>
                    <n-tooltip trigger="hover">
                      <template #trigger>
                        <n-button aria-label="编辑节点" quaternary circle size="tiny" @click="startEdit(node)">
                          <template #icon><Pencil :size="12" /></template>
                        </n-button>
                      </template>
                      重命名
                    </n-tooltip>
                  </div>
                  <div v-if="aliasOf(node)" class="text-3" style="font-size: 11.5px">{{ node.name }}</div>
                  <div class="addr-mobile mono">{{ node.address }}</div>
                </td>
                <td><n-tag size="small" :bordered="false" class="mono">{{ node.kind }}</n-tag></td>
                <td class="mono text-2 col-wide-only">{{ node.address }}</td>
                <td class="col-optional mono" style="width: 76px; white-space: nowrap">
                  <span :class="latencyClass(node.nodeKey)" style="font-size: 12px">{{ latencyText(node.nodeKey) }}</span>
                  <n-tooltip v-if="latencyIntercepted(node.nodeKey)" trigger="hover">
                    <template #trigger>
                      <span class="text-3" style="font-size: 10px; margin-left: 3px">本机</span>
                    </template>
                    该节点解析到内网 / 本机假 IP（TUN 代理或 DNS 劫持），这个数字是到那个地址的往返，不代表节点质量
                  </n-tooltip>
                </td>
                <td class="col-optional">
                  <div class="row" style="gap: 4px">
                    <n-tag v-for="feature in featuresOf(node).slice(0, 3)" :key="feature" size="small" :bordered="false" style="font-size: 10.5px">
                      {{ feature }}
                    </n-tag>
                    <span v-if="featuresOf(node).length === 0" class="text-3">—</span>
                    <span v-else-if="featuresOf(node).length > 3" class="text-3" style="font-size: 11px">+{{ featuresOf(node).length - 3 }}</span>
                  </div>
                </td>
                <td>
                  <n-switch
                    size="small"
                    :value="annotationMap.get(node.nodeKey)?.excluded === true"
                    :disabled="busy > 0"
                    @update:value="toggleExcluded(node)"
                  />
                </td>
                <td class="col-optional">
                  <div class="row tight">
                    <n-button aria-label="上移" quaternary circle size="tiny" :disabled="!sortable || index === 0" @click="moveNode(nodes.indexOf(node), -1)">
                      <template #icon><ArrowUp :size="13" /></template>
                    </n-button>
                    <n-button aria-label="下移" quaternary circle size="tiny" :disabled="!sortable || index === filtered.length - 1" @click="moveNode(nodes.indexOf(node), 1)">
                      <template #icon><ArrowDown :size="13" /></template>
                    </n-button>
                  </div>
                </td>
                <td>
                  <n-button aria-label="展开或收起节点详情" quaternary circle size="tiny" @click="toggleDetail(node.nodeKey)">
                    <template #icon>
                      <ChevronDown :size="14" :style="{ transform: isOpen(node.nodeKey) ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }" />
                    </template>
                  </n-button>
                </td>
              </tr>
              <tr v-if="isOpen(node.nodeKey)" class="detail">
                <td colspan="9">
                  <div class="row" style="gap: 18px; align-items: flex-start; padding-top: 4px">
                    <div class="field" style="min-width: 210px">
                      <label>节点键</label>
                      <span class="mono text-3">{{ node.nodeKey }}</span>
                    </div>
                    <div class="field" style="flex: 1">
                      <label>参数</label>
                      <div class="row" style="gap: 5px">
                        <n-tag v-for="(value, key) in node.options" :key="key" size="small" :bordered="false" class="mono">
                          {{ key }}: {{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}
                        </n-tag>
                        <span v-if="Object.keys(node.options).length === 0" class="text-3" style="font-size: 12px">无附加参数</span>
                      </div>
                    </div>
                    <div class="field" style="min-width: 200px">
                      <label>地区（手动覆盖优先于名字识别）</label>
                      <n-select
                        :value="regionOf(node)"
                        size="small"
                        :options="[{ label: '跟随名字识别', value: '' }, ...REGION_OPTIONS]"
                        :disabled="busy > 0"
                        style="width: 180px"
                        @update:value="(value: string) => saveRegion(node, value)"
                      />
                      <span v-if="regionOf(node)" class="text-3" style="font-size: 11px">已覆盖为 {{ regionLabel(regionOf(node)) }}</span>
                    </div>
                    <n-button size="tiny" secondary @click="copyText(node.address)">
                      <template #icon><Copy :size="13" /></template>
                      复制地址
                    </n-button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div class="card-foot text-3" style="font-size: 11.5px">
        开关切换立即生效；排序需清除筛选后使用，顺序会写入标注并随构建生效。
      </div>
    </section>
  </div>
</template>
