<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NInput, NPopconfirm, NSelect, NTag } from 'naive-ui';
import { ArrowDown, ArrowUp, Info, Plus, Trash2 } from 'lucide-vue-next';
import { api } from '../api';
import type { NodeTransformView } from '../api';
import { activeProfileName, nodes, notify } from '../workspace';

/**
 * 按节点名批量清洗：机场常把「剩余流量 / 到期 / 过滤掉 N 条」伪装成节点塞进订阅，
 * 或是想要给所有美国节点加 🇺🇸 前缀。这类「一类节点」的粗加工在这里做，
 * 单个节点的别名/地区/排序仍归下面的节点清单（annotation）。
 *
 * 规则先于标注执行，且改名不改 nodeKey——所以已有标注不会因批量改名失效。
 */
interface Row {
  id: string;
  pattern: string;
  action: 'exclude' | 'rename';
  replacement: string;
}
const rows = reactive<Row[]>([]);
const loading = ref(false);
const saving = ref(false);
const loadedFor = ref<string | null>(null);
let nextId = 1;

const actionOptions = [
  { label: '剔除节点', value: 'exclude' },
  { label: '改名', value: 'rename' },
];

const newId = (): string => `t${Date.now().toString(36)}${(nextId++).toString(36)}`;

function addRow(): void {
  rows.push({ id: newId(), pattern: '', action: 'exclude', replacement: '' });
}

function move(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return;
  const [row] = rows.splice(index, 1);
  if (row !== undefined) rows.splice(target, 0, row);
}

function removeRow(index: number): void {
  rows.splice(index, 1);
}

/** 与后端 compileMatcher 同口径：/regex/flags、glob(*?)、字面量（不区分大小写、子串匹配）。 */
function matcherOf(pattern: string): RegExp | null {
  const text = pattern.trim();
  if (text.length === 0) return null;
  const literal = /^\/(.*)\/([a-z]*)$/i.exec(text);
  if (literal !== null) {
    try {
      return new RegExp(literal[1] ?? '', (literal[2] ?? '').replace(/[gy]/g, ''));
    } catch {
      return null;
    }
  }
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/[*?]/.test(text)) {
    const body = [...text].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escape(ch))).join('');
    try {
      return new RegExp(`^${body}$`, 'i');
    } catch {
      return null;
    }
  }
  return new RegExp(escape(text), 'i');
}

const actionable = computed(() => rows.filter((row) => row.pattern.trim().length > 0));
const invalidPatterns = computed(() => rows.filter((row) => row.pattern.trim() && matcherOf(row.pattern) === null).length);

/** 命中数与样例：只统计当前节点清单，给用户一个「这条规则会不会误伤」的即时反馈。 */
function preview(row: Row): { count: number; samples: string[] } {
  const matcher = matcherOf(row.pattern);
  if (matcher === null) return { count: 0, samples: [] };
  const hit = nodes.value.filter((node) => matcher.test(node.name));
  return { count: hit.length, samples: hit.slice(0, 3).map((node) => node.name) };
}

const hasChanges = computed(() => {
  const current = JSON.stringify(rows.map((row) => ({
    id: row.id,
    order: rows.indexOf(row),
    pattern: row.pattern,
    action: row.action,
    ...(row.replacement === '' ? {} : { replacement: row.replacement }),
  })));
  return current !== baseline.value;
});
const baseline = ref('');

function snapshot(): string {
  return JSON.stringify(rows.map((row, index) => ({
    id: row.id,
    order: index,
    pattern: row.pattern,
    action: row.action,
    ...(row.replacement === '' ? {} : { replacement: row.replacement }),
  })));
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const view = await api.nodeTransforms(activeProfileName.value);
    const sorted = [...view.transforms].sort((left, right) => left.order - right.order);
    rows.splice(0, rows.length, ...sorted.map((t) => ({
      id: t.id,
      pattern: t.pattern,
      action: t.action,
      replacement: t.replacement ?? '',
    })));
    baseline.value = snapshot();
    loadedFor.value = activeProfileName.value;
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '读取清洗规则失败');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (invalidPatterns.value > 0) {
    notify('error', '有规则的匹配式写错了，请先修正');
    return;
  }
  saving.value = true;
  try {
    const transforms: NodeTransformView[] = rows
      // 新增但没填匹配式的空行不提交，否则后端 min(1) 会整批 400。
      .filter((row) => row.pattern.trim().length > 0)
      .map((row, index) => ({
        id: row.id,
        order: index,
        pattern: row.pattern.trim(),
        action: row.action,
        ...(row.action === 'rename' && row.replacement !== ''
          ? { replacement: row.replacement }
          : {}),
      }));
    const saved = await api.saveNodeTransforms(transforms, activeProfileName.value);
    await load();
    notify('ok', `已保存 ${saved.transforms.length} 条规则；产物预览与订阅下次拉取时生效`);
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '保存清洗规则失败');
  } finally {
    saving.value = false;
  }
}

onMounted(() => { void load(); });
watch(activeProfileName, (name) => {
  if (name !== loadedFor.value) void load();
});
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>批量清洗</h2>
      <n-tag size="small" :bordered="false" class="mono">
        {{ loading ? '读取中' : `${actionable.length} 条规则` }}
      </n-tag>
    </div>
    <div class="card-body">
      <p class="text-3" style="font-size: 12px; margin: 0 0 12px; max-width: 680px">
        按节点名匹配，<strong>从上往下依次执行</strong>：剔除机场塞进来的信息节点，或给一类节点加地区前缀。
        这条只做「一类节点」的粗加工；单个节点的别名、地区、排序在下方节点清单里改。
        改名不改变节点的稳定标识，已有标注不会失效。
      </p>

      <div v-if="rows.length === 0" class="transform-empty">
        <span class="text-3" style="font-size: 12px">还没有规则。节点的名字里带「剩余流量」这类营销信息？加一条剔除规则试试。</span>
      </div>

      <div v-for="(row, index) in rows" :key="row.id" class="transform-row">
        <div class="transform-row-head">
          <span class="mono text-3" style="font-size: 11.5px">#{{ index + 1 }}</span>
          <n-select
            v-model:value="row.action"
            :options="actionOptions"
            size="small"
            style="width: 120px; flex: 0 0 auto"
          />
          <div class="spacer"></div>
          <n-button size="small" quaternary :disabled="index === 0" title="上移" @click="move(index, -1)">
            <template #icon><ArrowUp :size="14" /></template>
          </n-button>
          <n-button size="small" quaternary :disabled="index === rows.length - 1" title="下移" @click="move(index, 1)">
            <template #icon><ArrowDown :size="14" /></template>
          </n-button>
          <n-button size="small" quaternary title="删除" @click="removeRow(index)">
            <template #icon><Trash2 :size="14" /></template>
          </n-button>
        </div>
        <div class="transform-fields">
          <div class="field">
            <label>匹配节点名</label>
            <n-input v-model:value="row.pattern" size="small" placeholder="/流量|到期|剩余|套餐/i" />
          </div>
          <div v-if="row.action === 'rename'" class="field">
            <label>改成</label>
            <n-input v-model:value="row.replacement" size="small" placeholder="🇺🇸 {name}" />
          </div>
        </div>
        <div v-if="row.pattern.trim()" class="transform-preview text-3" style="font-size: 11.5px">
          <template v-if="matcherOf(row.pattern) === null">
            <span class="badge danger">匹配式无效</span>
          </template>
          <template v-else>
            命中 <strong>{{ preview(row).count }}</strong> 个节点
            <span v-if="preview(row).samples.length > 0" class="mono">
              · {{ preview(row).samples.join(' / ') }}
            </span>
          </template>
        </div>
      </div>

      <n-alert type="info" :bordered="false" style="margin-top: 12px">
        <div style="font-size: 11.5px; line-height: 1.7">
          匹配式三种写法：<code>/正则/flags</code>（如 <code>/流量|到期/i</code>）、
          <code>*通配符</code>（如 <code>*香港*</code>）、普通文字（子串、不区分大小写）。
          改名的 <code>{name}</code> 会替换成原节点名，例如 <code>🇺🇸 {name}</code> 给命中的节点加美国前缀。
        </div>
      </n-alert>

      <div class="row" style="margin-top: 12px; gap: 8px">
        <n-button size="small" secondary @click="addRow">
          <template #icon><Plus :size="14" /></template>
          添加规则
        </n-button>
        <n-button size="small" type="primary" :loading="saving" :disabled="!hasChanges" @click="save">
          保存清洗规则
        </n-button>
        <n-popconfirm v-if="rows.length > 0" @positive-click="rows.splice(0, rows.length); void save()">
          <template #trigger>
            <n-button size="small" secondary>清空全部</n-button>
          </template>
          清空后这份配置的产物不再做批量清洗，确认？
        </n-popconfirm>
      </div>
    </div>
  </section>
</template>

<style scoped>
.transform-empty {
  padding: 10px 0 2px;
}
.transform-row {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  margin-bottom: 8px;
}
.transform-row-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}
.transform-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.transform-fields .field label {
  display: block;
  font-size: 11.5px;
  margin-bottom: 4px;
}
.transform-preview {
  margin-top: 8px;
}
code {
  font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  background: var(--surface-2);
  padding: 1px 4px;
  border-radius: 3px;
}
@media (max-width: 640px) {
  .transform-fields { grid-template-columns: 1fr; }
}
</style>
