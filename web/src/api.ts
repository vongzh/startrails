export interface AnnotationView {
  nodeKey: string;
  excluded?: boolean;
  alias?: string;
  tag?: string;
  order?: number;
  region?: string;
}

export type SourceKind = 'remote' | 'file' | 'inline';

/** 上游 `subscription-userinfo` 的快照，仅当上游给了才有值。 */
export interface SourceUserinfoView {
  upload?: number;
  download?: number;
  total?: number;
  expire?: number;
}

export interface SourceView {
  id: string;
  name: string;
  kind: SourceKind;
  enabled: boolean;
  url: string | null;
  format: string | null;
  ua: string | null;
  refreshPolicy: string | null;
  /** 解析后的间隔毫秒；null = 不自动刷新。服务端已归一，前端不再重复解析字符串。 */
  refreshIntervalMs: number | null;
  proxy: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  /** 本地快照距今多久（毫秒）；无快照为 null。 */
  snapshotAgeMs: number | null;
  /** 有快照但已超出新鲜期：此时构建用的是旧数据，界面必须讲明。 */
  snapshotStale: boolean;
  userinfo: SourceUserinfoView | null;
  suggestedRefreshHours: number | null;
  bytes: number;
  updatedAt: string | null;
}

/**
 * 加工管线的一步。与旧字段（prefix/include/exclude/rename/limit）的关系：
 * 写了 `process` 就按链执行，旧字段只是编译成等价链——顺序从此是语义的一部分。
 */
export type ProcessStep =
  | { type: 'filter'; by: 'regex' | 'region' | 'type' | 'useless'; keep: boolean; value?: string[] }
  | { type: 'rename'; template: string }
  | { type: 'prefix'; value: string }
  | { type: 'sort'; by: 'name' | 'region' | 'kind'; order: 'asc' | 'desc' }
  | { type: 'dedupe'; strategy: 'nodeKey' | 'name' | 'none' }
  | { type: 'limit'; count: number }
  | { type: 'set-property'; key: 'udp' | 'skip-cert-verify' | 'alpn'; value: boolean | string }
  | { type: 'flag'; value: string };

export interface MemberFilterView {
  enabled?: boolean;
  prefix?: string;
  include?: string[];
  exclude?: string[];
  limit?: number;
  /** 改名模板，支持 {name} {index} {source} {prefix}。 */
  rename?: string;
  /** 可编排的加工链；存在时优先于上面的旧字段（服务端按链执行）。 */
  process?: ProcessStep[];
}

export interface CollectionMemberView {
  sourceId: string;
  filter?: MemberFilterView;
}

export type DedupeView = 'nodeKey' | 'name' | 'none';

export interface CollectionView {
  id: string;
  name: string;
  members: CollectionMemberView[];
  dedupe: DedupeView;
  order: number;
  previewCount?: number;
}

export interface ProfileEntryView {
  kind: 'source' | 'collection';
  id: string;
}

export interface ProfileView {
  id: string;
  name: string;
  entries: ProfileEntryView[];
}

export interface TokenView {
  id: string;
  profile: string;
  target: string;
  revoked: boolean;
  createdAt: string;
  /** 可重新复制/出二维码的完整地址；早期只存 hash 的记录为 null，需要重新签发。 */
  url: string | null;
}

export interface ClientTargetView {
  id: string;
  name: string;
  dialect: string;
  fileExtension: string;
  contentMode: string;
  basis: string;
  independentEvidence: boolean;
}

export interface StateView {
  version: string;
  coreVersion: string;
  sources: SourceView[];
  collections: CollectionView[];
  profiles: ProfileView[];
  annotations: AnnotationView[];
  tokens: TokenView[];
  targets: string[];
  sourceFormats: string[];
  clientTargets: ClientTargetView[];
}

export interface NodeView {
  nodeKey: string;
  kind: string;
  name: string;
  address: string;
  options: Record<string, unknown>;
  sources: string[];
}

export interface DiagnosticView {
  stage: string;
  target: string | null;
  subject: string;
  reason: string;
}

export interface SourceStatView {
  id: string;
  enabled: boolean;
  format?: string;
  nodes: number;
  skipped: number;
  sample: string[];
  bytes?: number;
  diagnostics: DiagnosticView[];
}

export type OverlayMode = 'inherit' | 'replace' | 'merge';

export interface RuleConditionView {
  type: string;
  value?: string;
  noResolve?: boolean;
  children?: RuleConditionView[];
  child?: RuleConditionView;
}
export interface InlineRuleView {
  kind?: 'inline';
  condition: RuleConditionView;
  policy: string;
}
export interface ExternalRuleView {
  kind: 'external';
  url: string;
  policy: string;
  shape?: 'domain' | 'ipcidr' | 'rules';
  format?: 'text' | 'yaml';
}
export interface FinalRuleView {
  kind: 'final';
  policy: string;
}
export type RuleView = InlineRuleView | ExternalRuleView | FinalRuleView;
export interface GroupMemberView {
  kind: 'ref' | 'match' | 'region' | 'rest';
  name?: string;
  pattern?: string;
  code?: string;
}
export interface GroupView {
  name: string;
  members: Array<string | GroupMemberView>;
  order?: number;
  strategy?: 'select' | 'url-test' | 'fallback';
  testUrl?: string;
  interval?: number;
  tolerance?: number;
  lazy?: boolean;
  hidden?: boolean;
}
export interface PolicyGroupBaseView {
  name: string;
  members: string[];
  strategy?: 'select' | 'url-test' | 'fallback';
}
export interface TraceStepView {
  index: number;
  diff: { kind: string; ref: string; detail: string }[];
  diagnostics: DiagnosticView[];
  nodesBefore: number;
  nodesAfter: number;
}
export interface PreviewView {
  target: string;
  filename: string;
  content: string;
  trace: { steps: TraceStepView[] };
  report: { skipped: number; passed: number; diagnostics: DiagnosticView[] };
}
export interface EvidenceView {
  target: string;
  scope: string;
  subject: string;
  value: string;
  source: string;
  note: string;
}
export interface HistoryEntry {
  buildId: string;
  target: string;
  createdAt: string;
  skipped: number;
  passed: number;
}

/** 单次构建的完整回执：构建历史点进去看的就是这一份。 */
export interface BuildReportView {
  buildId: string;
  target: string;
  createdAt: string;
  report: { skipped: number; passed: number; diagnostics: DiagnosticView[] };
}

/** 删除源 / 组合订阅时一并回收的引用数。 */
export interface DetachView {
  collections: number;
  profiles: number;
  removedCollections?: string[];
}

export interface NotifyTestResultView {
  channel: string;
  ok: boolean;
  error: string | null;
}

export interface WebDavProbeView {
  ok: boolean;
  status: number;
  reason: string | null;
}

/** DNS / TUN：整份配置级的部署设置，与订阅内容无关。 */
export interface DnsPolicyView {
  mode: 'system' | 'fake-ip' | 'redir-host';
  nameserver?: string[];
  proxyNameserver?: string[];
  directNameserver?: string[];
  fallback?: string[];
  nameserverPolicy?: Record<string, string>;
  ecs?: string;
  fakeIpRange?: string;
  ipv6?: boolean;
}
export interface TunPolicyView {
  enabled: boolean;
  stack?: 'gvisor' | 'system' | 'mixed';
  strictRoute?: boolean;
  mtu?: number;
}
export interface RuntimePolicyView {
  dns?: DnsPolicyView;
  tun?: TunPolicyView;
}
/** 每个目标对 DNS / TUN 的能力（support / unverified / reject），用来在界面上直接说清「谁支持」。 */
export type RuntimeCapabilityView = Record<
  'dns' | 'tun' | 'fakeIp' | 'ecs' | 'enhancedMode',
  'support' | 'unverified' | 'reject'
>;
export interface RuntimeView {
  runtime: RuntimePolicyView | null;
  dnsMode?: OverlayMode;
  targets: Record<string, RuntimeCapabilityView>;
}

/** 通知渠道的界面配置：Telegram（成对）与 Bark（https url）二选一或都配。 */
export interface NotifyConfigView {
  /** 总开关：false = 暂停推送，但渠道配置仍然保留。缺省视为开启。 */
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  barkUrl?: string;
}

/** WebDAV 远端备份目标。username/password 成对出现。 */
export interface WebDavConfigView {
  url: string;
  username?: string;
  password?: string;
}

export interface SourceInput {
  kind: SourceKind;
  name?: string;
  url?: string;
  content?: string;
  format?: string;
  ua?: string;
  refreshPolicy?: string;
  proxy?: string;
}

let adminToken = sessionStorage.getItem('startrails_admin') ?? '';

export const getToken = (): string => adminToken;
export const setToken = (value: string): void => {
  adminToken = value;
  sessionStorage.setItem('startrails_admin', value);
};

/**
 * 401 的唯一出口。令牌失效（重启换密钥 / 在别处轮换 / 过期）后必须把界面打回登录页，
 * 否则每个动作都只弹一句「管理令牌无效」，用户还得自己猜要刷新页面。
 */
let unauthorizedHandler: (() => void) | null = null;
export const setUnauthorizedHandler = (handler: () => void): void => {
  unauthorizedHandler = handler;
};

/** 统一的请求发送：补鉴权头、统一处理 401（令牌失效 → 打回登录页）。 */
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (adminToken.length > 0) headers.authorization = `Bearer ${adminToken}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...init, headers });
  // 登录/初始化端点自己处理 401（那本来就是「令牌不对」的正常回执），不触发登出。
  if (response.status === 401 && !path.startsWith('/api/setup')) unauthorizedHandler?.();
  return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init);
  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = await response.text();
    }
    throw new Error(`${response.status} ${response.statusText} · ${detail.slice(0, 220)}`);
  }
  return (await response.json()) as T;
}

/**
 * 「结果本身带失败原因」的端点专用：测试发送失败是**数据**不是传输错误，
 * 后端把 channels 级原因放在 body 里回 502，这里照常解析，不抛成一句裸 status。
 */
async function requestSoft<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init);
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

/**
 * 当前活动的 Profile 名。服务端按 name（不是 id）解析，且订阅 token 绑定同一个 name，
 * 因此这里不能写死 'default'：库里没有该名字时所有请求都会 404。
 */
let activeProfile = 'default';

export const setActiveProfile = (name: string): void => {
  activeProfile = name;
};

export const getActiveProfile = (): string => activeProfile;

/**
 * 排除 / 规则 / 策略组 / DNS 都按配置存，这些读写必须带上「哪一份」。
 * 缺省用当前活动的 Profile：漏传的调用点会落到当前配置，而不是悄悄写到 default 上。
 */
const withProfile = (path: string, profile: string): string =>
  `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`;

export const api = {
  /** 匿名端点：服务端尚未设置管理令牌时返回 required=true，登录页据此切换为初始化形态。 */
  setupStatus: () =>
    request<{ required: boolean; secretRequired: boolean }>('/api/setup/status'),
  setup: (body: { token?: string; secret?: string }) => post<{ ok: boolean }>('/api/setup', body),
  health: () => request<{ ok: boolean; version: string; coreVersion: string }>('/health'),
  state: (profile = activeProfile) => request<StateView>(withProfile('/api/state', profile)),
  nodes: (profile = activeProfile) =>
    request<{ nodes: NodeView[]; diagnostics: DiagnosticView[]; configVersion: string }>(
      `/api/nodes?profile=${encodeURIComponent(profile)}`,
    ),
  preview: (target: string, profile = activeProfile) =>
    request<PreviewView>(
      `/api/preview?target=${encodeURIComponent(target)}&profile=${encodeURIComponent(profile)}`,
    ),
  capabilities: () => request<{ evidence: EvidenceView[] }>('/api/capabilities'),
  diagnostics: () => request<{ reports: HistoryEntry[] }>('/api/diagnostics'),
  rules: (profile = activeProfile) =>
    request<{ rules: RuleView[]; mode: OverlayMode; placement: 'before' | 'after' }>(
      withProfile('/api/rules', profile),
    ),
  saveRules: (
    body: { rules: RuleView[]; mode: OverlayMode; placement: 'before' | 'after' },
    profile = activeProfile,
  ) => post<{ count: number }>(withProfile('/api/rules', profile), body),
  policyGroups: (profile = activeProfile) =>
    request<{ mode: OverlayMode; groups: GroupView[]; base: PolicyGroupBaseView[] }>(
      withProfile('/api/policy-groups', profile),
    ),
  savePolicyGroups: (body: { mode: OverlayMode; groups: GroupView[] }, profile = activeProfile) =>
    post<{ count: number }>(withProfile('/api/policy-groups', profile), body),
  trace: (profile = activeProfile) =>
    request<{ configVersion: string; steps: TraceStepView[] }>(
      `/api/trace?profile=${encodeURIComponent(profile)}`,
    ),

  inspectSources: () => request<{ sources: SourceStatView[] }>('/api/sources/inspect'),
  addSource: (body: SourceInput & { profile?: string }) =>
    post<{ id: string; name: string; kind: SourceKind; url: string | null; attached: boolean }>(
      '/api/sources',
      body,
    ),
  /** 单个源详情：含文件 / 粘贴源的正文（远端源 content 为 null）。 */
  sourceDetail: (id: string) =>
    request<{ source: SourceView; content: string | null }>(`/api/sources/${encodeURIComponent(id)}`),
  updateSource: (id: string, body: Partial<SourceInput> & { enabled?: boolean }) =>
    request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** 真去上游拉一次（ETag 复用），与 inspect 的「解析检查」是两件事。 */
  refreshSource: (id: string) =>
    request<{ refreshed: number; failed: number; lastError: string | null; lastFetchedAt: string | null }>(
      `/api/sources/${encodeURIComponent(id)}/refresh`,
      { method: 'POST', body: '{}' },
    ),
  /** 手动触发全部「启用中的远端源」刷新，不受 refreshPolicy 限制。 */
  refreshRemote: () =>
    request<{ refreshed: number; failed: number }>('/api/refresh', { method: 'POST', body: '{}' }),
  /** 运维能力状态：通知渠道、WebDAV 备份、调度器粒度。 */
  ops: () =>
    request<{
      notify: { enabled: boolean; channels: string[] };
      webdav: { configured: boolean };
      scheduler: { intervalMs: number };
    }>('/api/ops'),
  /** 通知渠道设置（界面可覆盖环境变量默认值）。 */
  notifySettings: () =>
    request<{
      value: NotifyConfigView | null;
      envDefaults: { telegram?: { botToken: string; chatId: string }; bark?: { url: string } } | null;
      effective: { enabled?: boolean; telegram?: { botToken: string; chatId: string }; bark?: { url: string } } | null;
    }>('/api/settings/notify'),
  saveNotify: (notify: NotifyConfigView | null) =>
    request<{ ok: boolean; value: unknown }>('/api/settings/notify', {
      method: 'PUT',
      body: JSON.stringify({ notify }),
    }),
  /** WebDAV 远端备份设置（界面可覆盖环境变量默认值）。 */
  webdavSettings: () =>
    request<{
      /** 界面覆盖值；密码不回传明文，用 hasPassword 表示是否已设。 */
      value: { url: string; username?: string; hasPassword: boolean } | null;
      envDefaults: { url: string; hasPassword: boolean } | null;
      effective: { url: string; hasCredentials: boolean } | null;
    }>('/api/settings/webdav'),
  saveWebdav: (webdav: WebDavConfigView | null) =>
    request<{ ok: boolean; webdav: unknown }>('/api/settings/webdav', {
      method: 'PUT',
      body: JSON.stringify({ webdav }),
    }),
  backupRemote: () =>
    request<{ ok: boolean; remoteUrl: string; bytes: number; local: string }>('/api/backup/remote', {
      method: 'POST',
      body: '{}',
    }),
  /** TCP 握手延迟探测；明确不是代理链路测速。 */
  probe: (profile?: string) =>
    request<{
      note: string;
      samples: {
        nodeKey: string;
        name: string;
        server: string;
        port: number;
        latencyMs: number | null;
        error: string | null;
        /** 目标解析到非公网地址（内网 / TUN 假 IP），此时延迟不代表节点质量。 */
        intercepted: boolean;
      }[];
    }>('/api/probe', {
      method: 'POST',
      body: JSON.stringify({ ...(profile === undefined ? {} : { profile }) }),
    }),
  removeSource: (id: string) =>
    request<{ ok: boolean; detached: DetachView }>(`/api/sources/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  collections: () => request<{ collections: CollectionView[] }>('/api/collections'),
  saveCollection: (body: {
    id?: string;
    name: string;
    members: CollectionMemberView[];
    dedupe: DedupeView;
  }) => post<{ id: string }>('/api/collections', body),
  removeCollection: (id: string) =>
    request<{ ok: boolean; detached: { profiles: number } }>(
      `/api/collections/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  saveProfile: (entries: ProfileEntryView[], profile = activeProfile) =>
    post<{ name: string; id: string; created: boolean }>('/api/profiles', {
      id: profile,
      name: profile,
      entries,
    }),
  /** 新建 Profile：带一个可控名字、内容为空，随后由构成卡片往里加来源。 */
  createProfile: (name: string) =>
    post<{ name: string; id: string; created: boolean }>('/api/profiles', {
      id: name,
      name,
      entries: [],
    }),
  removeProfile: (name: string) =>
    request<{
      ok: boolean;
      /** 随删除一并回收的配置级数据：与删源 / 删组合的 detached 口径一致。 */
      detached: { rules: number; annotations: number; groupOverrides: number };
      /** 因此失效的订阅地址条数。 */
      revoked: number;
    }>(`/api/profiles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  /** 轮换管理令牌；环境变量提供令牌时后端会拒绝（409 admin-token-from-env）。 */
  rotateAdminToken: (token: string) => post<{ ok: boolean }>('/api/admin/token', { token }),
  testNotify: (notify?: NotifyConfigView | null) =>
    requestSoft<{ ok?: boolean; results?: NotifyTestResultView[]; error?: string; hint?: string }>(
      '/api/settings/notify/test',
      { method: 'POST', body: JSON.stringify({ notify: notify ?? null }) },
    ),
  testWebdav: (webdav?: WebDavConfigView | null) =>
    requestSoft<WebDavProbeView & { error?: string; hint?: string }>('/api/settings/webdav/test', {
      method: 'POST',
      body: JSON.stringify({ webdav: webdav ?? null }),
    }),
  /** 单次构建回执（构建历史 / 诊断详情）。 */
  buildReport: (buildId: string) =>
    request<BuildReportView>(`/api/diagnostics?buildId=${encodeURIComponent(buildId)}`),
  saveAnnotation: (annotation: AnnotationView, profile = activeProfile) =>
    post<{ ok: boolean }>(withProfile('/api/annotations', profile), annotation),
  /** 重新签发旧地址时要指定它原本所属的 Profile，不能跟着当前上下文漂。 */
  createToken: (target: string, profile: string = activeProfile) =>
    post<{ id: string; url: string; token: string }>('/api/tokens', { profile, target }),
  /** DNS / TUN：跟着配置走，改了只换那一份的 configVersion 与 ETag。 */
  runtime: (profile = activeProfile) => request<RuntimeView>(withProfile('/api/runtime', profile)),
  saveRuntime: (
    runtime: RuntimePolicyView | null,
    profile = activeProfile,
    dnsMode?: OverlayMode,
  ) =>
    request<{ ok: boolean; runtime: RuntimePolicyView | null }>(withProfile('/api/runtime', profile), {
      method: 'PUT',
      body: JSON.stringify({ runtime, ...(dnsMode === undefined ? {} : { dnsMode }) }),
    }),
  revokeToken: (id: string) =>
    request<{ ok: boolean }>(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refresh: () => post<{ ok: boolean }>('/api/refresh', {}),
  backup: () => post<{ destination: string }>('/api/backup', {}),
};
