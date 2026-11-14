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
  GroupView,
  HistoryEntry,
  InlineRuleView,
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

export type Tab =
  | 'overview'
  | 'sources'
  | 'nodes'
  | 'rules'
  | 'publish'
  | 'diagnostics'
  | 'capabilities'
  | 'settings';

export interface NavEntry {
  key: Tab;
  label: string;
  title: string;
  group: string;
  /** 手机底部标签栏只放主要入口，其余进「更多」。 */
  mobile?: boolean;
}

export const NAV: readonly NavEntry[] = [
  { key: 'overview', label: '概览', title: '概览', group: '编排', mobile: true },
  { key: 'sources', label: '订阅源', title: '订阅源', group: '编排', mobile: true },
  { key: 'nodes', label: '节点', title: '节点', group: '编排', mobile: true },
  { key: 'rules', label: '规则', title: '规则', group: '编排', mobile: true },
  { key: 'publish', label: '发布', title: '发布', group: '编排', mobile: true },
  { key: 'diagnostics', label: '诊断', title: '诊断', group: '排查' },
  { key: 'capabilities', label: '能力', title: '能力矩阵', group: '排查' },
  { key: 'settings', label: '设置', title: '设置', group: '系统' },
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

export interface GroupDraft {
  name: string;
  members: string[];
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
export const tab = ref<Tab>('overview');

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
export const target = ref('surge');
export const createdUrls = ref<{ target: string; url: string }[]>([]);
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
/** TCP 握手延迟：按 nodeKey 索引，不落库（延迟是瞬时属性）。 */
export const latencies = ref<Record<string, { ms: number | null; intercepted: boolean }>>({});
export const probing = ref(false);
export const profileEntries = ref<ProfileEntryView[]>([]);
export const rules = ref<InlineRuleView[]>([]);
export const groups = ref<GroupDraft[]>([]);

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

let messenger: Messenger | null = null;

/** 由 Shell 注入 Naive UI 的 message 实例，workspace 不直接依赖组件库。 */
export const setMessenger = (api: Messenger): void => {
  messenger = api;
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

export const activeTokens = computed(() => (state.value?.tokens ?? []).filter((item) => !item.revoked));

export const excludedCount = computed(
  () => nodes.value.filter((node) => annotationMap.value.get(node.nodeKey)?.excluded === true).length,
);

export const profileDirty = computed(
  () => JSON.stringify(profileEntries.value) !== loadedEntries.value,
);
export const rulesDirty = computed(() => JSON.stringify(rules.value) !== loadedRules.value);
export const groupsDirty = computed(() => JSON.stringify(groups.value) !== loadedGroups.value);

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
  if (text.includes('profile-empty')) return '当前 Profile 没有任何内容：先在订阅源页把源加入构成';
  if (text.includes('admin-token-from-env'))
    return '管理令牌由环境变量提供，请在部署侧修改后重启';
  if (text.includes('admin-token-unchanged')) return '新令牌与当前相同，无需更换';
  if (text.includes('last-profile')) return '至少要保留一个 Profile';
  if (text.includes('notify-not-configured')) return '还没配置通知渠道';
  if (text.includes('404') && text.includes('profile-not-found')) return 'Profile 不存在，请先在订阅源页重建';
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

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify('ok', '已复制');
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

export async function refreshPreview(): Promise<void> {
  previewLoading.value = true;
  try {
    preview.value = await api.preview(target.value);
  } finally {
    previewLoading.value = false;
  }
}

async function loadRuleState(): Promise<void> {
  const ruleData = await api.rules();
  rules.value = ruleData.rules;
  loadedRules.value = JSON.stringify(ruleData.rules);
  const groupData = await api.policyGroups();
  groups.value = groupData.groups.map((group) => ({ name: group.name, members: [...group.members] }));
  loadedGroups.value = JSON.stringify(groups.value);
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

export async function loadAll(): Promise<void> {
  const snapshot = await api.state();
  state.value = snapshot;
  const preferred = getActiveProfile();
  const profile =
    snapshot.profiles.find((item) => item.name === preferred) ??
    snapshot.profiles.find((item) => item.name === 'default') ??
    snapshot.profiles[0];
  setActiveProfile(profile?.name ?? 'default');
  activeProfileName.value = getActiveProfile();

  profileEntries.value = profile ? [...profile.entries] : [];
  loadedEntries.value = JSON.stringify(profileEntries.value);
  annotations.value = [...snapshot.annotations];

  const targetExists = snapshot.clientTargets.some((item) => item.id === target.value);
  if (!targetExists && snapshot.clientTargets[0] !== undefined) {
    target.value = snapshot.clientTargets[0].id;
  }

  await refreshSourceStats();
  await loadNodeState();
  await refreshPreview();
  await loadRuleState();
  evidence.value = (await api.capabilities()).evidence;
  history.value = (await api.diagnostics()).reports;
  ops.value = await api.ops();
  notifySettings.value = await api.notifySettings();
  webdavSettings.value = await api.webdavSettings();
}

/**
 * 保存后的轻量刷新：只取 /api/state（纯读库）。
 * loadAll 里的 /api/sources/inspect 会对每个远端源真的发一次上游请求，
 * 再加 nodes / preview / rules 等一串串行接口，机场慢或超时就会把「添加」按钮卡住十几秒。
 * 加完源只需要立刻关抽屉、立刻看到新的一行，用不着等这些。
 */
async function reloadAfterSave(): Promise<void> {
  const snapshot = await api.state();
  state.value = snapshot;
  const preferred = getActiveProfile();
  const profile =
    snapshot.profiles.find((item) => item.name === preferred) ??
    snapshot.profiles.find((item) => item.name === 'default') ??
    snapshot.profiles[0];
  profileEntries.value = profile ? [...profile.entries] : [];
  loadedEntries.value = JSON.stringify(profileEntries.value);
  annotations.value = [...snapshot.annotations];
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
    await loadAll();
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
    await loadAll();
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
  setToken('');
  connected.value = false;
  state.value = null;
  nodes.value = [];
  preview.value = null;
  annotations.value = [];
  createdUrls.value = [];
  rules.value = [];
  groups.value = [];
  profileEntries.value = [];
  sourceStats.value = {};
  buildReport.value = null;
  history.value = [];
  activeProfileName.value = 'default';
  setActiveProfile('default');
}

export function reload(): Promise<boolean> {
  return run(async () => {
    await loadAll();
    notify('ok', '已刷新');
  });
}

/* ---------------- 订阅源 ---------------- */

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
    notify('ok', attached ? `已添加 ${created.id}，并加入当前 Profile 构成` : `已添加 ${created.id}`);
  });
  // 保存已经落库，上游拉取交给后台：remote 源要真去拉一次，file 源只需补齐统计与构建状态。
  if (ok && createdId !== '') queueSourceRefresh(createdId, input.kind === 'remote');
  return { ok, attached };
}

export async function updateSource(
  id: string,
  patch: Partial<SourceInput> & { enabled?: boolean },
): Promise<boolean> {
  return run(async () => {
    await api.updateSource(id, patch);
    await loadAll();
  });
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
    if (cleaned.profiles > 0) parts.push(`${cleaned.profiles} 个 Profile 构成`);
    notify(
      'ok',
      parts.length === 0
        ? `已删除 ${name}`
        : `已删除 ${name}，并清理了 ${parts.join('、')} 中的引用`,
    );
  });
}

export async function inspectSource(id: string): Promise<SourceStatView | null> {
  let result: SourceStatView | null = null;
  await run(async () => {
    result = await api.previewSource(id);
    sourceStats.value = { ...sourceStats.value, [id]: result };
  });
  return result;
}

/**
 * 真去上游拉一次（走服务端 ETag 复用）。失败的源不抛错：
 * body 里带 lastError，交给调用方提示「上游 500」这类原因，而不是弹一个 bare 502。
 */
export async function refreshSource(id: string): Promise<{ refreshed: number; failed: number; lastError: string | null } | null> {
  let result: { refreshed: number; failed: number; lastError: string | null } | null = null;
  await run(async () => {
    result = await api.refreshSource(id);
    await loadAll();
    if (result.failed > 0) {
      notify('error', `${sourceLabel(id)} 拉取失败：${result.lastError ?? '未知原因'}`);
    } else {
      notify('ok', `${sourceLabel(id)} 已更新订阅`);
    }
  });
  return result;
}

export async function refreshRemoteSources(): Promise<void> {
  await run(async () => {
    const outcome = await api.refreshRemote();
    await loadAll();
    notify(
      outcome.failed > 0 ? 'error' : 'ok',
      outcome.failed > 0
        ? `${outcome.refreshed} 个已更新，${outcome.failed} 个失败（原因见订阅源列表）`
        : `已更新 ${outcome.refreshed} 个订阅`,
    );
  });
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
        ? `已删除组合订阅，并从 ${result.detached.profiles} 个 Profile 构成里移除`
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

export async function switchProfile(name: string): Promise<boolean> {
  if (name === activeProfileName.value) return true;
  return run(async () => {
    setActiveProfile(name);
    activeProfileName.value = name;
    await loadAll();
    notify('ok', `已切换到 Profile「${name}」`);
  });
}

export async function createProfile(name: string): Promise<boolean> {
  const value = name.trim();
  if (value.length === 0) {
    notify('error', '请填写 Profile 名称');
    return false;
  }
  return run(async () => {
    const created = await api.createProfile(value);
    if (!created.created) {
      notify('error', `Profile「${value}」已存在`);
      return;
    }
    setActiveProfile(value);
    activeProfileName.value = value;
    await loadAll();
    notify('ok', `已新建 Profile「${value}」，接着往构成里加来源`);
  });
}

export async function removeProfile(name: string): Promise<boolean> {
  return run(async () => {
    const result = await api.removeProfile(name);
    if (name === activeProfileName.value) {
      // 删的是当前 Profile：先切到一个还存在的，否则后续每个请求都会 404。
      const fallback = profiles.value.find((item) => item.name !== name)?.name ?? 'default';
      setActiveProfile(fallback);
      activeProfileName.value = fallback;
    }
    await loadAll();
    notify(
      'ok',
      result.revoked > 0
        ? `已删除 Profile「${name}」，并撤销 ${result.revoked} 个绑定它的订阅地址`
        : `已删除 Profile「${name}」`,
    );
  });
}

/* ---------------- Profile 构成 ---------------- */

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

export async function saveProfile(): Promise<boolean> {
  return run(async () => {
    await api.saveProfile(profileEntries.value);
    state.value = await api.state();
    loadedEntries.value = JSON.stringify(profileEntries.value);
    await loadNodeState();
    await refreshPreview();
    notify('ok', 'Profile 已保存');
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

export async function toggleExcluded(node: NodeView): Promise<boolean> {
  const payload = annotationOf(node);
  payload.excluded = !(payload.excluded === true);
  return run(async () => {
    await api.saveAnnotation(payload);
    upsertAnnotation(payload);
    await refreshPreview();
  });
}

export async function saveAlias(node: NodeView, value: string): Promise<boolean> {
  const payload = annotationOf(node);
  const trimmed = value.trim();
  if (trimmed.length > 0) payload.alias = trimmed;
  else delete payload.alias;
  return run(async () => {
    await api.saveAnnotation(payload);
    upsertAnnotation(payload);
    await refreshPreview();
    notify('ok', trimmed.length > 0 ? `已重命名为 ${trimmed}` : '已恢复原名');
  });
}

/** 手动改地区：覆盖值存进 Annotation.region，空串 = 清除覆盖、回退名字推断。 */
export async function saveRegion(node: NodeView, code: string): Promise<boolean> {
  const payload = annotationOf(node);
  if (code === '') delete payload.region;
  else payload.region = code;
  return run(async () => {
    await api.saveAnnotation(payload);
    upsertAnnotation(payload);
    await refreshPreview();
    notify('ok', code === '' ? '已清除地区覆盖' : `地区已改为 ${code}`);
  });
}

export async function moveNode(index: number, direction: number): Promise<boolean> {
  const next = index + direction;
  if (next < 0 || next >= nodes.value.length) return false;
  const current = nodes.value[index];
  const other = nodes.value[next];
  if (current === undefined || other === undefined) return false;
  const left = { ...annotationOf(current), order: next };
  const right = { ...annotationOf(other), order: index };
  return run(async () => {
    await api.saveAnnotation(left);
    await api.saveAnnotation(right);
    upsertAnnotation(left);
    upsertAnnotation(other);
    const reordered = [...nodes.value];
    reordered[index] = other;
    reordered[next] = current;
    nodes.value = reordered;
    await refreshPreview();
  });
}

/* ---------------- 订阅 URL ---------------- */

/** 签发成功返回明文地址（只此一次），失败返回 null；调用方拿到就能立刻给用户复制。 */
export async function createToken(forTarget: string): Promise<string | null> {
  let url: string | null = null;
  const ok = await run(async () => {
    const result = await api.createToken(forTarget);
    url = result.url;
    createdUrls.value = [
      { target: forTarget, url: result.url },
      ...createdUrls.value.filter((item) => item.target !== forTarget),
    ];
    state.value = await api.state();
    notify('ok', '订阅地址已生成');
  });
  return ok ? url : null;
}

export async function revokeToken(id: string): Promise<boolean> {
  return run(async () => {
    await api.revokeToken(id);
    state.value = await api.state();
    notify('ok', '订阅地址已撤销');
  });
}

/* ---------------- 规则 ---------------- */

function syncRules(next: InlineRuleView[]): void {
  rules.value = next;
}

export function ruleLabel(rule: InlineRuleView): string {
  const condition = rule.condition;
  if (condition.value !== undefined) return `${condition.type}: ${condition.value}`;
  if (condition.children !== undefined) return `${condition.type} (${condition.children.length} 子条件)`;
  if (condition.child !== undefined) return `${condition.type} (子条件)`;
  return condition.type;
}

export function addRule(condition: { type: string; value: string }, policy: string): void {
  syncRules([
    ...rules.value,
    { condition: { type: condition.type, value: condition.value }, policy: policy.trim() || 'DIRECT' },
  ]);
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
  syncRules(parsed as InlineRuleView[]);
  notify('ok', `已载入 ${parsed.length} 条规则，保存后生效`);
  return true;
}

export async function saveRules(): Promise<boolean> {
  return run(async () => {
    await api.saveRules(rules.value);
    loadedRules.value = JSON.stringify(rules.value);
    await refreshPreview();
    notify('ok', '规则已保存');
  });
}

/** 新建策略组：名字是去重键，重复或空名直接忽略，不制造两条同名组。 */
export function addGroup(name: string): boolean {
  const value = name.trim();
  if (value.length === 0 || groups.value.some((item) => item.name === value)) return false;
  groups.value = [...groups.value, { name: value, members: [] }];
  return true;
}

export function removeGroup(name: string): void {
  groups.value = groups.value.filter((item) => item.name !== name);
}

export function addGroupMember(group: GroupDraft, member: string): void {
  const value = member.trim();
  if (value.length === 0 || group.members.includes(value)) return;
  groups.value = groups.value.map((item) =>
    item.name === group.name ? { ...item, members: [...item.members, value] } : item,
  );
}

export function removeGroupMember(group: GroupDraft, member: string): void {
  groups.value = groups.value.map((item) =>
    item.name === group.name
      ? { ...item, members: item.members.filter((value) => value !== member) }
      : item,
  );
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
      members: group.members,
    }));
    await api.savePolicyGroups(payload);
    loadedGroups.value = JSON.stringify(groups.value);
    await refreshPreview();
    notify('ok', '策略组已保存');
  });
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
