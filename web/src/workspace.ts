import { computed, ref } from 'vue';
import { api, getActiveProfile, setActiveProfile, setToken, setUnauthorizedHandler } from './api';
import type {
  AnnotationView,
  BuildReportView,
  CollectionMemberView,
  CollectionView,
  DedupeView,
  DiagnosticView,
  EvidenceView,
  FetchDefaultsView,
  GroupMemberView,
  GroupView,
  HistoryEntry,
  OverlayMode,
  PolicyGroupBaseView,
  RuleView,
  NodeView,
  NotifyConfigView,
  PreviewView,
  ProfileEntryView,
  SourceInput,
  SourceStatView,
  SourceView,
  StateView,
  TraceStepView,
  WebDavConfigView,
} from './api';
import { formatTraffic, lineCount } from './format';
import { clientLabelOf } from './client-icons';
import { formatRuleText, parseRuleText } from './rule-text';
import type { RuleTextParseResult } from './rule-text';

/**
 * 一级页面只留需要频繁切换的：诊断与能力都是只读参考，收在设置的分区里；
 * 设置本身也不占导航项——它是「这只实例」的事，入口固定在侧栏底部 / 顶栏图标。
 */
export type Tab = 'overview' | 'sources' | 'config' | 'output' | 'publish' | 'settings';

export interface NavEntry {
  key: Tab;
  label: string;
  title: string;
  group: string;
}

export const NAV: readonly NavEntry[] = [
  { key: 'overview', label: '概览', title: '概览', group: '编排' },
  { key: 'sources', label: '订阅', title: '订阅', group: '编排' },
  // 配置是「这份产物怎么组装」：构成、节点取舍、规则与策略、DNS 与 TUN 四段全在这里。
  // 它与「产物预览」的分工是输入 / 输出——那边只读，这边改。
  { key: 'config', label: '配置', title: '配置', group: '编排' },
  { key: 'output', label: '产物预览', title: '产物预览', group: '编排' },
  { key: 'publish', label: '发布', title: '发布', group: '编排' },
];

export const DIALECT_LABELS: Record<string, string> = {
  'surge-ini': 'Surge',
  'clash-yaml': 'Clash / mihomo',
  'sing-box-json': 'sing-box',
  'loon-ini': 'Loon',
  'quanx-ini': 'Quantumult X',
  'egern-yaml': 'Egern',
  'uri-list': '节点 URI',
};

export interface GroupMemberDraft {
  kind: 'ref' | 'match' | 'region' | 'rest';
  value: string;
}

export interface GroupDraft {
  name: string;
  strategy: 'select' | 'url-test' | 'fallback';
  testUrl: string;
  interval: number | null;
  tolerance: number | null;
  lazy: boolean;
  hidden: boolean;
  members: GroupMemberDraft[];
}

/* ---------------- 全局状态 ---------------- */

export const connected = ref(false);
export const connecting = ref(false);
export const loginError = ref('');
/** 服务端处于「首次设置」状态：登录页从「输入令牌」切换为「设置令牌」。 */
export const setupRequired = ref(false);
/** 服务端还没有持久加密密钥：登录页需要额外要求设置（或由环境变量提供）。 */
export const secretRequired = ref(false);
/** 状态查询未回来前禁用提交，避免首帧按「普通登录」形态把令牌送去 401。 */
export const setupChecking = ref(true);
export const busy = ref(0);
export const reloading = ref(false);
export const nodeBusy = ref(false);
export const runtimeDirty = ref(false);
export const pendingBuildId = ref<string | null>(null);
export const tab = ref<Tab>('overview');
/**
 * 配置页当前分段。默认落在「构成」：那是这份配置最上游、也最常改的一段。
 * 概览的管线卡与发布页的台账都会按 name 指定要落到哪一段。
 */
export const configSection = ref<'composition' | 'nodes' | 'rules' | 'runtime'>('composition');

/**
 * 「跳到设置里的某个分区」。诊断与能力收进设置后，别的页面仍要能一键跳过去
 * （如订阅列表里的「查看诊断」）。设置页被 KeepAlive 缓存，所以走这个 ref 而不是 hash：
 * 组件不会重新挂载，只能靠状态变化通知它切分区。值被设置页消费后置回 null。
 */
export const settingsSection = ref<string | null>(null);

export function openSettingsSection(id: string): void {
  settingsSection.value = id;
  tab.value = 'settings';
}

export function openBuildDiagnostic(buildId: string): void {
  pendingBuildId.value = buildId;
  openSettingsSection('diagnostics');
}

export const state = ref<StateView | null>(null);
export const nodes = ref<NodeView[]>([]);
export const nodeDiagnostics = ref<DiagnosticView[]>([]);
export const annotations = ref<AnnotationView[]>([]);
export const preview = ref<PreviewView | null>(null);
export const previewLoading = ref(false);
export const evidence = ref<EvidenceView[]>([]);
export const history = ref<HistoryEntry[]>([]);
/** 构建历史点开的那一次回执（完整诊断）。null = 未选中。 */
export const buildReport = ref<BuildReportView | null>(null);
export const buildReportLoading = ref(false);
export const traceSteps = ref<TraceStepView[]>([]);
/**
 * 两个客户端选择互不干扰，别合并：
 * `target` 是「产物预览里我正在读哪一个客户端的产物」；`publishTarget` 是「接下来要签发哪一种」。
 * 签发完一次之后才把 `target` 拨过去（生成的那份，用户下一步多半就要核对它）。
 */
export const target = ref('surge');
/** 签发默认走「自动识别」：多数人只想要一条能喂给所有客户端的地址，先让他点生成就能拿到。 */
export const publishTarget = ref('auto');
export const createdUrls = ref<{ profile: string; target: string; url: string }[]>([]);
export const activeProfileName = ref(getActiveProfile());

export const sourceStats = ref<Record<string, SourceStatView>>({});
/** 保存后在后台补拉上游的源 id。刻意不进 busy：不能因为后台任务让整页按钮一直转。 */
export const sourceUpdating = ref<string[]>([]);

/** 运维能力状态（通知 / WebDAV / 调度器）；登录后拉一次，避免每屏都问。 */
export const ops = ref<{ notify: { enabled: boolean; channels: string[] }; webdav: { configured: boolean }; scheduler: { intervalMs: number } } | null>(null);
/** 通知渠道的界面配置（界面覆盖值 + 环境变量默认值 + 生效值）。 */
export const notifySettings = ref<{
  value: NotifyConfigView | null;
  envDefaults: { telegram?: { botToken: string; chatId: string }; bark?: { url: string } } | null;
  effective: { telegram?: { botToken: string; chatId: string }; bark?: { url: string } } | null;
} | null>(null);
/** WebDAV 远端备份的界面配置（密码不回传，用 hasPassword 标记）。 */
export const webdavSettings = ref<{
  value: { url: string; username?: string; hasPassword: boolean } | null;
  envDefaults: { url: string; hasPassword: boolean } | null;
  effective: { url: string; hasCredentials: boolean } | null;
} | null>(null);
/** 实例级拉取默认（界面覆盖值）；header 值脱敏回显。 */
export const fetchDefaultsSettings = ref<{
  value: FetchDefaultsView | null;
} | null>(null);
/** TCP 握手延迟：按 nodeKey 索引，不落库（延迟是瞬时属性）。 */
export const latencies = ref<Record<string, { ms: number | null; intercepted: boolean }>>({});
export const probing = ref(false);
export const profileEntries = ref<ProfileEntryView[]>([]);
export const rules = ref<RuleView[]>([]);
export const ruleMode = ref<OverlayMode>('inherit');
export const rulePlacement = ref<'before' | 'after'>('after');
export const groups = ref<GroupDraft[]>([]);
export const groupMode = ref<OverlayMode>('inherit');
export const baseGroups = ref<PolicyGroupBaseView[]>([]);

export type ThemeMode = 'system' | 'light' | 'dark';
export type Palette = 'indigo' | 'clay' | 'graphite' | 'celadon' | 'ocean';

export const PALETTES: readonly { id: Palette; label: string; hint: string }[] = [
  { id: 'clay', label: '陶土', hint: '米白纸感，默认' },
  { id: 'indigo', label: '靛蓝', hint: '冷灰 + 靛蓝' },
  { id: 'graphite', label: '石墨', hint: '纯中性，无彩色强调' },
  { id: 'celadon', label: '青瓷', hint: '冷灰绿，护眼' },
  { id: 'ocean', label: '海蓝', hint: '中性蓝，网络面板常见' },
];

const THEME_KEY = 'startrails_theme_mode';
const PALETTE_KEY = 'startrails_palette';
const storedMode = localStorage.getItem(THEME_KEY);
const storedPalette = localStorage.getItem(PALETTE_KEY);
export const themeMode = ref<ThemeMode>(
  storedMode === 'light' || storedMode === 'dark' ? storedMode : 'system',
);
export const palette = ref<Palette>(
  (PALETTES as readonly { id: Palette }[]).some((item) => item.id === storedPalette)
    ? (storedPalette as Palette)
    : 'clay',
);
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(mediaQuery.matches);
mediaQuery.addEventListener('change', (event) => {
  systemDark.value = event.matches;
});
export const theme = computed<'light' | 'dark'>(() =>
  themeMode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : themeMode.value,
);

const loadedRules = ref('[]');
const loadedGroups = ref('[]');
const loadedEntries = ref('[]');

interface Messenger {
  success: (text: string) => void;
  error: (text: string) => void;
}

interface Dialoger {
  confirmDiscard: (detail: string) => Promise<boolean>;
}

let messenger: Messenger | null = null;
let dialoger: Dialoger | null = null;

/** 由 Shell 注入 Naive UI 的 message 与 dialog 实例，workspace 不直接依赖组件库。 */
export const setMessenger = (api: Messenger): void => {
  messenger = api;
};
export const setDialoger = (api: Dialoger): void => {
  dialoger = api;
};

/* ---------------- 派生数据 ---------------- */

export const annotationMap = computed(
  () => new Map(annotations.value.map((item) => [item.nodeKey, item])),
);

export const allDiagnostics = computed<DiagnosticView[]>(() => [
  ...nodeDiagnostics.value,
  ...(preview.value?.report.diagnostics ?? []),
]);

export const clientTargets = computed(() => state.value?.clientTargets ?? []);
export const sources = computed<readonly SourceView[]>(() => state.value?.sources ?? []);
export const collections = computed<readonly CollectionView[]>(() => state.value?.collections ?? []);
export const profiles = computed(() => state.value?.profiles ?? []);

/**
 * 当前构成里「没被用上」的源。加完源却没进构成是最常见的失手：
 * 界面上节点数一直是 0，用户却以为源已经生效了。
 */
export const unattachedSources = computed<readonly SourceView[]>(() => {
  const direct = new Set(
    profileEntries.value.filter((entry) => entry.kind === 'source').map((entry) => entry.id),
  );
  const viaCollection = new Set<string>();
  for (const entry of profileEntries.value) {
    if (entry.kind !== 'collection') continue;
    const found = collections.value.find((item) => item.id === entry.id);
    for (const member of found?.members ?? []) viaCollection.add(member.sourceId);
  }
  return sources.value.filter(
    (item) => item.enabled && !direct.has(item.id) && !viaCollection.has(item.id),
  );
});

export const targetName = computed(() => {
  const found = clientTargets.value.find((item) => item.id === target.value);
  return found?.name ?? target.value;
});

/** 任意客户端 id 的显示名：服务端注册表优先，未注册时退回图标表的兜底名（如 auto）。 */
export const clientNameOf = (id: string): string =>
  clientLabelOf(id, clientTargets.value.find((item) => item.id === id)?.name);

export const publishTargetName = computed(() => clientNameOf(publishTarget.value));

/** 发布页左侧：按方言分组的客户端清单。 */
export const targetGroups = computed(() => {
  const buckets = new Map<string, { id: string; name: string; ext: string; nodesOnly: boolean }[]>();
  for (const item of clientTargets.value) {
    const list = buckets.get(item.dialect) ?? [];
    list.push({
      id: item.id,
      name: item.name,
      ext: item.fileExtension,
      nodesOnly: item.contentMode === 'nodes-only',
    });
    buckets.set(item.dialect, list);
  }
  return [...buckets.entries()].map(([dialect, items]) => ({
    dialect,
    label: DIALECT_LABELS[dialect] ?? dialect,
    items,
  }));
});

export const excludedCount = computed(
  () => nodes.value.filter((node) => annotationMap.value.get(node.nodeKey)?.excluded === true).length,
);

export const profileDirty = computed(
  () => JSON.stringify(profileEntries.value) !== loadedEntries.value,
);
export const rulesDirty = computed(
  () => JSON.stringify({ mode: ruleMode.value, placement: rulePlacement.value, rules: rules.value }) !== loadedRules.value,
);
export const groupsDirty = computed(
  () => JSON.stringify({ mode: groupMode.value, groups: groups.value }) !== loadedGroups.value,
);

export const previewMeta = computed(() => {
  const content = preview.value?.content ?? '';
  return {
    lines: lineCount(content),
    bytes: new Blob([content]).size,
    filename: preview.value?.filename ?? '',
  };
});

/** 源 id → 名称；组合订阅与节点来源列都靠它显示人话。 */
export const sourceNameMap = computed(
  () => new Map(sources.value.map((item) => [item.id, item.name])),
);

export function sourceLabel(id: string): string {
  return sourceNameMap.value.get(id) ?? id;
}

/* ---------------- 基础工具 ---------------- */

function messageOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (text.includes('401')) return '管理令牌无效或已失效';
  if (text.includes('409') && text.includes('admin-already-initialized'))
    return '管理令牌已设置，请刷新页面后直接登录';
  if (text.includes('400') && text.includes('admin-token-too-short')) return '管理令牌至少 8 位';
  if (text.includes('400') && text.includes('secret-too-short')) return '加密密钥至少 16 位';
  if (text.includes('secret-setup-required')) return '请先设置数据加密密钥';
  if (text.includes('payload-undecryptable'))
    return '已有正文无法用新密钥解密：请用原 STARTRAILS_TOKEN_SECRET 启动，或从备份恢复';
  if (text.includes('secret-file-desync'))
    return '密钥文件没写成，但数据库已切到新密钥：重启前把密钥文件内容改成刚才设置的密钥，否则正文解不开';
  if (text.includes('secret-persist-failed')) return '加密密钥写入失败，已回滚，请检查 data 目录权限';
  if (text.includes('profile-empty')) return '当前配置没有任何内容：先在配置页把订阅加入构成';
  if (text.includes('admin-token-from-env'))
    return '管理令牌由环境变量提供，请在部署侧修改后重启';
  if (text.includes('admin-token-unchanged')) return '新令牌与当前相同，无需更换';
  if (text.includes('last-profile')) return '至少要保留一个配置';
  if (text.includes('profile-name-taken')) return '已有同名配置，换一个名字';
  if (text.includes('notify-not-configured')) return '还没配置通知渠道';
  if (text.includes('redacted-url-rejected')) return '订阅链接是脱敏值：请在编辑弹窗重新粘贴完整链接';
  if (text.includes('redacted-proxy-rejected')) return '代理地址是脱敏值：请重新粘贴完整代理地址';
  if (text.includes('invalid-source-format')) return '订阅格式不支持：请选择已列出的格式或留空自动识别';
  if (text.includes('invalid-enabled')) return '启用状态只能是开或关';
  if (text.includes('content-required')) return '正文不能为空，删除正文请直接删源';
  if (text.includes('url-required')) return '订阅链接不能为空';
  if (text.includes('name-required')) return '名称不能为空';
  if (text.includes('404') && text.includes('profile-not-found')) return '配置不存在，请在配置页新建';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export function notify(kind: 'ok' | 'error', text: string): void {
  if (messenger === null) {
    console.warn(`[startrails] ${kind}: ${text}`);
    return;
  }
  if (kind === 'ok') messenger.success(text);
  else messenger.error(text);
}

/**
 * 令牌失效的唯一处理：清掉会话、打回登录页，并说明原因。
 * 已经不在登录态时不重复动作——登录页自己会把错误显示在输入框下面。
 */
setUnauthorizedHandler(() => {
  if (!connected.value) return;
  disconnect();
  loginError.value = '管理令牌已失效，请重新输入';
});

async function run(action: () => Promise<void>): Promise<boolean> {
  busy.value += 1;
  try {
    await action();
    return true;
  } catch (cause) {
    notify('error', messageOf(cause));
    return false;
  } finally {
    busy.value -= 1;
  }
}

export function applyTheme(value: 'light' | 'dark' = theme.value): void {
  const root = document.documentElement;
  root.dataset.theme = value;
  root.dataset.palette = palette.value;
}

export function setThemeMode(mode: ThemeMode): void {
  themeMode.value = mode;
  localStorage.setItem(THEME_KEY, mode);
  applyTheme();
}

export function setPalette(next: Palette): void {
  palette.value = next;
  localStorage.setItem(PALETTE_KEY, next);
  applyTheme();
}

export function toggleTheme(): void {
  setThemeMode(theme.value === 'dark' ? 'light' : 'dark');
}

export async function copyText(text: string, label = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify('ok', label);
  } catch {
    notify('error', '复制失败，请手动选择文本');
  }
}

export function downloadPreview(): void {
  const content = preview.value?.content ?? '';
  if (content.length === 0) {
    notify('error', '当前没有可下载的内容');
    return;
  }
  const filename = previewMeta.value.filename || `startrails-${target.value}.txt`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  notify('ok', `已下载 ${filename}`);
}

/* ---------------- 数据加载 ---------------- */

/**
 * 产物预览刷新。序号守卫两件事：
 * ① 快速切换 target（点客户端 / 签发后拨指针）时，先发出的响应可能后到，
 *    旧响应不得覆盖新状态——否则卡头是新客户端、正文还是旧产物；
 * ② 失败时清空旧内容并提示（比如配置为空），而不是继续展示上一个 target 的产物。
 */
let previewSeq = 0;
export async function refreshPreview(): Promise<void> {
  const seq = ++previewSeq;
  previewLoading.value = true;
  try {
    const result = await api.preview(target.value);
    if (seq === previewSeq) preview.value = result;
  } catch (cause) {
    if (seq === previewSeq) {
      preview.value = null;
      notify('error', messageOf(cause));
    }
  } finally {
    if (seq === previewSeq) previewLoading.value = false;
  }
}

/**
 * 规则与策略组的草稿保护同构成：后台刷新不得覆盖未保存的修改。
 * 但 force（切配置）时必须无条件覆盖——旧配置的规则草稿留在界面里，
 * 点保存就会写进新配置；此时 loadedRules / loadedGroups 也要一起重建，
 * 否则脏标记永远停 true。
 */
async function loadRuleState(force = false): Promise<void> {
  const ruleData = await api.rules();
  if (force || !rulesDirty.value) {
    rules.value = ruleData.rules;
    ruleMode.value = ruleData.mode;
    rulePlacement.value = ruleData.placement;
    loadedRules.value = JSON.stringify({
      mode: ruleMode.value,
      placement: rulePlacement.value,
      rules: rules.value,
    });
  }
  const groupData = await api.policyGroups();
  if (force || !groupsDirty.value) {
    groupMode.value = groupData.mode;
    baseGroups.value = groupData.base;
    groups.value = groupData.groups.map(groupDraftOf);
    loadedGroups.value = JSON.stringify({ mode: groupMode.value, groups: groups.value });
  }
}

async function loadTrace(): Promise<void> {
  traceSteps.value = (await api.trace()).steps;
}

async function refreshSourceStats(): Promise<void> {
  const result = await api.inspectSources();
  sourceStats.value = Object.fromEntries(result.sources.map((item) => [item.id, item]));
}

async function loadNodeState(): Promise<void> {
  const nodeData = await api.nodes();
  nodes.value = nodeData.nodes;
  nodeDiagnostics.value = nodeData.diagnostics;
}

/**
 * 把 /api/state 映射成全局状态。后台补拉上游、手动刷新、保存动作都会经过这里，
 * 所以未保存的草稿必须由它保护：早期实现无条件重写 profileEntries / loadedEntries，
 * 用户在后台拉上游那几十秒里改构成，保存按钮会自己变回「已保存」，改动静默消失。
 * 规则与策略组同理，保护放在 loadRuleState 里。
 *
 * force 只给「用户主动换 Profile」用：此时必须按新 Profile 的构成重建界面，
 * 否则旧 Profile 的未保存草稿会被带过去、点保存时写进新 Profile。
 */
function applyStateSnapshot(snapshot: StateView, force = false): void {
  state.value = snapshot;
  const preferred = getActiveProfile();
  const profile =
    snapshot.profiles.find((item) => item.name === preferred) ??
    snapshot.profiles.find((item) => item.name === 'default') ??
    snapshot.profiles[0];
  setActiveProfile(profile?.name ?? 'default');
  activeProfileName.value = getActiveProfile();

  if (force || !profileDirty.value) {
    profileEntries.value = profile ? [...profile.entries] : [];
    loadedEntries.value = JSON.stringify(profileEntries.value);
  }
  // 加工轨迹是按配置算的：换配置时必须清掉，否则诊断页的 loadTraceIfNeeded
  // 看到「有数据」就短路，展示的还是上一个配置的步骤。
  if (force) traceSteps.value = [];
  // 标注是即时保存（没有草稿态），可以放心同步。
  annotations.value = [...snapshot.annotations];

  const targetExists = snapshot.clientTargets.some((item) => item.id === target.value);
  if (!targetExists && snapshot.clientTargets[0] !== undefined) {
    target.value = snapshot.clientTargets[0].id;
  }
}

export async function loadAll(force = false): Promise<void> {
  applyStateSnapshot(await api.state(), force);

  await refreshSourceStats();
  await loadNodeState();
  await refreshPreview();
  await loadRuleState(force);
  evidence.value = (await api.capabilities()).evidence;
  history.value = (await api.diagnostics()).reports;
  ops.value = await api.ops();
  notifySettings.value = await api.notifySettings();
  webdavSettings.value = await api.webdavSettings();
  fetchDefaultsSettings.value = await api.fetchDefaults();
}

/**
 * 保存后的轻量刷新：只取 /api/state（纯读库）。
 * loadAll 里的 /api/sources/inspect 会对每个远端源真的发一次上游请求，
 * 再加 nodes / preview / rules 等一串串行接口，机场慢或超时就会把「添加」按钮卡住十几秒。
 * 加完源只需要立刻关抽屉、立刻看到新的一行，用不着等这些。
 */
async function reloadAfterSave(): Promise<void> {
  applyStateSnapshot(await api.state());
}

/**
 * 保存后的后台补齐：inspectSources 会对每个远端源真发一次上游请求，不能让它挡住
 * 「抽屉关闭 / 开关翻转」。串行排队，避免连续操作后旧响应反而覆盖了新状态。
 */
let backgroundReload: Promise<void> = Promise.resolve();
function scheduleBackgroundReload(): void {
  backgroundReload = backgroundReload.then(() => loadAll()).catch(() => undefined);
}

/**
 * 后台补做「拉上游 + 全量状态同步」。刻意不进 busy，也不弹错误打断用户：
 * 后端会把失败原因写进 source.lastError，状态列的 tooltip 会呈现；
 * 这里只负责把节点数 / 构建结果在拉完后补齐。
 */
export function queueSourceRefresh(id: string, pullUpstream: boolean): void {
  if (sourceUpdating.value.includes(id)) return;
  sourceUpdating.value = [...sourceUpdating.value, id];
  void (async () => {
    try {
      if (pullUpstream) await api.refreshSource(id);
      await loadAll();
    } catch {
      // 上游不通或构建失败时退回一次纯读库刷新，至少让列表反映刚保存的状态。
      try { await reloadAfterSave(); } catch { /* 保存时已经刷过一次，忽略 */ }
    } finally {
      sourceUpdating.value = sourceUpdating.value.filter((item) => item !== id);
    }
  })();
}

export async function connect(token: string): Promise<void> {
  loginError.value = '';
  setToken(token.trim());
  connecting.value = true;
  try {
    await loadAll(true);
    connected.value = true;
    tab.value = 'overview';
  } catch (cause) {
    connected.value = false;
    loginError.value = messageOf(cause);
  } finally {
    connecting.value = false;
  }
}

/** 启动前问一次服务端是否待初始化；请求失败按普通登录处理，不把用户卡在空白页。 */
export async function checkSetup(): Promise<void> {
  try {
    const status = await api.setupStatus();
    setupRequired.value = status.required;
    secretRequired.value = status.secretRequired;
  } catch {
    setupRequired.value = false;
    secretRequired.value = false;
  } finally {
    setupChecking.value = false;
  }
}

/**
 * 首次设置：管理令牌与加密密钥可能只缺其一。两者都缺时，服务端先重加密数据库
 * 再原子写入密钥文件，随后写入管理令牌哈希；成功后立刻用同一枚令牌进入控制台。
 */
export async function initialize(token: string, secret = ''): Promise<void> {
  loginError.value = '';
  const trimmedToken = token.trim();
  const trimmedSecret = secret.trim();
  if (setupRequired.value && trimmedToken.length === 0) {
    loginError.value = '请设置管理令牌';
    return;
  }
  if (!setupRequired.value && secretRequired.value && trimmedToken.length === 0) {
    loginError.value = '请输入管理令牌';
    return;
  }
  if (secretRequired.value && trimmedSecret.length < 16) {
    loginError.value = '加密密钥至少 16 位';
    return;
  }
  connecting.value = true;
  try {
    // 管理令牌已存在、只缺密钥时，setup 端点需要鉴权：先把令牌放进请求头。
    if (!setupRequired.value && secretRequired.value) setToken(trimmedToken);
    await api.setup({
      ...(setupRequired.value ? { token: trimmedToken } : {}),
      ...(secretRequired.value ? { secret: trimmedSecret } : {}),
    });
    setupRequired.value = false;
    secretRequired.value = false;
    if (trimmedToken.length > 0) setToken(trimmedToken);
    await loadAll(true);
    connected.value = true;
    tab.value = 'overview';
  } catch (cause) {
    connected.value = false;
    loginError.value = messageOf(cause);
  } finally {
    connecting.value = false;
  }
}

export function disconnect(): void {
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  setToken('');
  connected.value = false;
  state.value = null;
  nodes.value = [];
  preview.value = null;
  annotations.value = [];
  createdUrls.value = [];
  latestTokenId.value = null;
  runtimeDirty.value = false;
  pendingBuildId.value = null;
  rules.value = [];
  ruleMode.value = 'inherit';
  rulePlacement.value = 'after';
  groups.value = [];
  groupMode.value = 'inherit';
  baseGroups.value = [];
  profileEntries.value = [];
  loadedEntries.value = '[]';
  loadedRules.value = '[]';
  loadedGroups.value = '[]';
  nodeDiagnostics.value = [];
  evidence.value = [];
  traceSteps.value = [];
  sourceStats.value = {};
  buildReport.value = null;
  history.value = [];
  activeProfileName.value = 'default';
  setActiveProfile('default');
}

export async function reload(): Promise<boolean> {
  reloading.value = true;
  try {
    return await run(async () => {
      await loadAll();
      notify('ok', '已刷新');
    });
  } finally {
    reloading.value = false;
  }
}

/* ---------------- 订阅 ---------------- */

export async function createSource(
  input: SourceInput,
): Promise<{ ok: boolean; attached: boolean }> {
  let attached = false;
  let createdId = '';
  const ok = await run(async () => {
    const created = await api.addSource({ ...input, profile: activeProfileName.value });
    attached = created.attached;
    createdId = created.id;
    await reloadAfterSave();
    notify('ok', attached ? `已添加 ${created.id}，并加入当前配置构成` : `已添加 ${created.id}`);
  });
  // 保存已经落库，上游拉取交给后台：remote 源要真去拉一次，file 源只需补齐统计与构建状态。
  if (ok && createdId !== '') queueSourceRefresh(createdId, input.kind === 'remote');
  return { ok, attached };
}

export async function updateSource(
  id: string,
  patch: Partial<SourceInput> & { enabled?: boolean },
): Promise<boolean> {
  // 启用开关是受控组件：先本地翻转，失败再回滚。等一串上游请求回来才动会让人连点。
  const enabled = patch.enabled;
  const before = enabled === undefined ? undefined : sources.value.find((item) => item.id === id)?.enabled;
  const flip = (value: boolean): void => {
    if (state.value === null) return;
    state.value = {
      ...state.value,
      sources: state.value.sources.map((item) => (item.id === id ? { ...item, enabled: value } : item)),
    };
  };
  if (enabled !== undefined && before !== undefined) flip(enabled);

  const ok = await run(async () => {
    await api.updateSource(id, patch);
    await reloadAfterSave();
  });
  if (!ok && enabled !== undefined && before !== undefined) flip(before);
  if (ok) scheduleBackgroundReload();
  return ok;
}

export async function removeSource(id: string): Promise<boolean> {
  const name = sourceLabel(id);
  return run(async () => {
    const result = await api.removeSource(id);
    await loadAll();
    // 引用是工具写进去的，删掉时说清顺手收回了什么，用户才知道自己的组合订阅变了。
    const cleaned = result.detached;
    const parts: string[] = [];
    if (cleaned.collections > 0) parts.push(`${cleaned.collections} 个组合订阅`);
    if (cleaned.profiles > 0) parts.push(`${cleaned.profiles} 个配置构成`);
    notify(
      'ok',
      parts.length === 0
        ? `已删除 ${name}`
        : `已删除 ${name}，并清理了 ${parts.join('、')} 中的引用`,
    );
  });
}

/**
 * 真去上游拉一次（走服务端 ETag 复用）。失败的源不抛错：
 * body 里带 lastError，交给调用方提示「上游 500」这类原因，而不是弹一个 bare 502。
 */
export async function refreshSource(id: string): Promise<{ refreshed: number; failed: number; lastError: string | null } | null> {
  // 手动「更新订阅」也要写 sourceUpdating：按钮的 loading / disabled 只认它，
  // 否则点下去毫无反馈，还能连点出多个并发的上游请求。
  if (sourceUpdating.value.includes(id)) return null;
  sourceUpdating.value = [...sourceUpdating.value, id];
  let result: { refreshed: number; failed: number; lastError: string | null } | null = null;
  try {
    await run(async () => {
      result = await api.refreshSource(id);
      await loadAll();
      if (result.failed > 0) {
        notify('error', `${sourceLabel(id)} 拉取失败：${result.lastError ?? '未知原因'}`);
      } else {
        notify('ok', `${sourceLabel(id)} 已更新订阅`);
      }
    });
  } finally {
    sourceUpdating.value = sourceUpdating.value.filter((item) => item !== id);
  }
  return result;
}

export async function refreshRemoteSources(): Promise<void> {
  // 批量更新也要占住每个源的「更新中」：否则状态列不动、单源按钮仍可点，
  // 会和批量刷新并发打同一条上游。只清掉自己加进去的 id，不碰后台队列已占的。
  const ids = sources.value
    .filter((item) => item.kind === 'remote' && item.enabled)
    .map((item) => item.id);
  const marked = ids.filter((id) => !sourceUpdating.value.includes(id));
  sourceUpdating.value = [...sourceUpdating.value, ...marked];
  try {
    await run(async () => {
      const outcome = await api.refreshRemote();
      await loadAll();
      notify(
        outcome.failed > 0 ? 'error' : 'ok',
        outcome.failed > 0
          ? `${outcome.refreshed} 个已更新，${outcome.failed} 个失败（原因见订阅列表）`
          : `已更新 ${outcome.refreshed} 个订阅`,
      );
    });
  } finally {
    sourceUpdating.value = sourceUpdating.value.filter((id) => !marked.includes(id));
  }
}

/* ---------------- 组合订阅 ---------------- */

export async function saveCollection(input: {
  id?: string;
  name: string;
  members: CollectionMemberView[];
  dedupe: DedupeView;
}): Promise<boolean> {
  return run(async () => {
    await api.saveCollection(input);
    await loadAll();
    notify('ok', `组合订阅「${input.name}」已保存`);
  });
}

export async function removeCollection(id: string): Promise<boolean> {
  return run(async () => {
    const result = await api.removeCollection(id);
    await loadAll();
    notify(
      'ok',
      result.detached.profiles > 0
        ? `已删除组合订阅，并从 ${result.detached.profiles} 个配置构成里移除`
        : '已删除组合订阅',
    );
  });
}

/** 把一批源追加到当前构成并立即保存：用于「未加入构成」的批量补挂。 */
export async function attachSources(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  for (const id of ids) {
    if (profileEntries.value.some((entry) => entry.kind === 'source' && entry.id === id)) continue;
    addProfileEntry({ kind: 'source', id });
  }
  return saveProfile();
}

/* ---------------- Profile ---------------- */

/** 切换器的选项。侧栏与配置页窄屏共用一份，别在两处各建一次。 */
export const profileOptions = computed(() =>
  profiles.value.map((item) => ({ label: item.name, value: item.name })),
);

export async function onProfileChange(value: string): Promise<void> {
  await switchProfile(value);
}

function dirtyPartsLabel(): string {
  const parts: string[] = [];
  if (profileDirty.value) parts.push('构成');
  if (rulesDirty.value) parts.push('规则');
  if (groupsDirty.value) parts.push('策略组');
  if (runtimeDirty.value) parts.push('DNS / TUN');
  return parts.join('、');
}

async function confirmLeaveDirty(actionLabel: string): Promise<boolean> {
  const what = dirtyPartsLabel();
  if (what === '') return true;
  if (dialoger !== null) {
    return dialoger.confirmDiscard(`当前配置「${activeProfileName.value}」有未保存的${what}修改，${actionLabel}将会丢弃这些草稿。`);
  }
  return true;
}

export async function switchProfile(name: string): Promise<boolean> {
  if (name === activeProfileName.value) return true;
  const previous = activeProfileName.value;
  const hadDraft = dirtyPartsLabel();
  if (!(await confirmLeaveDirty('切换配置'))) return false;
  return run(async () => {
    setActiveProfile(name);
    activeProfileName.value = name;
    await loadAll(true);
    if (hadDraft !== '' && dialoger === null) {
      notify('error', `切换配置，「${previous}」未保存的${hadDraft}修改已丢弃`);
    } else notify('ok', `已切换到配置「${name}」`);
  });
}

export async function createProfile(name: string): Promise<boolean> {
  const value = name.trim();
  if (value.length === 0) {
    notify('error', '请填写配置名称');
    return false;
  }
  const previous = activeProfileName.value;
  const hadDraft = dirtyPartsLabel();
  if (!(await confirmLeaveDirty('新建并切换配置'))) return false;
  return run(async () => {
    const created = await api.createProfile(value);
    if (!created.created) {
      notify('error', `配置「${value}」已存在`);
      return;
    }
    setActiveProfile(value);
    activeProfileName.value = value;
    await loadAll(true);
    if (hadDraft !== '' && dialoger === null) {
      notify('error', `新建配置，「${previous}」未保存的${hadDraft}修改已丢弃`);
    }
    notify('ok', `已新建配置「${value}」，接着往构成里加订阅`);
  });
}

export async function removeProfile(name: string): Promise<boolean> {
  const previous = activeProfileName.value;
  const hadDraft = dirtyPartsLabel();
  if (name === activeProfileName.value && !(await confirmLeaveDirty('删除当前配置'))) return false;
  return run(async () => {
    const result = await api.removeProfile(name);
    createdUrls.value = createdUrls.value.filter((item) => item.profile !== name);
    if (name === activeProfileName.value) {
      // 删的是当前 Profile：先切到一个还存在的，否则后续每个请求都会 404。
      const fallback = profiles.value.find((item) => item.name !== name)?.name ?? 'default';
      setActiveProfile(fallback);
      activeProfileName.value = fallback;
    }
    await loadAll(true);
    if (hadDraft !== '' && dialoger === null) {
      notify('error', `删除配置，「${previous}」未保存的${hadDraft}修改已丢弃`);
    }
    notify(
      'ok',
      result.revoked > 0
        ? `已删除配置「${name}」，并撤销 ${result.revoked} 个绑定它的订阅地址`
        : `已删除配置「${name}」`,
    );
  });
}

/* ----------------配置构成 ---------------- */

export function addProfileEntry(entry: ProfileEntryView): void {
  profileEntries.value = [...profileEntries.value, entry];
}

export function removeProfileEntry(index: number): void {
  profileEntries.value = profileEntries.value.filter((_, position) => position !== index);
}

export function moveProfileEntry(index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= profileEntries.value.length) return;
  const list = [...profileEntries.value];
  const current = list[index];
  const other = list[next];
  if (current === undefined || other === undefined) return;
  list[index] = other;
  list[next] = current;
  profileEntries.value = list;
}

/**
 * 丢弃构成草稿，回到最近一次 /api/state 里落库的构成。
 * 用 state 而不是 loadedEntries 当来源：基线只是字符串比对用的快照，
 * 一旦历史上某次保存把基线写成错的，靠它「还原」只会把错误再写一遍。
 */
export function discardProfileDraft(): void {
  const snapshot = state.value;
  if (snapshot === null) return;
  const profile = snapshot.profiles.find((item) => item.name === activeProfileName.value);
  profileEntries.value = profile ? [...profile.entries] : [];
  loadedEntries.value = JSON.stringify(profileEntries.value);
}

export async function saveProfile(): Promise<boolean> {
  return run(async () => {
    await api.saveProfile(profileEntries.value);
    // 先把基线对齐，再走统一的状态映射：否则草稿保护会把刚保存的构成当成「未保存改动」跳过。
    loadedEntries.value = JSON.stringify(profileEntries.value);
    applyStateSnapshot(await api.state());
    await loadNodeState();
    await refreshPreview();
    notify('ok', '配置已保存');
  });
}

/* ---------------- 节点标注 ---------------- */

function annotationOf(node: NodeView): AnnotationView {
  return { ...(annotationMap.value.get(node.nodeKey) ?? { nodeKey: node.nodeKey }) };
}

function upsertAnnotation(next: AnnotationView): void {
  const rest = annotations.value.filter((item) => item.nodeKey !== next.nodeKey);
  annotations.value = [...rest, next];
}

let previewTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePreviewRefresh(): void {
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void refreshPreview();
  }, 350);
}

export async function toggleExcluded(node: NodeView): Promise<boolean> {
  const prev = annotationOf(node);
  const payload: AnnotationView = { ...prev, excluded: !(prev.excluded === true) };
  upsertAnnotation(payload);
  nodeBusy.value = true;
  try {
    await api.saveAnnotation(payload);
    schedulePreviewRefresh();
    return true;
  } catch (cause) {
    upsertAnnotation(prev);
    notify('error', messageOf(cause));
    return false;
  } finally {
    nodeBusy.value = false;
  }
}

export async function saveAlias(node: NodeView, value: string): Promise<boolean> {
  const prev = annotationOf(node);
  const payload: AnnotationView = { ...prev };
  const trimmed = value.trim();
  if (trimmed.length > 0) payload.alias = trimmed;
  else delete payload.alias;
  upsertAnnotation(payload);
  nodeBusy.value = true;
  try {
    await api.saveAnnotation(payload);
    schedulePreviewRefresh();
    notify('ok', trimmed.length > 0 ? `已重命名为 ${trimmed}` : '已恢复原名');
    return true;
  } catch (cause) {
    upsertAnnotation(prev);
    notify('error', messageOf(cause));
    return false;
  } finally {
    nodeBusy.value = false;
  }
}

/** 手动改地区：覆盖值存进 Annotation.region，空串 = 清除覆盖、回退名字推断。 */
export async function saveRegion(node: NodeView, code: string): Promise<boolean> {
  const prev = annotationOf(node);
  const payload: AnnotationView = { ...prev };
  if (code === '') delete payload.region;
  else payload.region = code;
  upsertAnnotation(payload);
  nodeBusy.value = true;
  try {
    await api.saveAnnotation(payload);
    schedulePreviewRefresh();
    notify('ok', code === '' ? '已清除地区覆盖' : `地区已改为 ${code}`);
    return true;
  } catch (cause) {
    upsertAnnotation(prev);
    notify('error', messageOf(cause));
    return false;
  } finally {
    nodeBusy.value = false;
  }
}

export async function moveNode(index: number, direction: number): Promise<boolean> {
  const next = index + direction;
  if (next < 0 || next >= nodes.value.length) return false;
  const current = nodes.value[index];
  const other = nodes.value[next];
  if (current === undefined || other === undefined) return false;
  const prevCurrent = annotationOf(current);
  const prevOther = annotationOf(other);
  const prevNodes = [...nodes.value];
  const left = { ...prevCurrent, order: next };
  const right = { ...prevOther, order: index };
  const reordered = [...nodes.value];
  reordered[index] = other;
  reordered[next] = current;
  nodes.value = reordered;
  upsertAnnotation(left);
  upsertAnnotation(right);
  nodeBusy.value = true;
  try {
    await Promise.all([api.saveAnnotation(left), api.saveAnnotation(right)]);
    schedulePreviewRefresh();
    return true;
  } catch (cause) {
    nodes.value = prevNodes;
    upsertAnnotation(prevCurrent);
    upsertAnnotation(prevOther);
    notify('error', messageOf(cause));
    return false;
  } finally {
    nodeBusy.value = false;
  }
}

/* ---------------- 订阅 URL ---------------- */

export const latestTokenId = ref<string | null>(null);

/** 签发成功返回明文地址，失败返回 null；调用方拿到就能立刻给用户复制。 */
export async function createToken(
  forTarget: string,
  forProfile: string = activeProfileName.value,
): Promise<string | null> {
  let url: string | null = null;
  const ok = await run(async () => {
    const result = await api.createToken(forTarget, forProfile);
    url = result.url;
    latestTokenId.value = result.id;
    createdUrls.value = [
      { profile: forProfile, target: forTarget, url: result.url },
      ...createdUrls.value.filter((item) => !(item.profile === forProfile && item.target === forTarget)),
    ];
    applyStateSnapshot(await api.state());
    notify('ok', '订阅地址已生成');
  });
  return ok ? url : null;
}

/**
 * 早期记录只存了 token 的 hash，链接和二维码再也还原不出来。
 * 重签发先建新地址、成功后才撤销旧的：中间任何一步失败都只是短暂并存，
 * 不会出现「旧的已失效、新的又没签出来」把用户锁在门外。
 */
export async function reissueToken(
  id: string,
  forTarget: string,
  forProfile: string,
): Promise<boolean> {
  return run(async () => {
    // 先建新地址：这一步失败就整体失败，旧地址原样保留，用户不会被锁在门外。
    const result = await api.createToken(forTarget, forProfile);
    latestTokenId.value = result.id;
    createdUrls.value = [
      { profile: forProfile, target: forTarget, url: result.url },
      ...createdUrls.value.filter((item) => !(item.profile === forProfile && item.target === forTarget)),
    ];
    try {
      await api.revokeToken(id);
    } catch {
      // 新地址已经可用，只是旧地址没撤掉：说清楚现状，别让用户以为整件事失败了。
      applyStateSnapshot(await api.state());
      notify('error', '新地址已生成，但旧地址撤销失败，请在列表里手动撤销');
      return;
    }
    applyStateSnapshot(await api.state());
    notify('ok', '已重新签发，旧地址已失效');
  });
}

export async function revokeToken(id: string): Promise<boolean> {
  return run(async () => {
    await api.revokeToken(id);
    applyStateSnapshot(await api.state());
    notify('ok', '订阅地址已撤销');
  });
}

/* ---------------- 规则 ---------------- */

function syncRules(next: RuleView[]): void {
  rules.value = next;
}

export function ruleLabel(rule: RuleView): string {
  if (rule.kind === 'external') {
    return `规则集 ${rule.shape ?? '未定形状'} ${rule.format ?? 'text'}: ${rule.url}`;
  }
  if (rule.kind === 'final') return '兜底 MATCH';
  const condition = rule.condition;
  const suffix = condition.noResolve === true ? ' no-resolve' : '';
  if (condition.value !== undefined) return `${condition.type}: ${condition.value}${suffix}`;
  if (condition.children !== undefined) return `${condition.type} (${condition.children.length} 子条件)`;
  if (condition.child !== undefined) return `${condition.type} (子条件)`;
  return condition.type;
}

export function addRule(rule: RuleView): void {
  syncRules([...rules.value, rule]);
}

export function updateRule(index: number, rule: RuleView): void {
  if (index < 0 || index >= rules.value.length) return;
  syncRules(rules.value.map((item, position) => (position === index ? rule : item)));
}

export function moveRule(index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= rules.value.length) return;
  const list = [...rules.value];
  const current = list[index];
  const other = list[next];
  if (current === undefined || other === undefined) return;
  list[index] = other;
  list[next] = current;
  syncRules(list);
}

export function removeRule(index: number): void {
  syncRules(rules.value.filter((_, position) => position !== index));
}

export function exportRuleText(): string {
  return formatRuleText(rules.value);
}

export function importRuleText(text: string, mode: 'append' | 'replace'): RuleTextParseResult {
  const result = parseRuleText(text);
  if (result.rules.length === 0) {
    notify('error', result.skipped.length > 0 ? '未识别到可导入的规则，请检查下方跳过说明' : '没有可导入的规则行');
    return result;
  }
  syncRules(mode === 'append' ? [...rules.value, ...result.rules] : result.rules);
  const action = mode === 'append' ? '已追加' : '已替换为';
  const suffix = result.skipped.length > 0 ? `，另有 ${result.skipped.length} 行未导入` : '';
  notify('ok', `${action} ${result.rules.length} 条规则${suffix}，保存后生效`);
  return result;
}

export function importRules(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    notify('error', `JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
  if (!Array.isArray(parsed)) {
    notify('error', '规则必须是数组');
    return false;
  }
  syncRules(parsed as RuleView[]);
  notify('ok', `已载入 ${parsed.length} 条规则，保存后生效`);
  return true;
}

export async function saveRules(): Promise<boolean> {
  return run(async () => {
    await api.saveRules({ mode: ruleMode.value, placement: rulePlacement.value, rules: rules.value });
    loadedRules.value = JSON.stringify({
      mode: ruleMode.value,
      placement: rulePlacement.value,
      rules: rules.value,
    });
    await refreshPreview();
    notify('ok', '规则已保存');
  });
}

export function discardRules(): void {
  if (loadedRules.value === '') return;
  try {
    const parsed = JSON.parse(loadedRules.value) as {
      mode: OverlayMode;
      placement: 'before' | 'after';
      rules: RuleView[];
    };
    ruleMode.value = parsed.mode;
    rulePlacement.value = parsed.placement;
    syncRules(parsed.rules);
    notify('ok', '已恢复为上次保存的规则');
  } catch {
    // 忽略异常快照
  }
}

/** 新建策略组：名字是去重键，重复或空名直接忽略，不制造两条同名组。 */
function memberDraftOf(member: string | GroupMemberView): GroupMemberDraft {
  if (typeof member === 'string') return { kind: 'ref', value: member };
  if (member.kind === 'match') return { kind: 'match', value: member.pattern ?? '' };
  if (member.kind === 'region') return { kind: 'region', value: member.code ?? '' };
  if (member.kind === 'rest') return { kind: 'rest', value: '' };
  return { kind: 'ref', value: member.name ?? '' };
}

function groupDraftOf(group: GroupView): GroupDraft {
  return {
    name: group.name,
    strategy: group.strategy ?? 'select',
    testUrl: group.testUrl ?? '',
    interval: group.interval ?? null,
    tolerance: group.tolerance ?? null,
    lazy: group.lazy === true,
    hidden: group.hidden === true,
    members: group.members.map(memberDraftOf),
  };
}

export function addGroup(name: string): boolean {
  const value = name.trim();
  if (value.length === 0 || groups.value.some((item) => item.name === value)) return false;
  groups.value = [
    ...groups.value,
    { name: value, strategy: 'select', testUrl: '', interval: null, tolerance: null, lazy: false, hidden: false, members: [] },
  ];
  return true;
}

export function removeGroup(name: string): void {
  groups.value = groups.value.filter((item) => item.name !== name);
}

export function addGroupMember(group: GroupDraft, member: GroupMemberDraft): void {
  if (member.kind === 'rest') {
    if (group.members.some((item) => item.kind === 'rest')) return;
    groups.value = groups.value.map((item) =>
      item.name === group.name ? { ...item, members: [...item.members, { kind: 'rest', value: '' }] } : item,
    );
    return;
  }
  const value = member.value.trim();
  if (value.length === 0) return;
  const next = { kind: member.kind, value };
  if (group.members.some((item) => item.kind === next.kind && item.value === next.value)) return;
  groups.value = groups.value.map((item) =>
    item.name === group.name ? { ...item, members: [...item.members, next] } : item,
  );
}

export function removeGroupMember(group: GroupDraft, member: GroupMemberDraft): void {
  groups.value = groups.value.map((item) =>
    item.name === group.name
      ? { ...item, members: item.members.filter((value) => !(value.kind === member.kind && value.value === member.value)) }
      : item,
  );
}

export function moveGroupMember(group: GroupDraft, index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= group.members.length) return;
  const list = [...group.members];
  const current = list[index];
  const other = list[next];
  if (current === undefined || other === undefined) return;
  list[index] = other;
  list[next] = current;
  groups.value = groups.value.map((item) => (item.name === group.name ? { ...item, members: list } : item));
}

export function patchGroup(name: string, patch: Partial<GroupDraft>): void {
  groups.value = groups.value.map((item) => (item.name === name ? { ...item, ...patch, name: item.name } : item));
}

export function adoptBaseGroups(): void {
  groups.value = baseGroups.value.map((group) => ({
    name: group.name,
    strategy: group.strategy ?? 'select',
    testUrl: '',
    interval: group.strategy !== undefined && group.strategy !== 'select' ? 300 : null,
    tolerance: group.strategy === 'url-test' ? 50 : null,
    lazy: false,
    hidden: false,
    members: group.members.map((member) => ({ kind: 'ref' as const, value: member })),
  }));
}

export function moveGroup(index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= groups.value.length) return;
  const list = [...groups.value];
  const current = list[index];
  const other = list[next];
  if (current === undefined || other === undefined) return;
  list[index] = other;
  list[next] = current;
  groups.value = list;
}

export async function saveGroups(): Promise<boolean> {
  return run(async () => {
    const payload: GroupView[] = groups.value.map((group) => ({
      name: group.name,
      strategy: group.strategy,
      ...(group.testUrl.trim().length === 0 ? {} : { testUrl: group.testUrl.trim() }),
      ...(group.interval === null ? {} : { interval: group.interval }),
      ...(group.tolerance === null ? {} : { tolerance: group.tolerance }),
      ...(group.lazy ? { lazy: true } : {}),
      ...(group.hidden ? { hidden: true } : {}),
      members: group.members.map((member) =>
        member.kind === 'match'
          ? { kind: 'match' as const, pattern: member.value }
          : member.kind === 'region'
            ? { kind: 'region' as const, code: member.value }
            : member.kind === 'rest'
              ? { kind: 'rest' as const }
              : { kind: 'ref' as const, name: member.value },
      ),
    }));
    await api.savePolicyGroups({ mode: groupMode.value, groups: payload });
    loadedGroups.value = JSON.stringify({ mode: groupMode.value, groups: groups.value });
    await refreshPreview();
    notify('ok', '策略组已保存');
  });
}

export function discardGroups(): void {
  if (loadedGroups.value === '') return;
  try {
    const parsed = JSON.parse(loadedGroups.value) as {
      mode: OverlayMode;
      groups: GroupDraft[];
    };
    groupMode.value = parsed.mode;
    groups.value = parsed.groups;
    notify('ok', '已恢复为上次保存的策略组');
  } catch {
    // 忽略异常快照
  }
}

/* ---------------- 维护 ---------------- */

export async function clearCache(): Promise<boolean> {
  return run(async () => {
    await api.refresh();
    // 刷新会重写各源的最后拉取时间 / 流量信息：不重载 state，界面还停在旧快照上。
    await loadAll();
    notify('ok', '上游缓存已清空并重新拉取');
  });
}

/** 读取单次构建回执：构建历史里点进去看完整诊断。 */
export async function loadBuildReport(buildId: string): Promise<void> {
  buildReportLoading.value = true;
  try {
    buildReport.value = await api.buildReport(buildId);
  } catch (cause) {
    notify('error', messageOf(cause));
  } finally {
    buildReportLoading.value = false;
  }
}

export function closeBuildReport(): void {
  buildReport.value = null;
}

/** 轮换管理令牌：换完后本会话继续用新令牌，其他设备需要重新输入。 */
export async function rotateAdminToken(next: string): Promise<boolean> {
  return run(async () => {
    await api.rotateAdminToken(next);
    setToken(next);
    notify('ok', '管理令牌已更换；其他设备需要重新输入新令牌');
  });
}

export async function backupDatabase(): Promise<boolean> {
  return run(async () => {
    const result = await api.backup();
    notify('ok', `已备份到 ${result.destination}`);
  });
}

/** 备份并上传到配置好的 WebDAV；未配置时服务端回 501，这里给一句人话。 */
export async function backupToRemote(): Promise<boolean> {
  return run(async () => {
    try {
      const result = await api.backupRemote();
      notify('ok', `已上传 ${formatTraffic(result.bytes)} 到 WebDAV`);
    } catch (cause) {
      notify('error', `WebDAV 上传失败：${messageOf(cause)}`);
    }
  });
}

/** 保存通知渠道配置（界面覆盖环境变量默认值）。 */
export async function saveNotifySettings(next: NotifyConfigView | null): Promise<boolean> {
  return run(async () => {
    await api.saveNotify(next);
    notifySettings.value = await api.notifySettings();
    ops.value = await api.ops();
    notify('ok', next === null ? '已清除通知配置，回退环境变量' : '通知配置已保存');
  });
}

/** 保存 WebDAV 远端备份配置（界面覆盖环境变量默认值）。 */
export async function saveWebdavSettings(next: WebDavConfigView | null): Promise<boolean> {
  return run(async () => {
    await api.saveWebdav(next);
    webdavSettings.value = await api.webdavSettings();
    ops.value = await api.ops();
    notify('ok', next === null ? '已清除 WebDAV 配置，回退环境变量' : 'WebDAV 配置已保存');
  });
}

/** 保存实例级拉取默认。源级若单独配了 UA / 代理，仍压过这里的默认值。 */
export async function saveFetchDefaults(next: FetchDefaultsView | null): Promise<boolean> {
  return run(async () => {
    await api.saveFetchDefaults(next);
    fetchDefaultsSettings.value = await api.fetchDefaults();
    notify('ok', next === null ? '已清除采集默认，源按自身配置拉取' : '采集默认已保存，新拉取的订阅下次生效');
  });
}

/**
 * TCP 握手延迟探测。刻意把结果只放在内存里、并明确标注「非代理链路测速」——
 * 它回答的是「服务器通不通、大概多远」，不是「这个节点跑多快」。
 */
export async function probeLatency(): Promise<void> {
  if (probing.value) return;
  probing.value = true;
  try {
    const result = await api.probe();
    latencies.value = Object.fromEntries(
      result.samples.map((item) => [item.nodeKey, { ms: item.latencyMs, intercepted: item.intercepted }]),
    );
    const reachable = result.samples.filter((item) => item.latencyMs !== null);
    const intercepted = reachable.filter((item) => item.intercepted).length;
    notify(
      reachable.length > 0 ? 'ok' : 'error',
      intercepted > 0
        ? `${reachable.length}/${result.samples.length} 个 TCP 可达，其中 ${intercepted} 个解析到内网/本机假 IP，延迟无参考意义`
        : `${reachable.length}/${result.samples.length} 个节点 TCP 可达`,
    );
  } catch (cause) {
    notify('error', `探测失败：${messageOf(cause)}`);
  } finally {
    probing.value = false;
  }
}

export function loadTraceIfNeeded(): Promise<void> {
  if (traceSteps.value.length > 0) return Promise.resolve();
  return run(async () => {
    await loadTrace();
    await refreshPreview();
  }).then(() => undefined);
}
