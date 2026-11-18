import { validateHeaderName, validateHeaderValue } from 'node:http';
import {
  CLIENT_TARGETS,
  SOURCE_FORMATS,
  parseProfile,
} from '../core/index.ts';
import type {
  ClientTarget,
  InlineRule,
  MemberFilter,
  Process,
  SourceFormat,
} from '../core/index.ts';
import type {
  OverlayMode,
  PersistedGroupOverride,
  Store,
  StoredMember,
  StoredRule,
} from '../store/port.ts';
import { parseWebDavUrl } from './backup.ts';
import type { WebDavConfig } from './backup.ts';
import type { NotifyConfig } from './notify.ts';
import { parseProxyUrl } from './proxy-fetch.ts';
import { hasRedactionMarkers } from './redact.ts';

/** 实例级拉取默认的设置键；值存 JSON，header 值回显掩码。 */
export const SETTING_FETCH_DEFAULTS = 'fetch.defaults';

/** 一个链接喂所有客户端：按 UA 猜不出时明确拒绝，不静默给错格式。 */
export const UA_TARGETS: readonly { readonly pattern: RegExp; readonly target: ClientTarget }[] = [
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

export const guessTargetByUa = (ua: string): ClientTarget | undefined =>
  UA_TARGETS.find((item) => item.pattern.test(ua))?.target;

export const isTarget = (value: string): value is ClientTarget =>
  (CLIENT_TARGETS as readonly string[]).includes(value);

export const isSourceFormat = (value: string): value is SourceFormat =>
  (SOURCE_FORMATS as readonly string[]).includes(value);

export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const asOverlayMode = (value: unknown): OverlayMode | undefined =>
  value === 'inherit' || value === 'replace' || value === 'merge' ? value : undefined;

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
export const proxyFrom = (raw: unknown): { readonly ok: boolean; readonly value?: string } => {
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
export const parseProcesses = (raw: unknown): Process[] => {
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
export const buildFilter = (raw: Record<string, unknown>): MemberFilter | undefined => {
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
export const parseNotifyConfig = (raw: unknown): NotifyConfig | null => {
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
export const notifyViewOf = (config: NotifyConfig | null): Record<string, unknown> | null => {
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
export const parseWebdavConfig = (raw: unknown, inheritPasswordFrom?: WebDavConfig): WebDavConfig | null => {
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
export interface FetchDefaults {
  readonly ua?: string;
  readonly proxy?: string;
  readonly headers: Readonly<Record<string, string>>;
}

export const EMPTY_FETCH_DEFAULTS: FetchDefaults = { headers: {} };
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
export const parseFetchDefaults = (raw: unknown, inheritFrom?: FetchDefaults): FetchDefaults | null => {
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
export const fetchDefaults = (store: Store): FetchDefaults => {
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
export const fetchDefaultsView = (config: FetchDefaults) => ({
  ua: config.ua ?? null,
  proxy: config.proxy ?? null,
  headers: Object.entries(config.headers).map(([name]) => ({
    name,
    value: FETCH_HEADER_MASK,
  })),
});

export function parseStoredRules(rules: readonly unknown[]): StoredRule[] | null {
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

export function parseStoredGroups(groups: readonly unknown[]): PersistedGroupOverride[] {
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
