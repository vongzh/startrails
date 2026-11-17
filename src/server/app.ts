import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, validateHeaderName, validateHeaderValue } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, extname, join, resolve, sep } from 'node:path';
import {
  CLIENT_TARGETS,
  CAPABILITY_EVIDENCE,
  CORE_VERSION,
  SOURCE_FORMATS,
  TARGETS,
  applyMemberFilter,
  applyAnnotations,
  applyNodeTransforms,
  composeCollection,
  dedupeNodes,
  describeRuleSet,
  ingest,
  nodeKey,
  parseNodeTransforms,
  parseProfile,
  parseRuntime,
  renderQrSvg,
  traceProcessors,
  verifiedCapabilityTables,
} from '../core/index.ts';
import type {
  ClientTarget,
  CollectionMember,
  Diagnostic,
  InlineRule,
  MemberFilter,
  PolicyGroup,
  Process,
  RuntimePolicy,
  ProcessChange,
  ProcessTrace,
  Profile,
  ProxyNode,
  RuleSource,
  SourceFormat,
} from '../core/index.ts';
import { buildOne, outputFilename } from '../pipeline.ts';
import type { BuildOutput } from '../pipeline.ts';
import { hashToken, newToken, safeEqual, sha256 } from '../store/crypto.ts';
import type {
  OverlayMode,
  PersistedCollection,
  PersistedGroupOverride,
  PersistedProfile,
  PersistedSource,
  Store,
  StoredMember,
  StoredRule,
} from '../store/port.ts';
import { alignInheritedMembers, applyDnsOverlay, applyGroupOverlay, applyRuleOverlay, effectiveModes } from './section-overlay.ts';
import { SnapshotCache } from './cache.ts';
import { dueSourceIds, parseRefreshPolicy } from './schedule.ts';
import { BuildCache } from './build-cache.ts';
import { hasRedactionMarkers, redact, redactDiagnostic } from './redact.ts';
import { assertPublicUrl, fetchSnapshot } from './url-guard.ts';
import { parseProxyUrl } from './proxy-fetch.ts';
import { createNotifier, sendTestNotify } from './notify.ts';
import type { NotifyConfig } from './notify.ts';
import { parseWebDavUrl, probeWebDav, uploadToWebDav } from './backup.ts';
import type { WebDavConfig } from './backup.ts';
import { probeAll } from './probe.ts';
import { RuleSetCache } from './ruleset.ts';
import type { ProbeTarget } from './probe.ts';
import {
  MIN_TOKEN_SECRET_LENGTH,
  commitSecretFile,
  discardSecretFile,
  stageSecretFile,
} from './secret.ts';

export interface AppOptions {
  readonly store: Store;
  /**
   * 环境变量注入的管理令牌，优先级最高。不传 / 空字符串 = 未配置：
   * 回退到数据库里首次设置时落下的哈希；两者都没有则开放一次性设置端点。
   */
  readonly adminToken?: string;
  readonly cacheDir: string;
  readonly dataDir: string;
  readonly webRoot?: string;
  readonly allowPrivate?: boolean;
  /**
   * 数据加密密钥是否已配置（环境变量或 `<data>/secret.key`）。false = 本次启动使用临时密钥，
   * 所有管理写入在 UI 设置密钥前都会被拒绝。
   */
  readonly secretConfigured?: boolean;
  /** UI 首次设置的密钥落盘路径；未提供时只允许由环境变量 / 既有文件提供密钥。 */
  readonly secretFile?: string;
  /** 运维通知（Telegram / Bark）；未配置时全部 send 走空实现。 */
  readonly notify?: NotifyConfig;
  /** WebDAV 远端备份目标；未配置时 /api/backup/remote 回 501。 */
  readonly webdav?: WebDavConfig;
  /**
   * 对外可达的基地址（例如 https://sub.example.com）。配置后外部规则集会改写成镜像地址
   * `${publicBaseUrl}/rules/<key>`；不配则保持原始 URL，镜像功能整块不启用。
   */
  readonly publicBaseUrl?: string;
  /**
   * 无状态一次性转换 `GET /sub?url=&target=` 是否开放。**默认关闭**：
   * 它等价于「让匿名请求用服务器身份去拉任意公网 URL 再原样吐回」，
   * 在没配 allowPrivate 的环境里也依然是一个可被滥用的出口。开启需要在部署侧显式表态。
   */
  readonly allowStateless?: boolean;
}

export interface App {
  readonly server: Server;
  readonly close: () => Promise<void>;
  /** 立即跑一轮「到期源刷新」，供测试与手动触发用；调度器内部也走这里。 */
  readonly refreshDue: () => Promise<{ refreshed: number; failed: number }>;
}

interface Snapshot {
  readonly id: string;
  readonly body: string;
}
interface PreparedState {
  readonly profileName: string;
  readonly snapshots: readonly Snapshot[];
  readonly etag: string;
  readonly irKey: string;
  readonly configVersion: string;
  readonly diagnostics: readonly Diagnostic[];
}
interface TraceStepView {
  readonly index: number;
  readonly diff: readonly ProcessChange[];
  readonly diagnostics: readonly Diagnostic[];
  readonly nodesBefore: number;
  readonly nodesAfter: number;
}
interface TraceView {
  readonly steps: readonly TraceStepView[];
}
interface BuiltState {
  readonly output: BuildOutput;
  /** 实际参与构建的 IR：延迟探测等旁路操作要按「客户端看到的同一份节点集合」来算。 */
  readonly profile: Profile;
  readonly buildId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly trace: TraceView;
}
/** Profile 的一项展开结果：源直接透传，组合订阅走成员合并；缺失的引用只记诊断。 */
type Segment =
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'collection'; readonly collection: PersistedCollection }
  | { readonly kind: 'missing'; readonly id: string; readonly ref: string };

const CONTENT_TYPE_BY_FORMAT: Readonly<Record<'ini' | 'yaml' | 'json' | 'uri', string>> = {
  ini: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  uri: 'text/plain; charset=utf-8',
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** app_setting 里实例级设置的行键。字符串常量集中一处，避免读写两处拼错。 */
const SETTING_NOTIFY = 'notify';
const SETTING_WEBDAV = 'webdav';
/** 实例级拉取默认：UA / 代理 / 附加请求头，源级配置缺省时回退到这里。 */
const SETTING_FETCH_DEFAULTS = 'fetch.defaults';

/**
 * app_setting 里管理面令牌的哈希键。只存 hash，明文不落库（备份 .db 时不带明文凭据）。
 * 导出给服务入口判断「是否已完成首次设置」。
 */
export const ADMIN_TOKEN_SETTING_KEY = 'admin.token.hash';
/** 只挡空值与明显误填，不替用户做口令强度策略。 */
const MIN_ADMIN_TOKEN_LENGTH = 8;

/** 文件订阅通常是几百 KB 的 YAML / base64，1MB 不够；8MB 覆盖绝大多数订阅。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 调度器轮询粒度：到期判定按 lastFetchedAt 算，轮询只决定「多久检查一次」。 */
const SCHEDULER_INTERVAL_MS = 60_000;

/** 一个链接喂所有客户端：按 UA 猜不出时明确拒绝，不静默给错格式。 */
const UA_TARGETS: readonly { readonly pattern: RegExp; readonly target: ClientTarget }[] = [
  { pattern: /surge/i, target: 'surge' },
  { pattern: /quantumult/i, target: 'quanx' },
  { pattern: /loon/i, target: 'loon' },
  { pattern: /shadowrocket/i, target: 'shadowrocket' },
  { pattern: /stash/i, target: 'clash' },
  { pattern: /egern/i, target: 'egern' },
  { pattern: /sing-box|sfa|sfi|sfm/i, target: 'sing-box' },
  { pattern: /hiddify/i, target: 'hiddify' },
  { pattern: /karing/i, target: 'karing' },
  { pattern: /flclash/i, target: 'flclash' },
  { pattern: /clash|mihomo|verge/i, target: 'mihomo' },
];

/** 可预期的请求错误：外层统一转成 4xx，而不是把解析失败当成服务端 500。 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 所有响应都带的最小安全头；不引入 CSP，避免误伤现有界面与内联样式。 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

const send = (
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
};

/** If-None-Match 允许 `*`、逗号分隔与弱校验；只比字符串会让合法的条件请求全部落空。 */
const ifNoneMatch = (header: string | undefined, etag: string): boolean => {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === `W/${etag}` || value.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request-body-too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid-json-body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body-must-be-object');
  }
  return parsed as Record<string, unknown>;
};

const isTarget = (value: string): value is ClientTarget =>
  (CLIENT_TARGETS as readonly string[]).includes(value);

const isSourceFormat = (value: string): value is SourceFormat =>
  (SOURCE_FORMATS as readonly string[]).includes(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * 陈旧程度的紧凑写法（`45s` / `12m` / `2h05m` / `3d4h`）。
 * 只保留两级单位：诊断与通知里要扫读，`2h05m` 比 `7380 秒` 有用得多。
 */
export const describeAge = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
};

/**
 * 源级代理的入参解释：`null` / 空串表示「清除」，缺省表示「本次不改」，
 * 非法（协议不支持、缺 host:port）返回 ok:false 由调用方回 400——不能静默存一个永远连不上的字符串。
 */
const proxyFrom = (raw: unknown): { readonly ok: boolean; readonly value?: string } => {
  if (raw === null || raw === undefined) return { ok: true };
  if (typeof raw !== 'string') return { ok: false };
  const text = raw.trim();
  if (text.length === 0) return { ok: true };
  return parseProxyUrl(text) === null ? { ok: false } : { ok: true, value: text };
};

/**
 * 加工算子链的入参校验。这里刻意做得「宽进严出」：
 * 认不出的步骤直接丢掉（并在下一层留下可解释的行为），而不是整份组合订阅存不进去——
 * 一个拼错的算子不该让用户丢掉别的配置。
 */
const parseProcesses = (raw: unknown): Process[] => {
  if (!Array.isArray(raw)) return [];
  const steps: Process[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const type = asString(record['type']);
    if (type === 'filter') {
      const by = asString(record['by']);
      if (by !== 'regex' && by !== 'region' && by !== 'type' && by !== 'useless') continue;
      const value = asStringArray(record['value']);
      steps.push({
        type: 'filter',
        by,
        keep: record['keep'] !== false,
        ...(value.length === 0 ? {} : { value }),
      });
      continue;
    }
    if (type === 'rename') {
      const template = asString(record['template']);
      if (template !== undefined) steps.push({ type: 'rename', template });
      continue;
    }
    if (type === 'prefix') {
      const value = asString(record['value']);
      if (value !== undefined) steps.push({ type: 'prefix', value });
      continue;
    }
    if (type === 'sort') {
      const by = asString(record['by']);
      if (by !== 'name' && by !== 'region' && by !== 'kind') continue;
      steps.push({ type: 'sort', by, order: record['order'] === 'desc' ? 'desc' : 'asc' });
      continue;
    }
    if (type === 'dedupe') {
      const strategy = asString(record['strategy']);
      if (strategy !== 'nodeKey' && strategy !== 'name' && strategy !== 'none') continue;
      steps.push({ type: 'dedupe', strategy });
      continue;
    }
    if (type === 'limit') {
      const count = record['count'];
      if (typeof count !== 'number' || count <= 0) continue;
      steps.push({ type: 'limit', count: Math.floor(count) });
    }
  }
  return steps;
};

/** 成员过滤的解析：只保留真正给值的字段，避免把 undefined 写进 IR。 */
const buildFilter = (raw: Record<string, unknown>): MemberFilter | undefined => {
  const entries: [string, unknown][] = [];
  if (typeof raw['enabled'] === 'boolean') entries.push(['enabled', raw['enabled']]);
  // 有算子链就只认链：两套字段同时存在时行为必须唯一，不能「链跑完再跑旧字段」。
  const steps = parseProcesses(raw['process']);
  if (steps.length > 0) {
    entries.push(['process', steps]);
    return Object.fromEntries(entries) as unknown as MemberFilter;
  }
  const prefix = asString(raw['prefix']);
  if (prefix !== undefined) entries.push(['prefix', prefix]);
  const include = asStringArray(raw['include']);
  if (include.length > 0) entries.push(['include', include]);
  const exclude = asStringArray(raw['exclude']);
  if (exclude.length > 0) entries.push(['exclude', exclude]);
  const limit = typeof raw['limit'] === 'number' && raw['limit'] > 0 ? Math.floor(raw['limit']) : undefined;
  if (limit !== undefined) entries.push(['limit', limit]);
  const rename = asString(raw['rename']);
  if (rename !== undefined) entries.push(['rename', rename]);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as MemberFilter;
};

/**
 * 通知配置解析：只认 Telegram（botToken+chatId 成对）与 Bark（合法 https url），
 * 两者至少一个；多余字段丢弃。解析失败返回 null。
 * `enabled` 是总开关：false 时不推送但保留渠道配置，所以它要和渠道一起落库。
 */
const parseNotifyConfig = (raw: unknown): NotifyConfig | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const enabledRaw = record['enabled'];
  const paused = enabledRaw === false;
  const tgToken = asString(record['botToken']);
  const tgChat = asString(record['chatId']);
  const telegram =
    tgToken !== undefined && tgToken.length > 0 && tgChat !== undefined && tgChat.length > 0
      ? { botToken: tgToken, chatId: tgChat }
      : undefined;
  let bark: { readonly url: string } | undefined;
  const barkUrl = asString(record['barkUrl']);
  if (barkUrl !== undefined && barkUrl.length > 0) {
    try {
      const url = new URL(barkUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') bark = { url: barkUrl };
    } catch {
      // 非法 Bark 地址：忽略，不因为一个坏字段拒绝整份配置。
    }
  }
  if (telegram === undefined && bark === undefined) return null;
  return {
    ...(paused ? { enabled: false } : {}),
    ...(telegram === undefined ? {} : { telegram }),
    ...(bark === undefined ? {} : { bark }),
  };
};

/**
 * 落库是嵌套结构（`telegram` / `bark` 各自成对象），界面用的是扁平字段。
 * 读接口必须摊平回扁平形态，否则「保存 → 切走 → 切回来」表单读到的是 undefined，
 * 全空表单再点保存就会把刚配好的渠道清掉。
 */
const notifyViewOf = (config: NotifyConfig | null): Record<string, unknown> | null => {
  if (config === null) return null;
  return {
    enabled: config.enabled !== false,
    ...(config.telegram === undefined
      ? {}
      : { botToken: config.telegram.botToken, chatId: config.telegram.chatId }),
    ...(config.bark === undefined ? {} : { barkUrl: config.bark.url }),
  };
};

/**
 * WebDAV 配置解析：url 必填且为 http/https；username/password 成对出现才认（避免只存一半）。
 * `inheritPasswordFrom`：当本次未提交密码时，继承旧配置里已有的密码（界面密码框留空=保持原密码）。
 */
const parseWebdavConfig = (raw: unknown, inheritPasswordFrom?: WebDavConfig): WebDavConfig | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const url = asString(record['url']);
  if (url === undefined || parseWebDavUrl(url) === null) return null;
  const username = asString(record['username']);
  const password = asString(record['password']);
  const hasUser = username !== undefined && username.length > 0;
  const hasPass = password !== undefined && password.length > 0;
  // 本次只给了账号没给密码：尝试继承旧密码。
  const effectivePassword = hasPass
    ? (password as string)
    : hasUser && inheritPasswordFrom?.password !== undefined
      ? inheritPasswordFrom.password
      : undefined;
  if (hasUser && effectivePassword === undefined) return null; // 账号密码必须成对
  return {
    url,
    ...(hasUser ? { username: username as string, password: effectivePassword as string } : {}),
  };
};

/**
 * 实例级拉取默认。影响「怎么取回上游正文」，不进产物语义，因此按实例存而非按配置存。
 * 字段与源级同名：ua / proxy 可直接回退；headers 是新增的任意请求头（如鉴权头）。
 */
interface FetchDefaults {
  readonly ua?: string;
  readonly proxy?: string;
  readonly headers: Readonly<Record<string, string>>;
}

const EMPTY_FETCH_DEFAULTS: FetchDefaults = { headers: {} };
/** header 值绝不回传明文：一律回这个掩码，提交时识别为「未改、沿用旧值」。 */
const FETCH_HEADER_MASK = '••••••';
/**
 * 受控头：由系统另行维护（UA 走 options.ua、缓存协商走 If-None-Match），
 * 不允许从「附加请求头」入口注入——否则会静默覆盖掉 UA 下拉里选的值，
 * 两个配置入口写同一个 HTTP 头，语义打架。大小写不敏感比对。
 */
const RESERVED_HEADER_NAMES = new Set([
  'user-agent',
  'if-none-match',
  'host',
  'content-length',
  'content-type',
  'accept-encoding',
  'connection',
  'transfer-encoding',
]);

/**
 * 解析界面提交的拉取默认。非法项就地丢弃而不是整份拒绝：一个写错的 header 名
 * 不该让已经配好的 UA / 代理全部失效。代理走 parseProxyUrl 校验，header 名值走
 * node:http 的校验器（与 url-guard / proxy-fetch 同一口径）。
 * `inheritFrom`：header 值回显时是脱敏的，原样提交时从旧配置继承原值（同 WebDAV 密码）。
 */
const parseFetchDefaults = (raw: unknown, inheritFrom?: FetchDefaults): FetchDefaults | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const ua = asString(record['ua']);
  const proxyText = asString(record['proxy']);
  const proxy = proxyText !== undefined && parseProxyUrl(proxyText) !== null ? proxyText : undefined;

  const headers: Record<string, string> = {};
  const rawHeaders = record['headers'];
  // 两种形态都要认：UI 提交的是 [{name,value}] 数组，落库的是 {name:value} 对象。
  const pairs: Array<{ name: string; value: string }> = [];
  if (Array.isArray(rawHeaders)) {
    for (const item of rawHeaders) {
      if (typeof item !== 'object' || item === null) continue;
      const pair = item as Record<string, unknown>;
      const name = asString(pair['name']);
      const value = asString(pair['value']);
      if (name !== undefined && value !== undefined) pairs.push({ name, value });
    }
  } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string' && value.trim().length > 0) pairs.push({ name, value: value.trim() });
    }
  }
  for (const { name, value: submitted } of pairs) {
    if (hasRedactionMarkers(name)) continue;
    // 受控头由系统维护，从「附加请求头」注入会覆盖 UA / 缓存协商，直接拒收。
    if (RESERVED_HEADER_NAMES.has(name.trim().toLowerCase())) continue;
    // 掩码 / 脱敏痕迹 = 界面没改这一项，沿用旧值（header 值不回传明文，回显的是掩码）。
    const unchanged = submitted === FETCH_HEADER_MASK || hasRedactionMarkers(submitted);
    const value = unchanged ? inheritFrom?.headers[name] : submitted;
    if (value === undefined) continue;
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      continue;
    }
    headers[name] = value;
  }
  return {
    ...(ua === undefined ? {} : { ua }),
    ...(proxy === undefined ? {} : { proxy }),
    headers,
  };
};

/** 读取实例级拉取默认；库里没有或坏 JSON 时用空默认（= 等价未配置）。 */
const fetchDefaults = (store: Store): FetchDefaults => {
  const raw = store.getSetting(SETTING_FETCH_DEFAULTS);
  if (raw === undefined) return EMPTY_FETCH_DEFAULTS;
  try {
    return parseFetchDefaults(JSON.parse(raw)) ?? EMPTY_FETCH_DEFAULTS;
  } catch {
    return EMPTY_FETCH_DEFAULTS;
  }
};

/**
 * 回显给界面的拉取默认：header 值可能含 token/password，一律脱敏后返回掩码。
 * 前端凭「值是否为掩码」判断该项是否已配置（与 WebDAV 密码同构），不额外传布尔。
 */
const fetchDefaultsView = (config: FetchDefaults) => ({
  ua: config.ua ?? null,
  proxy: config.proxy ?? null,
  headers: Object.entries(config.headers).map(([name]) => ({
    name,
    value: FETCH_HEADER_MASK,
  })),
});

function asOverlayMode(value: unknown): OverlayMode | undefined {
  return value === 'inherit' || value === 'replace' || value === 'merge' ? value : undefined;
}

function parseStoredRules(rules: readonly unknown[]): StoredRule[] | null {
  const parsed: StoredRule[] = [];
  for (const entry of rules) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (record['kind'] === 'final') {
      if (typeof record['policy'] !== 'string' || record['policy'].trim().length === 0) return null;
      parsed.push({ kind: 'final', policy: record['policy'].trim() });
      continue;
    }
    if (record['kind'] === 'external') {
      const url = record['url'];
      const policy = record['policy'];
      if (typeof url !== 'string' || url.trim().length === 0) return null;
      if (typeof policy !== 'string' || policy.trim().length === 0) return null;
      const shape = record['shape'];
      const format = record['format'];
      parsed.push({
        kind: 'external',
        url: url.trim(),
        policy: policy.trim(),
        ...(shape === 'domain' || shape === 'ipcidr' || shape === 'rules' ? { shape } : {}),
        ...(format === 'text' || format === 'yaml' ? { format } : {}),
      });
      continue;
    }
    let inline: InlineRule;
    try {
      const profile = parseProfile({
        nodes: [],
        ruleSources: [{ kind: 'inline', rules: [record] }],
        policyGroups: [],
      });
      const source = profile.ruleSources[0];
      if (source === undefined || source.kind !== 'inline' || source.rules[0] === undefined) return null;
      inline = source.rules[0];
    } catch {
      return null;
    }
    parsed.push(inline);
  }
  return parsed;
}

function parseStoredMember(value: unknown): StoredMember | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'ref' && typeof record['name'] === 'string' && record['name'].trim().length > 0) {
    return { kind: 'ref', name: record['name'].trim() };
  }
  if (record['kind'] === 'match' && typeof record['pattern'] === 'string' && record['pattern'].trim().length > 0) {
    return { kind: 'match', pattern: record['pattern'].trim() };
  }
  if (record['kind'] === 'region' && typeof record['code'] === 'string' && record['code'].trim().length > 0) {
    return { kind: 'region', code: record['code'].trim() };
  }
  if (record['kind'] === 'rest') return { kind: 'rest' };
  return undefined;
}

function parseStoredGroups(groups: readonly unknown[]): PersistedGroupOverride[] {
  const parsed: PersistedGroupOverride[] = [];
  for (const entry of groups) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || name.trim().length === 0 || !Array.isArray(record['members'])) continue;
    const members = record['members'].map(parseStoredMember).filter((member): member is StoredMember => member !== undefined);
    const strategy = record['strategy'];
    const testUrl = record['testUrl'];
    parsed.push({
      name: name.trim(),
      members,
      order: parsed.length,
      ...(strategy === 'select' || strategy === 'url-test' || strategy === 'fallback' ? { strategy } : {}),
      ...(typeof testUrl === 'string' && testUrl.trim().length > 0 ? { testUrl: testUrl.trim() } : {}),
      ...(typeof record['interval'] === 'number' ? { interval: record['interval'] } : {}),
      ...(typeof record['tolerance'] === 'number' ? { tolerance: record['tolerance'] } : {}),
      ...(record['lazy'] === true ? { lazy: true } : {}),
      ...(record['hidden'] === true ? { hidden: true } : {}),
    });
  }
  return parsed;
}

export function createApp(options: AppOptions): App {
  const { store } = options;
  const cache = new SnapshotCache(options.cacheDir);
  const buildCache = new BuildCache();

  /**
   * 管理面令牌优先级：环境变量 > 数据库哈希 > 首次设置。每次请求实时求值，
   * 首次设置写入后立即生效、不必重启；环境变量存在时数据库值始终不生效。
   */
  const envToken = options.adminToken?.trim() ?? '';
  const envTokenHash = envToken.length > 0 ? hashToken(envToken) : undefined;
  const activeAdminHash = (): string | undefined => {
    const hash = envTokenHash ?? store.getSetting(ADMIN_TOKEN_SETTING_KEY);
    return hash === undefined || hash.length === 0 ? undefined : hash;
  };
  const setupRequired = (): boolean => activeAdminHash() === undefined;

  /**
   * 加密密钥是否已配置。false 时启动用的是临时密钥：所有管理面请求（除初始化端点）
   * 一律 503，避免用户把正文写进一个重启后必然解不开的库。
   */
  let secretConfigured = options.secretConfigured !== false;
  const secretFile = options.secretFile;
  const secretSetupRequired = (): boolean => !secretConfigured;

  /**
   * 通知渠道：环境变量只作「部署默认值」，界面配过之后存 app_setting 覆盖之。
   * 优先级：存库配置 > 环境变量 > 未配置。notifier 每次发送前实时求值，界面改完无需重启即生效。
   */
  const notifyConfig = (): NotifyConfig | undefined => {
    const raw = store.getSetting(SETTING_NOTIFY);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as NotifyConfig;
        if (parsed.telegram !== undefined || parsed.bark !== undefined) return parsed;
      } catch {
        // 坏 JSON 按「没有界面覆盖」处理，回退环境变量。
      }
    }
    return options.notify;
  };
  const notifier = createNotifier(notifyConfig);

  /**
   * WebDAV 远端备份目标：环境变量为默认值，界面配过后存 app_setting 覆盖。
   * 同样实时求值，界面保存后「上传备份」立即可用。
   */
  const webdavConfig = (): WebDavConfig | undefined => {
    const raw = store.getSetting(SETTING_WEBDAV);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as WebDavConfig;
        if (parseWebDavUrl(parsed.url) !== null) return parsed;
      } catch {
        // 坏 JSON 回退环境变量。
      }
    }
    return options.webdav;
  };

  const ruleSets = new RuleSetCache(
    join(options.dataDir, 'cache', 'rulesets'),
    undefined,
    options.allowPrivate ?? false,
  );

  /**
   * 配置指纹里必须剔除「运行态」字段（最近拉取时间 / 错误 / 流量信息 / 上游建议间隔）。
   * 否则每拉一次上游就换一次版本号 → ETag 永远对不上，L2/L3 缓存全部失效。
   */
  const stripRuntime = (source: PersistedSource): Omit<PersistedSource, 'lastFetchedAt' | 'lastError' | 'userinfo' | 'suggestedRefreshHours'> => {
    const { lastFetchedAt, lastError, userinfo, suggestedRefreshHours, ...definition } = source;
    void lastFetchedAt;
    void lastError;
    void userinfo;
    void suggestedRefreshHours;
    return definition;
  };

  /**
   * 指纹按配置算，不按实例算：改 A 的排除、规则或 DNS，不该让 B 的客户端判定产物过期而重新拉。
   * 源与组合订阅也只统计这份配置实际引用的闭包（直接引用的源 + 引用组合的成员源）——
   * 改一个没被任何配置引用的源，谁的产物都不该换版本。
   */
  const configVersion = (profileId: string): string => {
    const definition = store.listProfiles().find((item) => item.id === profileId) ?? null;
    const collections = store.listCollections();
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const sources = new Map(store.listSources().map((source) => [source.id, source]));
    const referencedCollections = new Set<string>();
    const referencedSources = new Set<string>();
    for (const entry of definition?.entries ?? []) {
      if (entry.kind === 'collection') {
        referencedCollections.add(entry.id);
        for (const member of collectionById.get(entry.id)?.members ?? []) referencedSources.add(member.sourceId);
      } else {
        referencedSources.add(entry.id);
      }
    }
    return sha256(
      JSON.stringify({
        // Set 按插入序遍历（entries 顺序 + 组合成员顺序），同一份库数据算出的指纹稳定。
        sources: [...referencedSources].flatMap((id) => {
          const source = sources.get(id);
          return source === undefined ? [] : [stripRuntime(source)];
        }),
        collections: [...referencedCollections].flatMap((id) => {
          const collection = collectionById.get(id);
          return collection === undefined ? [] : [collection];
        }),
        profile: definition,
        annotations: store.listAnnotations(profileId),
        rules: store.listRules(profileId),
        groups: store.listGroupOverrides(profileId),
      }),
    ).slice(0, 16);
  };

  /**
   * /health 没有配置上下文：把每份配置的版本拼起来再取 hash，
   * 任一配置变了都算实例版本变了，探活侧不需要知道有几种配置。
   */
  const instanceVersion = (): string =>
    sha256(store.listProfiles().map((profile) => configVersion(profile.id)).join('|')).slice(0, 16);

  const listProfiles = (): readonly PersistedProfile[] => store.listProfiles();

  const findProfile = (name: string): PersistedProfile | undefined =>
    listProfiles().find((profile) => profile.name === name);

  /** 把 Profile 的 items 展开成有序段落；组合订阅保留为一段，合并时才展开成员。 */
  const segmentsOf = (profile: PersistedProfile): readonly Segment[] =>
    profile.entries.map((entry): Segment => {
      if (entry.kind === 'source') return { kind: 'source', sourceId: entry.id };
      const collection = store.getCollection(entry.id);
      if (collection === undefined) return { kind: 'missing', id: entry.id, ref: 'collection-not-found' };
      return { kind: 'collection', collection };
    });

  /** 一次构建实际要用到的源 id 集合（去重，避免同一源被组合订阅重复拉取）。 */
  const sourceIdsOf = (segments: readonly Segment[]): readonly string[] => {
    const ids = new Set<string>();
    for (const segment of segments) {
      if (segment.kind === 'source') ids.add(segment.sourceId);
      if (segment.kind === 'collection') {
        for (const member of segment.collection.members) ids.add(member.sourceId);
      }
    }
    return [...ids];
  };

  /**
   * 删除源之后清理引用。留着悬空引用，构建只会吐 `source-not-found` /
   * `collection-member-missing` 这类代码级诊断，用户既看不懂也修不了——
   * 引用是工具自己写进去的，就该由工具负责收回。
   */
  const detachSourceRefs = (
    sourceId: string,
  ): { collections: number; profiles: number; removedCollections: string[] } => {
    let collectionHits = 0;
    const removedCollections: string[] = [];
    const removedIds: string[] = [];
    for (const collection of store.listCollections()) {
      const members = collection.members.filter((member) => member.sourceId !== sourceId);
      if (members.length === collection.members.length) continue;
      collectionHits += 1;
      if (members.length === 0) {
        // 成员被清空的组合订阅只剩空壳，留着只会让构成里多一段「0 节点」，一并删掉。
        store.removeCollection(collection.id);
        removedIds.push(collection.id);
        removedCollections.push(collection.name);
      } else {
        store.putCollection({ ...collection, members });
      }
    }

    let profileHits = 0;
    for (const profile of store.listProfiles()) {
      const entries = profile.entries.filter((entry) =>
        entry.kind === 'source' ? entry.id !== sourceId : !removedIds.includes(entry.id),
      );
      if (entries.length === profile.entries.length) continue;
      profileHits += 1;
      store.putProfile({ ...profile, entries });
    }
    return { collections: collectionHits, profiles: profileHits, removedCollections };
  };

  /** 删除组合订阅时同步摘掉 Profile 构成里的引用。 */
  const detachCollectionRefs = (collectionId: string): number => {
    let profileHits = 0;
    for (const profile of store.listProfiles()) {
      const entries = profile.entries.filter(
        (entry) => entry.kind !== 'collection' || entry.id !== collectionId,
      );
      if (entries.length === profile.entries.length) continue;
      profileHits += 1;
      store.putProfile({ ...profile, entries });
    }
    return profileHits;
  };

  /**
   * 拉一次远端源：结果写快照缓存与运行态（流量信息 / 最近拉取时间 / 最近错误）。
   * 失败向上抛，由调用方决定是记诊断还是直接回错误——调度器与构建共用这一条路径。
   */
  const fetchRemote = async (source: PersistedSource): Promise<string | null> => {
    if (source.url === undefined) throw new Error('source-missing-url');
    // ETag 取 lastGood 而不是 get：即使正文已过 TTL，用旧 ETag 做条件请求依然正确（能省一次全量传输），
    // 而 304 回来说明内容未变，正好把新鲜度重新续期。
    const cached = cache.lastGood(source.id);
    // 源级优先、全局回退：单独给某个源配的 UA / 代理压过实例默认；
    // headers 目前只在全局配置（源级没有这个字段），整份透传。
    const defaults = fetchDefaults(store);
    const fetched = await fetchSnapshot(source.url, cached?.etag ?? null, {
      allowPrivate: options.allowPrivate ?? false,
      ua: source.ua ?? defaults.ua ?? null,
      proxy: source.proxy ?? defaults.proxy ?? null,
      headers: defaults.headers,
    });
    const body = fetched.notModified ? cached?.body : fetched.body;
    if (body === undefined || body === null) throw new Error('upstream-empty-after-304');
    cache.set(source.id, { body, etag: fetched.etag, fetchedAt: Date.now() });
    store.updateSourceState(source.id, {
      lastFetchedAt: new Date().toISOString(),
      lastError: null,
      ...(fetched.userinfo === null ? {} : { userinfo: fetched.userinfo }),
      ...(fetched.suggestedRefreshHours === null
        ? {}
        : { suggestedRefreshHours: fetched.suggestedRefreshHours }),
    });
    return body;
  };

  /** 取源正文：远端走带 ETag 的缓存，文件 / 粘贴源直接读库。 */
  const loadBody = async (
    source: PersistedSource,
    diagnostics: Diagnostic[],
  ): Promise<string | null> => {
    if (source.kind === 'remote') {
      try {
        return await fetchRemote(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
        // 失败也要落库：否则「昨天还好、今天挂了」在 UI 上完全看不出来。
        store.updateSourceState(source.id, {
          lastFetchedAt: new Date().toISOString(),
          lastError: reason,
        });
        /**
         * 上游挂了不等于没有数据可发。回退到最后一次成功的快照，
         * 但必须在诊断里带上「它有多旧」——静默使用旧数据比直接报错更坏。
         */
        const stale = cache.lastGood(source.id);
        if (stale === undefined) throw error;
        const ageMs = Math.max(0, Date.now() - stale.fetchedAt);
        diagnostics.push({
          stage: 'ingest',
          target: null,
          subject: source.id,
          reason: `upstream-stale:${describeAge(ageMs)}`,
        });
        void notifier.notify({
          key: `upstream-stale:${source.id}`,
          title: '订阅源拉取失败，已回退旧快照',
          body: `${source.name}（${source.id}）：${reason}；正在使用 ${describeAge(ageMs)}前的快照`,
        });
        return stale.body;
      }
    }
    const payload = store.readSourcePayload(source.id);
    if (payload === undefined) {
      diagnostics.push({ stage: 'ingest', target: null, subject: source.id, reason: 'source-payload-empty' });
      return null;
    }
    return payload;
  };

  /** 第一阶段：只拉上游 + 算轻量 ETag，不跑 Ingest，命中可直接 304。 */
  const prepareState = async (profileName: string): Promise<PreparedState | null> => {
    const definition = findProfile(profileName);
    if (definition === undefined) return null;
    const diagnostics: Diagnostic[] = [];
    const snapshots: Snapshot[] = [];
    const byId = new Map(store.listSources().map((source) => [source.id, source]));

    for (const sourceId of sourceIdsOf(segmentsOf(definition))) {
      const source = byId.get(sourceId);
      if (source === undefined) {
        diagnostics.push({ stage: 'ingest', target: null, subject: sourceId, reason: 'source-not-found' });
        continue;
      }
      if (!source.enabled) {
        diagnostics.push({ stage: 'ingest', target: null, subject: sourceId, reason: 'source-disabled' });
        continue;
      }
      try {
        const body = await loadBody(source, diagnostics);
        if (body !== null) snapshots.push({ id: source.id, body });
      } catch (error) {
        diagnostics.push({
          stage: 'ingest',
          target: null,
          subject: source.id,
          reason: `upstream-failed:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
        });
      }
    }

    const version = configVersion(definition.id);
    // irKey / ETag 只由「不跑 Ingest 就能算出」的量组成：配置版本 + 上游 body hash。
    const irKey = sha256([version, ...snapshots.map((s) => `${s.id}:${sha256(s.body)}`)].join('|'));
    const etag = `"${sha256(`${version}:${irKey}`).slice(0, 32)}"`;
    return { profileName, snapshots, etag, irKey, configVersion: version, diagnostics };
  };

  /**
   * 按段落顺序合成一份 IR：
   * - 单源 → 解析后直接进入结果；
   * - 组合订阅 → 成员逐条过滤 / 加前缀，再按策略去重；
   * - 全局再按 nodeKey 去重一次，避免同一源被多个组合订阅引用时重复出现。
   */
  const composeProfile = (
    profile: PersistedProfile,
    snapshots: readonly Snapshot[],
  ): {
    readonly profile: Profile;
    readonly diagnostics: readonly Diagnostic[];
    readonly provenance: ReadonlyMap<string, readonly string[]>;
  } => {
    const bodies = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.body]));
    const diagnostics: Diagnostic[] = [];
    const parsed = new Map<string, readonly ProxyNode[]>();
    const ruleSources: RuleSource[] = [];
    const groups = new Map<string, PolicyGroup>();
    const originalNames = new Map<string, string>();
    const provenance = new Map<string, string[]>();
    let sourceDns: Profile['runtime'] = undefined;
    const dnsSeen = new Set<string>();

    const ensureParsed = (sourceId: string): readonly ProxyNode[] | undefined => {
      const cached = parsed.get(sourceId);
      if (cached !== undefined) return cached;
      const body = bodies.get(sourceId);
      if (body === undefined) return undefined;
      const result = ingest(body);
      parsed.set(sourceId, result.profile.nodes);
      for (const node of result.profile.nodes) {
        if (!originalNames.has(nodeKey(node))) originalNames.set(nodeKey(node), node.name);
      }
      diagnostics.push(...result.diagnostics);
      // 规则集与策略组只按源取一次：同一源被两个组合订阅引用时不应翻倍。
      ruleSources.push(...result.profile.ruleSources);
      for (const group of result.profile.policyGroups) {
        const existing = groups.get(group.name);
        groups.set(
          group.name,
          existing === undefined
            ? group
            : { ...existing, members: [...new Set([...existing.members, ...group.members])] },
        );
      }
      if (!dnsSeen.has(sourceId)) {
        dnsSeen.add(sourceId);
        const incoming = result.profile.runtime?.dns;
        if (incoming !== undefined) {
          if (sourceDns?.dns === undefined) sourceDns = { dns: incoming };
          else {
            diagnostics.push({
              stage: 'ingest',
              target: null,
              subject: sourceId,
              reason: 'dns-ignored',
            });
          }
        }
      }
      return result.profile.nodes;
    };

    const collected: ProxyNode[] = [];
    const markProvenance = (nodes: readonly ProxyNode[], sourceId: string): void => {
      for (const node of nodes) {
        const key = nodeKey(node);
        const bucket = provenance.get(key) ?? [];
        if (!bucket.includes(sourceId)) bucket.push(sourceId);
        provenance.set(key, bucket);
      }
    };

    for (const segment of segmentsOf(profile)) {
      if (segment.kind === 'missing') {
        diagnostics.push({ stage: 'process', target: null, subject: segment.id, reason: segment.ref });
        continue;
      }
      if (segment.kind === 'source') {
        const nodes = ensureParsed(segment.sourceId);
        if (nodes === undefined) {
          diagnostics.push({
            stage: 'process',
            target: null,
            subject: segment.sourceId,
            reason: 'source-unavailable',
          });
          continue;
        }
        collected.push(...nodes);
        markProvenance(nodes, segment.sourceId);
        continue;
      }
      const composed = composeCollection(segment.collection, (sourceId) => ensureParsed(sourceId));
      collected.push(...composed.nodes);
      diagnostics.push(...composed.diagnostics);
      for (const member of segment.collection.members) {
        const nodes = ensureParsed(member.sourceId);
        if (nodes === undefined) continue;
        const filtered = applyMemberFilter(nodes, member.filter, member.sourceId).nodes;
        markProvenance(filtered, member.sourceId);
      }
    }

    // 全局去重：同名节点不合并，因为它们可能是不同落地机；按稳定 nodeKey 去重更安全。
    const deduped = dedupeNodes(collected, 'nodeKey');
    if (deduped.dropped > 0) {
      diagnostics.push({
        stage: 'process',
        target: null,
        subject: profile.name,
        reason: `duplicate-dropped:${deduped.dropped}`,
      });
    }

    /**
     * 「构建出来是 0 个节点」必须自己说出来。否则界面上只有一片空白：
     * 用户分不清是「还没加源」「源没进构成」还是「源解析失败」。
     */
    if (deduped.nodes.length === 0) {
      diagnostics.push({
        stage: 'process',
        target: null,
        subject: profile.name,
        reason: profile.entries.length === 0 ? 'profile-empty' : 'profile-no-nodes',
      });
    }

    const renamed = new Map<string, string>();
    for (const node of deduped.nodes) {
      const previous = originalNames.get(nodeKey(node));
      if (previous !== undefined && previous !== node.name) renamed.set(previous, node.name);
    }
    const alignedGroups = [...groups.values()].map((group) =>
      renamed.size === 0
        ? group
        : { ...group, members: group.members.map((member) => renamed.get(member) ?? member) },
    );
    return {
      profile: parseProfile({
        nodes: [...deduped.nodes],
        ruleSources,
        policyGroups: alignedGroups,
        ...(sourceDns === undefined ? {} : { runtime: sourceDns }),
      }),
      diagnostics,
      provenance,
    };
  };

  /**
   * 用户持久化意图注入解析产物：规则和 DNS 在这里按模式叠上去。
   * 策略组要等节点改名之后再展开，所以这里先留着订阅里的组。
   */
  const withOverrides = (profile: Readonly<Profile>, definition: PersistedProfile): Profile => {
    const rules = store.listRules(definition.id);
    const overrides = [...store.listGroupOverrides(definition.id)].sort((left, right) => left.order - right.order);
    const modes = effectiveModes(definition, overrides.length > 0, rules.length > 0);
    const ruleSources = applyRuleOverlay(profile.ruleSources, rules, modes.rules, modes.rulePlacement);
    const runtime = applyDnsOverlay(profile.runtime, definition.runtime, modes.dns);
    return parseProfile({
      nodes: [...profile.nodes],
      ruleSources,
      policyGroups: [...profile.policyGroups],
      ...(runtime === undefined ? {} : { runtime }),
    });
  };

  /**
   * 外部规则集去重 + 镜像 + 定性：同一 URL 在多个源里出现时只保留一条，改成 `${publicBaseUrl}/rules/<key>`。
   * 不配 publicBaseUrl 时仅去重、保留原 URL——镜像地址不可达就没有意义。
   *
   * 这里会**按需拉一次规则集正文**，只为判定它装的是域名 / CIDR / 整条规则：
   * mihomo 的 `rule-providers.behavior` 写错会让整份配置拒绝加载，这一栏不能猜。
   * 代价是首次构建多几个请求（之后按 6 小时 TTL 命中缓存），换来的是镜像同时被预热——
   * 客户端第一次来取 `/rules/<key>` 时内容已经在磁盘上了。
   */
  /**
   * `eager=false` 只给 /api/trace、/api/probe 这类「不产出配置正文」的交互端点：
   * 它们只需要 IR，不需要为了推断规则集形状去等一次可能 15 秒的上游请求。
   * 缓存里没有内容时挂一次后台预热，真正的订阅渲染下次就能命中。
   */
  const withRuleSetMirror = async (profile: Readonly<Profile>, eager = true): Promise<Profile> => {
    const base = options.publicBaseUrl?.replace(/\/+$/, '');
    const seen = new Set<string>();
    const ruleSources: RuleSource[] = [];
    for (const source of profile.ruleSources) {
      if (source.kind !== 'external') {
        ruleSources.push(source);
        continue;
      }
      const key = ruleSets.register(source.url);
      const dedupeKey = `${key}:${source.policy ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      let shape = source.shape;
      let encoding = source.encoding;
      if (shape === undefined || encoding === undefined) {
        const entry = eager ? await ruleSets.resolve(source.url) : ruleSets.peek(source.url);
        const described = entry === null ? undefined : describeRuleSet(entry.body);
        if (shape === undefined) shape = described?.shape;
        if (encoding === undefined) encoding = described?.encoding;
        if (!eager && entry === null) void ruleSets.resolve(source.url);
      }
      ruleSources.push({
        ...source,
        ...(shape === undefined ? {} : { shape }),
        ...(encoding === undefined ? {} : { encoding }),
        ...(base === undefined ? {} : { url: `${base}/rules/${key}` }),
      });
    }
    return parseProfile({
      nodes: [...profile.nodes],
      ruleSources,
      policyGroups: [...profile.policyGroups],
      ...(profile.runtime === undefined ? {} : { runtime: profile.runtime }),
    });
  };

  const traceView = (trace: ProcessTrace): TraceView => ({
    steps: trace.steps.map((step) => ({
      index: step.index,
      diff: step.diff,
      diagnostics: step.diagnostics,
      nodesBefore: step.before.nodes.length,
      nodesAfter: step.after.nodes.length,
    })),
  });

  /**
   * 第二阶段：ETag 未命中才解析 IR、加工，并且只构建请求的那个 Target。
   * queryFilter 来自参数化订阅（?include=&exclude=&prefix=&limit=），只影响本次响应，不进缓存。
   */
  const buildFromSnapshots = async (
    state: PreparedState,
    target: ClientTarget,
    queryFilter?: MemberFilter,
    eager = true,
  ): Promise<BuiltState> => {
    // 标注按配置取，命中 L3 缓存时也要能拿到，所以 definition 提到分支外面。
    const definition = findProfile(state.profileName);
    if (definition === undefined) throw new Error('profile-not-found');
    // eager=false 的产物不含镜像后的规则集 URL，不能进 L3，否则会污染订阅渲染的缓存。
    let configured = eager ? buildCache.getL3(state.irKey) : undefined;
    const diagnostics: Diagnostic[] = [...state.diagnostics];
    if (configured === undefined) {
      const composed = composeProfile(definition, state.snapshots);
      configured = await withRuleSetMirror(withOverrides(composed.profile, definition), eager);
      diagnostics.push(...composed.diagnostics);
      if (eager) buildCache.setL3(state.irKey, configured);
    }
    const trace = traceProcessors(
      configured,
      { configVersion: state.configVersion },
      [
        applyNodeTransforms(store.listNodeTransforms(definition.id)),
        applyAnnotations(store.listAnnotations(definition.id)),
      ],
    );
    const groupOverrides = [...store.listGroupOverrides(definition.id)].sort((left, right) => left.order - right.order);
    const groupModes = effectiveModes(definition, groupOverrides.length > 0, store.listRules(definition.id).length > 0);
    const alignedGroups = alignInheritedMembers(trace.final.policyGroups, configured.nodes, trace.final.nodes);
    const grouped = applyGroupOverlay(alignedGroups, groupOverrides, trace.final.nodes, groupModes.groups);
    let final: Profile = parseProfile({
      nodes: [...trace.final.nodes],
      ruleSources: [...trace.final.ruleSources],
      policyGroups: grouped,
      ...(trace.final.runtime === undefined ? {} : { runtime: trace.final.runtime }),
    });
    if (queryFilter !== undefined) {
      const applied = applyMemberFilter(final.nodes, queryFilter, 'query');
      diagnostics.push(...applied.diagnostics);
      final = parseProfile({
        nodes: [...applied.nodes],
        ruleSources: [...final.ruleSources],
        policyGroups: [...final.policyGroups],
        ...(final.runtime === undefined ? {} : { runtime: final.runtime }),
      });
    }
    const buildId = randomUUID();
    const output = buildOne(final, target, { buildId });
    // 被「拒绝」的节点不是降级，是整条节点不可用；这类事件值得推一次（30 分钟内同类只推一条）。
    const rejected = output.report.diagnostics.filter((item) => item.reason.startsWith('feature-required:'));
    if (rejected.length > 0) {
      const features = [...new Set(rejected.map((item) => item.reason.slice('feature-required:'.length)))];
      void notifier.notify({
        key: `build-rejected:${target}`,
        title: '构建拒绝了节点',
        body: `${state.profileName} → ${target}：${rejected.length} 个节点缺少 ${features.join(' / ')}，已整条拒绝（降级会生成连不上的配置）`,
      });
    }

    return {
      output,
      profile: final,
      buildId,
      diagnostics: [...diagnostics, ...trace.steps.flatMap((step) => step.diagnostics)],
      trace: traceView(trace),
    };
  };

  const redacted = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
    diagnostics.map(redactDiagnostic);

  const serveStatic = (pathname: string, res: ServerResponse): void => {
    const root = options.webRoot;
    if (root === undefined) {
      send(res, 404, 'UI bundle not built', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    const base = resolve(root);
    let requested: string;
    try {
      requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\//, '');
    } catch {
      send(res, 400, 'invalid-url-encoding', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    let file = resolve(join(base, requested));
    if (file !== base && !file.startsWith(base + sep)) {
      send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      file = join(base, 'index.html'); // SPA fallback
    }
    if (!existsSync(file)) {
      send(res, 404, 'UI bundle not built', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    // 必须按字节读：图片 / 字体等二进制资源按 utf8 解码会损坏。
    send(res, 200, readFileSync(file), {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    });
  };

  /**
   * 规则集镜像端点：客户端（Surge / Loon）直接来取，因此**不走管理令牌**——
   * 内容是公开的规则文本，key 是 URL 的哈希，拿到 key 也需要先知道原始 URL。
   * 上游取不到时回退旧内容；连旧内容都没有才 404。
   */
  const serveRuleSet = async (res: ServerResponse, rawKey: string): Promise<void> => {
    const key = rawKey.replace(/\.(txt|list|yaml|yml)$/i, '').replace(/[^0-9a-f]/gi, '');
    const entry = key.length === 0 ? undefined : ruleSets.get(key);
    if (entry === undefined) {
      send(res, 404, 'unknown-rule-set', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    const resolved = await ruleSets.resolve(entry.url);
    const body = resolved?.body ?? entry.body;
    if (body.length === 0) {
      send(res, 502, 'rule-set-unavailable', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    send(res, 200, body, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...(resolved?.etag === null || resolved?.etag === undefined ? {} : { etag: resolved.etag }),
    });
  };

  const isAdmin = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = activeAdminHash();
    return presented.length > 0 && expected !== undefined && safeEqual(hashToken(presented), expected);
  };

  /**
   * 管理面（/api/*）整体在 401 闸门之后，这里的 url / proxy 返回明文。
   * 编辑抽屉靠它回填输入框：此前走 redact()，`?token=***` 被回填后又被 PUT 写回库，
   * 用户只改个名字就会把订阅链接永久毁掉。诊断文本、错误原因仍走 redact。
   */
  const sourceView = (source: PersistedSource): Record<string, unknown> => {
    const info = store.sourcePayloadInfo(source.id);
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      enabled: source.enabled,
      url: source.url ?? null,
      format: source.format ?? null,
      ua: source.ua ?? null,
      refreshPolicy: source.refreshPolicy ?? null,
      refreshIntervalMs: parseRefreshPolicy(source.refreshPolicy),
      proxy: source.proxy ?? null,
      lastFetchedAt: source.lastFetchedAt ?? null,
      lastError: source.lastError ?? null,
      // 快照年龄 + 是否已超出 TTL：界面据此把「正在用旧数据」讲清楚，而不是只显示一个红点。
      snapshotAgeMs: cache.ageOf(source.id),
      snapshotStale: source.kind === 'remote' && cache.lastGood(source.id) !== undefined && !cache.isFresh(source.id),
      userinfo: source.userinfo ?? null,
      suggestedRefreshHours: source.suggestedRefreshHours ?? null,
      bytes: info?.bytes ?? 0,
      updatedAt: info?.updatedAt ?? null,
    };
  };

  /**
   * 把多个源的流量信息合成一个 `subscription-userinfo` 响应头。
   * 口径：上传 / 下载 / 总量按源累加（Profile 可能合并多个机场），到期取最早的一个。
   * 一个源都没有信息时返回 null，不下发空头——避免客户端把「未知」显示成「0」。
   */
  const userinfoHeader = (sources: readonly PersistedSource[]): string | null => {
    let upload = 0;
    let download = 0;
    let total = 0;
    let expire = 0;
    let seen = false;
    for (const source of sources) {
      const info = source.userinfo;
      if (info === undefined) continue;
      seen = true;
      upload += info.upload ?? 0;
      download += info.download ?? 0;
      total += info.total ?? 0;
      if (info.expire !== undefined && (expire === 0 || info.expire < expire)) expire = info.expire;
    }
    if (!seen) return null;
    return [
      `upload=${Math.round(upload)}`,
      `download=${Math.round(download)}`,
      `total=${Math.round(total)}`,
      ...(expire > 0 ? [`expire=${expire}`] : []),
    ].join('; ');
  };

  /** 刷新一批源；返回成功 / 失败计数，失败原因已落库不吞掉。 */
  const refreshSources = async (
    ids: readonly string[],
  ): Promise<{ refreshed: number; failed: number }> => {
    let refreshed = 0;
    let failed = 0;
    for (const id of ids) {
      const source = store.getSource(id);
      if (source === undefined) continue;
      try {
        await fetchRemote(source);
        refreshed += 1;
      } catch (error) {
        failed += 1;
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
        store.updateSourceState(id, {
          lastError: reason,
          lastFetchedAt: new Date().toISOString(),
        });
        // 失败必须推送出去：定时刷新是后台行为，用户不会盯着界面看。
        // 通知里有源名与原因，但没有 URL / 凭据——标题里的 id 已足够定位。
        void notifier.notify({
          key: `refresh-failed:${id}`,
          title: '订阅源拉取失败',
          body: `${source.name}（${id}）：${reason}`,
        });
      }
    }
    return { refreshed, failed };
  };

  /** 调度器每轮的动作；单独导出便于测试里手动触发而不用等定时器。 */
  const refreshDue = async (): Promise<{ refreshed: number; failed: number }> => {
    const due = dueSourceIds(store.listSources(), Date.now());
    if (due.length === 0) return { refreshed: 0, failed: 0 };
    return refreshSources(due);
  };

  /** 单源解析检查：给「文件到底解析出几个节点、前几个叫什么」一个直接答案。 */
  const inspectSource = async (
    source: PersistedSource,
  ): Promise<Record<string, unknown>> => {
    const diagnostics: Diagnostic[] = [];
    if (!source.enabled) {
      return { id: source.id, enabled: false, nodes: 0, skipped: 0, diagnostics: [], sample: [] };
    }
    let body: string | null = null;
    try {
      body = await loadBody(source, diagnostics);
    } catch (error) {
      diagnostics.push({
        stage: 'ingest',
        target: null,
        subject: source.id,
        reason: `upstream-failed:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      });
    }
    if (body === null) {
      return {
        id: source.id,
        enabled: true,
        nodes: 0,
        skipped: 0,
        diagnostics: redacted(diagnostics),
        sample: [],
      };
    }
    const result = ingest(body);
    return {
      id: source.id,
      enabled: true,
      format: result.format,
      nodes: result.profile.nodes.length,
      skipped: result.skipped,
      sample: result.profile.nodes.slice(0, 6).map((node) => node.name),
      bytes: Buffer.byteLength(body, 'utf8'),
      diagnostics: redacted([...diagnostics, ...result.diagnostics]),
    };
  };

  /** 组合订阅的节点数快速估算：只读本地正文，远端源留给检查接口，避免这里发网络请求。 */
  const offlineNodesOf = (collection: PersistedCollection) => {
    const cache = new Map<string, readonly ProxyNode[]>();
    return (sourceId: string): readonly ProxyNode[] | undefined => {
      const cached = cache.get(sourceId);
      if (cached !== undefined) return cached;
      const source = store.getSource(sourceId);
      if (source === undefined || source.kind === 'remote') return undefined;
      const payload = store.readSourcePayload(sourceId);
      if (payload === undefined) return undefined;
      const nodes = ingest(payload).profile.nodes;
      cache.set(sourceId, nodes);
      return nodes;
    };
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';

    // 首次设置必须在统一 401 之前分流：此时还没有任何凭据可供校验。
    if (method === 'GET' && pathname === '/api/setup/status') {
      sendJson(res, 200, {
        required: setupRequired(),
        secretRequired: secretSetupRequired(),
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/setup') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        // 这是唯一面向未认证用户的写端点，坏 body 必须给 400 / 413 而不是落到外层 500。
        const status = error instanceof HttpError ? error.status : 400;
        sendJson(res, status, { error: status === 413 ? 'request-body-too-large' : 'invalid-json-body' });
        return;
      }
      // 先读完 body 再判定：Node 单线程下，从这里到写库/写文件之间没有 await，
      // 并发首次提交只会有一个请求看到「仍待初始化」。
      const adminMissing = setupRequired();
      const secretMissing = secretSetupRequired();
      if (!adminMissing && !secretMissing) {
        sendJson(res, 409, { error: 'already-initialized' });
        return;
      }
      // 管理令牌已存在、只缺加密密钥时，必须先通过管理面鉴权。
      if (!adminMissing && !isAdmin(req)) {
        sendJson(res, 401, { error: 'admin-auth-required' });
        return;
      }
      const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
      const nextSecret = typeof body['secret'] === 'string' ? body['secret'].trim() : '';
      if (adminMissing && token.length < MIN_ADMIN_TOKEN_LENGTH) {
        sendJson(res, 400, { error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH });
        return;
      }
      if (secretMissing) {
        if (nextSecret.length < MIN_TOKEN_SECRET_LENGTH) {
          sendJson(res, 400, {
            error: 'secret-too-short',
            minLength: MIN_TOKEN_SECRET_LENGTH,
          });
          return;
        }
        if (secretFile === undefined) {
          sendJson(res, 500, { error: 'secret-file-unavailable' });
          return;
        }
        let staged: string | null = null;
        let rollback: (() => void) | undefined;
        try {
          // 先重加密数据库（可回滚），再原子替换密钥文件；两步之间失败都不会留下
          // 「文件是新密钥、库是旧密钥」的半成品。
          staged = stageSecretFile(secretFile, nextSecret);
          rollback = store.rotateSecret(nextSecret);
          commitSecretFile(secretFile, staged);
          staged = null;
          secretConfigured = true;
        } catch (error) {
          if (staged !== null) discardSecretFile(staged);
          // 密钥文件没提交成功（rename 撞上文件占用、磁盘满、只读挂载）时数据库已经换成新密钥，
          // 此时必须退回旧密钥，否则重启后按盘上的旧密钥解不开任何正文。
          let reverted = true;
          if (rollback !== undefined) {
            try {
              rollback();
            } catch {
              reverted = false;
            }
          }
          const reason = error instanceof Error ? error.message : 'unknown';
          if (/unable to authenticate|bad decrypt|wrong final block length/i.test(reason)) {
            sendJson(res, 422, {
              error: 'payload-undecryptable',
              hint: '已有正文无法用新密钥解密：请先用原 STARTRAILS_TOKEN_SECRET 启动，或从备份恢复',
            });
          } else if (!reverted) {
            // 这条路径比普通写入失败严重：库已经用新密钥，盘上还是旧密钥，
            // 重启就会解不开。用独立错误码，别让前端按「检查目录权限」轻描淡写。
            sendJson(res, 500, {
              error: 'secret-file-desync',
              reason: redact(reason).slice(0, 160),
              hint: '数据库已切到新密钥但密钥文件未写入：重启前把密钥文件内容改成刚才设置的密钥，或用 STARTRAILS_TOKEN_SECRET 启动，否则已有正文将无法解密',
            });
          } else {
            sendJson(res, 500, {
              error: 'secret-persist-failed',
              reason: redact(reason).slice(0, 160),
            });
          }
          return;
        }
      }
      // 原子写入：并发首次提交只有一个赢家，已初始化后重复提交也不会覆盖既有令牌。
      if (adminMissing && !store.claimSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(token))) {
        sendJson(res, 409, { error: 'admin-already-initialized' });
        return;
      }
      sendJson(res, 201, { ok: true });
      return;
    }

    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'admin-auth-required' });
      return;
    }

    // 没有持久密钥时，临时密钥写下的任何正文都会在重启后丢失：先让用户完成密钥设置。
    if (secretSetupRequired()) {
      sendJson(res, 503, {
        error: 'secret-setup-required',
        hint: '先在登录页设置数据加密密钥（或部署 STARTRAILS_TOKEN_SECRET）',
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      // 首屏接口：配置名写错不该让整个后台登不进去，回落到 default 而不是 404。
      const requested = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(requested) ?? findProfile('default');
      sendJson(res, 200, {
        version: definition === undefined ? instanceVersion() : configVersion(definition.id),
        coreVersion: CORE_VERSION,
        sources: store.listSources().map(sourceView),
        collections: store.listCollections().map((collection) => ({
          ...collection,
          previewCount: composeCollection(collection, offlineNodesOf(collection)).nodes.length,
        })),
        profiles: store.listProfiles(),
        // 标注按配置回：前端拿它标记排除与别名，拿错一份就会显示成另一份配置的取舍。
        annotations: definition === undefined ? [] : store.listAnnotations(definition.id),
        tokens: store.listTokens().map((token) => ({
          id: token.id,
          profile: token.profile,
          target: token.target,
          revoked: token.revoked,
          createdAt: token.createdAt,
          /**
           * 台账要能重新复制链接、扫二维码，而不只是签发那一次。
           * 早期记录库里只有 hash、还原不出 token：url 为 null，前端提示重新签发。
           */
          url:
            token.token === undefined
              ? null
              : absoluteUrlOf(
                  req,
                  token.target === 'auto'
                    ? `/s/${token.token}`
                    : `/s/${token.token}/${token.profile}/${token.target}`,
                  '',
                ),
        })),
        targets: CLIENT_TARGETS,
        sourceFormats: SOURCE_FORMATS,
        clientTargets: TARGETS.map((item) => ({
          id: item.id,
          name: item.name,
          dialect: item.dialect,
          fileExtension: item.fileExtension,
          contentMode: item.contentMode,
          basis: item.basis,
          independentEvidence: item.independentEvidence,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/nodes') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const state = await prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const composed = composeProfile(definition, state.snapshots);
      sendJson(res, 200, {
        configVersion: state.configVersion,
        // 只回摘要，不把 uuid / password 等凭据送进浏览器。
        nodes: composed.profile.nodes.map((node) => ({
          nodeKey: nodeKey(node),
          kind: node.kind,
          name: node.name,
          address: `${node.server}:${node.port}`,
          options: node.options ?? {},
          sources: composed.provenance.get(nodeKey(node)) ?? [],
        })),
        diagnostics: redacted([...state.diagnostics, ...composed.diagnostics]),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/sources/inspect') {
      const sources = store.listSources();
      const results = await Promise.all(sources.map((source) => inspectSource(source)));
      sendJson(res, 200, { sources: results });
      return;
    }

    if (method === 'GET' && pathname === '/api/collections') {
      const collections = store.listCollections();
      sendJson(res, 200, {
        collections: collections.map((collection) => ({
          ...collection,
          previewCount: composeCollection(collection, offlineNodesOf(collection)).nodes.length,
        })),
      });
      return;
    }

    if (pathname === '/api/collections') {
      if (method === 'POST') {
        const body = await readJson(req);
        const name = asString(body['name']);
        if (name === undefined) {
          sendJson(res, 400, { error: 'name-required' });
          return;
        }
        const members: CollectionMember[] = [];
        for (const entry of Array.isArray(body['members']) ? body['members'] : []) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const sourceId = asString(record['sourceId']);
          if (sourceId === undefined) continue;
          const rawFilter = record['filter'];
          if (typeof rawFilter !== 'object' || rawFilter === null) {
            members.push({ sourceId });
            continue;
          }
          const filter = buildFilter(rawFilter as Record<string, unknown>);
          members.push(filter === undefined ? { sourceId } : { sourceId, filter });
        }
        const dedupeRaw = asString(body['dedupe']);
        const id = asString(body['id']) ?? `col-${randomUUID().slice(0, 8)}`;
        const current = store.getCollection(id);
        store.putCollection({
          id,
          name,
          members,
          dedupe: dedupeRaw === 'name' || dedupeRaw === 'none' ? dedupeRaw : 'nodeKey',
          // 编辑不能改顺序：order 是创建时的位置。写成「当前数量」会让被编辑的组合跳到末尾，
          // 每次改个过滤条件都改变构建结果的合并顺序。
          order:
            current?.order ??
            store.listCollections().reduce((max, item) => Math.max(max, item.order), -1) + 1,
        });
        sendJson(res, 201, { id, name, members: members.length });
        return;
      }
    }

    if (method === 'DELETE' && pathname.startsWith('/api/collections/')) {
      const id = decodeURIComponent(pathname.slice('/api/collections/'.length));
      store.removeCollection(id);
      // 顺手摘掉构成里的引用：删除动作一旦留下悬空 id，预览会多出一条用户无法处理的诊断。
      sendJson(res, 200, { ok: true, detached: { profiles: detachCollectionRefs(id) } });
      return;
    }

    if (pathname === '/api/rules') {
      // 内联规则按配置存：它的 policy 字段引用的是这份配置的策略组，跟着配置走才不会悬空。
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const rules = store.listRules(definition.id);
        const modes = effectiveModes(definition, store.listGroupOverrides(definition.id).length > 0, rules.length > 0);
        sendJson(res, 200, { rules, mode: modes.rules, placement: modes.rulePlacement });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const rules = body['rules'];
        if (!Array.isArray(rules)) {
          sendJson(res, 400, { error: 'rules-must-be-array' });
          return;
        }
        const parsed = parseStoredRules(rules);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-rules' });
          return;
        }
        store.replaceRules(definition.id, parsed);
        const requested = asOverlayMode(body['mode']);
        if (requested !== undefined) {
          const current = effectiveModes(
            definition,
            store.listGroupOverrides(definition.id).length > 0,
            parsed.length > 0,
          );
          const placement = body['placement'] === 'before' ? 'before' : body['placement'] === 'after' ? 'after' : current.rulePlacement;
          store.putSectionModes(definition.id, { ...current, rules: requested, rulePlacement: placement });
        }
        sendJson(res, 200, { count: parsed.length });
        return;
      }
    }

    if (pathname === '/api/policy-groups') {
      // 策略组属于某一份配置：脱离「哪份配置」谈它没有意义，缺省才回落 default。
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const state = (await prepareState(profileName)) as PreparedState;
        const base = composeProfile(definition, state.snapshots).profile;
        const overrides = store.listGroupOverrides(definition.id);
        const modes = effectiveModes(definition, overrides.length > 0, store.listRules(definition.id).length > 0);
        sendJson(res, 200, {
          mode: modes.groups,
          groups: overrides,
          base: base.policyGroups,
        });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const groups = body['groups'];
        if (!Array.isArray(groups)) {
          sendJson(res, 400, { error: 'groups-must-be-array' });
          return;
        }
        const parsedGroups = parseStoredGroups(groups);
        store.replaceGroupOverrides(definition.id, parsedGroups);
        const requested = asOverlayMode(body['mode']);
        if (requested !== undefined) {
          const current = effectiveModes(definition, parsedGroups.length > 0, store.listRules(definition.id).length > 0);
          store.putSectionModes(definition.id, { ...current, groups: requested });
        }
        sendJson(res, 200, { count: parsedGroups.length });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/trace') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const state = await prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      sendJson(res, 200, {
        configVersion: state.configVersion,
        steps: (await buildFromSnapshots(state, 'surge', undefined, false)).trace.steps,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/capabilities') {
      sendJson(res, 200, { evidence: CAPABILITY_EVIDENCE });
      return;
    }

    if (method === 'GET' && pathname === '/api/diagnostics') {
      const buildId = url.searchParams.get('buildId');
      if (buildId !== null) {
        const report = store.getBuildReport(buildId);
        if (report === undefined) {
          sendJson(res, 404, { error: 'build-not-found' });
        } else {
          sendJson(res, 200, {
            ...report,
            report: { ...report.report, diagnostics: redacted(report.report.diagnostics) },
          });
        }
        return;
      }
      sendJson(res, 200, {
        reports: store.listBuildReports(10).map((report) => ({
          buildId: report.buildId,
          target: report.target,
          createdAt: report.createdAt,
          skipped: report.report.skipped,
          passed: report.report.passed,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/preview') {
      const target = url.searchParams.get('target') ?? 'surge';
      const profileName = url.searchParams.get('profile') ?? 'default';
      if (!isTarget(target)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      const state = await prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const built = await buildFromSnapshots(state, target);
      const output = built.output;
      sendJson(res, 200, {
        target,
        filename: outputFilename(target),
        content: output.content,
        trace: built.trace,
        report: {
          ...output.report,
          diagnostics: redacted([...built.diagnostics, ...output.report.diagnostics]),
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/sources') {
      const body = await readJson(req);
      const kindRaw = asString(body['kind']) ?? 'remote';
      const kind = kindRaw === 'file' || kindRaw === 'inline' ? kindRaw : 'remote';
      const url = asString(body['url']);
      const content = typeof body['content'] === 'string' ? body['content'] : undefined;

      if (kind === 'remote' && url === undefined) {
        sendJson(res, 400, { error: 'url-required' });
        return;
      }
      // 与 PUT 侧同一把尺：纯空白正文也算「没给内容」，不能靠 trim 前的 length 混过去。
      if (kind !== 'remote' && (content === undefined || content.trim().length === 0)) {
        sendJson(res, 400, { error: 'content-required' });
        return;
      }
      if (url !== undefined && hasRedactionMarkers(url)) {
        sendJson(res, 400, {
          error: 'redacted-url-rejected',
          hint: '链接里是脱敏值，请粘贴完整订阅链接',
        });
        return;
      }
      if (kind === 'remote' && url !== undefined) {
        try {
          await assertPublicUrl(url, { allowPrivate: options.allowPrivate ?? false });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'unsafe-url' });
          return;
        }
      }

      const formatRaw = asString(body['format']);
      if (formatRaw !== undefined && formatRaw !== '' && !isSourceFormat(formatRaw)) {
        sendJson(res, 400, { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' });
        return;
      }
      const format = formatRaw !== undefined && isSourceFormat(formatRaw) ? formatRaw : undefined;
      const ua = asString(body['ua']);
      const refreshPolicy = asString(body['refreshPolicy']);
      const proxy = proxyFrom(body['proxy']);
      if (!proxy.ok) {
        sendJson(res, 400, { error: 'invalid-proxy-url', hint: 'expect http://, https:// or socks5://host:port' });
        return;
      }
      if (proxy.value !== undefined && hasRedactionMarkers(proxy.value)) {
        sendJson(res, 400, { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' });
        return;
      }
      const id = asString(body['id']) ?? `${kind}-${randomUUID().slice(0, 8)}`;
      const name = asString(body['name']) ?? id;
      const source: PersistedSource = {
        id,
        name,
        kind,
        enabled: body['enabled'] === false ? false : true,
        ...(url === undefined || kind !== 'remote' ? {} : { url }),
        ...(ua === undefined ? {} : { ua }),
        ...(format === undefined ? {} : { format }),
        ...(refreshPolicy === undefined ? {} : { refreshPolicy }),
        ...(proxy.value === undefined ? {} : { proxy: proxy.value }),
      };
      store.putSource(source);
      if (content !== undefined && kind !== 'remote') store.writeSourcePayload(id, content);
      /**
       * 首次使用的闭环：Profile 还是空的时候，「刚加的源」就是用户唯一的意图，直接挂进构成，
       * 否则加完源进节点页是一片空白，用户以为坏掉了。非空 Profile 不自动追加——
       * 静默改掉已发布的构成比多点一次更坏，界面上另有「未加入构成」提示。
       */
      const attachTo = asString(body['profile']);
      const attachTarget = attachTo === undefined ? undefined : findProfile(attachTo);
      const attached = attachTarget !== undefined && attachTarget.entries.length === 0;
      if (attached && attachTarget !== undefined) {
        store.putProfile({ ...attachTarget, entries: [{ kind: 'source', id }] });
      }
      sendJson(res, 201, {
        id,
        name,
        kind,
        url: source.url ?? null,
        attached,
      });
      return;
    }

    if (pathname.startsWith('/api/sources/')) {
      const rest = pathname.slice('/api/sources/'.length);
      const [rawId, action] = rest.split('/');
      const id = decodeURIComponent(rawId ?? '');
      const existing = store.getSource(id);
      if (existing === undefined) {
        sendJson(res, 404, { error: 'source-not-found' });
        return;
      }
      if (method === 'GET' && action === 'preview') {
        sendJson(res, 200, await inspectSource(existing));
        return;
      }
      // 文件 / 粘贴源的正文要能读出来才能改：GET 回源详情 + 原文（远端源没有本地正文）。
      if (method === 'GET' && action === undefined) {
        sendJson(res, 200, {
          source: sourceView(existing),
          content: existing.kind === 'remote' ? null : (store.readSourcePayload(id) ?? ''),
        });
        return;
      }
      if (method === 'PUT' && action === undefined) {
        const body = await readJson(req);
        // 缺省 = 本次不改；显式空串 = 想清空。远端源把链接清成空必须报错，
        // 不能让 asString('') → undefined → 静默回退旧值之后还回 200（提示「保存成功」是假的）。
        const urlProvided = 'url' in body;
        const url = urlProvided ? asString(body['url']) : existing.url;
        if (existing.kind === 'remote' && urlProvided && url === undefined) {
          sendJson(res, 400, { error: 'url-required' });
          return;
        }
        // 旧版前端会把脱敏值回填并原样写回；即便用户开着缓存的旧页面，也不让它再次毁掉链接。
        // 只在「本次真的传了 url」时检查：库里若已被旧版写坏，用户至少还能停用 / 改名。
        if (urlProvided && url !== undefined && hasRedactionMarkers(url)) {
          sendJson(res, 400, {
            error: 'redacted-url-rejected',
            hint: '链接里是脱敏值（可能被旧版页面写坏过），请在编辑抽屉重新粘贴完整订阅链接',
          });
          return;
        }
        if (existing.kind === 'remote' && url !== undefined && url !== existing.url) {
          try {
            await assertPublicUrl(url, { allowPrivate: options.allowPrivate ?? false });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : 'unsafe-url' });
            return;
          }
        }
        const name = 'name' in body ? asString(body['name']) : existing.name;
        if (name === undefined) {
          sendJson(res, 400, { error: 'name-required' });
          return;
        }
        if ('enabled' in body && typeof body['enabled'] !== 'boolean') {
          sendJson(res, 400, { error: 'invalid-enabled', hint: 'enabled 只能是布尔值' });
          return;
        }
        // 只有请求里显式出现的键才覆盖：开关只带 { enabled } 时不能把 ua / 代理 / 刷新策略顺手清掉。
        // 例外是 format：显式传空串（「自动识别」）表示清除格式偏好，省略该键才是「不改」。
        let format = existing.format;
        if ('format' in body) {
          const raw = asString(body['format']);
          if (raw !== undefined && !isSourceFormat(raw)) {
            sendJson(res, 400, { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' });
            return;
          }
          format = raw !== undefined && isSourceFormat(raw) ? raw : undefined;
        }
        const ua = 'ua' in body ? asString(body['ua']) : existing.ua;
        // 本地源没有上游：不写入策略，顺手清掉旧库里遗留的那条「永不执行」。
        const refreshPolicy =
          existing.kind === 'remote'
            ? ('refreshPolicy' in body ? asString(body['refreshPolicy']) : existing.refreshPolicy)
            : undefined;
        let proxy: string | undefined = existing.proxy;
        if ('proxy' in body) {
          const parsed = proxyFrom(body['proxy']);
          if (!parsed.ok) {
            sendJson(res, 400, {
              error: 'invalid-proxy-url',
              hint: 'expect http://, https:// or socks5://host:port',
            });
            return;
          }
          if (parsed.value !== undefined && hasRedactionMarkers(parsed.value)) {
            sendJson(res, 400, { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' });
            return;
          }
          proxy = parsed.value;
        }
        // 正文清成空串没有意义（构建必然为空），回 400 而不是假装保存成功。
        if ('content' in body && existing.kind !== 'remote') {
          const content = body['content'];
          if (typeof content !== 'string' || content.trim().length === 0) {
            sendJson(res, 400, { error: 'content-required' });
            return;
          }
        }
        const next: PersistedSource = {
          id,
          name,
          kind: existing.kind,
          enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : existing.enabled,
          ...(existing.kind === 'remote' && url !== undefined ? { url } : {}),
          ...(ua === undefined ? {} : { ua }),
          ...(format === undefined ? {} : { format }),
          ...(refreshPolicy === undefined ? {} : { refreshPolicy }),
          ...(proxy === undefined ? {} : { proxy }),
        };
        store.putSource(next);
        if (typeof body['content'] === 'string' && body['content'].length > 0 && existing.kind !== 'remote') {
          store.writeSourcePayload(id, body['content']);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'DELETE' && action === undefined) {
        store.removeSource(id);
        // 引用回收必须跟删除同一个请求完成：留到下次构建才暴露，用户根本不知道从哪下手。
        sendJson(res, 200, { ok: true, detached: detachSourceRefs(id) });
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/profiles') {
      const body = await readJson(req);
      const name = asString(body['name']);
      if (name === undefined) {
        sendJson(res, 400, { error: 'name-required' });
        return;
      }
      const entries: { kind: 'source' | 'collection'; id: string }[] = [];
      if (Array.isArray(body['entries'])) {
        for (const entry of body['entries']) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const id = asString(record['id']);
          const kind = record['kind'] === 'collection' ? 'collection' : 'source';
          if (id !== undefined) entries.push({ kind, id });
        }
      } else {
        // 兼容旧前端：只给 sourceIds 时按扁平顺序换算。
        for (const id of asStringArray(body['sourceIds'])) entries.push({ kind: 'source', id });
      }
      const id = asString(body['id']) ?? name;
      // 改名撞已有配置名：name 上有 UNIQUE 约束，不前置拦截会落到 500 internal-error。
      const nameTaken = store.listProfiles().some((profile) => profile.name === name && profile.id !== id);
      if (nameTaken) {
        sendJson(res, 409, { error: 'profile-name-taken', hint: '已有同名配置' });
        return;
      }
      const previous = store.listProfiles().find((profile) => profile.id === id);
      const existed = previous !== undefined;
      store.putProfile({ id, name, entries });
      // 改名要级联到令牌：令牌的 profile 存的是签发时的名字，不跟着改的话
      // /s/ 交付链路按 record.profile 对不上 URL 里的配置名，已签发地址会整体失效。
      if (existed && previous.name !== name) {
        store.renameTokenProfile(previous.name, name);
      }
      // 统一 201（建或改都由 `created` 区分）：调用方一直按「201 = 写成功」处理，不为语义优雅而改契约。
      sendJson(res, 201, { name, id, entries: entries.length, created: !existed, renamed: existed && previous.name !== name });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
      const name = decodeURIComponent(pathname.slice('/api/profiles/'.length));
      const profile = findProfile(name);
      if (profile === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (store.listProfiles().length <= 1) {
        sendJson(res, 409, { error: 'last-profile', hint: '至少要保留一个 Profile' });
        return;
      }
      // 引用回收必须跟删除同一个请求完成：配置级的标注 / 规则 / 策略组跟着配置走，
      // 留着会让同名配置重建时继承旧意图。数量在删之前数好——删完就查不到了。
      const detached = {
        rules: store.listRules(profile.id).length,
        annotations: store.listAnnotations(profile.id).length,
        groupOverrides: store.listGroupOverrides(profile.id).length,
      };
      store.removeProfile(profile.id);
      // 绑在这个 Profile 上的订阅地址会随之一并失效；留着只会让客户端拿到 404，
      // 不如当场撤销，并在响应里说清撤了几个。
      const affected = store.listTokens().filter((token) => token.profile === profile.name && !token.revoked);
      for (const token of affected) store.revokeToken(token.id);
      sendJson(res, 200, { ok: true, detached, revoked: affected.length });
      return;
    }

    if (method === 'POST' && pathname === '/api/annotations') {
      // 排除 / 别名 / 排序都只作用于这一份配置的产物，所以必须指明是哪一份。
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const body = await readJson(req);
      const key = asString(body['nodeKey']);
      if (key === undefined) {
        sendJson(res, 400, { error: 'nodeKey-required' });
        return;
      }
      const alias = asString(body['alias']);
      const tag = asString(body['tag']);
      const region = asString(body['region']);
      store.putAnnotation(definition.id, {
        nodeKey: key,
        ...(typeof body['excluded'] === 'boolean' ? { excluded: body['excluded'] } : {}),
        ...(alias === undefined ? {} : { alias }),
        ...(tag === undefined ? {} : { tag }),
        ...(region === undefined ? {} : { region }),
        ...(typeof body['order'] === 'number' ? { order: body['order'] } : {}),
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/node-transforms') {
      // 按节点名批量剔除/改名，整份有序列表按配置隔离。与 annotations 分开：
      // 这里改「一类节点」，标注改「一个节点」，两者按 nodeKey 关联、顺序执行。
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { transforms: store.listNodeTransforms(definition.id) });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        try {
          const parsed = parseNodeTransforms(body['transforms'] ?? []);
          store.replaceNodeTransforms(definition.id, parsed);
          sendJson(res, 200, { ok: true, transforms: parsed });
        } catch (error) {
          sendJson(res, 400, {
            error: 'invalid-node-transforms',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/tokens') {
      const body = await readJson(req);
      const profileName = asString(body['profile']) ?? 'default';
      const target = asString(body['target']) ?? '';
      if (target !== 'auto' && !isTarget(target)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      /**
       * 空壳不许签发：构成是空的、也没有任何内联规则或策略组时，产物必然什么都没有，
       * 签发出去的地址客户端导入后是个空壳。这里只拦「确定为空」的情况——
       * 判「源能不能解析出节点」要拉上游，不该在签发这一步替用户跑一次构建。
       */
      if (
        definition.entries.length === 0 &&
        store.listRules(definition.id).length === 0 &&
        store.listGroupOverrides(definition.id).length === 0
      ) {
        sendJson(res, 409, {
          error: 'profile-empty',
          hint: '当前 Profile 没有任何内容：先在订阅源页把源加入构成并保存，再签发地址',
        });
        return;
      }
      const token = newToken();
      const id = randomUUID();
      const resolvedTarget: ClientTarget | 'auto' = isTarget(target) ? target : 'auto';
      store.createToken({
        id,
        tokenHash: hashToken(token),
        // 明文与 hash 一起入库（应用层加密）：台账要能重看链接与二维码，不只签发这一瞬间。
        token,
        profile: profileName,
        target: resolvedTarget,
        revoked: false,
        createdAt: new Date().toISOString(),
      });
      const path =
        resolvedTarget === 'auto' ? `/s/${token}` : `/s/${token}/${profileName}/${resolvedTarget}`;
      /**
       * 给出去的是「能直接填进客户端的地址」，不是相对路径：客户端拿到的是一段要粘进
       * 配置里的字符串，没有页面上下文可以补域名。用配置的 publicBaseUrl 优先，
       * 否则按请求头推断（与二维码同一条规则）。
       */
      sendJson(res, 201, {
        id,
        token,
        url: absoluteUrlOf(req, path, ''),
        path,
        target: resolvedTarget,
        profile: profileName,
      });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/tokens/')) {
      store.revokeToken(decodeURIComponent(pathname.slice('/api/tokens/'.length)));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/refresh') {
      // 显式刷新：清空构建缓存后立即拉一遍「启用中的远端源」，不受 refreshPolicy 限制。
      buildCache.clear();
      const remoteIds = store
        .listSources()
        .filter((source) => source.enabled && source.kind === 'remote')
        .map((source) => source.id);
      const outcome = await refreshSources(remoteIds);
      sendJson(res, 200, { ok: true, ...outcome });
      return;
    }

    if (method === 'POST' && /^\/api\/sources\/[^/]+\/refresh$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/api/sources/'.length, -'/refresh'.length));
      const source = store.getSource(id);
      if (source === undefined) {
        sendJson(res, 404, { error: 'source-not-found' });
        return;
      }
      if (source.kind !== 'remote') {
        sendJson(res, 400, { error: 'source-not-remote' });
        return;
      }
      const outcome = await refreshSources([id]);
      const updated = store.getSource(id);
      // 拉取失败是「数据面结果」而不是传输层错误：body 里已经给出 failed / lastError，
      // 回 502 只会让前端把它当异常弹出，反而看不到具体原因。
      sendJson(res, 200, {
        ...outcome,
        lastError: updated?.lastError ?? null,
        userinfo: updated?.userinfo ?? null,
        lastFetchedAt: updated?.lastFetchedAt ?? null,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/backup') {
      const destination = join(options.dataDir, 'backup', `startrails-${Date.now()}.db`);
      await store.backup(destination);
      sendJson(res, 200, { destination });
      return;
    }

    if (method === 'POST' && pathname === '/api/backup/remote') {
      const webdav = webdavConfig();
      if (webdav === undefined || parseWebDavUrl(webdav.url) === null) {
        sendJson(res, 501, {
          error: 'webdav-not-configured',
          hint: '在设置页配置 WebDAV，或设置 STARTRAILS_WEBDAV_URL（可选 _USER / _PASS）',
        });
        return;
      }
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const destination = join(options.dataDir, 'backup', `startrails-${stamp}.db`);
      await store.backup(destination);
      try {
        const outcome = await uploadToWebDav(webdav, destination, basename(destination));
        sendJson(res, 200, { ok: true, ...outcome, local: destination });
      } catch (error) {
        sendJson(res, 502, {
          error: 'webdav-upload-failed',
          reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
          local: destination,
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/probe') {
      // 探测目标 = 当前 Profile 构建出来的节点（与客户端看到的集合一致），按 server:port 去重。
      const body = await readJson(req);
      const profileName = asString(body['profile']) ?? store.listProfiles()[0]?.name ?? 'default';
      const probeState = await prepareState(profileName);
      if (probeState === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const built = await buildFromSnapshots(probeState, 'surge', undefined, false);
      const seen = new Set<string>();
      const targets: ProbeTarget[] = [];
      for (const node of built.profile.nodes) {
        const id = `${node.server}:${node.port}`;
        if (seen.has(id)) continue;
        seen.add(id);
        targets.push({ nodeKey: nodeKey(node), name: node.name, server: node.server, port: node.port });
        if (targets.length >= 200) break;
      }
      const samples = await probeAll(targets, { timeoutMs: 1_000, attempts: 2, concurrency: 16 });
      sendJson(res, 200, {
        note: 'TCP 握手延迟（主控机 → 节点 server:port），不是代理链路测速，也不代表落地出口质量',
        samples,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/token') {
      if (envTokenHash !== undefined) {
        sendJson(res, 409, {
          error: 'admin-token-from-env',
          hint: '管理令牌来自环境变量 STARTRAILS_ADMIN_TOKEN，请在部署侧修改后重启',
        });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'invalid-json-body' });
        return;
      }
      const next = typeof body['token'] === 'string' ? body['token'].trim() : '';
      if (next.length < MIN_ADMIN_TOKEN_LENGTH) {
        sendJson(res, 400, { error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH });
        return;
      }
      const current = activeAdminHash();
      // 新旧相同不算错误，但也没必要写库——直接告诉用户「没变化」，避免误以为轮换成功。
      if (current !== undefined && safeEqual(hashToken(next), current)) {
        sendJson(res, 400, { error: 'admin-token-unchanged' });
        return;
      }
      store.putSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(next));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings/notify/test') {
      let body: Record<string, unknown> = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      // 先测后存的顺序最常用：请求里带了候选配置就测候选，否则测当前生效值。
      const candidate = body['notify'];
      const config =
        candidate === null || candidate === undefined ? notifyConfig() : (parseNotifyConfig(candidate) ?? undefined);
      if (config === undefined) {
        sendJson(res, 400, {
          error: 'notify-not-configured',
          hint: '先填 Telegram Bot Token + Chat ID，或 Bark 地址',
        });
        return;
      }
      const results = await sendTestNotify(config);
      const ok = results.length > 0 && results.every((item) => item.ok);
      sendJson(res, ok ? 200 : 502, { ok, results });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings/webdav/test') {
      let body: Record<string, unknown> = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const candidate = body['webdav'];
      let config: WebDavConfig | undefined;
      if (candidate !== undefined && candidate !== null) {
        // 表单密码留空 = 用已保存的密码去测，而不是当成「无密码」。
        config = parseWebdavConfig(candidate, webdavConfig()) ?? undefined;
        if (config === undefined) {
          sendJson(res, 400, { error: 'invalid-webdav-config' });
          return;
        }
      } else {
        config = webdavConfig();
      }
      if (config === undefined || parseWebDavUrl(config.url) === null) {
        sendJson(res, 400, { error: 'webdav-not-configured', hint: '先填写 WebDAV 地址' });
        return;
      }
      try {
        const probe = await probeWebDav(config);
        sendJson(res, probe.ok ? 200 : 502, probe);
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message.slice(0, 160) : 'webdav-unreachable',
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/ops') {
      const notify = notifier.describe();
      sendJson(res, 200, {
        notify: { enabled: notify.enabled, channels: notify.channels },
        webdav: { configured: parseWebDavUrl(webdavConfig()?.url) !== null },
        scheduler: { intervalMs: SCHEDULER_INTERVAL_MS },
      });
      return;
    }

    if (pathname === '/api/runtime') {
      // 运行时段按配置存：手机要 fake-ip + TUN，路由器要 redir-host，两者不该互相牵制。
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const modes = effectiveModes(
          definition,
          store.listGroupOverrides(definition.id).length > 0,
          store.listRules(definition.id).length > 0,
        );
        sendJson(res, 200, {
          runtime: definition.runtime ?? null,
          dnsMode: modes.dns,
          targets: Object.fromEntries(
            CLIENT_TARGETS.map((target) => [target, verifiedCapabilityTables.runtime[target]]),
          ),
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['runtime'];
        // 传 null / 缺省 = 清空。清空是合法操作（回到「不写 DNS / TUN 段」）。
        if (candidate === null || candidate === undefined) {
          store.putProfileRuntime(definition.id, null);
          const requested = asOverlayMode(body['dnsMode']);
          if (requested !== undefined) {
            const current = effectiveModes(
              definition,
              store.listGroupOverrides(definition.id).length > 0,
              store.listRules(definition.id).length > 0,
            );
            store.putSectionModes(definition.id, { ...current, dns: requested });
          }
          sendJson(res, 200, { ok: true, runtime: null });
          return;
        }
        try {
          const parsed = parseRuntime(candidate);
          store.putProfileRuntime(definition.id, parsed);
          const requested = asOverlayMode(body['dnsMode']);
          if (requested !== undefined) {
            const current = effectiveModes(
              definition,
              store.listGroupOverrides(definition.id).length > 0,
              store.listRules(definition.id).length > 0,
            );
            store.putSectionModes(definition.id, { ...current, dns: requested });
          }
          sendJson(res, 200, { ok: true, runtime: parsed });
        } catch (error) {
          sendJson(res, 400, {
            error: 'invalid-runtime-policy',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
        return;
      }
    }

    if (pathname === '/api/settings/notify') {
      if (method === 'GET') {
        const raw = store.getSetting(SETTING_NOTIFY);
        const active = notifyConfig();
        // value 是「界面覆盖值」的扁平视图（enabled / botToken / chatId / barkUrl），
        // 只在库里确实存过时才有；环境变量默认值走 envDefaults 单独标注，避免界面误显示为空。
        let stored: Record<string, unknown> | null = null;
        if (raw !== undefined) {
          try {
            stored = notifyViewOf(JSON.parse(raw) as NotifyConfig | null);
          } catch {
            stored = null;
          }
        }
        sendJson(res, 200, {
          value: stored,
          envDefaults: options.notify ?? null,
          effective: active ?? null,
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['notify'];
        // null = 清除界面覆盖，回退环境变量。
        if (candidate === null || candidate === undefined) {
          store.putSetting(SETTING_NOTIFY, 'null');
          // 响应形状与 GET 的 value 对齐（扁平视图），调用方「保存后回读表单」不必特判两种形状。
          sendJson(res, 200, { ok: true, value: null });
          return;
        }
        const parsed = parseNotifyConfig(candidate);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-notify-config' });
          return;
        }
        store.putSetting(SETTING_NOTIFY, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, value: notifyViewOf(parsed) });
        return;
      }
    }

    if (pathname === '/api/settings/webdav') {
      if (method === 'GET') {
        const raw = store.getSetting(SETTING_WEBDAV);
        const active = webdavConfig();
        // 密码绝不回传明文给前端：value 里只回 url/username，密码用 hasPassword 布尔表示，
        // 前端据此判断「已设过密码」但需重填才可保存新值。
        let value: { url: string; username?: string; hasPassword: boolean } | null = null;
        if (raw !== undefined) {
          try {
            const parsed = JSON.parse(raw) as WebDavConfig;
            if (parseWebDavUrl(parsed.url) !== null) {
              value = {
                url: parsed.url,
                ...(parsed.username === undefined ? {} : { username: parsed.username }),
                hasPassword: parsed.password !== undefined,
              };
            }
          } catch {
            value = null;
          }
        }
        sendJson(res, 200, {
          value,
          envDefaults:
            options.webdav === undefined
              ? null
              : { url: options.webdav.url, hasPassword: options.webdav.password !== undefined },
          effective: active === undefined ? null : { url: active.url, hasCredentials: active.username !== undefined },
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['webdav'];
        if (candidate === null || candidate === undefined) {
          store.putSetting(SETTING_WEBDAV, 'null');
          sendJson(res, 200, { ok: true, webdav: null });
          return;
        }
        // 密码框留空 = 保持旧密码：从当前存库配置里继承。
        const existing = webdavConfig();
        const parsed = parseWebdavConfig(candidate, existing);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-webdav-config' });
          return;
        }
        store.putSetting(SETTING_WEBDAV, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, webdav: { url: parsed.url, hasCredentials: parsed.username !== undefined } });
        return;
      }
    }

    if (pathname === '/api/settings/fetch-defaults') {
      if (method === 'GET') {
        const raw = store.getSetting(SETTING_FETCH_DEFAULTS);
        let stored: FetchDefaults = EMPTY_FETCH_DEFAULTS;
        if (raw !== undefined && raw !== 'null') {
          try {
            stored = parseFetchDefaults(JSON.parse(raw)) ?? EMPTY_FETCH_DEFAULTS;
          } catch {
            stored = EMPTY_FETCH_DEFAULTS;
          }
        }
        sendJson(res, 200, {
          value: raw === undefined || raw === 'null' ? null : fetchDefaultsView(stored),
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['defaults'];
        if (candidate === null || candidate === undefined) {
          // 与 WebDAV 清除同构：存字符串 'null' 表示「未配置」，GET 据此返回 value: null。
          store.putSetting(SETTING_FETCH_DEFAULTS, 'null');
          sendJson(res, 200, { ok: true, value: null });
          return;
        }
        // header 值回显是脱敏的，原样提交时从旧值继承（同 WebDAV 密码）。
        const parsed = parseFetchDefaults(candidate, fetchDefaults(store));
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-fetch-defaults' });
          return;
        }
        store.putSetting(SETTING_FETCH_DEFAULTS, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, value: fetchDefaultsView(parsed) });
        return;
      }
    }

    sendJson(res, 404, { error: 'unknown-api-route' });
  };

  /**
   * 拼出「外部能打开」的绝对地址。二维码里必须是绝对 URL，否则扫出来是一段无法访问的相对路径。
   * 优先用部署时声明的 publicBaseUrl；没配则按请求本身推断（反向代理需要设置 X-Forwarded-Proto）。
   */
  const absoluteUrlOf = (req: IncomingMessage, pathname: string, search: string): string => {
    const configured = options.publicBaseUrl?.replace(/\/+$/, '');
    if (configured !== undefined) return `${configured}${pathname}${search}`;
    const forwarded = req.headers['x-forwarded-proto'];
    const proto =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ??
      ((req.socket as { encrypted?: boolean }).encrypted === true ? 'https' : 'http');
    return `${proto}://${req.headers.host ?? 'localhost'}${pathname}${search}`;
  };

  const renderSubscription = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const pathname = url.pathname;
    // 两种路径形态 × 两种后缀：
    //   /s/<token>                        按 UA 自适应
    //   /s/<token>/<profile>/<target>     锁定目标
    //   后缀 /diagnostics 出调试 JSON，/qr.svg 出二维码；后缀不参与 token 匹配。
    const adaptive = /^\/s\/([^/]+)(\/(diagnostics|qr\.svg))?$/.exec(pathname);
    const locked = /^\/s\/([^/]+)\/([^/]+)\/([^/]+)(\/(diagnostics|qr\.svg))?$/.exec(pathname);
    const match = adaptive ?? locked;
    if (match === null) {
      sendJson(res, 404, { error: 'invalid-subscription-path' });
      return;
    }
    // 最后一个捕获组是内层分组，取到的是不带斜杠的后缀名（`diagnostics` / `qr.svg`）。
    const suffix = match[match.length - 1] ?? '';
    const diagnosticsSuffix = suffix === 'diagnostics' ? suffix : undefined;
    const rawToken = decodeURIComponent(match[1] ?? '');
    const record = store.findTokenByHash(hashToken(rawToken));
    if (record === undefined || record.revoked) {
      sendJson(res, 404, { error: 'token-invalid-or-revoked' });
      return;
    }

    if (suffix === 'qr.svg') {
      // 二维码只编码「这个订阅地址本身」，不跑 Ingest / Plan / Emit。
      // 也就是说：配置坏了二维码照样能出，因为扫出来的是地址，不是配置内容。
      const subscriptionPath = pathname.replace(/\/qr\.svg$/, '');
      const targetUrl = absoluteUrlOf(req, subscriptionPath, url.search);
      const svg = renderQrSvg(targetUrl, {
        ec: 'M', // M 级（约 15% 容错）是「手机屏上扫得动」与「码不太密」的平衡点
        moduleSize: 4,
        title: `${record.profile} · 订阅二维码`,
      });
      send(res, 200, svg, {
        'content-type': 'image/svg+xml; charset=utf-8',
        // 二维码只随地址变。但地址里含 token，不许被中间缓存长期留存。
        'cache-control': 'private, max-age=300',
      });
      return;
    }

    let profileName: string;
    let target: ClientTarget;
    if (adaptive !== null) {
      profileName = record.profile;
      if (record.target !== 'auto') {
        target = record.target;
      } else {
        const ua = req.headers['user-agent'] ?? '';
        const guessed = UA_TARGETS.find((item) => item.pattern.test(ua))?.target;
        if (guessed === undefined) {
          sendJson(res, 400, {
            error: 'unknown-user-agent',
            hint: 'append /profile/target to the URL, or request with a known client UA',
          });
          return;
        }
        target = guessed;
      }
    } else {
      profileName = decodeURIComponent(match[2] ?? '');
      const rawTarget = match[3] ?? '';
      if (!isTarget(rawTarget)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      target = rawTarget;
      if (record.profile !== profileName || (record.target !== 'auto' && record.target !== target)) {
        sendJson(res, 404, { error: 'token-invalid-or-revoked' });
        return;
      }
    }

    const state = await prepareState(profileName);
    if (state === null) {
      sendJson(res, 404, { error: 'profile-not-found' });
      return;
    }

    // 参数化订阅：include / exclude / prefix / limit 只作用于本次响应，不改库、不进缓存。
    const include = url.searchParams.getAll('include').flatMap((value) => value.split(',')).filter((value) => value.trim().length > 0);
    const exclude = url.searchParams.getAll('exclude').flatMap((value) => value.split(',')).filter((value) => value.trim().length > 0);
    const prefix = (url.searchParams.get('prefix') ?? '').trim();
    const limitRaw = Number(url.searchParams.get('limit') ?? '0');
    const queryFilter: MemberFilter | undefined =
      include.length > 0 || exclude.length > 0 || prefix.length > 0 || limitRaw > 0
        ? {
            include,
            exclude,
            ...(prefix.length === 0 ? {} : { prefix }),
            ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
          }
        : undefined;

    /**
     * ETag 必须标识「这次真正返回的表示」，而不只是上游状态：
     * 同一个 token 的自适应 Surge / mihomo、带过滤与不带过滤、诊断 JSON 与订阅正文
     * 都是不同表示。只拿 state.etag 比较会让客户端拿 304 却保留另一份内容。
     */
    const responseEtag = `"${sha256(
      JSON.stringify({
        state: state.etag,
        target,
        suffix: diagnosticsSuffix ?? 'subscription',
        filter: queryFilter ?? null,
      }),
    ).slice(0, 32)}"`;

    // 订阅正文可以 304；诊断 JSON 里有 `upstream-stale:45s` 这类随时间变化的年龄字段，
    // 同一份 state.etag 不能代表它，所以诊断请求总是重新生成（仍返回 ETag 供客户端参考）。
    if (diagnosticsSuffix === undefined && ifNoneMatch(req.headers['if-none-match'], responseEtag)) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        ETag: responseEtag,
        Vary: 'User-Agent',
        'Cache-Control': 'no-cache',
      });
      res.end();
      return;
    }

    const cachedBuild = queryFilter === undefined ? buildCache.getL2(state.etag, target) : undefined;
    let output: BuildOutput;
    let extraDiagnostics: readonly Diagnostic[];
    if (cachedBuild !== undefined) {
      output = { target, content: cachedBuild.content, report: cachedBuild.report };
      extraDiagnostics = cachedBuild.diagnostics;
    } else {
      const built = await buildFromSnapshots(state, target, queryFilter);
      const found = built.output;
      output = found;
      extraDiagnostics = built.diagnostics;
      if (queryFilter === undefined) {
        buildCache.setL2(state.etag, target, {
          content: found.content,
          report: found.report,
          diagnostics: built.diagnostics,
        });
      }
    }

    const buildId = output.report.buildId ?? randomUUID();
    store.saveBuildReport({
      buildId,
      target,
      report: output.report,
      createdAt: new Date().toISOString(),
    });
    store.pruneBuildReports(200); // 历史诊断只保留最近 200 次构建

    const definition = findProfile(profileName);
    const usedSources =
      definition === undefined
        ? []
        : store
            .listSources()
            .filter((source) => sourceIdsOf(segmentsOf(definition)).includes(source.id));
    const traffic = userinfoHeader(usedSources);
    /**
     * 一行摘要。客户端看不见，但 `curl -I` 时能立刻回答「这次到底出了什么事」：
     * 节点数掉没掉、跳过了多少、这次真正喂进构建的有几个源、其中几个在用旧快照。
     *
     * `sources` 取 `state.snapshots.length`（本次真的拿到 body 的源），不是 Profile 里配置的源数：
     * 拉取失败的源在配置里仍然占一格，报上去会让人以为它参与了构建。
     * `stale` 取**本次构建真的回退了**的源数（看 upstream-stale 诊断），
     * 而不是「缓存里有没有旧快照」——后者会把「刚刚拉成功、但缓存里另有一份旧的」也算成陈旧。
     */
    const staleCount = state.diagnostics.filter((item) => item.reason.startsWith('upstream-stale:')).length;
    const summary = `nodes=${output.report.passed} skipped=${output.report.skipped} sources=${state.snapshots.length} stale=${staleCount}`;
    const headers: Record<string, string> = {
      ETag: responseEtag,
      Vary: 'User-Agent',
      'Cache-Control': 'no-cache',
      'X-Startrails-Build-Id': buildId,
      'X-Startrails-Skipped': String(output.report.skipped),
      'X-Startrails-Summary': summary,
      ...(traffic === null ? {} : { 'subscription-userinfo': traffic }),
    };

    if (diagnosticsSuffix !== undefined) {
      send(res, 200, JSON.stringify({
        buildId,
        target,
        etag: responseEtag,
        summary,
        report: {
          ...output.report,
          diagnostics: redacted([...extraDiagnostics, ...output.report.diagnostics]),
        },
      }), {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
      });
      return;
    }

    const contentType = CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format];
    // `?download=1`：直接把产物当文件拿走（离线分发 / 塞进别的工具）。
    // 文件名去掉引号与换行，避免拼出畸形的 Content-Disposition。
    const download = url.searchParams.get('download');
    const disposition =
      download === null || download === '0' || download === 'false'
        ? null
        : `attachment; filename="${`${profileName}-${outputFilename(target)}`
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .slice(0, 80)}"`;
    send(res, 200, output.content, {
      ...headers,
      'content-type': contentType,
      ...(disposition === null ? {} : { 'content-disposition': disposition }),
    });
  };

  /**
   * 无状态一次性转换：`GET /sub?url=<订阅地址>&target=<客户端>`。
   *
   * 与 `/s/<token>` 的区别只有一个——**不落库**：不建源、不建 Profile、不建 token、不写构建历史。
   * 给脚本化场景（CI 里生成一份 surge.conf）和「同事发来一个订阅，我只想看一眼」用。
   *
   * 默认关闭。开启后仍走 `assertPublicUrl`，SSRF 面与「建一个远端源」完全一致；
   * 但它是匿名可达的，所以是否开放必须由部署侧显式决定，不能默认给。
   */
  const renderStateless = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (options.allowStateless !== true) {
      sendJson(res, 404, {
        error: 'stateless-disabled',
        hint: 'GET /sub?url=&target= is off by default; enable allowStateless to open it',
      });
      return;
    }
    const rawUrl = (url.searchParams.get('url') ?? '').trim();
    if (rawUrl.length === 0) {
      sendJson(res, 400, { error: 'missing-url' });
      return;
    }
    const rawTarget = (url.searchParams.get('target') ?? 'auto').trim();
    let target: ClientTarget;
    if (rawTarget.length === 0 || rawTarget === 'auto') {
      const ua = req.headers['user-agent'] ?? '';
      const guessed = UA_TARGETS.find((item) => item.pattern.test(ua))?.target;
      if (guessed === undefined) {
        sendJson(res, 400, { error: 'unknown-target', hint: 'pass ?target=<client> or use a known client UA' });
        return;
      }
      target = guessed;
    } else if (isTarget(rawTarget)) {
      target = rawTarget;
    } else {
      sendJson(res, 400, { error: 'unknown-target', target: rawTarget });
      return;
    }

    let body: string;
    try {
      const fetched = await fetchSnapshot(rawUrl, null, { allowPrivate: options.allowPrivate ?? false });
      if (fetched.body === null) throw new Error('upstream-empty');
      body = fetched.body;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      sendJson(res, 502, { error: 'upstream-failed', reason: redact(reason).slice(0, 160) });
      return;
    }

    // 别人的订阅就按它自己的内容出，不套本地的内联规则、分组覆盖，也不套某一份配置的
    // DNS / TUN：那三项现在都跟着配置走，而无状态端点不属于任何一份配置。
    const parsed = ingest(body);
    const deduped = dedupeNodes(parsed.profile.nodes, 'nodeKey');
    const profile = await withRuleSetMirror(
      parseProfile({
        nodes: [...deduped.nodes],
        ruleSources: [...parsed.profile.ruleSources],
        policyGroups: [...parsed.profile.policyGroups],
      }),
    );
    const output = buildOne(profile, target);
    send(res, 200, output.content, {
      'content-type': CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format],
      'x-startrails-stateless': '1',
      'x-startrails-summary': `nodes=${output.report.passed} skipped=${output.report.skipped} sources=1 stale=0`,
      // 不进任何缓存：内容是「输入 URL 的即时函数」，缓存只会让上游变更后的结果对不上。
      'cache-control': 'no-store',
    });
  };

  const server = createServer((req, res) => {
    // URL 解析器会先把 %2e%2e 规范化掉，所以要在解析前检查原始路径。
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (/%2e%2e|\.\./i.test(rawPath)) {
      send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    // Host 头是客户端可控的：用它拼 base 可能让 new URL 抛错。这个回调在 try 之外，
    // 未捕获的同步异常会直接打崩进程，所以坏 URL 必须在这里就地变成 400。
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'invalid-request-url' });
      return;
    }
    const pathname = url.pathname;
    void (async () => {
      try {
        if (pathname === '/health') {
          sendJson(res, 200, { ok: true, version: instanceVersion(), coreVersion: CORE_VERSION });
        } else if (pathname.startsWith('/rules/')) {
          await serveRuleSet(res, pathname.slice('/rules/'.length));
        } else if (pathname.startsWith('/api/')) {
          await handleApi(req, res, pathname, url);
        } else if (pathname.startsWith('/s/')) {
          await renderSubscription(req, res, url);
        } else if (pathname === '/sub') {
          await renderStateless(req, res, url);
        } else {
          serveStatic(pathname, res);
        }
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        // 路径里的 % 编码不合法（例如 %E0%A4%A）是客户端错误，不是服务端 500。
        if (error instanceof URIError) {
          sendJson(res, 400, { error: 'invalid-url-encoding' });
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: 'internal-error', reason: redact(reason) });
      }
    })();
  });

  /**
   * 调度器：每 60 秒检查一次到期源。用 unref() 让定时器不阻止进程退出
   * ——单测里创建 App 不会因为调度器挂着而无法结束。
   */
  const scheduler = setInterval(() => {
    void refreshDue().catch(() => undefined);
  }, SCHEDULER_INTERVAL_MS);
  scheduler.unref();

  return {
    server,
    refreshDue,
    close: () =>
      new Promise<void>((done, reject) => {
        clearInterval(scheduler);
        // 未 listen 过（测试里只调 refreshDue 的场景）时 server.close 会抛 ERR_SERVER_NOT_RUNNING，
        // 关闭动作必须是幂等的，否则调用方还要自己判断有没有监听。
        if (!server.listening) {
          done();
          return;
        }
        server.close((error) => (error === undefined ? done() : reject(error)));
      }),
  };
}
