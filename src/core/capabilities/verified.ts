import type {
  CapabilityTables,
  CapabilityValue,
  NodeFeature,
  OutputCapability,
  ProtocolKind,
  RuntimeFeature,
} from './index.ts';
import { NODE_FEATURES, PROTOCOL_KINDS, RUNTIME_FEATURES } from './constants.ts';
import { RULE_CONDITION_KINDS } from '../rules/index.ts';
import type { RuleConditionKind } from '../rules/index.ts';
import { CLIENT_TARGETS, dialectOf } from '../targets.ts';
import type { ClientTarget, Dialect } from '../targets.ts';

export interface CapabilityEvidence {
  readonly target: ClientTarget;
  readonly scope: 'node' | 'feature' | 'rule' | 'runtime' | 'output';
  readonly subject: string;
  readonly value: CapabilityValue;
  readonly source: string;
  readonly note: string;
}

type Row<K extends string> = Readonly<Record<K, CapabilityValue>>;

interface DialectBase {
  readonly node: Row<ProtocolKind>;
  readonly feature: Row<NodeFeature>;
  readonly rule: Row<RuleConditionKind>;
  /** 运行时段：DNS / TUN / fake-ip / ECS / enhanced-mode。 */
  readonly runtime: Row<RuntimeFeature>;
  readonly output: OutputCapability;
}

const row = <K extends string>(
  keys: readonly K[],
  value: CapabilityValue,
  overrides: Partial<Record<K, CapabilityValue>> = {},
): Row<K> =>
  Object.freeze(
    Object.fromEntries(keys.map((key) => [key, overrides[key] ?? value])) as Row<K>,
  );

/**
 * 每种方言一套「已核实基线」，依据见 CAPABILITY_EVIDENCE。
 * 未核实的能力一律写 unverified，不推测、不静默降级。
 */
const DIALECT_BASE: Readonly<Record<Dialect, DialectBase>> = {
  'surge-ini': {
    node: row(PROTOCOL_KINDS, 'support', {
      vless: 'reject',
      trojan: 'unverified',
      anytls: 'reject',
      // WireGuard 在 Surge 是 [Proxy] 引用（wireguard, section-name = …）+ 独立 [WireGuard] 段；
      // emitter 已落地 section 输出，故核实为 support。
      wireguard: 'support',
      // Surge 只有 socks5 直连节点，没有 http 代理节点行。
      http: 'reject',
    }),
    feature: row(NODE_FEATURES, 'support', {
      flow: 'unverified',
      alterId: 'unverified',
      plugin: 'unverified',
      reality: 'reject',
      congestion: 'unverified',
      udpRelayMode: 'unverified',
      idleSession: 'unverified',
      fingerprint: 'unverified',
      // Surge 的 SS 只有 obfs 类参数，没有 shadow-tls：写了必然连不上。
      shadowTls: 'unverified',
    }),
    rule: row(RULE_CONDITION_KINDS, 'unverified', {
      domain: 'support',
      domainSuffix: 'support',
      ipCidr: 'support',
    }),
    // Surge 的 TUN / fake-ip 是 App 内开关，配置文件里没有对应段；ECS 未在 dns-server 语法中出现。
    runtime: row(RUNTIME_FEATURES, 'reject', { dns: 'support' }),
    output: { format: 'ini', allowsComments: true, allowsExternalRuleSet: false },
  },
  'clash-yaml': {
    node: row(PROTOCOL_KINDS, 'support'),
    // shadow-tls 只有 mihomo 内核系核实过，其余 clash 方言在 OVERRIDES 里逐家打开。
    feature: row(NODE_FEATURES, 'support', { shadowTls: 'unverified' }),
    rule: row(RULE_CONDITION_KINDS, 'support'),
    runtime: row(RUNTIME_FEATURES, 'support', { ecs: 'unverified' }),
    output: {
      format: 'yaml',
      allowsComments: true,
      allowsExternalRuleSet: false,
      snell: { minVersion: 1, maxVersion: 5, defaultVersion: 4 },
    },
  },
  'sing-box-json': {
    // WireGuard outbound 自 1.11 起 deprecated、1.13 移除，写法迁至 endpoints 模型；
    // 在未核实当前目标版本的 outbound 语法前，宁可不写也不写出「看着合法但加载失败」的段。
    node: row(PROTOCOL_KINDS, 'support', { snell: 'reject', wireguard: 'unverified' }),
    // tls / transport 子结构已核实（shared/tls、shared/v2ray-transport）；
    // server_ports 的写法与 IR 的 ports 字符串不同构，标 unverified 以免写出错格式。
    feature: row(NODE_FEATURES, 'support', {
      ports: 'unverified',
      version: 'unverified',
      // sing-box 的 SS 插件只支持 obfs-local / v2ray-plugin，没有 shadow-tls。
      shadowTls: 'unverified',
    }),
    rule: row(RULE_CONDITION_KINDS, 'unverified'),
    // 只输出 outbounds 片段，不带 inbounds（TUN 属 inbound），因此 tun 不写。
    runtime: row(RUNTIME_FEATURES, 'unverified', {
      dns: 'support',
      fakeIp: 'support',
      ecs: 'support',
      tun: 'reject',
    }),
    output: { format: 'json', allowsComments: false, allowsExternalRuleSet: false },
  },
  'loon-ini': {
    node: row(PROTOCOL_KINDS, 'support', {
      tuic: 'unverified',
      snell: 'unverified',
      wireguard: 'unverified',
      socks5: 'unverified',
      http: 'unverified',
    }),
    feature: row(NODE_FEATURES, 'support', {
      plugin: 'unverified',
      congestion: 'unverified',
      udpRelayMode: 'unverified',
      version: 'unverified',
      shadowTls: 'unverified',
    }),
    // Loon 官方 Node 页明确只写 [Proxy] 段，未给 [Rule] 段；规则语法本次未核实。
    rule: row(RULE_CONDITION_KINDS, 'unverified'),
    // 官方 DNS 页只给 dns-server / doh-server / doq-server / doh3-server，无 fake-ip / TUN / ECS 配置项。
    runtime: row(RUNTIME_FEATURES, 'reject', { dns: 'support' }),
    output: { format: 'ini', allowsComments: true, allowsExternalRuleSet: false },
  },
  'quanx-ini': {
    node: row(PROTOCOL_KINDS, 'support', {
      hysteria2: 'reject',
      tuic: 'reject',
      anytls: 'reject',
      snell: 'reject',
      wireguard: 'reject',
      socks5: 'unverified',
      http: 'unverified',
    }),
    feature: row(NODE_FEATURES, 'unverified', {
      tls: 'support',
      sni: 'support',
      transport: 'support',
      path: 'support',
      host: 'support',
      flow: 'support',
      cipher: 'support',
      udp: 'support',
    }),
    // sample.conf 的 [filter_local] 给出 host / host-suffix / ip-cidr / final，无逻辑规则示例。
    rule: row(RULE_CONDITION_KINDS, 'unverified', {
      domain: 'support',
      domainSuffix: 'support',
      ipCidr: 'support',
    }),
    // sample.conf 的 [dns] 段给出 server / doh-server / doq-server / no-ipv6；无 fake-ip / TUN / ECS。
    runtime: row(RUNTIME_FEATURES, 'reject', { dns: 'support' }),
    output: { format: 'ini', allowsComments: true, allowsExternalRuleSet: false },
  },
  'egern-yaml': {
    node: row(PROTOCOL_KINDS, 'support', {
      hysteria2: 'unverified',
      tuic: 'unverified',
      anytls: 'unverified',
      snell: 'unverified',
      wireguard: 'unverified',
      socks5: 'unverified',
      http: 'unverified',
    }),
    feature: row(NODE_FEATURES, 'support', {
      reality: 'support',
      alterId: 'unverified',
      plugin: 'unverified',
      obfs: 'unverified',
      alpn: 'unverified',
      insecure: 'unverified',
      fingerprint: 'unverified',
      bandwidth: 'unverified',
      ports: 'unverified',
      congestion: 'unverified',
      udpRelayMode: 'unverified',
      version: 'unverified',
      idleSession: 'unverified',
      shadowTls: 'unverified',
    }),
    // Egern 官方 proxies 页明确未出现 rules / proxy_groups 段写法。
    rule: row(RULE_CONDITION_KINDS, 'unverified'),
    // Egern 的 dns 段是 bootstrap / upstreams / forward 结构，没有 fake-ip；ECS 走 public_ip_lookup_url 自动取。
    runtime: row(RUNTIME_FEATURES, 'reject', {
      dns: 'support',
      ecs: 'unverified',
      tun: 'unverified',
    }),
    output: { format: 'yaml', allowsComments: true, allowsExternalRuleSet: false },
  },
  'uri-list': {
    // Snell 只有 Surge 自己的配置行，没有公开分享链接规范，故不宣称可导出。
    node: row(PROTOCOL_KINDS, 'support', { snell: 'unverified' }),
    // hysteria2 依官方 URI Scheme；tuic / anytls 依各家客户端通行的分享链接约定。
    feature: row(NODE_FEATURES, 'unverified', {
      tls: 'support',
      sni: 'support',
      transport: 'support',
      path: 'support',
      host: 'support',
      flow: 'support',
      alterId: 'support',
      cipher: 'support',
      plugin: 'support',
      reality: 'support',
      obfs: 'support',
      alpn: 'support',
      insecure: 'support',
      fingerprint: 'support',
      congestion: 'support',
      udpRelayMode: 'support',
      // SIP002 的 plugin= 是通用透传串，shadow-tls 的参数可原样带回去。
      shadowTls: 'support',
    }),
    rule: row(RULE_CONDITION_KINDS, 'unverified'),
    // 只有节点 URI，没有任何配置段。
    runtime: row(RUNTIME_FEATURES, 'reject'),
    output: { format: 'uri', allowsComments: true, allowsExternalRuleSet: false },
  },
};

/** 逐 Target 的能力差异。没有差异就不写，避免 19 份重复表。 */
interface TargetOverride {
  readonly node?: Partial<Record<ProtocolKind, CapabilityValue>>;
  readonly feature?: Partial<Record<NodeFeature, CapabilityValue>>;
  readonly rule?: Partial<Record<RuleConditionKind, CapabilityValue>>;
  readonly runtime?: Partial<Record<RuntimeFeature, CapabilityValue>>;
  readonly output?: Partial<OutputCapability>;
}

const OVERRIDES: Partial<Record<ClientTarget, TargetOverride>> = {
  // Stash 官方文档的 proxy-types 页给出节点字段，但未给逻辑规则语法；
  // 与通用 mihomo 分开，避免把 AND/OR/NOT 直接写进 Stash 配置。
  // 另：Stash 的 hysteria2 认证字段是 auth（mihomo 是 password），tuic 必须写 version，
  // 与 mihomo 方言不同构 —— 标 unverified 让其按「能力未核实」拒绝，而不是写出错配置。
  clash: {
    node: { hysteria2: 'unverified', tuic: 'unverified' },
    rule: { and: 'unverified', or: 'unverified', not: 'unverified' },
    // Stash 的 fake-ip 是默认行为，官方示例里没有 enhanced-mode 这个键；写进去只会被忽略。
    // TUN 是 App 内设置，配置里没有 tun 段。
    runtime: { enhancedMode: 'reject', tun: 'reject', ecs: 'unverified' },
    output: { snell: { minVersion: 1, maxVersion: 3, defaultVersion: 1 } },
  },
  // Clash App（clash-apple）自 1.0.18 起搭载 mihomo 1.19.34 并文档化 Snell v1–v6；
  // 其余新协议与 Reality 在此能力表中仍保守维持 unverified，直到各字段独立核实。
  'clash-apple': {
    node: {
      hysteria2: 'unverified',
      tuic: 'unverified',
      anytls: 'unverified',
    },
    feature: { reality: 'unverified' },
    // Clash 的 TUN 同样是 App 内设置。
    runtime: { tun: 'reject', ecs: 'unverified' },
    output: {
      snell: {
        minVersion: 1,
        maxVersion: 6,
        defaultVersion: 4,
        disallowObfsOnV6: true,
        minPskBytesOnV6: 12,
        maxPskBytesOnV6: 255,
      },
    },
  },
  // Karing 对实验性插件能力支持尚不固定，
  // 这里把未独立核实的插件能力显式标为 unverified。
  karing: { feature: { plugin: 'unverified' } },
  // mihomo 官方 ss 页明确支持 plugin: shadow-tls + plugin-opts{host,password,version}。
  // 其余 clash 方言（Stash / Clash Premium / 各家壳）未核实该插件，保持 unverified → 拒绝节点，
  // 而不是写成普通 SS（那样语法合法、握手必失败）。
  mihomo: { feature: { shadowTls: 'support' } },
  'clash-verge': { feature: { shadowTls: 'support' } },
  clashmac: { feature: { shadowTls: 'support' } },
  flclash: { feature: { shadowTls: 'support' } },
  'mihomo-party': { feature: { shadowTls: 'support' } },
  // clash-mi / hiddify 等是各家的壳，TUN 写在配置里的能力差异较大：只保留 DNS，不写 TUN。
  'clash-mi': { runtime: { tun: 'unverified' } },
  hiddify: { runtime: { tun: 'reject' } },
};

const merged = <K extends string>(
  base: Row<K>,
  override: Partial<Record<K, CapabilityValue>> | undefined,
): Row<K> => Object.freeze({ ...base, ...(override ?? {}) });

const buildTables = (): CapabilityTables => {
  const node = Object.fromEntries(
    CLIENT_TARGETS.map((target) => [
      target,
      merged(DIALECT_BASE[dialectOf(target)].node, OVERRIDES[target]?.node),
    ]),
  ) as CapabilityTables['node'];
  const feature = Object.fromEntries(
    CLIENT_TARGETS.map((target) => [
      target,
      merged(DIALECT_BASE[dialectOf(target)].feature, OVERRIDES[target]?.feature),
    ]),
  ) as CapabilityTables['feature'];
  const rule = Object.fromEntries(
    CLIENT_TARGETS.map((target) => [
      target,
      merged(DIALECT_BASE[dialectOf(target)].rule, OVERRIDES[target]?.rule),
    ]),
  ) as CapabilityTables['rule'];
  const runtime = Object.fromEntries(
    CLIENT_TARGETS.map((target) => [
      target,
      merged(DIALECT_BASE[dialectOf(target)].runtime, OVERRIDES[target]?.runtime),
    ]),
  ) as CapabilityTables['runtime'];
  const output = Object.fromEntries(
    CLIENT_TARGETS.map((target) => [
      target,
      Object.freeze({
        ...DIALECT_BASE[dialectOf(target)].output,
        ...(OVERRIDES[target]?.output ?? {}),
      }),
    ]),
  ) as CapabilityTables['output'];
  return { node, feature, rule, runtime, output };
};

/**
 * 核实日期：2026-11-11。
 * 依据只用各客户端官方文档与公开配置格式规范。
 * 未核实项保持 unverified：协议级 → 拒绝节点；特性级 → 降级（丢弃该字段并产出诊断），
 * 其中 reality / obfs / plugin 属认证级，丢弃后必然连不上，因此改判「拒绝节点」。
 */
export const CAPABILITY_EVIDENCE: readonly CapabilityEvidence[] = [
  {
    target: 'surge',
    scope: 'node',
    subject: '*',
    value: 'support',
    source: 'https://manual.nssurge.com/policies/overview.html',
    note: 'Supported Proxy Protocols 列出 ss / vmess / trojan / hysteria2 / tuic / snell 等；[Proxy] 行语法见同页与 profile/format.html',
  },
  {
    target: 'surge',
    scope: 'node',
    subject: 'vless',
    value: 'reject',
    source: 'https://manual.nssurge.com/policies/overview.html',
    note: '手册 Supported Proxy Protocols 表未列 VLESS，故不生成该类型策略；surge-mac 同方言继承',
  },
  {
    target: 'surge',
    scope: 'node',
    subject: 'trojan',
    value: 'unverified',
    source: 'https://manual.nssurge.com/policies/overview.html',
    note: '协议关键词已确认存在，但 Trojan 参数页字段依据本次未取得，不推测 password/sni 写法，按拒绝处理；核实后只改数据',
  },
  {
    target: 'surge',
    scope: 'node',
    subject: 'hysteria2',
    value: 'support',
    source: 'https://manual.nssurge.com/policies/hysteria2.html',
    note: 'iOS 5.8.0+ / Mac 5.4.0+；行格式 Hysteria2 = host, port, password=…，参数含 download-bandwidth、port-hopping、salamander-password、gecko-password、alpn 与通用 TLS 参数',
  },
  {
    target: 'surge',
    scope: 'node',
    subject: 'tuic',
    value: 'support',
    source: 'https://manual.nssurge.com/policies/tuic.html',
    note: 'tuic-v5 用 uuid + password（tuic 关键字是 v4 token 模式）；本 IR 只建模 v5，故输出 tuic-v5',
  },
  {
    target: 'surge',
    scope: 'node',
    subject: 'snell',
    value: 'support',
    source: 'https://manual.nssurge.com/policies/snell.html',
    note: 'Name = snell, host, port, psk=…, version=<1-6>；另含 obfs / obfs-host / obfs-uri / reuse / udp-port / mode(v6)',
  },
  {
    target: 'surge',
    scope: 'feature',
    subject: 'reality',
    value: 'reject',
    source: 'https://manual.nssurge.com/policies/tls.html',
    note: 'TLS 参数页只给出 skip-cert-verify / sni / alpn / 证书固定等，未出现 Reality；Surge 无 Reality 客户端能力',
  },
  {
    target: 'surge',
    scope: 'feature',
    subject: 'vmess:username/tls/ws/ws-path',
    value: 'support',
    source: 'https://manual.nssurge.com/policies/vmess.html',
    note: 'vmess 页明确 Name = vmess, host, port, username=UUID 及 tls / ws / ws-path / ws-headers 参数；TLS 通用参数含 sni',
  },
  {
    target: 'surge-mac',
    scope: 'output',
    subject: 'surge-ini',
    value: 'passthrough',
    source: 'https://manual.nssurge.com/profile/format.html',
    note: 'Surge Mac 与 iOS 共用 profile 格式，差异在导入入口而非字段；按同方言输出',
  },
  {
    target: 'mihomo',
    scope: 'node',
    subject: '*',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/',
    note: '出站代理文档列有 ss / vmess / vless / trojan / hysteria2 / tuic / anytls / snell',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'vmess/vless/trojan/ss',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/vmess/',
    note: 'vmess: uuid/alterId/cipher/tls/servername/network；vless: uuid/flow/tls/servername；trojan: password/sni/network；ss: cipher/password/udp/plugin',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'hysteria2: password/obfs/obfs-password/up/down/ports/hop-interval',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/hysteria2/',
    note: '字段表明确 password、obfs(salamander|gecko)、obfs-password、up/down、ports、hop-interval、sni、skip-cert-verify、fingerprint、alpn；ports 与 port 互斥',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'tuic: uuid/password/congestion-controller/udp-relay-mode/alpn',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/tuic/',
    note: 'v5 用 uuid + password，v4 用 token，两者互斥；含 congestion-controller、udp-relay-mode、disable-sni、alpn',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'anytls: password/idle-session-timeout',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/anytls/',
    note: 'password 必填；idle-session-check-interval / idle-session-timeout / min-idle-session；页内明确 Mihomo 不支持 AnyTLS + Reality 组合',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'snell: psk/version/obfs-opts',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/snell/',
    note: 'psk 必填，version 1–5，obfs-opts.mode 取 http/tls/shadow-tls/restls/jls、host 为混淆域名',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'reality-opts / client-fingerprint / ws-opts / grpc-opts',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/vless/',
    note: 'vless 模板含 reality-opts{public-key, short-id} 与顶层 client-fingerprint；传输层 ws-opts{path,headers.Host} 与 grpc-opts{grpc-service-name} 见 transport 页',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'ss: plugin / plugin-opts',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/ss/',
    note: 'plugin 取 obfs / v2ray-plugin 等；obfs 用 plugin-opts{mode,host}，v2ray-plugin 用 {mode,tls,host,path}',
  },
  {
    target: 'clash',
    scope: 'node',
    subject: 'hysteria2 / tuic',
    value: 'unverified',
    source: 'https://stash.wiki/en/proxy-protocols/proxy-types',
    note: 'Stash 的 hysteria2 认证字段写作 auth（mihomo 是 password），tuic 必须显式 version；与 clash-yaml 方言不同构，拒绝而不写错字段',
  },
  {
    target: 'clash',
    scope: 'feature',
    subject: 'ss/vmess/vless/trojan/reality/anytls/snell',
    value: 'support',
    source: 'https://stash.wiki/en/proxy-protocols/proxy-types',
    note: 'Stash 官方页给出 type/name/server/port 与各协议字段，含 reality-opts{public-key,short-id}、anytls、snell{pks,version,obfs-opts}、plugin、ws-opts',
  },
  {
    target: 'clash-apple',
    scope: 'node',
    subject: 'hysteria2 / tuic / anytls / reality',
    value: 'unverified',
    source: 'https://clash.md/guide/config/',
    note: 'Hysteria2 / TUIC / AnyTLS / Reality 专属字段在本能力表尚未逐项核实，暂标 unverified',
  },
  {
    target: 'clash-apple',
    scope: 'node',
    subject: 'snell (v1-v6)',
    value: 'support',
    source: 'https://clash.md/zh/guide/config/outbound/snell',
    note: 'Clash App 自 1.0.18 起内置 mihomo 1.19.34 支持 Snell v1–v6；v6 禁用 HTTP/TLS obfs 且 PSK 须为 12–255 字节',
  },
  {
    target: 'sing-box',
    scope: 'node',
    subject: '*',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/outbound/',
    note: 'outbound type 列表含 shadowsocks / vmess / vless / trojan / hysteria2 / tuic / anytls；无 snell（故 snell 判 reject）；hiddify 同方言继承',
  },
  {
    target: 'sing-box',
    scope: 'feature',
    subject: 'tls.enabled/server_name/insecure/alpn/utls/reality',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/shared/tls/',
    note: 'shared/tls 给出 outbound 完整结构：enabled/server_name/insecure/alpn/utls{enabled,fingerprint}/reality{enabled,public_key,short_id}',
  },
  {
    target: 'sing-box',
    scope: 'feature',
    subject: 'transport.ws / transport.grpc',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/shared/v2ray-transport/',
    note: 'ws: {type:"ws", path, headers{Host}}；grpc: {type:"grpc", service_name}；由此 path / host 不再判 unverified',
  },
  {
    target: 'sing-box',
    scope: 'feature',
    subject: 'server/server_port/method/password/uuid/plugin',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/outbound/shadowsocks/',
    note: 'ss 页 Required: server / server_port / method / password，plugin 仅内置 obfs-local 与 v2ray-plugin、参数走 plugin_opts 分号串',
  },
  {
    target: 'sing-box',
    scope: 'feature',
    subject: 'hysteria2 / tuic / anytls 各自字段',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/outbound/hysteria2/',
    note: 'hysteria2: password/up_mbps/down_mbps/obfs{type,password}/server_ports；tuic: uuid/password/congestion_control/udp_relay_mode；anytls: password/idle_session_timeout',
  },
  {
    target: 'loon',
    scope: 'node',
    subject: 'ss/vmess/vless/trojan/hysteria2/anytls',
    value: 'support',
    source: 'https://nsloon.app/en/docs/Node/',
    note: '官方 [Proxy] 段分别给出 Shadowsocks / VMess / VLESS / Trojan / Hysteria2 / AnyTLS 的完整行格式与参数表',
  },
  {
    target: 'loon',
    scope: 'feature',
    subject: 'over-tls/sni/transport/path/host/flow/alterId/udp/alpn/tls-profile',
    value: 'support',
    source: 'https://nsloon.app/en/docs/Node/',
    note: '官方页列 over-tls / sni / transport / path / host / flow / alterId / udp、tls-profile 指纹、tls-cert-sha256',
  },
  {
    target: 'loon',
    scope: 'feature',
    subject: 'reality: public-key / short-id',
    value: 'support',
    source: 'https://nsloon.app/en/docs/Node/',
    note: 'VLESS-Reality 与 Trojan-Reality 示例行明确写 public-key + short-id + tls-profile=chrome',
  },
  {
    target: 'loon',
    scope: 'feature',
    subject: 'obfs: salamander-password / server-ports / hop-interval / download-bandwidth',
    value: 'support',
    source: 'https://nsloon.app/en/docs/Node/',
    note: 'Hysteria2 示例行含 salamander-password、server-ports、hop-interval、download-bandwidth、alpn',
  },
  {
    target: 'loon',
    scope: 'node',
    subject: 'tuic / snell',
    value: 'unverified',
    source: 'https://nsloon.app/en/docs/Node/',
    note: '本次取得的官方 Node 页未覆盖 TUIC / Snell 段，不推测行格式',
  },
  {
    target: 'loon',
    scope: 'rule',
    subject: '[Rule]',
    value: 'unverified',
    source: 'https://nsloon.app/en/docs/Node/',
    note: '该页明确只写 [Proxy] 段，未给 [Proxy Group] / [Rule]；规则段本次未核实，输出保留注释说明',
  },
  {
    target: 'quanx',
    scope: 'node',
    subject: 'ss/vmess/vless/trojan',
    value: 'support',
    source: 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf',
    note: '官方 sample.conf 的 [server_local] 分别给出 shadowsocks= / vmess= / vless= / trojan= 行示例',
  },
  {
    target: 'quanx',
    scope: 'node',
    subject: 'hysteria2 / tuic / anytls / snell',
    value: 'reject',
    source: 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf',
    note: 'sample.conf 的 [server_local] 无这四类协议，客户端不提供对应行格式',
  },
  {
    target: 'quanx',
    scope: 'feature',
    subject: 'over-tls/tls-host/obfs/obfs-uri/obfs-host/vless-flow/method',
    value: 'support',
    source: 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf',
    note: 'sample.conf 注释与示例行明写上述参数；alterId、plugin、reality 未出现，标 unverified',
  },
  {
    target: 'quanx',
    scope: 'rule',
    subject: 'host / host-suffix / ip-cidr / final',
    value: 'support',
    source: 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf',
    note: '[filter_local] 给出 host, x, proxy / host-suffix / ip-cidr / final 行格式；无逻辑规则示例，AND/OR/NOT 保持 unverified',
  },
  {
    target: 'egern',
    scope: 'node',
    subject: 'ss/vmess/vless/trojan',
    value: 'support',
    source: 'https://egernapp.com/docs/configuration/proxies',
    note: '官方页分别给出 shadowsocks / vmess / vless / trojan 的 Required 字段（user_id / security / method / password）',
  },
  {
    target: 'egern',
    scope: 'feature',
    subject: 'transport/tls/sni/flow/udp_relay/security/reality',
    value: 'support',
    source: 'https://egernapp.com/docs/configuration/proxies',
    note: '官方页给出 transport.ws / transport.tls / reality / grpc 子结构、trojan.sni、vless.flow；页面无 alterId、obfs、alpn、Reality 之外的新协议字段',
  },
  {
    target: 'egern',
    scope: 'node',
    subject: 'hysteria2 / tuic / anytls / snell',
    value: 'unverified',
    source: 'https://egernapp.com/docs/configuration/proxies',
    note: '该页仅覆盖 shadowsocks / vmess / vless / trojan；新四类协议字段未取得依据，标 unverified',
  },
  {
    target: 'egern',
    scope: 'output',
    subject: 'proxies/rules',
    value: 'unverified',
    source: 'https://egernapp.com/docs/configuration/proxies',
    note: '该页未出现 proxies: 外层段、proxy_groups 或 rules 段；只按单节点根键输出 YAML 片段并显式标注，不编造完整配置结构',
  },
  {
    target: 'surge',
    scope: 'rule',
    subject: 'DOMAIN / DOMAIN-SUFFIX / IP-CIDR / FINAL',
    value: 'support',
    source: 'https://manual.nssurge.com/rules/overview.html',
    note: 'Rules Overview 给出 TYPE,VALUE,POLICY 三段式与 FINAL 结尾规则；逻辑规则类型在索引中列出但具体语法未核实，保持 unverified',
  },
  {
    target: 'mihomo',
    scope: 'rule',
    subject: 'DOMAIN / DOMAIN-SUFFIX / IP-CIDR / MATCH / AND / OR / NOT',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/rules/',
    note: '页面给出基础规则行示例与 LOGIC_TYPE,((payload1),(payload2)),Proxy 模板，含 AND / OR / NOT 三条完整示例',
  },
  {
    target: 'sing-box',
    scope: 'rule',
    subject: 'route.rules',
    value: 'unverified',
    source: 'https://sing-box.sagernet.org/configuration/',
    note: 'configuration/ 只列出顶层 route: {}，本次未核实 rules 子结构，不生成规则段',
  },
  {
    target: 'surge',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://manual.nssurge.com/dns/dns-server.html',
    note: '[General] dns-server = 逗号分隔的 IP 列表（支持 system 关键字）；加密 DNS 走 encrypted-dns-server = https://… / h3:// / quic:// / tls://（https://manual.nssurge.com/dns/encrypted-dns.html）。TUN 与 fake-ip 是 App 内开关，配置文件中无对应段',
  },
  {
    target: 'loon',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://nsloon.app/en/docs/DNS/',
    note: '[General] dns-server = system,119.29.29.29；doh-server / doq-server / doh3-server 分别接收加密 DNS。页面未出现 fake-ip、TUN、ECS 配置项',
  },
  {
    target: 'quanx',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf',
    note: '[dns] 段：多条 server = 行、doh-server / doq-server、no-system / no-ipv6 开关；无 fake-ip 与 TUN',
  },
  {
    target: 'mihomo',
    scope: 'feature',
    subject: 'shadow-tls',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/proxies/ss/',
    note: 'ss 页明确「插件，支持 obfs/v2ray-plugin/gost-plugin/shadow-tls/restls/kcptun/jls」，shadow-tls 的 plugin-opts 含 host / password / version(1–3)，并可配 client-fingerprint',
  },
  {
    target: 'mihomo',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://wiki.metacubex.one/config/dns/',
    note: 'dns 段含 enable / enhanced-mode（fake-ip 或 redir-host）/ fake-ip-range / default-nameserver / nameserver / proxy-server-nameserver / direct-nameserver / fallback；tun 段为顶层配置项',
  },
  {
    target: 'clash',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://stash.wiki/en/features/dns-server',
    note: 'Stash 的 dns 段支持 default-nameserver / nameserver / nameserver-policy / proxy-server-nameserver，fake-ip 为默认模式，通过 fake-ip-range / fake-ip-filter 调整；官方示例无 enhanced-mode 键，故不写该键',
  },
  {
    target: 'clash',
    scope: 'runtime',
    subject: 'fake-ip',
    value: 'support',
    source: 'https://stash.wiki/en/features/dns-server',
    note: 'Fake-IP 默认开启（返回 198.18.0.0/16 保留段地址），无需 enhanced-mode；因此只写 fake-ip-range，并记一条「默认即 fake-ip」的说明性诊断',
  },
  {
    target: 'clash-apple',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://clash.md/guide/config/',
    note: '字段表确认 dns.enable / dns.ipv6 / dns.nameserver / dns.fallback / dns.fallback-filter / dns.enhanced-mode / dns.fake-ip-range 均存在，enhanced-mode 支持 fake-ip',
  },
  {
    target: 'sing-box',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/dns/server/https/',
    note: '1.12 起为 typed DNS server（type / tag / server / server_port / path / tls / detour / domain_resolver）；legacy address 写法在 1.12 弃用、1.14 移除，故只写 typed',
  },
  {
    target: 'sing-box',
    scope: 'runtime',
    subject: 'fake-ip',
    value: 'support',
    source: 'https://sing-box.sagernet.org/migration/',
    note: 'fakeip 迁移为独立 server：{type:"fakeip", tag, inet4_range, inet6_range}，dns.fakeip 块整体移除',
  },
  {
    target: 'sing-box',
    scope: 'runtime',
    subject: 'ecs',
    value: 'support',
    source: 'https://sing-box.sagernet.org/configuration/dns/server/legacy/',
    note: 'DNS server 与 dns 顶层都有 client_subnet（自 1.9.0），即 EDNS Client Subnet；其余客户端的 ECS 写法未核实',
  },
  {
    target: 'egern',
    scope: 'runtime',
    subject: 'dns',
    value: 'support',
    source: 'https://egernapp.com/docs/configuration/dns',
    note: 'dns 段为 bootstrap（明文 UDP）+ upstreams（命名组，组内并发取最快）+ forward（按域名路由）+ proxy_nameservers + hosts + block_ips；无 fake-ip 概念',
  },
  {
    target: 'v2box',
    scope: 'node',
    subject: 'ss/vmess/vless/trojan/hysteria2/tuic/anytls',
    value: 'support',
    source: 'https://shadowsocks.org/doc/sip002.html',
    note: '节点 URI 依据 SIP002（SS）、Xray 分享链接规范（VMess/VLESS/Trojan）与 Hysteria 2 URI Scheme；V2Box / Anywhere 仅接收节点列表，客户端专属字段未核实',
  },
  {
    target: 'shadowrocket',
    scope: 'feature',
    subject: 'hysteria2 / tuic / anytls / reality',
    value: 'support',
    source: 'https://v2.hysteria.network/docs/developers/URI-Scheme/',
    note: 'hysteria2 有官方 URI Scheme（auth / obfs / obfs-password / sni / insecure / pinSHA256）；tuic:// 与 anytls:// 为各客户端通行的分享链接约定（uuid:password@host、password@host），vless 的 reality 参数见 Xray 分享链接规范',
  },
];

export const verifiedCapabilityTables: CapabilityTables = buildTables();
