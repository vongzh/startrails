<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NInput, NModal, NPopconfirm, NSelect, NTag } from 'naive-ui';
import { ArrowDown, ArrowUp, Plus, SlidersHorizontal, Trash2 } from 'lucide-vue-next';
import { api } from '../api';
import type { NodeTransformView } from '../api';
import { activeProfileName, invalidateTrace, nodes, notify, refreshPreview } from '../workspace';
import { compileMatcher } from '@core/collections/index.ts';

/**
 * 按节点名批量处理：机场常把「剩余流量 / 到期 / 过滤掉 N 条」伪装成节点塞进订阅，
 * 或是想要给所有美国节点加 🇺🇸 前缀。这类「一类节点」的粗加工在这里做，
 * 单个节点的别名/地区/排序仍归下面的节点清单（annotation）。
 *
 * 规则先于标注执行，且重命名不改 nodeKey——所以已有标注不会因批量重命名失效。
 *
 * 内容页只做「当前有哪些规则」的速览；编辑收进弹窗，避免十来行表单常驻把节点清单挤下去。
 */
interface Row {
  id: string;
  pattern: string;
  action: 'exclude' | 'keep' | 'rename';
  replacement: string;
}
const rows = reactive<Row[]>([]);
const loading = ref(false);
const saving = ref(false);
const loadedFor = ref<string | null>(null);
const editorOpen = ref(false);
let nextId = 1;

const actionOptions = [
  { label: '移除节点', value: 'exclude' },
  { label: '保留节点', value: 'keep' },
  { label: '重命名', value: 'rename' },
];

/** 常用匹配式：点一下往列表末尾追加一条预填规则，省得从头敲正则。 */
const presets: ReadonlyArray<{ label: string; pattern: string; action: Row['action']; replacement?: string }> = [
  { label: '移除信息节点', pattern: '/剩余流量|套餐|到期|过期|过滤掉/i', action: 'exclude' },
  { label: '移除「过滤掉N条」', pattern: '/过滤掉\\s*\\d+\\s*条/i', action: 'exclude' },
];

const newId = (): string => `t${Date.now().toString(36)}${(nextId++).toString(36)}`;

function addRow(): void {
  rows.push({ id: newId(), pattern: '', action: 'exclude', replacement: '' });
}

function addPreset(preset: (typeof presets)[number]): void {
  rows.push({
    id: newId(),
    pattern: preset.pattern,
    action: preset.action,
    replacement: preset.replacement ?? '',
  });
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

const actionable = computed(() => rows.filter((row) => row.pattern.trim().length > 0));
const invalidPatterns = computed(() => rows.filter((row) => row.pattern.trim() && compileMatcher(row.pattern) === null).length);

interface StepPreview {
  valid: boolean;
  count: number;
  remaining: number;
  samples: string[];
}

/** 命中数与样例：按规则顺序模拟流水线推演（移除 / 保留 / 重命名都会改变后续步骤看到的结果）。 */
const stepPreviews = computed<StepPreview[]>(() => {
  let pool = nodes.value.map((node) => ({ nodeKey: node.nodeKey, name: node.name }));
  return rows.map((row) => {
    const trimmed = row.pattern.trim();
    const matcher = trimmed.length > 0 ? compileMatcher(trimmed) : null;
    if (matcher === null) {
      return { valid: false, count: 0, remaining: pool.length, samples: [] };
    }
    const matched = pool.filter((item) => matcher.test(item.name));
    const samples = matched.slice(0, 3).map((item) => item.name);
    if (row.action === 'exclude') {
      pool = pool.filter((item) => !matcher.test(item.name));
    } else if (row.action === 'keep') {
      pool = matched;
    } else if (row.action === 'rename') {
      const replacement = row.replacement;
      pool = pool.map((item) =>
        matcher.test(item.name)
          ? { ...item, name: replacement === '' ? item.name : replacement.replace(/\{name\}/g, item.name) }
          : item,
      );
    }
    return { valid: true, count: matched.length, remaining: pool.length, samples };
  });
});

function snapshotActionable(): string {
  return JSON.stringify(
    rows
      .filter((row) => row.pattern.trim().length > 0)
      .map((row, index) => ({
        id: row.id,
        order: index,
        pattern: row.pattern.trim(),
        action: row.action,
        ...(row.action === 'rename' && row.replacement !== '' ? { replacement: row.replacement } : {}),
      })),
  );
}

const baselineActionable = ref('');
const hasChanges = computed(() => snapshotActionable() !== baselineActionable.value);
const hasPendingRows = computed(() => JSON.stringify(rows) !== baselineRows.value);
const baselineRows = ref('');

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
    baselineActionable.value = snapshotActionable();
    baselineRows.value = JSON.stringify(rows);
    loadedFor.value = activeProfileName.value;
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '读取处理规则失败');
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
    invalidateTrace();
    await refreshPreview();
    editorOpen.value = false;
    notify('ok', `已保存 ${saved.transforms.length} 条规则；产物预览与订阅下次拉取时生效`);
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '保存处理规则失败');
  } finally {
    saving.value = false;
  }
}

/** 关弹窗视作放弃未保存草稿：重新读回已落库的规则，摘要才不会显示「看起来生效了」的内容。 */
function closeEditor(): void {
  editorOpen.value = false;
  if (hasChanges.value || hasPendingRows.value) void load();
}

function onEditorChange(show: boolean): void {
  if (show) editorOpen.value = true;
  else closeEditor();
}

onMounted(() => { void load(); });
watch(activeProfileName, (name) => {
  if (name !== loadedFor.value) {
    editorOpen.value = false;
    void load();
  }
});
</script>

<template>
  <section class="card transforms-bar">
    <div class="transforms-strip">
      <div class="transforms-title">
        <h2>节点批量处理</h2>
        <n-tag size="small" :bordered="false" class="mono">
          {{ loading ? '读取中' : `${actionable.length} 条规则` }}
        </n-tag>
        <n-tag v-if="!loading && hasChanges" size="small" :bordered="false" type="warning">未保存</n-tag>
      </div>

      <div class="transforms-summary">
        <span v-if="actionable.length === 0" class="text-3" style="font-size: 12px">
          按节点名批量移除、保留或重命名，规则先于下方单节点标注生效
        </span>
        <div v-else class="transforms-pills">
          <div v-for="(row, index) in actionable" :key="row.id" class="rule-pill">
            <span class="mono text-3">#{{ index + 1 }}</span>
            <n-tag
              size="tiny"
              :bordered="false"
              :type="row.action === 'exclude' ? 'error' : row.action === 'keep' ? 'success' : 'info'"
            >
              {{ row.action === 'exclude' ? '移除' : row.action === 'keep' ? '保留' : '重命名' }}
            </n-tag>
            <code>{{ row.pattern }}</code>
            <span v-if="row.action === 'rename' && row.replacement" class="text-3">
              → {{ row.replacement }}
            </span>
          </div>
        </div>
      </div>

      <div class="transforms-action">
        <n-button size="small" secondary :disabled="loading" @click="editorOpen = true">
          <template #icon><SlidersHorizontal :size="14" /></template>
          编辑规则
        </n-button>
      </div>
    </div>
  </section>

  <n-modal
    :show="editorOpen"
    preset="card"
    title="节点批量处理规则"
    style="width: 720px; max-width: calc(100vw - 32px)"
    @update:show="onEditorChange"
  >
    <div class="editor-body">
      <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
        <div style="font-size: 11.5px; line-height: 1.7">
          规则从上往下依次执行；重命名不改节点稳定标识，已有标注不会失效。
          匹配式支持 <code>/正则/flags</code>（如 <code>/流量|到期/i</code>）、
          <code>*通配符</code>（如 <code>*香港*</code>）和普通文字（子串、不区分大小写）；
          移除丢掉命中的、保留只留下命中的、重命名的 <code>{name}</code> 会替换成原节点名，
          例如 <code>🇺🇸 {name}</code> 给命中节点加美国前缀。
        </div>
      </n-alert>

      <div class="preset-block">
        <span class="text-3" style="font-size: 11.5px">快速添加</span>
        <div class="preset-list">
          <n-button
            v-for="preset in presets"
            :key="preset.label"
            size="tiny"
            secondary
            @click="addPreset(preset)"
          >
            {{ preset.label }}
          </n-button>
        </div>
      </div>

      <div v-if="rows.length === 0" class="transform-empty">
        <span class="text-3" style="font-size: 12px">还没有规则。点上方预设快速添加，或手动新增一条。</span>
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
          <template v-if="!stepPreviews[index]?.valid">
            <span class="badge danger">匹配式无效</span>
          </template>
          <template v-else>
            命中 <strong>{{ stepPreviews[index]?.count ?? 0 }}</strong> 个 · 剩余 {{ stepPreviews[index]?.remaining ?? 0 }} 个
            <span v-if="row.action === 'rename' && row.replacement === ''" style="color: var(--warn)">
              · 新名称模板为空，暂不修改名称
            </span>
            <span v-if="(stepPreviews[index]?.samples.length ?? 0) > 0" class="mono">
              · {{ stepPreviews[index]?.samples.join(' / ') }}
            </span>
          </template>
        </div>
      </div>

      <div class="row" style="margin-top: 12px; gap: 8px">
        <n-button size="small" secondary @click="addRow">
          <template #icon><Plus :size="14" /></template>
          添加空规则
        </n-button>
        <n-popconfirm v-if="rows.length > 0" @positive-click="rows.splice(0, rows.length)">
          <template #trigger>
            <n-button size="small" secondary>清空全部</n-button>
          </template>
          清空编辑中的全部规则，仍需点「保存处理规则」才生效，确认？
        </n-popconfirm>
      </div>
    </div>

    <template #footer>
      <div class="row end" style="width: 100%">
        <n-button size="small" quaternary @click="closeEditor">{{ hasChanges ? '放弃修改' : '关闭' }}</n-button>
        <n-button size="small" type="primary" :loading="saving" :disabled="!hasChanges" @click="save">
          保存处理规则
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.transforms-bar {
  margin-bottom: 12px;
}
.transforms-strip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  flex-wrap: wrap;
}
.transforms-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.transforms-title h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.transforms-summary {
  flex: 1 1 260px;
  min-width: 0;
}
.transforms-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.rule-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 11.5px;
}
.transforms-action {
  flex: 0 0 auto;
  margin-left: auto;
}
.transform-empty {
  padding: 10px 0 2px;
}
.preset-block {
  margin-bottom: 12px;
}
.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.editor-body .transform-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
