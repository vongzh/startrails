import YAML from 'yaml';
import type {
  DnsPolicy,
  InlineRule,
  NodeOptions,
  NodeTransport,
  ObfsOptions,
  PluginOptions,
  PolicyGroup,
  ProxyNode,
  RuleSource,
  RuleSetShape,
  RuntimePolicy,
} from '../ir/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';

export interface ParseOutcome {
  readonly nodes: readonly ProxyNode[];
  readonly ruleSources: readonly RuleSource[];
  readonly policyGroups: readonly PolicyGroup[];
  readonly runtime?: RuntimePolicy | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly parsed: number;
  readonly skipped: number;
}

export const emptyOutcome = (): ParseOutcome => ({
  nodes: [],
  ruleSources: [],
  policyGroups: [],
  diagnostics: [],
  parsed: 0,
  skipped: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 && parsed <= 65535 ? parsed : undefined;
  }
  return undefined;
};

const positive = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
};

const truthy = (value: unknown): boolean => value === true || value === 'true' || value === 'tls';

const transportOf = (value: unknown): NodeTransport | undefined => {
  if (value === 'ws') return 'ws';
  if (value === 'grpc') return 'grpc';
  if (value === 'h2' || value === 'http2' || value === 'http') return 'http2';
  return undefined;
};

const obfsOf = (value: unknown): ObfsOptions | undefined => {
  if (value === 'salamander' || value === 'gecko' || value === 'http' || value === 'tls') {
    return { type: value };
  }
  return undefined;
};

/** exactOptionalPropertyTypes 下不能写 `field: undefined`，统一用紧凑对象过滤。 */
const optionsOf = (parts: Record<string, unknown>): NodeOptions | undefined => {
  const cleaned = Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined));
  return Object.keys(cleaned).length > 0 ? (cleaned as NodeOptions) : undefined;
};

const withOptions = (node: ProxyNode, options: NodeOptions | undefined): ProxyNode =>
  options === undefined ? node : ({ ...node, options } as ProxyNode);

const splitHostPort = (value: string): { host: string; port: number } | null => {
  const match = /^\[?([^\]:]+)\]?:(\d+)$/.exec(value);
  if (match === null) return null;
  const port = num(match[2]);
  return port === undefined ? null : { host: match[1] ?? '', port };
};

const decodeBase64 = (input: string): string | null => {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
};

/** 逗号分隔但尊重双引号：`a,"b,c",d` → ['a','b,c','d']。 */
const splitRespectingQuotes = (value: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"' && value[i - 1] !== '\\') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => unquote(part));
};

const skipped = (diagnostics: Diagnostic[], subject: string, reason: string): void => {
  diagnostics.push(makeDiagnostic('ingest', null, subject.slice(0, 80), reason));
};

/** SIP002 的 `plugin=obfs-local;obfs=http;obfs-host=x` 或 mihomo 的 plugin-opts 对象。 */
const pluginFromSip003 = (value: string): { plugin: string; pluginOpts?: PluginOptions } | null => {
  const parts = value.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
  const name = parts[0];
  if (name === undefined) return null;
  const opts: Record<string, unknown> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      if (part === 'tls') opts['tls'] = true;
      continue;
    }
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (key === 'obfs' || key === 'mode') opts['mode'] = raw;
    if (key === 'obfs-host' || key === 'host') opts['host'] = raw;
    if (key === 'path') opts['path'] = raw;
    if (key === 'tls') opts['tls'] = raw !== 'false';
    // shadow-tls 的三件套：伪装域名、独立密码、协议版本。少写任何一个都会握手失败。
    if (key === 'password') opts['password'] = raw;
    if (key === 'version') {
      const version = Number(raw);
      if (Number.isInteger(version) && version >= 1 && version <= 3) opts['version'] = version;
    }
  }
  return Object.keys(opts).length === 0
    ? { plugin: name }
    : { plugin: name, pluginOpts: opts as PluginOptions };
};

/** 公开分享链接：vless / trojan / vmess / ss / hysteria2 / tuic / anytls。 */
export function parseSubscriptionUris(raw: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const nodes: ProxyNode[] = [];
  let skippedCount = 0;

  // 整段 base64 订阅（无 URI 前缀）先解码一次。
  const trimmed = raw.trim();
  const body = /^(?:[a-z0-9+.-]+:\/\/)/i.test(trimmed) ? trimmed : (decodeBase64(trimmed) ?? trimmed);

  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) continue;
    if (!/^[a-z0-9+.-]+:\/\//i.test(text)) {
      skipped(diagnostics, text, 'unsupported-line:not-a-uri');
      skippedCount += 1;
      continue;
    }

    const node = parseUri(text, diagnostics);
    if (node === null) {
      skippedCount += 1;
    } else {
      nodes.push(node);
    }
  }

  return {
    nodes,
    ruleSources: [],
    policyGroups: [],
    diagnostics,
    parsed: nodes.length,
    skipped: skippedCount,
  };
}

function parseUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  if (text.startsWith('vmess://')) return parseVmessUri(text, diagnostics);
  if (text.startsWith('ss://')) return parseSsUri(text, diagnostics);
  if (text.startsWith('hysteria2://') || text.startsWith('hy2://')) {
    return parseHysteria2Uri(text, diagnostics);
  }
  if (text.startsWith('tuic://')) return parseTuicUri(text, diagnostics);
  if (text.startsWith('anytls://')) return parseAnytlsUri(text, diagnostics);
  if (text.startsWith('wireguard://') || text.startsWith('wg://')) {
    return parseWireguardUri(text, diagnostics);
  }
  if (text.startsWith('socks5://') || text.startsWith('socks://') || text.startsWith('http://') || text.startsWith('https://')) {
    return parseProxyUri(text, diagnostics);
  }
  if (text.startsWith('vless://') || text.startsWith('trojan://')) {
    return parseStandardUri(text, diagnostics);
  }
  skipped(diagnostics, text, 'unsupported-scheme');
  return null;
}

/** 拆 `${scheme}://auth@host:port[/]?query#name`，端口里可能带逗号（Hysteria2 端口跳跃）。 */
function splitUri(text: string): {
  auth: string;
  host: string;
  port: number;
  ports?: string;
  query: URLSearchParams;
  name: string;
} | null {
  const schemeAt = text.indexOf('://');
  if (schemeAt < 0) return null;
  const rest = text.slice(schemeAt + 3);
  const hashAt = rest.indexOf('#');
  const name = hashAt >= 0 ? decodeURIComponent(rest.slice(hashAt + 1)) : '';
  const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const questionAt = beforeHash.indexOf('?');
  const query = new URLSearchParams(questionAt >= 0 ? beforeHash.slice(questionAt + 1) : '');
  const main = (questionAt >= 0 ? beforeHash.slice(0, questionAt) : beforeHash).replace(/\/$/, '');
  const at = main.lastIndexOf('@');
  const auth = at >= 0 ? decodeURIComponent(main.slice(0, at)) : '';
  const hostPort = at >= 0 ? main.slice(at + 1) : main;
  const colon = hostPort.lastIndexOf(':');
  if (colon < 0) return null;
  const host = hostPort.slice(0, colon).replace(/^\[|\]$/g, '');
  const portPart = hostPort.slice(colon + 1);
  if (host.length === 0) return null;
  if (/^\d+$/.test(portPart)) {
    const port = num(portPart);
    return port === undefined ? null : { auth, host, port, query, name };
  }
  // `123,5000-6000` 这类端口跳跃写法：首个数字是主端口，其余整体存 ports。
  const first = /^\d+/.exec(portPart)?.[0];
  const port = first === undefined ? undefined : num(first);
  if (port === undefined) return null;
  return { auth, host, port, ports: portPart, query, name };
}

function parseStandardUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-uri');
    return null;
  }
  const { auth, host, port, query, name } = parts;
  const security = query.get('security');
  const realityPublicKey = query.get('pbk');
  const reality =
    realityPublicKey === null || realityPublicKey.length === 0
      ? undefined
      : {
          publicKey: realityPublicKey,
          ...(query.get('sid') === null ? {} : { shortId: query.get('sid') as string }),
          ...(query.get('fp') === null ? {} : { fingerprint: query.get('fp') as string }),
          ...(query.get('spx') === null ? {} : { spiderX: query.get('spx') as string }),
        };
  const alpn = query.get('alpn');
  const grpcService = query.get('serviceName');
  const options = optionsOf({
    tls: security === 'tls' || security === 'reality' ? true : undefined,
    sni: query.get('sni') ?? undefined,
    transport: transportOf(query.get('type')),
    path: (query.get('type') === 'grpc' ? grpcService : query.get('path')) ?? undefined,
    host: query.get('host') ?? undefined,
    flow: query.get('flow') ?? undefined,
    reality,
    alpn: alpn === null ? undefined : alpn.split(',').filter((item) => item.length > 0),
    insecure: query.get('allowInsecure') === '1' || query.get('insecure') === '1' ? true : undefined,
  });
  const base = { name: name || host, server: host, port };

  if (text.startsWith('vless://')) {
    return withOptions({ ...base, kind: 'vless', uuid: auth }, options);
  }
  return withOptions({ ...base, kind: 'trojan', password: auth }, options);
}

/** Hysteria 2 官方 URI Scheme：userinfo=密码，query 含 obfs / obfs-password / sni / insecure / pinSHA256。 */
function parseHysteria2Uri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-hysteria2-uri');
    return null;
  }
  const { auth, host, port, ports, query, name } = parts;
  if (auth.length === 0) {
    skipped(diagnostics, text, 'missing-hysteria2-auth');
    return null;
  }
  const obfsType = query.get('obfs');
  const obfs = obfsOf(obfsType);
  const options = optionsOf({
    sni: query.get('sni') ?? undefined,
    insecure: query.get('insecure') === '1' ? true : undefined,
    obfs:
      obfs === undefined
        ? undefined
        : { ...obfs, ...(query.get('obfs-password') === null ? {} : { password: query.get('obfs-password') ?? '' }) },
    ports,
  });
  return withOptions(
    { kind: 'hysteria2', name: name || host, server: host, port, password: auth },
    options,
  );
}

/** tuic:// 无官方规范，按 uuid:password@host:port 的通行约定解析。 */
function parseTuicUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-tuic-uri');
    return null;
  }
  const { auth, host, port, query, name } = parts;
  const colon = auth.indexOf(':');
  if (colon <= 0) {
    skipped(diagnostics, text, 'tuic-requires-uuid-password');
    return null;
  }
  const alpn = query.get('alpn');
  const options = optionsOf({
    sni: query.get('sni') ?? undefined,
    congestionControl: query.get('congestion_control') ?? undefined,
    udpRelayMode: query.get('udp_relay_mode') ?? undefined,
    alpn: alpn === null ? undefined : alpn.split(',').filter((item) => item.length > 0),
    insecure:
      query.get('allow_insecure') === '1' || query.get('insecure') === '1' ? true : undefined,
  });
  return withOptions(
    {
      kind: 'tuic',
      name: name || host,
      server: host,
      port,
      uuid: auth.slice(0, colon),
      password: auth.slice(colon + 1),
    },
    options,
  );
}

function parseAnytlsUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-anytls-uri');
    return null;
  }
  const { auth, host, port, query, name } = parts;
  if (auth.length === 0) {
    skipped(diagnostics, text, 'missing-anytls-password');
    return null;
  }
  const alpn = query.get('alpn');
  const options = optionsOf({
    sni: query.get('sni') ?? undefined,
    insecure: query.get('insecure') === '1' ? true : undefined,
    alpn: alpn === null ? undefined : alpn.split(',').filter((item) => item.length > 0),
  });
  return withOptions(
    { kind: 'anytls', name: name || host, server: host, port, password: auth },
    options,
  );
}

/**
 * WireGuard URI：`wireguard://<privateKey>@<server>:<port>?publickey=<peerPubKey>&address=<ip>[&address=...]...`。
 * 字段约定依 Incy / 各客户端通行的分享链接：
 * - userinfo = 本地私钥（base64）
 * - `publickey` / `public_key` = 对端公钥
 * - `address` = 客户端隧道地址（可多值）
 * - `psk` / `pre-shared-key` = 预共享密钥
 * - `mtu`、`reserved`（`a,b,c` 三字节）、`allowedips` 可选。
 */
function parseWireguardUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-wireguard-uri');
    return null;
  }
  const { auth, host, port, query, name } = parts;
  const peerPublicKey = query.get('publickey') ?? query.get('public_key');
  if (auth.length === 0 || peerPublicKey === null || peerPublicKey.length === 0) {
    skipped(diagnostics, text, 'missing-wireguard-required-fields');
    return null;
  }
  const addresses = query.getAll('address').filter((item) => item.length > 0);
  if (addresses.length === 0) {
    skipped(diagnostics, text, 'missing-wireguard-address');
    return null;
  }
  const mtuRaw = query.get('mtu');
  const reservedRaw = query.get('reserved');
  const reserved =
    reservedRaw === null
      ? undefined
      : reservedRaw
          .split(',')
          .map((item) => Number(item.trim()))
          .filter((item) => Number.isFinite(item));
  const allowedIpsRaw = query.get('allowedips') ?? query.get('allowed-ips');
  const allowedIps =
    allowedIpsRaw === null
      ? undefined
      : allowedIpsRaw
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  return {
    kind: 'wireguard',
    name: name || host,
    server: host,
    port,
    privateKey: auth,
    peerPublicKey,
    ...(query.get('psk') === null && query.get('pre-shared-key') === null
      ? {}
      : { preSharedKey: (query.get('psk') ?? query.get('pre-shared-key')) as string }),
    addresses,
    ...(mtuRaw === null || mtuRaw === '' ? {} : { mtu: Number(mtuRaw) }),
    ...(reserved === undefined || reserved.length === 0 ? {} : { reserved }),
    ...(allowedIps === undefined || allowedIps.length === 0 ? {} : { allowedIps }),
  };
}

/**
 * 直连中转节点：`socks5://user:pass@host:port`、`http://user:pass@host:port`（也接受 https:// 作为 HTTP 代理）。
 * userinfo 里 `user:pass`，两者皆可选；无认证时省略 `@`。
 */
function parseProxyUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const parts = splitUri(text);
  if (parts === null) {
    skipped(diagnostics, text, 'invalid-proxy-uri');
    return null;
  }
  const { auth, host, port, name } = parts;
  const kind = text.startsWith('socks5://') || text.startsWith('socks://') ? 'socks5' : 'http';
  const colon = auth.indexOf(':');
  const username = colon < 0 ? (auth.length > 0 ? auth : undefined) : auth.slice(0, colon);
  const password = colon < 0 ? undefined : auth.slice(colon + 1);
  return {
    kind,
    name: name || host,
    server: host,
    port,
    ...(username === undefined || username.length === 0 ? {} : { username }),
    ...(password === undefined || password.length === 0 ? {} : { password }),
  };
}

function parseVmessUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const decoded = decodeBase64(text.slice('vmess://'.length));
  if (decoded === null) {
    skipped(diagnostics, text, 'invalid-base64');
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(decoded) as unknown;
  } catch {
    skipped(diagnostics, text, 'invalid-vmess-json');
    return null;
  }
  if (!isRecord(data)) {
    skipped(diagnostics, text, 'invalid-vmess-shape');
    return null;
  }
  const port = num(data['port']);
  const server = str(data['add']);
  const uuid = str(data['id']);
  if (port === undefined || server === undefined || uuid === undefined) {
    skipped(diagnostics, text, 'missing-vmess-required-fields');
    return null;
  }
  const options = optionsOf({
    tls: truthy(data['tls']) ? true : undefined,
    sni: str(data['sni']),
    transport: transportOf(data['net']),
    path: str(data['path']),
    host: str(data['host']),
    alterId:
      typeof data['aid'] === 'number' && data['aid'] >= 0
        ? data['aid']
        : data['aid'] === '0' || data['aid'] === 0
          ? 0
          : undefined,
    cipher: str(data['scy']),
  });
  return withOptions(
    { kind: 'vmess', name: str(data['ps']) ?? `${server}:${port}`, server, port, uuid },
    options,
  );
}

function parseSsUri(text: string, diagnostics: Diagnostic[]): ProxyNode | null {
  const body = text.slice('ss://'.length);
  const hashAt = body.indexOf('#');
  const main = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const name = hashAt >= 0 ? decodeURIComponent(body.slice(hashAt + 1)) : '';
  const queryAt = main.indexOf('?');
  const core = queryAt >= 0 ? main.slice(0, queryAt) : main;
  const pluginRaw = queryAt >= 0 ? new URLSearchParams(main.slice(queryAt + 1)).get('plugin') : null;

  let credential: string | null;
  let hostPort: string;
  if (core.includes('@')) {
    const at = core.lastIndexOf('@');
    credential = decodeBase64(core.slice(0, at)) ?? core.slice(0, at);
    hostPort = core.slice(at + 1);
  } else {
    const decoded = decodeBase64(core);
    if (decoded === null) {
      skipped(diagnostics, text, 'invalid-base64');
      return null;
    }
    const at = decoded.lastIndexOf('@');
    if (at < 0) {
      skipped(diagnostics, text, 'invalid-ss-shape');
      return null;
    }
    credential = decoded.slice(0, at);
    hostPort = decoded.slice(at + 1);
  }

  const colon = credential.indexOf(':');
  const target = splitHostPort(hostPort);
  if (colon < 0 || target === null) {
    skipped(diagnostics, text, 'invalid-ss-credentials-or-host');
    return null;
  }
  const plugin = pluginRaw === null ? null : pluginFromSip003(pluginRaw);
  const options = optionsOf({
    ...(plugin === null ? {} : { plugin: plugin.plugin }),
    ...(plugin === null ? {} : { pluginOpts: plugin.pluginOpts }),
  });
  return withOptions(
    {
      kind: 'shadowsocks',
      name: name || `${target.host}:${target.port}`,
      server: target.host,
      port: target.port,
      method: credential.slice(0, colon),
      password: credential.slice(colon + 1),
    },
    options,
  );
}

/** Clash / mihomo YAML：proxies / proxy-groups / rule-providers。 */
export function parseClashYaml(raw: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const doc: unknown = YAML.parse(raw);
  if (!isRecord(doc) || !Array.isArray(doc['proxies'])) {
    return { ...emptyOutcome(), diagnostics: [makeDiagnostic('ingest', null, 'clash-yaml', 'missing-proxies-array')], skipped: 1 };
  }
  const nodes: ProxyNode[] = [];
  let skippedCount = 0;
  for (const entry of doc['proxies']) {
    const node = clashNode(entry, diagnostics);
    if (node === null) skippedCount += 1;
    else nodes.push(node);
  }
  const groups: PolicyGroup[] = [];
  if (Array.isArray(doc['proxy-groups'])) {
    for (const entry of doc['proxy-groups']) {
      const group = clashGroup(entry, diagnostics);
      if (group === null) skippedCount += 1;
      else groups.push(group);
    }
  }
  const ruleSources: RuleSource[] = [];
  const providerUrls = new Map<string, { url: string; shape?: RuleSetShape; encoding?: 'text' | 'yaml' }>();
  const shapeOfBehavior = (value: unknown): RuleSetShape | undefined =>
    value === 'domain' ? 'domain' : value === 'ipcidr' ? 'ipcidr' : value === 'classical' ? 'rules' : undefined;
  if (isRecord(doc['rule-providers'])) {
    for (const [key, value] of Object.entries(doc['rule-providers'])) {
      if (isRecord(value) && typeof value['url'] === 'string') {
        const shape = shapeOfBehavior(value['behavior']);
        const encoding = value['format'] === 'yaml' || value['format'] === 'text' ? value['format'] : undefined;
        providerUrls.set(key, {
          url: value['url'],
          ...(shape === undefined ? {} : { shape }),
          ...(encoding === undefined ? {} : { encoding }),
        });
      } else {
        skipped(diagnostics, key, 'rule-provider-without-url');
        skippedCount += 1;
      }
    }
  }
  // 规则按原文顺序留下。同一 provider 被引用多次时只保留第一次：一份规则集只能落在一个策略上。
  const seenRuleUrls = new Set<string>();
  let inline: InlineRule[] = [];
  const flushInline = (): void => {
    if (inline.length === 0) return;
    ruleSources.push({ kind: 'inline', rules: inline });
    inline = [];
  };
  if (Array.isArray(doc['rules'])) {
    for (const entry of doc['rules']) {
      if (typeof entry !== 'string') {
        skipped(diagnostics, 'rule', 'rule-not-modelled');
        skippedCount += 1;
        continue;
      }
      const parts = entry.split(',').map((part) => part.trim());
      const head = parts[0]?.toUpperCase();
      if (head === 'RULE-SET') {
        const provider = parts[1];
        const policy = parts[2];
        const meta = provider === undefined ? undefined : providerUrls.get(provider);
        if (provider === undefined || policy === undefined || meta === undefined || seenRuleUrls.has(meta.url)) {
          if (meta === undefined) skipped(diagnostics, entry.slice(0, 80), 'rule-provider-unknown');
          skippedCount += 1;
          continue;
        }
        flushInline();
        seenRuleUrls.add(meta.url);
        ruleSources.push({
          kind: 'external',
          url: meta.url,
          policy,
          ...(meta.shape === undefined ? {} : { shape: meta.shape }),
          ...(meta.encoding === undefined ? {} : { encoding: meta.encoding }),
        });
        continue;
      }
      const rule = clashInlineRule(parts);
      if (rule === null) {
        skipped(diagnostics, entry.slice(0, 80), `rule-not-modelled:${head ?? 'rule'}`);
        skippedCount += 1;
        continue;
      }
      inline.push(rule);
    }
  }
  flushInline();
  // 有 url 但没被 rules 引用的 provider 仍要记下来（去重 + 镜像），只是拿不到 policy。
  for (const [key, meta] of providerUrls) {
    if (seenRuleUrls.has(meta.url)) continue;
    seenRuleUrls.add(meta.url);
    ruleSources.push({
      kind: 'external',
      url: meta.url,
      ...(meta.shape === undefined ? {} : { shape: meta.shape }),
      ...(meta.encoding === undefined ? {} : { encoding: meta.encoding }),
    });
    if (!Array.isArray(doc['rules'])) skipped(diagnostics, key, 'rule-provider-without-policy');
  }
  const runtime = clashRuntime(doc['dns'], diagnostics);
  return {
    nodes,
    ruleSources,
    policyGroups: groups,
    ...(runtime === undefined ? {} : { runtime }),
    diagnostics,
    parsed: nodes.length,
    skipped: skippedCount,
  };
}

function clashGroup(entry: unknown, diagnostics: Diagnostic[]): PolicyGroup | null {
  if (!isRecord(entry)) return null;
  const name = str(entry['name']);
  if (name === undefined || !Array.isArray(entry['proxies'])) return null;
  const rawType = str(entry['type']);
  const strategy = rawType === 'select' || rawType === 'url-test' || rawType === 'fallback' ? rawType : undefined;
  if (rawType !== undefined && strategy === undefined) {
    skipped(diagnostics, name, `group-strategy-not-modelled:${rawType}`);
  }
  const testUrl = str(entry['url']);
  const interval = positiveInt(entry['interval']);
  const tolerance = nonNegativeInt(entry['tolerance']);
  return {
    name,
    members: entry['proxies'].filter((member): member is string => typeof member === 'string' && member.length > 0),
    ...(strategy === undefined ? {} : { strategy }),
    ...(testUrl === undefined ? {} : { testUrl }),
    ...(interval === undefined ? {} : { interval }),
    ...(tolerance === undefined ? {} : { tolerance }),
    ...(entry['lazy'] === true ? { lazy: true } : {}),
    ...(entry['hidden'] === true ? { hidden: true } : {}),
  };
}

function clashInlineRule(parts: readonly string[]): InlineRule | null {
  const head = parts[0]?.toUpperCase();
  const noResolve = parts.at(-1)?.toLowerCase() === 'no-resolve';
  const policyAt = (index: number): string | undefined => parts[index];
  if (head === 'MATCH') {
    const policy = policyAt(1);
    return policy === undefined || policy.length === 0 ? null : { condition: { type: 'match' }, policy };
  }
  const value = parts[1];
  const policy = parts[2];
  if (value === undefined || value.length === 0 || policy === undefined || policy.length === 0 || policy.toLowerCase() === 'no-resolve') {
    return null;
  }
  if (head === 'DOMAIN') return { condition: { type: 'domain', value }, policy };
  if (head === 'DOMAIN-SUFFIX') return { condition: { type: 'domainSuffix', value }, policy };
  if (head === 'DOMAIN-KEYWORD') return { condition: { type: 'domainKeyword', value }, policy };
  if (head === 'GEOSITE') return { condition: { type: 'geosite', value }, policy };
  if (head === 'GEOIP') return { condition: { type: 'geoip', value, ...(noResolve ? { noResolve: true } : {}) }, policy };
  if (head === 'IP-CIDR') return { condition: { type: 'ipCidr', value, ...(noResolve ? { noResolve: true } : {}) }, policy };
  if (head === 'IP-CIDR6') return { condition: { type: 'ipCidr6', value, ...(noResolve ? { noResolve: true } : {}) }, policy };
  return null;
}

function clashRuntime(value: unknown, diagnostics: Diagnostic[]): RuntimePolicy | undefined {
  if (!isRecord(value) || value['enable'] === false) return undefined;
  const enhanced = str(value['enhanced-mode']);
  const mode = enhanced === 'fake-ip' ? 'fake-ip' : enhanced === 'redir-host' ? 'redir-host' : 'system';
  const nameserver = stringList(value['nameserver']);
  const fallback = stringList(value['fallback']);
  const proxyNameserver = stringList(value['proxy-server-nameserver']);
  const directNameserver = stringList(value['direct-nameserver']);
  const nameserverPolicy: Record<string, string> = {};
  if (isRecord(value['nameserver-policy'])) {
    for (const [domain, server] of Object.entries(value['nameserver-policy'])) {
      if (typeof server !== 'string' || server.length === 0) continue;
      const keys = domain.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
      if (keys.length > 1) skipped(diagnostics, domain.slice(0, 80), 'nameserver-policy-comma-key');
      for (const key of keys) nameserverPolicy[key] = server;
    }
  }
  const fakeIpRange = str(value['fake-ip-range']);
  const ipv6 = typeof value['ipv6'] === 'boolean' ? value['ipv6'] : undefined;
  const dns: DnsPolicy = {
    mode,
    ...(nameserver === undefined ? {} : { nameserver }),
    ...(fallback === undefined ? {} : { fallback }),
    ...(proxyNameserver === undefined ? {} : { proxyNameserver }),
    ...(directNameserver === undefined ? {} : { directNameserver }),
    ...(Object.keys(nameserverPolicy).length === 0 ? {} : { nameserverPolicy }),
    ...(ipv6 === undefined ? {} : { ipv6 }),
    ...(fakeIpRange === undefined ? {} : { fakeIpRange }),
  };
  if (
    dns.nameserver === undefined &&
    dns.fallback === undefined &&
    dns.proxyNameserver === undefined &&
    dns.directNameserver === undefined &&
    dns.nameserverPolicy === undefined &&
    dns.fakeIpRange === undefined &&
    dns.ipv6 === undefined &&
    enhanced === undefined
  ) {
    return undefined;
  }
  return { dns };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length === 0 ? undefined : items;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** mihomo 用 up/down，Stash 用 up-speed/down-speed；两种写法都要认。 */
function clashBandwidth(value: Record<string, unknown>): { up?: number; down?: number } | undefined {
  const up = positive(value['up']) ?? positive(value['up-speed']);
  const down = positive(value['down']) ?? positive(value['down-speed']);
  if (up === undefined && down === undefined) return undefined;
  return {
    ...(up === undefined ? {} : { up }),
    ...(down === undefined ? {} : { down }),
  };
}

function clashNode(value: unknown, diagnostics: Diagnostic[]): ProxyNode | null {
  if (!isRecord(value)) {
    skipped(diagnostics, String(value), 'invalid-proxy-entry');
    return null;
  }
  const type = str(value['type']);
  const server = str(value['server']);
  const port = num(value['port']);
  const name = str(value['name']);
  if (type === undefined || server === undefined || port === undefined || name === undefined) {
    skipped(diagnostics, JSON.stringify(value), 'missing-common-fields');
    return null;
  }
  const base = { name, server, port };

  const wsOpts = isRecord(value['ws-opts']) ? value['ws-opts'] : undefined;
  const wsHeaders = wsOpts !== undefined && isRecord(wsOpts['headers']) ? wsOpts['headers'] : undefined;
  const grpcOpts = isRecord(value['grpc-opts']) ? value['grpc-opts'] : undefined;
  const realityOpts = isRecord(value['reality-opts']) ? value['reality-opts'] : undefined;
  const pluginOpts = isRecord(value['plugin-opts']) ? value['plugin-opts'] : undefined;
  const obfsOpts = isRecord(value['obfs-opts']) ? value['obfs-opts'] : undefined;
  const alpnRaw = value['alpn'];
  const network = str(value['network']);
  const transport = transportOf(network);

  const options = optionsOf({
    tls: truthy(value['tls']) ? true : undefined,
    sni: str(value['sni']) ?? str(value['servername']),
    transport,
    path:
      network === 'grpc'
        ? str(grpcOpts?.['grpc-service-name'])
        : (str(wsOpts?.['path']) ?? undefined),
    host: str(wsHeaders?.['Host']) ?? str(wsHeaders?.['host']),
    flow: str(value['flow']),
    alterId: value['alterId'] === 0 ? 0 : typeof value['alterId'] === 'number' ? value['alterId'] : undefined,
    cipher: str(value['cipher']) ?? str(value['security']),
    udp: typeof value['udp'] === 'boolean' ? value['udp'] : undefined,
    plugin: str(value['plugin']),
    pluginOpts:
      pluginOpts === undefined
        ? undefined
        : optionsOf({
            mode: str(pluginOpts['mode']),
            host: str(pluginOpts['host']),
            path: str(pluginOpts['path']),
            tls: typeof pluginOpts['tls'] === 'boolean' ? pluginOpts['tls'] : undefined,
          }) as PluginOptions | undefined,
    reality:
      realityOpts === undefined || str(realityOpts['public-key']) === undefined
        ? undefined
        : {
            publicKey: str(realityOpts['public-key']) ?? '',
            ...(str(realityOpts['short-id']) === undefined
              ? {}
              : { shortId: str(realityOpts['short-id']) ?? '' }),
            ...(str(value['client-fingerprint']) === undefined
              ? {}
              : { fingerprint: str(value['client-fingerprint']) ?? '' }),
          },
    obfs: obfsOf(value['obfs'] ?? obfsOpts?.['mode']),
    alpn: Array.isArray(alpnRaw) ? alpnRaw.filter((item): item is string => typeof item === 'string') : undefined,
    insecure: value['skip-cert-verify'] === true ? true : undefined,
    fingerprint: str(value['client-fingerprint']),
    bandwidth: clashBandwidth(value),
    ports: str(value['ports']),
    congestionControl: str(value['congestion-controller']),
    udpRelayMode: str(value['udp-relay-mode']),
    version: typeof value['version'] === 'number' ? value['version'] : undefined,
    idleSessionTimeout:
      typeof value['idle-session-timeout'] === 'number' ? value['idle-session-timeout'] : undefined,
  });

  // 混淆密码来自 obfs-password 或 snell 的 obfs-opts；在 optionsOf 里补便于按协议区分。
  const withObfs = (node: ProxyNode): ProxyNode => {
    const obfs = node.options?.obfs;
    if (obfs === undefined) return node;
    const password = str(value['obfs-password']) ?? str(obfsOpts?.['password']);
    const host = str(obfsOpts?.['host']);
    if (password === undefined && host === undefined) return node;
    return {
      ...node,
      options: {
        ...node.options,
        obfs: {
          ...obfs,
          ...(password === undefined ? {} : { password }),
          ...(host === undefined ? {} : { host }),
        },
      },
    } as ProxyNode;
  };

  switch (type) {
    case 'ss': {
      const method = str(value['cipher']);
      const password = str(value['password']);
      if (method === undefined || password === undefined) break;
      return withObfs(withOptions({ ...base, kind: 'shadowsocks', method, password }, options));
    }
    case 'vmess': {
      const uuid = str(value['uuid']);
      if (uuid !== undefined) return withObfs(withOptions({ ...base, kind: 'vmess', uuid }, options));
      break;
    }
    case 'vless': {
      const uuid = str(value['uuid']);
      if (uuid !== undefined) return withObfs(withOptions({ ...base, kind: 'vless', uuid }, options));
      break;
    }
    case 'trojan': {
      const password = str(value['password']);
      if (password !== undefined) {
        return withObfs(withOptions({ ...base, kind: 'trojan', password }, options));
      }
      break;
    }
    case 'hysteria2': {
      const password = str(value['password']) ?? str(value['auth']);
      if (password !== undefined) {
        return withObfs(withOptions({ ...base, kind: 'hysteria2', password }, options));
      }
      break;
    }
    case 'tuic': {
      const uuid = str(value['uuid']);
      const password = str(value['password']);
      if (uuid !== undefined && password !== undefined) {
        return withObfs(withOptions({ ...base, kind: 'tuic', uuid, password }, options));
      }
      // v4 只有 token，本 IR 不建模（Surge 用 tuic 关键字，SIP 语义不同）。
      if (str(value['token']) !== undefined) {
        skipped(diagnostics, name, 'tuic-v4-token-not-modelled');
        return null;
      }
      break;
    }
    case 'anytls': {
      const password = str(value['password']);
      if (password !== undefined) {
        return withObfs(withOptions({ ...base, kind: 'anytls', password }, options));
      }
      break;
    }
    case 'snell': {
      const psk = str(value['psk']);
      if (psk !== undefined) return withObfs(withOptions({ ...base, kind: 'snell', psk }, options));
      break;
    }
  }
  skipped(diagnostics, `${name}:${type}`, 'unsupported-or-incomplete-clash-type');
  return null;
}

/**
 * Surge / Loon INI 的 [Proxy] 段。两种方言共用这一解析路径：
 *  - Surge：`Name = ss, host, port, encrypt-method=…, password=…`
 *  - Loon：`Name = Shadowsocks, host, port, method, "password", transport=…`
 * 因此位置参数与 key=value 参数都要认。
 */
export function parseSurgeIni(raw: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const nodes: ProxyNode[] = [];
  const groups: PolicyGroup[] = [];
  let section = '';
  let skippedCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#') || text.startsWith(';') || text.startsWith('//')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(text);
    if (sectionMatch !== null) {
      section = (sectionMatch[1] ?? '').toLowerCase();
      continue;
    }
    const eq = text.indexOf('=');
    if (eq < 0) continue;
    const name = text.slice(0, eq).trim();
    const spec = text.slice(eq + 1).trim();

    if (section === 'proxy') {
      const parts = splitRespectingQuotes(spec);
      const type = (parts[0] ?? '').toLowerCase();
      const host = parts[1];
      const port = num(parts[2]);
      if (host === undefined || port === undefined) {
        skipped(diagnostics, text, 'invalid-proxy-line');
        skippedCount += 1;
        continue;
      }
      const params = new Map<string, string>();
      const positional: string[] = [];
      for (const part of parts.slice(3)) {
        const kv = part.indexOf('=');
        if (kv > 0) params.set(part.slice(0, kv).trim().toLowerCase(), part.slice(kv + 1).trim());
        else if (part.length > 0) positional.push(part);
      }
      const node = iniProxy(type, name, host, port, positional, params, diagnostics, text);
      if (node === null) skippedCount += 1;
      else nodes.push(node);
      continue;
    }

    if (section === 'proxy group' || section === 'proxygroup') {
      const parts = splitRespectingQuotes(spec);
      if (parts[0] === 'select') groups.push({ name, members: parts.slice(1) });
    }
  }

  return { nodes, ruleSources: [], policyGroups: groups, diagnostics, parsed: nodes.length, skipped: skippedCount };
}

function iniProxy(
  type: string,
  name: string,
  host: string,
  port: number,
  positional: readonly string[],
  params: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[],
  line: string,
): ProxyNode | null {
  const get = (key: string): string | undefined => {
    const value = params.get(key);
    return value === undefined ? undefined : unquote(value);
  };
  const transport = transportOf(get('transport') ?? (get('ws') === 'true' ? 'ws' : undefined));
  const base = { name, server: host, port };
  const realityPublicKey = get('public-key');
  const obfsType = get('obfs');
  const salamander = get('salamander-password');
  const gecko = get('gecko-password');

  const shared: Record<string, unknown> = {
    tls:
      get('over-tls') === 'true' || get('tls') === 'true' || realityPublicKey !== undefined
        ? true
        : undefined,
    sni: get('sni'),
    transport,
    path: get('path') ?? get('ws-path'),
    host: get('host') ?? get('ws-headers')?.match(/Host:([^|,]+)/)?.[1],
    flow: get('flow'),
    alterId: get('alterid') === undefined ? undefined : Number(get('alterid')),
    cipher: get('encrypt-method'),
    udp: get('udp') === undefined ? undefined : get('udp') === 'true',
    plugin: undefined,
    reality:
      realityPublicKey === undefined
        ? undefined
        : {
            publicKey: realityPublicKey,
            ...(get('short-id') === undefined ? {} : { shortId: get('short-id') }),
            ...(get('tls-profile') === undefined ? {} : { fingerprint: get('tls-profile') }),
          },
    obfs:
      obfsType !== undefined
        ? { type: obfsType as ObfsOptions['type'], ...(get('obfs-host') === undefined ? {} : { host: get('obfs-host') }) }
        : salamander !== undefined
          ? { type: 'salamander' as const, password: salamander }
          : gecko !== undefined
            ? { type: 'gecko' as const, password: gecko }
            : undefined,
    alpn: get('alpn') === undefined ? undefined : get('alpn')?.split(','),
    insecure: get('skip-cert-verify') === 'true' ? true : undefined,
    fingerprint: get('tls-profile'),
    bandwidth:
      get('download-bandwidth') === undefined
        ? undefined
        : { down: Number(get('download-bandwidth')) },
    ports: get('port-hopping') ?? get('server-ports'),
    congestionControl: get('congestion-controller'),
    udpRelayMode: get('udp-relay-mode'),
    version: get('version') === undefined ? undefined : Number(get('version')),
    idleSessionTimeout:
      get('idle-session-timeout') === undefined ? undefined : Number(get('idle-session-timeout')),
  };

  switch (type) {
    case 'ss':
    case 'shadowsocks': {
      const method = get('encrypt-method') ?? positional[0];
      const password = get('password') ?? positional[1];
      if (method === undefined || password === undefined) {
        skipped(diagnostics, line, 'missing-ss-parameters');
        return null;
      }
      const options = optionsOf({ ...shared, cipher: method });
      return withOptions({ ...base, kind: 'shadowsocks', method, password }, options);
    }
    case 'vmess': {
      const uuid = get('username') ?? positional[1];
      if (uuid === undefined) {
        skipped(diagnostics, line, 'missing-vmess-username');
        return null;
      }
      const cipher = get('encrypt-method') ?? positional[0];
      return withOptions({ ...base, kind: 'vmess', uuid }, optionsOf({ ...shared, cipher }));
    }
    case 'vless': {
      const uuid = get('username') ?? positional[0];
      if (uuid === undefined) {
        skipped(diagnostics, line, 'missing-vless-uuid');
        return null;
      }
      return withOptions({ ...base, kind: 'vless', uuid }, optionsOf(shared));
    }
    case 'trojan': {
      const password = get('password') ?? positional[0];
      if (password === undefined) {
        skipped(diagnostics, line, 'missing-trojan-password');
        return null;
      }
      return withOptions({ ...base, kind: 'trojan', password }, optionsOf(shared));
    }
    case 'hysteria2': {
      const password = get('password') ?? positional[0];
      if (password === undefined) {
        skipped(diagnostics, line, 'missing-hysteria2-password');
        return null;
      }
      return withOptions({ ...base, kind: 'hysteria2', password }, optionsOf(shared));
    }
    case 'tuic':
    case 'tuic-v5': {
      const uuid = get('uuid');
      const password = get('password') ?? positional[0];
      if (uuid === undefined || password === undefined) {
        skipped(diagnostics, line, 'missing-tuic-uuid-password');
        return null;
      }
      return withOptions({ ...base, kind: 'tuic', uuid, password }, optionsOf(shared));
    }
    case 'snell': {
      const psk = get('psk');
      if (psk === undefined) {
        skipped(diagnostics, line, 'missing-snell-psk');
        return null;
      }
      return withOptions({ ...base, kind: 'snell', psk }, optionsOf(shared));
    }
    case 'anytls': {
      const password = get('password') ?? positional[0];
      if (password === undefined) {
        skipped(diagnostics, line, 'missing-anytls-password');
        return null;
      }
      return withOptions({ ...base, kind: 'anytls', password }, optionsOf(shared));
    }
    default:
      skipped(diagnostics, line, `unsupported-ini-protocol:${type || 'unknown'}`);
      return null;
  }
}

/** sing-box JSON outbounds；selector 映射为策略组。 */
export function parseSingBoxJson(raw: string): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const doc: unknown = JSON.parse(raw) as unknown;
  if (!isRecord(doc) || !Array.isArray(doc['outbounds'])) {
    return { ...emptyOutcome(), diagnostics: [makeDiagnostic('ingest', null, 'sing-box-json', 'missing-outbounds-array')], skipped: 1 };
  }
  const nodes: ProxyNode[] = [];
  const groups: PolicyGroup[] = [];
  let skippedCount = 0;

  for (const entry of doc['outbounds']) {
    if (!isRecord(entry)) {
      skipped(diagnostics, String(entry), 'invalid-outbound-entry');
      skippedCount += 1;
      continue;
    }
    const type = str(entry['type']);
    if (type === 'direct' || type === 'block') continue;
    if (type === 'selector') {
      const tag = str(entry['tag']);
      if (tag !== undefined && Array.isArray(entry['outbounds'])) {
        groups.push({ name: tag, members: entry['outbounds'].filter((m): m is string => typeof m === 'string') });
      }
      continue;
    }
    const server = str(entry['server']);
    const port = num(entry['server_port']);
    const name = str(entry['tag']);
    if (server === undefined || port === undefined || name === undefined) {
      skipped(diagnostics, JSON.stringify(entry), 'missing-outbound-common-fields');
      skippedCount += 1;
      continue;
    }

    const tls = isRecord(entry['tls']) ? entry['tls'] : undefined;
    const utls = tls !== undefined && isRecord(tls['utls']) ? tls['utls'] : undefined;
    const reality = tls !== undefined && isRecord(tls['reality']) ? tls['reality'] : undefined;
    const transportBlock = isRecord(entry['transport']) ? entry['transport'] : undefined;
    const transportType = str(transportBlock?.['type']);
    const headers = transportBlock !== undefined && isRecord(transportBlock['headers']) ? transportBlock['headers'] : undefined;
    const obfsBlock = isRecord(entry['obfs']) ? entry['obfs'] : undefined;
    const alpnRaw = tls?.['alpn'];
    const pluginOptsRaw = str(entry['plugin_opts']);
    const pluginName = str(entry['plugin']);
    const sip003 =
      pluginName === undefined
        ? null
        : pluginOptsRaw === undefined
          ? { plugin: pluginName }
          : pluginFromSip003(`${pluginName};${pluginOptsRaw}`);

    const options = optionsOf({
      tls: tls?.['enabled'] === true ? true : undefined,
      sni: str(tls?.['server_name']),
      transport: transportOf(transportType),
      path:
        transportType === 'grpc'
          ? str(transportBlock?.['service_name'])
          : str(transportBlock?.['path']),
      host: str(headers?.['Host']) ?? (Array.isArray(transportBlock?.['host']) ? str(transportBlock?.['host'][0]) : undefined),
      flow: str(entry['flow']),
      cipher: str(entry['security']),
      alterId: typeof entry['alter_id'] === 'number' ? entry['alter_id'] : undefined,
      plugin: sip003 === null ? undefined : sip003.plugin,
      pluginOpts: sip003 === null ? undefined : sip003.pluginOpts,
      reality:
        reality === undefined || str(reality['public_key']) === undefined
          ? undefined
          : {
              publicKey: str(reality['public_key']) ?? '',
              ...(str(reality['short_id']) === undefined ? {} : { shortId: str(reality['short_id']) ?? '' }),
            },
      obfs:
        obfsBlock === undefined || str(obfsBlock['type']) === undefined
          ? undefined
          : {
              type: (str(obfsBlock['type']) as ObfsOptions['type']),
              ...(str(obfsBlock['password']) === undefined ? {} : { password: str(obfsBlock['password']) ?? '' }),
            },
      alpn: Array.isArray(alpnRaw) ? alpnRaw.filter((item): item is string => typeof item === 'string') : undefined,
      insecure: tls?.['insecure'] === true ? true : undefined,
      fingerprint: str(utls?.['fingerprint']),
      bandwidth:
        positive(entry['up_mbps']) === undefined && positive(entry['down_mbps']) === undefined
          ? undefined
          : {
              ...(positive(entry['up_mbps']) === undefined ? {} : { up: positive(entry['up_mbps']) as number }),
              ...(positive(entry['down_mbps']) === undefined ? {} : { down: positive(entry['down_mbps']) as number }),
            },
      congestionControl: str(entry['congestion_control']),
      udpRelayMode: str(entry['udp_relay_mode']),
      idleSessionTimeout:
        str(entry['idle_session_timeout']) === undefined
          ? undefined
          : Number.parseInt(str(entry['idle_session_timeout']) ?? '', 10) || undefined,
    });
    const base = { name, server, port };

    switch (type) {
      case 'shadowsocks': {
        const method = str(entry['method']);
        const password = str(entry['password']);
        if (method !== undefined && password !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'shadowsocks', method, password }, options));
          continue;
        }
        break;
      }
      case 'vmess': {
        const uuid = str(entry['uuid']);
        if (uuid !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'vmess', uuid }, options));
          continue;
        }
        break;
      }
      case 'vless': {
        const uuid = str(entry['uuid']);
        if (uuid !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'vless', uuid }, options));
          continue;
        }
        break;
      }
      case 'trojan': {
        const password = str(entry['password']);
        if (password !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'trojan', password }, options));
          continue;
        }
        break;
      }
      case 'hysteria2': {
        const password = str(entry['password']);
        if (password !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'hysteria2', password }, options));
          continue;
        }
        break;
      }
      case 'tuic': {
        const uuid = str(entry['uuid']);
        const password = str(entry['password']);
        if (uuid !== undefined && password !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'tuic', uuid, password }, options));
          continue;
        }
        break;
      }
      case 'anytls': {
        const password = str(entry['password']);
        if (password !== undefined) {
          nodes.push(withOptions({ ...base, kind: 'anytls', password }, options));
          continue;
        }
        break;
      }
    }
    skipped(diagnostics, `${name}:${type ?? 'unknown'}`, 'unsupported-or-incomplete-outbound');
    skippedCount += 1;
  }

  return { nodes, ruleSources: [], policyGroups: groups, diagnostics, parsed: nodes.length, skipped: skippedCount };
}

/** Startrails 内部 IR JSON：走统一的严格校验路径。 */
export function parseStartrailsJson(raw: string): ParseOutcome {
  const doc: unknown = JSON.parse(raw) as unknown;
  if (!isRecord(doc) || !Array.isArray(doc['nodes'])) {
    return { ...emptyOutcome(), diagnostics: [makeDiagnostic('ingest', null, 'startrails-json', 'missing-nodes-array')], skipped: 1 };
  }
  return {
    nodes: doc['nodes'] as ProxyNode[],
    ruleSources: (Array.isArray(doc['ruleSources']) ? doc['ruleSources'] : []) as RuleSource[],
    policyGroups: (Array.isArray(doc['policyGroups']) ? doc['policyGroups'] : []) as PolicyGroup[],
    diagnostics: [],
    parsed: doc['nodes'].length,
    skipped: 0,
  };
}
