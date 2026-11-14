<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NInputNumber,
  NPopconfirm,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
} from 'naive-ui';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Globe,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next';
import type {
  CollectionMemberView,
  DedupeView,
  ProcessStep,
  ProfileEntryView,
  SourceKind,
  SourceView,
} from '../api';
import { api } from '../api';
import { formatBytes, formatDuration, formatExpire, formatTime, formatTraffic, initialOf, timeAgo } from '../format';
import {
  activeProfileName,
  addProfileEntry,
  attachSources,
  busy,
  collections,
  createSource,
  moveProfileEntry,
  notify,
  profileDirty,
  profileEntries,
  profiles,
  refreshRemoteSources,
  refreshSource,
  removeCollection,
  removeProfile,
  removeProfileEntry,
  removeSource,
  saveCollection,
  saveProfile,
  sourceLabel,
  sourceStats,
  sourceUpdating,
  sources,
  state,
  tab,
  unattachedSources,
  updateSource,
} from '../workspace';

/* ---------------- 添加订阅源 ---------------- */

const drawerOpen = ref(false);
const addTab = ref<string>('remote');
const adding = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const fileBaseName = computed(() => fileName.value.replace(/\.[^.]+$/, ''));
const draft = reactive({
  name: '',
  url: '',
  ua: '',
  format: '',
  content: '',
  refreshPolicy: 'off',
  proxy: '',
});

const formatOptions = computed(() => [
  { label: '自动识别', value: '' },
  ...(state.value?.sourceFormats ?? []).map((item) => ({ label: item, value: item })),
]);

/** 与后端 REFRESH_PRESETS 对齐；`off` 是默认值，避免新源一加就自动打上游。 */
const refreshOptions = [
  { label: '不自动刷新', value: 'off' },
  { label: '每 30 分钟', value: '30m' },
  { label: '每 2 小时', value: '2h' },
  { label: '每 6 小时', value: '6h' },
  { label: '每 12 小时', value: '12h' },
  { label: '每天', value: '1d' },
];

function resetDraft(): void {
  draft.name = '';
  draft.url = '';
  draft.ua = '';
  draft.format = '';
  draft.content = '';
  draft.refreshPolicy = 'off';
  draft.proxy = '';
  fileName.value = '';
  addTab.value = 'remote';
}

function openDrawer(): void {
  resetDraft();
  drawerOpen.value = true;
}

async function pickFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  try {
    if (file === undefined) return;
    if (file.size > 8 * 1024 * 1024) {
      // 超限后不能留着上一次选中的正文：否则提示报错、点「添加」却把旧文件内容存进去。
      draft.content = '';
      fileName.value = '';
      notify('error', '文件超过 8MB，请改用远端链接');
      return;
    }
    draft.content = await file.text();
    fileName.value = file.name;
    // 不自动把文件名填进「订阅名称」：那是用户输入框，写入后会让人以为改不动。
    // 留空时由 submitSource 用去掉扩展名的文件名兜底，placeholder 也如实写出这个名字。
    addTab.value = 'file';
  } finally {
    // 不清 value 的话重选同名文件不会触发 change，用户会以为「换文件」没生效。
    input.value = '';
  }
}

async function submitSource(): Promise<void> {
  if (adding.value) return;
  const name = draft.name.trim();
  if (addTab.value === 'remote' && draft.url.trim().length === 0) {
    notify('error', '请填写订阅链接');
    return;
  }
  if (addTab.value !== 'remote' && draft.content.trim().length === 0) {
    notify('error', '请先选择订阅文件');
    return;
  }
  // 文件名只作兜底，绝不写进 draft.name：用户改过的名字不能被后续重选文件覆盖。
  // 而且只在「文件」页兜底——选过文件再切回链接页时，不能拿文件名给远端源命名。
  const finalName = name.length > 0 ? name : addTab.value === 'file' ? fileBaseName.value : '';
  adding.value = true;
  const result = await createSource({
    kind: addTab.value as SourceKind,
    ...(finalName.length === 0 ? {} : { name: finalName }),
    ...(addTab.value === 'remote' ? { url: draft.url.trim() } : { content: draft.content }),
    ...(draft.format.length === 0 ? {} : { format: draft.format }),
    ...(draft.ua.trim().length === 0 || addTab.value !== 'remote' ? {} : { ua: draft.ua.trim() }),
    ...(addTab.value !== 'remote' || draft.refreshPolicy === 'off' ? {} : { refreshPolicy: draft.refreshPolicy }),
    ...(addTab.value !== 'remote' || draft.proxy.trim().length === 0 ? {} : { proxy: draft.proxy.trim() }),
  });
  adding.value = false;
  if (result.ok) drawerOpen.value = false;
}

/* ---------------- 编辑已有源 ---------------- */

const editOpen = ref(false);
const editSaving = ref(false);
const editing = ref<SourceView | null>(null);
const editContent = ref('');
const editContentLoaded = ref('');
const editContentLoading = ref(false);
const editDraft = reactive({
  name: '',
  url: '',
  ua: '',
  format: '',
  refreshPolicy: 'off',
  proxy: '',
});

const editContentDirty = computed(
  () => editing.value !== null && editing.value.kind !== 'remote' && editContent.value !== editContentLoaded.value,
);

async function openEdit(source: SourceView): Promise<void> {
  editing.value = source;
  editDraft.name = source.name;
  editDraft.url = source.url ?? '';
  editDraft.ua = source.ua ?? '';
  editDraft.format = source.format ?? '';
  editDraft.refreshPolicy = source.refreshPolicy ?? 'off';
  editDraft.proxy = source.proxy ?? '';
  editContent.value = '';
  editContentLoaded.value = '';
  editOpen.value = true;
  // 文件 / 粘贴源的正文要读出来才能改；远端源的正文永远在上游，不在这里编辑。
  if (source.kind === 'remote') return;
  editContentLoading.value = true;
  try {
    const detail = await api.sourceDetail(source.id);
    editContent.value = detail.content ?? '';
    editContentLoaded.value = editContent.value;
  } catch (cause) {
    notify('error', cause instanceof Error ? cause.message : '读取源正文失败');
  } finally {
    editContentLoading.value = false;
  }
}

async function submitEdit(): Promise<void> {
  const target = editing.value;
  if (target === null || editSaving.value) return;
  const name = editDraft.name.trim();
  if (name.length === 0) {
    notify('error', '名称不能为空');
    return;
  }
  // 清空链接要在这里拦掉：服务端会回 400，但用户会先看到一次无谓的请求与错误提示。
  if (target.kind === 'remote' && editDraft.url.trim().length === 0) {
    notify('error', '订阅链接不能为空');
    return;
  }
  // 本地源没有正文就等于没有内容可构建：后端会拒，这里先拦掉，省一个来回。
  if (target.kind !== 'remote' && editContentDirty.value && editContent.value.trim().length === 0) {
    notify('error', '正文不能为空，删除正文请直接删源');
    return;
  }
  editSaving.value = true;
  // proxy 传空串表示清除；本地源不发 url / ua / proxy / 自动刷新（写了也不会执行）。
  const ok = await updateSource(target.id, {
    name,
    ...(target.kind === 'remote' ? { url: editDraft.url.trim() } : {}),
    ...(target.kind === 'remote' ? { ua: editDraft.ua.trim() } : {}),
    // 空串是「自动识别」，必须显式发过去才能清掉旧的 format；省略键在服务端语义是「本次不改」。
    format: editDraft.format,
    ...(target.kind === 'remote' ? { refreshPolicy: editDraft.refreshPolicy } : {}),
    ...(target.kind === 'remote' ? { proxy: editDraft.proxy.trim() } : {}),
    ...(target.kind !== 'remote' && editContentDirty.value ? { content: editContent.value } : {}),
  });
  editSaving.value = false;
  if (ok) editOpen.value = false;
}

/* ---------------- 源行状态 ---------------- */

const kindLabels: Record<string, string> = {
  remote: '远端',
  file: '文件',
  inline: '粘贴',
};

function statOf(id: string) {
  return sourceStats.value[id];
}

/**
 * 状态列只回答「这个源现在能不能用」，不重复节点数——节点数有独立一列。
 * 时长、跳过条数、上游错误这些细节放 tooltip，避免把列宽撑开。
 */
function sourceStatus(sourceId: string): { kind: 'ok' | 'warn' | 'danger' | 'muted'; text: string } {
  if (sourceUpdating.value.includes(sourceId)) return { kind: 'muted', text: '更新中' };
  const source = sources.value.find((item) => item.id === sourceId);
  if (source === undefined) return { kind: 'muted', text: '未知' };
  if (!source.enabled) return { kind: 'muted', text: '已停用' };
  // 上游拉取失败比「解析为空」更要紧：内容根本没更新，节点数还停留在旧值。
  // 但失败不必然等于没数据——有旧快照时构建照常出节点，措辞要区分「有兜底」和「彻底没有」。
  if (source.lastError !== null) {
    return source.snapshotStale
      ? { kind: 'warn', text: '旧快照' }
      : { kind: 'danger', text: '拉取失败' };
  }
  if (source.snapshotStale) return { kind: 'warn', text: '已过期' };
  const stat = statOf(sourceId);
  if (stat === undefined) return { kind: 'muted', text: '待检查' };
  if (stat.nodes === 0) return { kind: 'danger', text: '解析为空' };
  if (stat.diagnostics.length > 0) return { kind: 'warn', text: '有诊断' };
  return { kind: 'ok', text: '正常' };
}

/** 状态列的完整原因：默认给节点数，出问题时优先给上游错误或快照时长。 */
function statusDetail(sourceId: string): string {
  const source = sources.value.find((item) => item.id === sourceId);
  if (source === undefined) return '未知源';
  if (source.lastError !== null) return source.lastError;
  if (source.snapshotStale) return `数据已 ${formatDuration(source.snapshotAgeMs ?? 0)} 未更新`;
  const stat = statOf(sourceId);
  if (stat === undefined) return '尚未检查';
  const skipped = stat.skipped > 0 ? `，跳过 ${stat.skipped} 条` : '';
  return `解析出 ${stat.nodes} 个节点${skipped}`;
}

/** 流量摘要：上游没给 subscription-userinfo 时返回空串，不编造 0。 */
function trafficOf(sourceId: string): string {
  const info = sources.value.find((item) => item.id === sourceId)?.userinfo;
  if (info === null || info === undefined) return '';
  const parts: string[] = [];
  const used = (info.upload ?? 0) + (info.download ?? 0);
  if ((info.total ?? 0) > 0) parts.push(`${formatTraffic(used)} / ${formatTraffic(info.total ?? 0)}`);
  else if (used > 0) parts.push(`已用 ${formatTraffic(used)}`);
  if (info.expire !== undefined && info.expire > 0) parts.push(formatExpire(info.expire));
  return parts.join(' · ');
}

/** 远端源显示「最近一次成功拉取」，本地源（文件 / 粘贴）显示「内容写入时间」。 */
function fetchTimeOf(source: SourceView): string {
  const stamp = source.kind === 'remote' ? source.lastFetchedAt : source.updatedAt;
  return stamp === null ? '—' : timeAgo(stamp);
}

async function refreshOne(id: string): Promise<void> {
  // 添加后后台已经拉过一次，别让用户手点再并发打上游。
  if (sourceUpdating.value.includes(id)) return;
  await refreshSource(id);
}

async function refreshAll(): Promise<void> {
  // refreshRemoteSources 内部的 loadAll 已经算过全源统计；再逐源 inspect 一遍是
  // N 个纯重复请求，还会让 busy 在两段请求之间归零、按钮闪一下。
  await refreshRemoteSources();
}

/* ---------------- 组合订阅 ---------------- */

/**
 * 加工链的一步（编辑态）。所有可选参数都平铺成字符串/布尔，
 * 换类型时不清空已填的值——改回上一个类型能接着用，比每次重填友好。
 */
interface StepDraft {
  type: 'filter' | 'rename' | 'prefix' | 'sort' | 'dedupe' | 'limit' | 'set-property' | 'flag';
  by: string;
  keep: boolean;
  value: string;
  order: 'asc' | 'desc';
  strategy: string;
  count: number | null;
  key: string;
}

interface MemberDraft {
  sourceId: string;
  enabled: boolean;
  prefix: string;
  include: string;
  exclude: string;
  rename: string;
  limit: number | null;
  /** 非空时按链执行，上面的旧字段全部不生效（服务端也是这个优先级）。 */
  process: StepDraft[];
  chainOpen: boolean;
  newType: StepDraft['type'];
}

const emptyStep = (type: StepDraft['type']): StepDraft => ({
  type,
  by: type === 'sort' ? 'name' : 'regex',
  keep: false,
  value: '',
  order: 'asc',
  strategy: 'nodeKey',
  count: null,
  key: 'udp',
});

const collectionOpen = ref(false);
const editingId = ref<string | null>(null);
const collectionSaving = ref(false);
const collectionDraft = reactive({
  name: '',
  dedupe: 'nodeKey' as DedupeView,
  members: [] as MemberDraft[],
});

const dedupeOptions = [
  { label: '按节点指纹（server + 端口 + 凭据 + 传输）', value: 'nodeKey' },
  { label: '按节点名', value: 'name' },
  { label: '不去重', value: 'none' },
];

const sourceOptions = computed(() =>
  sources.value.map((item) => ({ label: item.name, value: item.id })),
);

function openCollection(collection?: {
  id: string;
  name: string;
  dedupe: DedupeView;
  members: CollectionMemberView[];
}): void {
  editingId.value = collection?.id ?? null;
  collectionDraft.name = collection?.name ?? '';
  collectionDraft.dedupe = collection?.dedupe ?? 'nodeKey';
  collectionDraft.members = (collection?.members ?? []).map((member) => ({
    sourceId: member.sourceId,
    enabled: member.filter?.enabled !== false,
    prefix: member.filter?.prefix ?? '',
    include: (member.filter?.include ?? []).join(', '),
    exclude: (member.filter?.exclude ?? []).join(', '),
    rename: member.filter?.rename ?? '',
    limit: member.filter?.limit ?? null,
    process: (member.filter?.process ?? []).map(toStepDraft),
    chainOpen: (member.filter?.process ?? []).length > 0,
    newType: 'filter' as const,
  }));
  collectionOpen.value = true;
}

function addMember(): void {
  const first = sources.value[0];
  if (first === undefined) {
    notify('error', '先添加订阅源，再组建组合订阅');
    return;
  }
  collectionDraft.members.push({
    sourceId: first.id,
    enabled: true,
    prefix: '',
    include: '',
    exclude: '',
    rename: '',
    limit: null,
    process: [],
    chainOpen: false,
    newType: 'filter',
  });
}

function removeMember(index: number): void {
  collectionDraft.members.splice(index, 1);
}

function moveMember(index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= collectionDraft.members.length) return;
  const [moved] = collectionDraft.members.splice(index, 1);
  if (moved !== undefined) collectionDraft.members.splice(next, 0, moved);
}

const splitPatterns = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/* ---------------- 加工链 ---------------- */

const stepTypeOptions = [
  { label: '过滤 filter', value: 'filter' },
  { label: '改名 rename', value: 'rename' },
  { label: '前缀 prefix', value: 'prefix' },
  { label: '排序 sort', value: 'sort' },
  { label: '去重 dedupe', value: 'dedupe' },
  { label: '上限 limit', value: 'limit' },
  { label: '改属性 set-property', value: 'set-property' },
  { label: '加标记 flag', value: 'flag' },
];
const setPropertyKeyOptions = [
  { label: 'UDP（udp）', value: 'udp' },
  { label: '跳过证书校验（skip-cert-verify）', value: 'skip-cert-verify' },
  { label: 'ALPN（逗号分隔，空=清除）', value: 'alpn' },
];
const filterByOptions = [
  { label: '正则 / glob / 子串', value: 'regex' },
  { label: '地区（按名字关键字）', value: 'region' },
  { label: '协议类型', value: 'type' },
  { label: '无效节点（广告 / 账单 / 非 ASCII 凭据）', value: 'useless' },
];
/** Naive UI 的 option value 只认 string|number；算子里 keep 是 boolean，在选项层做一次显式映射。 */
const keepOptions = [
  { label: '剔除匹配的', value: 'drop' },
  { label: '只留匹配的', value: 'keep' },
];
const sortByOptions = [
  { label: '名字', value: 'name' },
  { label: '地区', value: 'region' },
  { label: '协议', value: 'kind' },
];
const orderOptions = [
  { label: '升序', value: 'asc' },
  { label: '降序', value: 'desc' },
];
const strategyOptions = [
  { label: '节点指纹', value: 'nodeKey' },
  { label: '节点名', value: 'name' },
  { label: '不去重', value: 'none' },
];

function toStepDraft(step: ProcessStep): StepDraft {
  const base = emptyStep(step.type);
  switch (step.type) {
    case 'filter':
      return { ...base, by: step.by, keep: step.keep, value: (step.value ?? []).join(', ') };
    case 'rename':
      return { ...base, value: step.template };
    case 'prefix':
      return { ...base, value: step.value };
    case 'sort':
      return { ...base, by: step.by, order: step.order };
    case 'dedupe':
      return { ...base, strategy: step.strategy };
    case 'limit':
      return { ...base, count: step.count };
    case 'set-property':
      return { ...base, key: step.key, value: String(step.value) };
    case 'flag':
      return { ...base, value: step.value };
  }
}

/** 参数不完整的步骤返回 null：宁可少一步，也不要提交一个语义不明的算子。 */
function toProcessStep(draft: StepDraft): ProcessStep | null {
  switch (draft.type) {
    case 'filter': {
      const value = splitPatterns(draft.value);
      const by = draft.by === 'useless' ? 'useless' : draft.by === 'region' ? 'region' : draft.by === 'type' ? 'type' : 'regex';
      if (by !== 'useless' && value.length === 0) return null;
      return { type: 'filter', by, keep: draft.keep, ...(value.length === 0 ? {} : { value }) };
    }
    case 'rename': {
      const template = draft.value.trim();
      return template.length === 0 ? null : { type: 'rename', template };
    }
    case 'prefix': {
      const value = draft.value.trim();
      return value.length === 0 ? null : { type: 'prefix', value };
    }
    case 'sort':
      return {
        type: 'sort',
        by: draft.by === 'region' ? 'region' : draft.by === 'kind' ? 'kind' : 'name',
        order: draft.order,
      };
    case 'dedupe':
      return {
        type: 'dedupe',
        strategy: draft.strategy === 'name' ? 'name' : draft.strategy === 'none' ? 'none' : 'nodeKey',
      };
    case 'limit':
      return draft.count === null || draft.count <= 0 ? null : { type: 'limit', count: draft.count };
    case 'set-property': {
      const key = draft.key === 'skip-cert-verify' ? 'skip-cert-verify' : draft.key === 'alpn' ? 'alpn' : 'udp';
      if (key === 'udp' || key === 'skip-cert-verify') {
        return { type: 'set-property', key, value: draft.value === 'true' };
      }
      // alpn：字符串，空串 = 清除（后端会删字段）。
      return { type: 'set-property', key, value: draft.value };
    }
    case 'flag': {
      const value = draft.value.trim();
      return value.length === 0 ? null : { type: 'flag', value };
    }
  }
}

function addStep(index: number): void {
  const member = collectionDraft.members[index];
  if (member === undefined) return;
  member.process.push(emptyStep(member.newType));
  member.chainOpen = true;
}

function removeStep(memberIndex: number, stepIndex: number): void {
  collectionDraft.members[memberIndex]?.process.splice(stepIndex, 1);
}

function moveStep(memberIndex: number, stepIndex: number, direction: number): void {
  const steps = collectionDraft.members[memberIndex]?.process;
  if (steps === undefined) return;
  const next = stepIndex + direction;
  if (next < 0 || next >= steps.length) return;
  const [moved] = steps.splice(stepIndex, 1);
  if (moved !== undefined) steps.splice(next, 0, moved);
}

function stepLabel(draft: StepDraft): string {
  switch (draft.type) {
    case 'filter':
      return `过滤 · ${draft.by} · ${draft.keep ? '保留' : '剔除'}`;
    case 'rename':
      return '改名';
    case 'prefix':
      return '前缀';
    case 'sort':
      return `排序 · ${draft.by} ${draft.order}`;
    case 'dedupe':
      return `去重 · ${draft.strategy}`;
    case 'limit':
      return '上限';
    case 'set-property':
      return `改属性 · ${draft.key}`;
    case 'flag':
      return '加标记';
  }
}

async function submitCollection(): Promise<void> {
  const name = collectionDraft.name.trim();
  if (name.length === 0) {
    notify('error', '请给组合订阅起个名字');
    return;
  }
  if (collectionDraft.members.length === 0) {
    notify('error', '组合订阅至少要有一个成员');
    return;
  }
  collectionSaving.value = true;
  const members: CollectionMemberView[] = collectionDraft.members.map((member) => {
    const include = splitPatterns(member.include);
    const exclude = splitPatterns(member.exclude);
    const process = member.process
      .map(toProcessStep)
      .filter((step): step is ProcessStep => step !== null);
    const hasFilter =
      !member.enabled ||
      process.length > 0 ||
      member.prefix.trim().length > 0 ||
      include.length > 0 ||
      exclude.length > 0 ||
      member.rename.trim().length > 0 ||
      member.limit !== null;
    return {
      sourceId: member.sourceId,
      ...(hasFilter
        ? {
            filter: {
              ...(member.enabled ? {} : { enabled: false }),
              // 有加工链时只提交链：两套都发会让「到底按哪套执行」变成隐式约定。
              ...(process.length > 0
                ? { process }
                : {
                    ...(member.prefix.trim().length === 0 ? {} : { prefix: member.prefix.trim() }),
                    ...(include.length === 0 ? {} : { include }),
                    ...(exclude.length === 0 ? {} : { exclude }),
                    ...(member.rename.trim().length === 0 ? {} : { rename: member.rename.trim() }),
                    ...(member.limit === null || member.limit <= 0 ? {} : { limit: member.limit }),
                  }),
            },
          }
        : {}),
    };
  });
  const ok = await saveCollection({
    ...(editingId.value === null ? {} : { id: editingId.value }),
    name,
    dedupe: collectionDraft.dedupe,
    members,
  });
  collectionSaving.value = false;
  if (ok) collectionOpen.value = false;
}

/* ---------------- Profile 构成 ---------------- */

const entryOptions = computed(() => [
  {
    type: 'group' as const,
    label: '组合订阅',
    key: 'collections',
    children: collections.value.map((item) => ({ label: item.name, value: `collection:${item.id}` })),
  },
  {
    type: 'group' as const,
    label: '单个订阅源',
    key: 'sources',
    children: sources.value.map((item) => ({ label: item.name, value: `source:${item.id}` })),
  },
]);

function addEntry(value: string): void {
  const [kind, id] = value.split(':');
  if (id === undefined) return;
  const entry: ProfileEntryView = { kind: kind === 'collection' ? 'collection' : 'source', id };
  if (profileEntries.value.some((item) => item.kind === entry.kind && item.id === entry.id)) {
    notify('error', '已经在构成里了');
    return;
  }
  addProfileEntry(entry);
}

function entryName(entry: ProfileEntryView): string {
  if (entry.kind === 'source') return sourceLabel(entry.id);
  return collections.value.find((item) => item.id === entry.id)?.name ?? `缺失：${entry.id}`;
}

function entryCount(entry: ProfileEntryView): string {
  if (entry.kind === 'source') {
    const stat = statOf(entry.id);
    return stat === undefined ? '—' : String(stat.nodes);
  }
  const found = collections.value.find((item) => item.id === entry.id);
  return found?.previewCount === undefined ? '—' : String(found.previewCount);
}

const derivedNodes = computed(() =>
  profileEntries.value.reduce((sum, entry) => {
    const value = Number.parseInt(entryCount(entry), 10);
    return Number.isNaN(value) ? sum : sum + value;
  }, 0),
);
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="card-head">
        <h2>订阅源</h2>
        <span class="count">{{ sources.length }}</span>
        <div class="spacer"></div>
        <n-button size="small" quaternary :loading="busy > 0" @click="refreshAll">
          <template #icon><RefreshCw :size="14" /></template>
          更新订阅
        </n-button>
        <n-button size="small" type="primary" @click="openDrawer">
          <template #icon><Plus :size="14" /></template>
          添加
        </n-button>
      </div>

      <n-empty v-if="sources.length === 0" description="还没有订阅源" style="padding: 40px 0">
        <template #icon><Globe :size="30" /></template>
        <template #extra>
          <div class="stack" style="gap: 8px; align-items: center">
            <n-button size="small" type="primary" @click="openDrawer">
              <template #icon><Plus :size="14" /></template>
              添加订阅源
            </n-button>
            <span class="text-3" style="font-size: 12px">支持远端链接、上传文件</span>
          </div>
        </template>
      </n-empty>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>名称</th>
              <th class="col-optional" style="width: 1%">方式</th>
              <th style="width: 1%">节点</th>
              <th class="col-wide-only">大小</th>
              <th class="col-wide-only">更新</th>
              <th class="col-optional" style="width: 1%">状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in sources" :key="source.id">
              <td>
                <div class="row tight" style="gap: 8px">
                  <span class="avatar sm">{{ initialOf(source.name) }}</span>
                  <div style="min-width: 0">
                    <div class="strong" style="font-size: 13px">{{ source.name }}</div>
                    <div class="addr-mobile mono text-3">
                      {{ source.url ?? (source.kind === 'file' ? `上传文件 · ${formatBytes(source.bytes)}` : '粘贴内容') }}
                    </div>
                    <div v-if="trafficOf(source.id) !== ''" class="text-3" style="font-size: 11.5px">
                      {{ trafficOf(source.id) }}
                    </div>
                    <!-- 窄屏隐藏状态列，但状态信号与启用开关都不能丢，否则手机上没法启停源。 -->
                    <div class="status-mobile">
                      <n-tooltip trigger="hover">
                        <template #trigger>
                          <span class="row tight status-signal" style="gap: 6px; flex-wrap: nowrap">
                            <span class="dot" :class="sourceStatus(source.id).kind"></span>
                            <span class="text-2" style="font-size: 11px">{{ sourceStatus(source.id).text }}</span>
                          </span>
                        </template>
                        {{ statusDetail(source.id) }}
                      </n-tooltip>
                      <n-switch
                        size="small"
                        :value="source.enabled"
                        @update:value="(value: boolean) => updateSource(source.id, { enabled: value })"
                      />
                    </div>
                  </div>
                </div>
              </td>
              <td class="col-optional">
                <n-tag size="small" :bordered="false" style="white-space: nowrap">
                  {{ kindLabels[source.kind] ?? source.kind }}
                </n-tag>
              </td>
              <td class="mono" style="width: 1%; white-space: nowrap">{{ statOf(source.id)?.nodes ?? '—' }}</td>
              <td class="col-wide-only mono text-3" style="width: 1%; white-space: nowrap">
                {{ source.bytes > 0 ? formatBytes(source.bytes) : '—' }}
              </td>
              <td class="col-wide-only text-3" style="width: 1%; white-space: nowrap; font-size: 11.5px">
                <n-tooltip v-if="source.kind === 'remote'" trigger="hover" :disabled="source.lastFetchedAt === null">
                  <template #trigger>
                    <span>{{ fetchTimeOf(source) }}</span>
                  </template>
                  {{ source.lastFetchedAt === null ? '尚未成功拉取' : formatTime(source.lastFetchedAt) }}
                  <template v-if="source.refreshPolicy !== null && source.refreshPolicy !== 'off'">
                    · 自动刷新 {{ source.refreshPolicy }}
                  </template>
                </n-tooltip>
                <span v-else>{{ fetchTimeOf(source) }}</span>
              </td>
              <td class="col-optional status-cell" style="width: 1%">
                <div class="status-line">
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <!-- .row 默认 flex-wrap: wrap；允许换行时圆点会单独占一行、行高从 40 涨到 49。 -->
                      <span class="row tight status-signal" style="gap: 6px; flex-wrap: nowrap">
                        <span class="dot" :class="sourceStatus(source.id).kind"></span>
                        <span class="text-2" style="font-size: 12px">{{ sourceStatus(source.id).text }}</span>
                      </span>
                    </template>
                    {{ statusDetail(source.id) }}
                  </n-tooltip>
                  <!-- 启用开关归在状态列：它是一个状态，不是一次操作。与圆点文字同一 flex 基线对齐。 -->
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-switch
                        size="small"
                        :value="source.enabled"
                        @update:value="(value: boolean) => updateSource(source.id, { enabled: value })"
                      />
                    </template>
                    参与构建
                  </n-tooltip>
                </div>
              </td>
              <td class="actions">
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <n-button aria-label="编辑订阅源" quaternary circle size="tiny" @click="openEdit(source)">
                      <template #icon><Pencil :size="13" /></template>
                    </n-button>
                  </template>
                  编辑
                </n-tooltip>
                <!-- 文件源没有上游，干脆不渲染这个按钮；原来只是 disabled，仍占位且破坏对齐。 -->
                <n-tooltip v-if="source.kind === 'remote'" trigger="hover">
                  <template #trigger>
                    <n-button
                      aria-label="更新订阅"
                      quaternary
                      circle
                      size="tiny"
                      :loading="sourceUpdating.includes(source.id)"
                      :disabled="sourceUpdating.includes(source.id)"
                      @click="refreshOne(source.id)"
                    >
                      <template #icon><RefreshCw :size="13" /></template>
                    </n-button>
                  </template>
                  更新订阅
                </n-tooltip>
                <n-popconfirm @positive-click="removeSource(source.id)">
                  <template #trigger>
                    <n-button aria-label="删除订阅源" quaternary circle size="tiny" type="error">
                      <template #icon><Trash2 :size="13" /></template>
                    </n-button>
                  </template>
                  删除「{{ source.name }}」？它在组合订阅与 Profile 构成里的引用会一并清除。
                </n-popconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="sources.some((item) => statOf(item.id)?.diagnostics.length)" class="card-foot">
        <AlertTriangle :size="14" class="text-3" />
        <span class="text-3" style="font-size: 12px">部分源存在解析诊断</span>
        <n-button text type="primary" size="tiny" @click="tab = 'diagnostics'">查看诊断</n-button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>组合订阅</h2>
        <span class="count">{{ collections.length }}</span>
        <div class="spacer"></div>
        <n-button size="small" secondary :disabled="sources.length === 0" @click="openCollection()">
          <template #icon><Layers :size="14" /></template>
          新建
        </n-button>
      </div>

      <n-empty
        v-if="collections.length === 0"
        description="组合订阅把多个源合并成一份，可逐源过滤、加前缀、去重"
        style="padding: 32px 0"
      >
        <template #icon><Layers :size="30" /></template>
        <template #extra>
          <n-button v-if="sources.length > 0" size="small" type="primary" @click="openCollection()">
            <template #icon><Layers :size="14" /></template>
            新建组合订阅
          </n-button>
          <n-button v-else size="small" type="primary" @click="openDrawer">
            <template #icon><Plus :size="14" /></template>
            先添加订阅源
          </n-button>
        </template>
      </n-empty>

      <div v-else class="list">
        <div v-for="collection in collections" :key="collection.id" class="list-item">
          <div class="avatar"><Layers :size="15" /></div>
          <div class="list-main">
            <div class="list-title">
              {{ collection.name }}
              <n-tag size="small" :bordered="false" class="mono">{{ collection.members.length }} 源</n-tag>
              <n-tag v-if="collection.previewCount !== undefined" size="small" :bordered="false">
                {{ collection.previewCount }} 节点
              </n-tag>
            </div>
            <div class="list-meta">
              {{ collection.members.map((member) => sourceLabel(member.sourceId)).join(' + ') }}
            </div>
          </div>
          <div class="row-actions">
            <n-button aria-label="编辑组合订阅" quaternary circle size="tiny" @click="openCollection(collection)">
              <template #icon><Pencil :size="13" /></template>
            </n-button>
            <n-popconfirm @positive-click="removeCollection(collection.id)">
              <template #trigger>
                <n-button aria-label="删除组合订阅" quaternary circle size="tiny" type="error">
                  <template #icon><Trash2 :size="13" /></template>
                </n-button>
              </template>
              删除组合订阅「{{ collection.name }}」？当前 Profile 构成里的引用会一并移除。
            </n-popconfirm>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Profile 构成</h2>
        <n-tag size="small" :bordered="false" class="mono">{{ activeProfileName }}</n-tag>
        <span class="count">{{ profileEntries.length }}</span>
        <div class="spacer"></div>
        <div class="head-actions">
          <n-select
            size="small"
            placeholder="添加来源"
            style="width: 180px"
            :options="entryOptions"
            :value="null"
            :disabled="sources.length === 0"
            @update:value="addEntry"
          />
          <n-button
            size="small"
            :type="profileDirty ? 'primary' : 'default'"
            :disabled="!profileDirty || busy > 0"
            @click="saveProfile()"
          >
            {{ profileDirty ? '保存' : '已保存' }}
          </n-button>
          <n-popconfirm v-if="profiles.length > 1" @positive-click="removeProfile(activeProfileName)">
            <template #trigger>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <n-button aria-label="删除当前 Profile" quaternary circle size="small" type="error">
                    <template #icon><Trash2 :size="14" /></template>
                  </n-button>
                </template>
                删除当前 Profile
              </n-tooltip>
            </template>
            删除 Profile「{{ activeProfileName }}」？绑定它的订阅地址会一并撤销，其余 Profile 不受影响。
          </n-popconfirm>
        </div>
      </div>

      <!-- 加完源却没进构成，是「节点一直是 0」最常见的成因；在构成卡片上当场补挂。 -->
      <div v-if="unattachedSources.length > 0" class="card-foot attach-hint">
        <AlertTriangle :size="14" class="text-3" />
        <span class="text-2" style="font-size: 12px">
          {{ unattachedSources.length }} 个已启用的源还没加入构成，构建不会用到它们
        </span>
        <span class="text-3" style="font-size: 11.5px" :title="unattachedSources.map((item) => item.name).join('、')">
          {{ unattachedSources.slice(0, 3).map((item) => item.name).join('、') }}{{ unattachedSources.length > 3 ? ' 等' : '' }}
        </span>
        <div class="spacer"></div>
        <n-button size="tiny" secondary :loading="busy > 0" @click="attachSources(unattachedSources.map((item) => item.id))">
          全部加入构成
        </n-button>
      </div>

      <n-empty
        v-if="profileEntries.length === 0"
        description="当前 Profile 没有任何来源，发布出去会是空配置"
        style="padding: 28px 0"
      >
        <template #extra>
          <n-button v-if="sources.length === 0" size="small" type="primary" @click="openDrawer">
            <template #icon><Plus :size="14" /></template>
            先添加一个订阅源
          </n-button>
          <span v-else class="text-3" style="font-size: 12px">用右上角的下拉把源加进来</span>
        </template>
      </n-empty>

      <div v-else>
        <div v-for="(entry, index) in profileEntries" :key="`${entry.kind}:${entry.id}`" class="entry-row">
          <span class="entry-index mono">{{ index + 1 }}</span>
          <n-tag size="small" :bordered="false" :type="entry.kind === 'collection' ? 'primary' : 'default'">
            {{ entry.kind === 'collection' ? '组合' : '源' }}
          </n-tag>
          <span class="strong" style="font-size: 13px">{{ entryName(entry) }}</span>
          <span class="text-3 mono" style="font-size: 11.5px">{{ entryCount(entry) }} 节点</span>
          <div class="spacer"></div>
          <div class="row-actions">
            <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveProfileEntry(index, -1)">
              <template #icon><ArrowUp :size="13" /></template>
            </n-button>
            <n-button aria-label="下移"
              quaternary
              circle
              size="tiny"
              :disabled="index === profileEntries.length - 1"
              @click="moveProfileEntry(index, 1)"
            >
              <template #icon><ArrowDown :size="13" /></template>
            </n-button>
            <n-button aria-label="移除构成来源" quaternary circle size="tiny" type="error" @click="removeProfileEntry(index)">
              <template #icon><X :size="13" /></template>
            </n-button>
          </div>
        </div>
        <div class="card-foot">
          <span class="text-3" style="font-size: 12px">
            顺序即合并顺序；按节点指纹全局去重，同一源被多个组合订阅引用只出现一次。
          </span>
          <div class="spacer"></div>
          <!-- 直接相加是去重前的量，别和旁边的「按节点指纹全局去重」说成同一个数。 -->
          <span class="mono text-2" style="font-size: 12px">合计 {{ derivedNodes }} 节点（去重前）</span>
        </div>
      </div>
    </section>

    <!-- 添加源 -->
    <n-drawer v-model:show="drawerOpen" :width="440" placement="right">
      <n-drawer-content title="添加订阅源" closable>
        <n-tabs v-model:value="addTab" type="segment" size="small">
          <n-tab-pane name="remote" tab="链接">
            <div class="stack" style="gap: 12px; padding-top: 12px">
              <div class="field">
                <label>订阅名称</label>
                <n-input v-model:value="draft.name" size="small" placeholder="例如 机场 A" />
              </div>
              <div class="field">
                <label>订阅链接</label>
                <n-input
                  v-model:value="draft.url"
                  size="small"
                  class="mono"
                  placeholder="https://example.com/api/v1/client/subscribe?token=..."
                />
              </div>
              <div class="field">
                <label>User-Agent（可选）</label>
                <n-input v-model:value="draft.ua" size="small" placeholder="部分机场按 UA 返回不同格式" />
              </div>
              <div class="field">
                <label>自动刷新</label>
                <n-select v-model:value="draft.refreshPolicy" size="small" :options="refreshOptions" />
              </div>
              <div class="field">
                <label>拉取代理（可选）</label>
                <n-input
                  v-model:value="draft.proxy"
                  size="small"
                  class="mono"
                  placeholder="socks5://127.0.0.1:1080 或 http://10.0.0.2:8080"
                />
                <span class="text-3" style="font-size: 11.5px">
                  机场按来源 IP 限区时填这里：服务端会用该代理去拉订阅，不改变客户端出网。
                </span>
              </div>
            </div>
          </n-tab-pane>

          <n-tab-pane name="file" tab="文件">
            <div class="stack" style="gap: 12px; padding-top: 12px">
              <div class="field">
                <label>订阅名称</label>
                <n-input
                  v-model:value="draft.name"
                  size="small"
                  :placeholder="fileName === '' ? '例如 机场 A' : `留空则用 ${fileBaseName}`"
                />
                <span class="text-3" style="font-size: 11.5px">名称随时可改，与文件名无关</span>
              </div>
              <div class="drop-zone" @click="fileInput?.click()">
                <Upload :size="20" />
                <div class="strong" style="font-size: 13px">
                  {{ fileName === '' ? '选择订阅文件' : fileName }}
                </div>
                <div class="text-3" style="font-size: 12px">
                  支持 Clash YAML / sing-box JSON / Surge conf / base64 订阅 / 节点链接，最大 8MB
                </div>
              </div>
              <input ref="fileInput" type="file" hidden accept=".yaml,.yml,.json,.conf,.txt,.ini" @change="pickFile" />
            </div>
          </n-tab-pane>
        </n-tabs>

        <div class="field" style="margin-top: 14px">
          <label>解析格式</label>
          <n-select v-model:value="draft.format" size="small" :options="formatOptions" />
        </div>

        <template #footer>
          <div class="row" style="width: 100%; justify-content: flex-end; gap: 8px">
            <n-button size="small" quaternary @click="drawerOpen = false">取消</n-button>
            <n-button size="small" type="primary" :loading="adding" @click="submitSource">
              添加
            </n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 编辑已有源 -->
    <n-drawer v-model:show="editOpen" :width="440" placement="right">
      <n-drawer-content title="编辑订阅源" closable>
        <div class="stack" style="gap: 12px">
          <div class="field">
            <label>名称</label>
            <n-input v-model:value="editDraft.name" size="small" />
          </div>
          <div v-if="editing?.kind === 'remote'" class="field">
            <label>订阅链接</label>
            <n-input v-model:value="editDraft.url" size="small" class="mono" />
          </div>
          <div v-if="editing?.kind === 'remote'" class="field">
            <label>User-Agent</label>
            <n-input v-model:value="editDraft.ua" size="small" placeholder="留空表示用默认 UA" />
          </div>
          <div v-if="editing !== null && editing.kind !== 'remote'" class="field">
            <label>
              正文
              <span v-if="editContentLoading" class="text-3">（读取中）</span>
              <span v-else-if="editContentDirty" class="text-3">（已修改，未保存）</span>
            </label>
            <n-input
              v-model:value="editContent"
              type="textarea"
              class="mono"
              :autosize="{ minRows: 8, maxRows: 20 }"
              :disabled="editContentLoading"
              placeholder="节点链接或完整配置…"
            />
            <span class="text-3" style="font-size: 11.5px">
              改完保存即重新解析；组合订阅与 Profile 构成不用动。
            </span>
          </div>
          <div class="field">
            <label>解析格式</label>
            <n-select v-model:value="editDraft.format" size="small" :options="formatOptions" />
          </div>
          <!-- 本地源没有上游：显示「自动刷新」只会写进一条永不执行的策略。 -->
          <div v-if="editing?.kind === 'remote'" class="field">
            <label>自动刷新</label>
            <n-select v-model:value="editDraft.refreshPolicy" size="small" :options="refreshOptions" />
            <span v-if="editing?.suggestedRefreshHours !== null && editing?.suggestedRefreshHours !== undefined" class="text-3" style="font-size: 11.5px">
              上游建议每 {{ editing.suggestedRefreshHours }} 小时刷新一次。
            </span>
          </div>
          <div v-if="editing?.kind === 'remote'" class="field">
            <label>拉取代理</label>
            <n-input
              v-model:value="editDraft.proxy"
              size="small"
              class="mono"
              placeholder="留空表示直连"
            />
          </div>
          <n-alert v-if="editing?.lastError !== null && editing?.lastError !== undefined" type="error" :bordered="false">
            最近一次拉取失败：<span class="mono">{{ editing.lastError }}</span>
          </n-alert>
        </div>

        <template #footer>
          <div class="row" style="width: 100%; justify-content: flex-end; gap: 8px">
            <n-button size="small" quaternary @click="editOpen = false">取消</n-button>
            <n-button size="small" type="primary" :loading="editSaving || busy > 0" @click="submitEdit">保存</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 组合订阅编辑 -->
    <n-drawer v-model:show="collectionOpen" :width="560" placement="right">
      <n-drawer-content :title="editingId === null ? '新建组合订阅' : '编辑组合订阅'" closable>
        <div class="stack" style="gap: 12px">
          <div class="field">
            <label>名称</label>
            <n-input v-model:value="collectionDraft.name" size="small" placeholder="例如 全部机场合并" />
          </div>

          <div class="field">
            <label>去重策略</label>
            <n-select v-model:value="collectionDraft.dedupe" size="small" :options="dedupeOptions" />
          </div>

          <div class="field">
            <label>成员（顺序即合并顺序）</label>
            <div class="member-list">
              <div v-for="(member, index) in collectionDraft.members" :key="index" class="member-card">
                <div class="row" style="gap: 8px">
                  <n-select v-model:value="member.sourceId" size="small" :options="sourceOptions" style="flex: 1" />
                  <n-switch v-model:value="member.enabled" size="small" />
                  <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveMember(index, -1)">
                    <template #icon><ArrowUp :size="13" /></template>
                  </n-button>
                  <n-button aria-label="下移"
                    quaternary
                    circle
                    size="tiny"
                    :disabled="index === collectionDraft.members.length - 1"
                    @click="moveMember(index, 1)"
                  >
                    <template #icon><ArrowDown :size="13" /></template>
                  </n-button>
                  <n-button aria-label="移除组合成员" quaternary circle size="tiny" type="error" @click="removeMember(index)">
                    <template #icon><X :size="13" /></template>
                  </n-button>
                </div>
                <div class="member-grid">
                  <n-input v-model:value="member.prefix" size="small" :disabled="member.process.length > 0" placeholder="前缀，如 HK-" />
                  <n-input v-model:value="member.rename" size="small" :disabled="member.process.length > 0" placeholder="改名，如 {index}-{name}" />
                  <n-input v-model:value="member.include" size="small" :disabled="member.process.length > 0" placeholder="只保留，逗号分隔" />
                  <n-input v-model:value="member.exclude" size="small" :disabled="member.process.length > 0" placeholder="排除，逗号分隔" />
                  <n-input-number
                    v-model:value="member.limit"
                    size="small"
                    :disabled="member.process.length > 0"
                    :min="0"
                    :max="9999"
                    placeholder="最多保留"
                    style="width: 100%"
                  />
                </div>

                <div class="row" style="gap: 8px; margin-top: 6px; flex-wrap: wrap">
                  <n-button
                    size="tiny"
                    quaternary
                    :type="member.process.length > 0 ? 'primary' : 'default'"
                    @click="member.chainOpen = !member.chainOpen"
                  >
                    <template #icon><Layers :size="13" /></template>
                    加工链{{ member.process.length > 0 ? `（${member.process.length} 步）` : '' }}
                  </n-button>
                  <span class="text-3" style="font-size: 11.5px">
                    {{
                      member.process.length > 0
                        ? '按链顺序执行；上面的前缀 / 过滤 / 改名 / 上限已停用'
                        : '需要「先去重再改名」这类顺序敏感的加工时才用'
                    }}
                  </span>
                </div>

                <div v-if="member.chainOpen" class="chain">
                  <div v-for="(step, stepIndex) in member.process" :key="stepIndex" class="chain-step">
                    <div class="row" style="gap: 6px">
                      <span class="chain-index mono">{{ stepIndex + 1 }}</span>
                      <n-select v-model:value="step.type" size="tiny" :options="stepTypeOptions" style="width: 132px" />
                      <span class="text-3" style="font-size: 11.5px">{{ stepLabel(step) }}</span>
                      <div class="spacer"></div>
                      <n-button aria-label="上移" quaternary circle size="tiny" :disabled="stepIndex === 0" @click="moveStep(index, stepIndex, -1)">
                        <template #icon><ArrowUp :size="12" /></template>
                      </n-button>
                      <n-button aria-label="下移"
                        quaternary
                        circle
                        size="tiny"
                        :disabled="stepIndex === member.process.length - 1"
                        @click="moveStep(index, stepIndex, 1)"
                      >
                        <template #icon><ArrowDown :size="12" /></template>
                      </n-button>
                      <n-button aria-label="移除加工步骤" quaternary circle size="tiny" type="error" @click="removeStep(index, stepIndex)">
                        <template #icon><X :size="12" /></template>
                      </n-button>
                    </div>
                    <div class="row" style="gap: 6px; margin-top: 5px; flex-wrap: wrap">
                      <template v-if="step.type === 'filter'">
                        <n-select v-model:value="step.by" size="tiny" :options="filterByOptions" style="width: 208px" />
                        <n-select
                          :value="step.keep ? 'keep' : 'drop'"
                          size="tiny"
                          :options="keepOptions"
                          style="width: 132px"
                          @update:value="(value: string) => { step.keep = value === 'keep'; }"
                        />
                        <n-input
                          v-if="step.by !== 'useless'"
                          v-model:value="step.value"
                          size="tiny"
                          placeholder="匹配值，逗号分隔（地区可写 HK, US）"
                          style="flex: 1; min-width: 180px"
                        />
                      </template>
                      <n-input
                        v-else-if="step.type === 'rename'"
                        v-model:value="step.value"
                        size="tiny"
                        placeholder="{index}-{name}"
                        style="flex: 1; min-width: 180px"
                      />
                      <n-input
                        v-else-if="step.type === 'prefix'"
                        v-model:value="step.value"
                        size="tiny"
                        placeholder="HK-"
                        style="flex: 1; min-width: 160px"
                      />
                      <template v-else-if="step.type === 'sort'">
                        <n-select v-model:value="step.by" size="tiny" :options="sortByOptions" style="width: 120px" />
                        <n-select v-model:value="step.order" size="tiny" :options="orderOptions" style="width: 110px" />
                      </template>
                      <n-select
                        v-else-if="step.type === 'dedupe'"
                        v-model:value="step.strategy"
                        size="tiny"
                        :options="strategyOptions"
                        style="width: 140px"
                      />
                      <template v-else-if="step.type === 'set-property'">
                        <n-select v-model:value="step.key" size="tiny" :options="setPropertyKeyOptions" style="width: 208px" />
                        <n-select
                          v-if="step.key === 'udp' || step.key === 'skip-cert-verify'"
                          :value="step.value === 'true' ? 'true' : 'false'"
                          size="tiny"
                          :options="[
                            { label: '开启 true', value: 'true' },
                            { label: '关闭 false', value: 'false' },
                          ]"
                          style="width: 120px"
                          @update:value="(value: string) => { step.value = value; }"
                        />
                        <n-input
                          v-else
                          v-model:value="step.value"
                          size="tiny"
                          placeholder="h2,http/1.1（空=清除）"
                          style="flex: 1; min-width: 160px"
                        />
                      </template>
                      <n-input
                        v-else-if="step.type === 'flag'"
                        v-model:value="step.value"
                        size="tiny"
                        placeholder="|机场A（已有则移除）"
                        style="flex: 1; min-width: 160px"
                      />
                      <n-input-number
                        v-else
                        v-model:value="step.count"
                        size="tiny"
                        :min="1"
                        :max="9999"
                        placeholder="保留 N 个"
                        style="width: 140px"
                      />
                    </div>
                  </div>
                  <div class="row" style="gap: 6px; margin-top: 6px">
                    <n-select v-model:value="member.newType" size="tiny" :options="stepTypeOptions" style="width: 132px" />
                    <n-button size="tiny" secondary @click="addStep(index)">
                      <template #icon><Plus :size="12" /></template>
                      添加步骤
                    </n-button>
                  </div>
                </div>
              </div>
            </div>
            <n-button size="small" secondary style="margin-top: 8px" @click="addMember">
              <template #icon><Plus :size="14" /></template>
              添加成员
            </n-button>
          </div>

          <n-alert type="default" :bordered="false">
            过滤语法：<span class="mono">/正则/i</span>、含 <span class="mono">*</span> 的 glob、其余按子串匹配。
            exclude 优先于 include。改名模板可用 <span class="mono">{name} {index} {source} {prefix}</span>，
            模板里写了 <span class="mono">{prefix}</span> 就不会再自动叠加前缀。
            <br />
            加工链<b>按添加顺序执行，顺序就是语义</b>：「先去重再改名」与「先改名再去重」结果不同；
            链一旦非空，上面的前缀 / 过滤 / 改名 / 上限全部停用，避免两套规则互相盖住。
          </n-alert>
        </div>

        <template #footer>
          <div class="row" style="width: 100%; justify-content: flex-end; gap: 8px">
            <n-button size="small" quaternary @click="collectionOpen = false">取消</n-button>
            <n-button size="small" type="primary" :loading="collectionSaving" @click="submitCollection">
              保存
            </n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
