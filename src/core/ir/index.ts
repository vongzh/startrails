export type { ClientTarget } from '../targets.ts';
export { CLIENT_TARGETS } from '../targets.ts';

export type NodeTransport = 'ws' | 'grpc' | 'http2';

/** Reality 参数（VLESS/VMess/Trojan 的 TLS 替换方案）；只有客户端侧字段。 */
export interface RealityOptions {
  readonly publicKey: string;
  readonly shortId?: string;
  /** 伪装用的 TLS 指纹（分享链接里的 fp）。 */
  readonly fingerprint?: string;
  /** spiderX（分享链接里的 spx），多数客户端用于伪装根路径。 */
  readonly spiderX?: string;
}

/**
 * 混淆：
 *  - QUIC 类协议（hysteria2）用 salamander / gecko；
 *  - Snell 用 http / tls。
 * 取值域不同，Emitter 必须按协议校验，不能跨协议照抄字段。
 */
export interface ObfsOptions {
  readonly type: 'salamander' | 'gecko' | 'http' | 'tls';
  readonly password?: string;
  readonly host?: string;
}

/** SIP003 插件参数（obfs-local / v2ray-plugin / shadow-tls）。 */
export interface PluginOptions {
  readonly mode?: string;
  readonly host?: string;
  readonly path?: string;
  readonly tls?: boolean;
  /** shadow-tls 的独立密码；与 SS 密码是两套东西，不能复用。 */
  readonly password?: string;
  /** shadow-tls 协议版本 1–3。 */
  readonly version?: number;
}

export interface BandwidthOptions {
  /** Mbps；缺省表示不声明，交由客户端自适应。 */
  readonly up?: number;
  readonly down?: number;
}

/** 只收录公开格式规范中能表达且已核实的传输层字段；新增字段必须同步能力表。 */
export interface NodeOptions {
  readonly tls?: boolean;
  readonly sni?: string;
  readonly transport?: NodeTransport;
  readonly path?: string;
  readonly host?: string;
  readonly flow?: string;
  readonly alterId?: number;
  readonly cipher?: string;
  readonly udp?: boolean;
  readonly plugin?: string;
  readonly pluginOpts?: PluginOptions;
  readonly reality?: RealityOptions;
  readonly obfs?: ObfsOptions;
  readonly alpn?: readonly string[];
  /** 跳过证书校验（skip-cert-verify / insecure） */
  readonly insecure?: boolean;
  /** 非 Reality 场景的 uTLS 指纹（client-fingerprint） */
  readonly fingerprint?: string;
  readonly bandwidth?: BandwidthOptions;
  /** 端口跳跃范围，原样保存分享链接/配置里的写法（如 `20000-30000`）。 */
  readonly ports?: string;
  readonly congestionControl?: string;
  readonly udpRelayMode?: string;
  /** Snell 协议版本 1–6。 */
  readonly version?: number;
  /** AnyTLS 空闲会话超时（秒）。 */
  readonly idleSessionTimeout?: number;
}

interface NodeBase {
  readonly name: string;
  readonly server: string;
  readonly port: number;
  readonly options?: NodeOptions;
  /** 用户手动覆盖的地区码（如 `JP`）；无覆盖时由名字关键词推断。仅作筛选/排序标签，不进产物。 */
  readonly region?: string;
}

export type ProxyNode =
  | (NodeBase & { readonly kind: 'vless'; readonly uuid: string })
  | (NodeBase & { readonly kind: 'vmess'; readonly uuid: string })
  | (NodeBase & { readonly kind: 'trojan'; readonly password: string })
  | (NodeBase & { readonly kind: 'shadowsocks'; readonly method: string; readonly password: string })
  | (NodeBase & { readonly kind: 'hysteria2'; readonly password: string })
  | (NodeBase & { readonly kind: 'tuic'; readonly uuid: string; readonly password: string })
  | (NodeBase & { readonly kind: 'anytls'; readonly password: string })
  | (NodeBase & { readonly kind: 'snell'; readonly psk: string })
  | (NodeBase & {
      readonly kind: 'wireguard';
      /** 本地私钥（base64）。 */
      readonly privateKey: string;
      /** 对端公钥（base64）。 */
      readonly peerPublicKey: string;
      /** 可选预共享密钥（base64）。 */
      readonly preSharedKey?: string;
      /** 客户端分配的隧道地址（含前缀，如 `10.0.0.2/32`），至少一条。 */
      readonly addresses: readonly string[];
      /** 可选 MTU。 */
      readonly mtu?: number;
      /** 可选 reserved 三字节（商业机场常用，用于绕过某些封锁）。 */
      readonly reserved?: readonly number[];
      /** 可选允许路由的网段（默认 0.0.0.0/0）。 */
      readonly allowedIps?: readonly string[];
    })
  | (NodeBase & {
      readonly kind: 'socks5';
      readonly username?: string;
      readonly password?: string;
    })
  | (NodeBase & {
      readonly kind: 'http';
      readonly username?: string;
      readonly password?: string;
    });

export type RuleCondition =
  | { readonly type: 'domain'; readonly value: string }
  | { readonly type: 'domainSuffix'; readonly value: string }
  | { readonly type: 'domainKeyword'; readonly value: string }
  | { readonly type: 'geosite'; readonly value: string }
  | { readonly type: 'geoip'; readonly value: string; readonly noResolve?: boolean | undefined }
  | { readonly type: 'ipCidr'; readonly value: string; readonly noResolve?: boolean | undefined }
  | { readonly type: 'ipCidr6'; readonly value: string; readonly noResolve?: boolean | undefined }
  | { readonly type: 'match' }
  | { readonly type: 'and'; readonly children: readonly RuleCondition[] }
  | { readonly type: 'or'; readonly children: readonly RuleCondition[] }
  | { readonly type: 'not'; readonly child: RuleCondition };

export interface InlineRule {
  readonly condition: RuleCondition;
  readonly policy: string;
}

/**
 * 外部规则集里**装的是什么**。这是内容语义，不是某个客户端的字段：
 * - `domain`：一行一个域名（裸域名 / `+.example.com`），客户端按域名后缀匹配；
 * - `ipcidr`：一行一段 CIDR；
 * - `rules`：一行一条完整规则（`IP-CIDR,10.0.0.0/8,no-resolve` 这种）。
 *
 * 为什么要建模：mihomo 的 `rule-providers` 必须声明 `behavior`，而**写错的后果是整份配置
 * 加载失败**，不是少一条规则。所以这一项宁可不写（跳过并诊断），也不靠文件名猜。
 */
export type RuleSetShape = 'domain' | 'ipcidr' | 'rules';

/** M1 规则层只做「引用 + 透传」；内联条件树编辑器属 M4。 */
export type RuleSource =
  | { readonly kind: 'inline'; readonly rules: readonly InlineRule[] }
  /**
   * 外部规则集。`policy` 只在源里能读到引用策略时才有（Clash `rules: RULE-SET,<provider>,<policy>`）：
   * 没有策略就无法生成 `RULE-SET,<url>,<policy>` 这一行，不能凭空指定一个。
   *
   * `shape` 有两条来路，都算「有依据」：Clash 源自身的 `rule-providers.<name>.behavior`
   * 直接映射；其余情况由服务端拿到正文后按内容判定（见 `inferRuleSetShape`）。
   * 两条都不通时保持 undefined——需要它的方言会跳过并留诊断，而不是猜一个。
   */
  | {
      readonly kind: 'external';
      readonly url: string;
      readonly policy?: string | undefined;
      readonly shape?: RuleSetShape | undefined;
      /** 文件编码。缺省按文本；`payload:` 包装的规则集必须是 yaml，否则 mihomo 拒载。 */
      readonly encoding?: 'text' | 'yaml' | undefined;
    };

/** DNS 解析模式。`fake-ip` 只在支持该模式的客户端上生效，其余降级为 `redir-host` 并记诊断。 */
export type DnsMode = 'system' | 'fake-ip' | 'redir-host';

/**
 * DNS 策略。刻意只建模「各客户端都能对上号」的这几个概念：
 * - `nameserver`：默认解析器，可写明文 IP 或加密 URL（`https://…/dns-query`、`tls://…`）；
 * - `proxyNameserver`：**解析代理节点域名**用的解析器。不写它，节点域名就要走默认解析器，
 *   在「默认解析器本身也被代理」的客户端上会形成 DNS → 代理 → DNS 的环；
 * - `directNameserver`：直连域名专用解析器（mihomo 的 `direct-nameserver`）；
 * - `ecs`：EDNS Client Subnet，只在确认支持该后缀的客户端上写。
 */
export interface DnsPolicy {
  readonly mode: DnsMode;
  readonly nameserver?: readonly string[];
  readonly proxyNameserver?: readonly string[];
  readonly directNameserver?: readonly string[];
  readonly fallback?: readonly string[];
  /** 域名 → 解析器。键用客户端自己的写法（`*.example.com` / `+.example.com` / 主机名）。 */
  readonly nameserverPolicy?: Readonly<Record<string, string>> | undefined;
  readonly ecs?: string;
  readonly fakeIpRange?: string;
  readonly ipv6?: boolean;
}

/** TUN 入站。只建模「各客户端同名概念」，不追求字段全集。 */
export interface TunPolicy {
  readonly enabled: boolean;
  readonly stack?: 'gvisor' | 'system' | 'mixed';
  readonly strictRoute?: boolean;
  readonly mtu?: number;
}

/**
 * 运行时段：与「节点」正交的整份配置策略。
 * 我们不是客户端，不承诺「防泄露」；只承诺写出的段与该客户端官方文档一致。
 */
export interface RuntimePolicy {
  readonly dns?: DnsPolicy;
  readonly tun?: TunPolicy;
}

export type GroupStrategy = 'select' | 'url-test' | 'fallback';

export interface PolicyGroup {
  readonly name: string;
  readonly members: readonly string[];
  /** 缺省是 select。url-test / fallback 还要有测速地址，否则生成时退回 select 并记诊断。 */
  readonly strategy?: GroupStrategy | undefined;
  readonly testUrl?: string | undefined;
  readonly interval?: number | undefined;
  readonly tolerance?: number | undefined;
  readonly lazy?: boolean | undefined;
  readonly hidden?: boolean | undefined;
}

/** 解析产物，可重建、不落盘；用户意图只存在 Annotation 里。 */
export interface Profile {
  readonly nodes: readonly ProxyNode[];
  readonly ruleSources: readonly RuleSource[];
  readonly policyGroups: readonly PolicyGroup[];
  /** 运行时段可选：没有就不写，绝不生成「看起来配了但没生效」的空段。 */
  readonly runtime?: RuntimePolicy;
}

/** 唯一持久化的用户意图：以稳定 nodeKey 关联节点，刷新后不丢。 */
export interface Annotation {
  readonly nodeKey: string;
  readonly excluded?: boolean;
  readonly alias?: string;
  readonly tag?: string;
  readonly order?: number;
  /** 手动覆盖的地区码（`JP`/`HK`/…）；空串表示清除覆盖、回退名字推断。 */
  readonly region?: string;
}

export interface SourceConfig {
  readonly id: string;
  readonly url: string;
  readonly credentialRef?: string;
  readonly refreshPolicy?: string;
}

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
};

// 纯 TS 短哈希，仅用于稳定 nodeKey，不用于任何安全用途（不引入 node:crypto）。
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const credentialOf = (node: ProxyNode): string => {
  switch (node.kind) {
    case 'vless':
    case 'vmess':
      return node.uuid;
    case 'trojan':
    case 'hysteria2':
    case 'anytls':
      return node.password;
    case 'tuic':
      return `${node.uuid}:${node.password}`;
    case 'shadowsocks':
      return `${node.method}:${node.password}`;
    case 'snell':
      return node.psk;
    case 'wireguard':
      return `${node.privateKey}:${node.peerPublicKey}`;
    case 'socks5':
    case 'http':
      return node.username ?? '';
    default:
      return assertNever(node);
  }
};

/**
 * 稳定标识：凭据 + 传输特征。刻意不含 name —— 用户在 UI 里改名不该让标注失效。
 * 但必须含 sni / transport / path / host / reality / obfs / plugin：
 * 同一 IP:443 上挂多个不同 sni 或不同 reality 公钥的节点很常见，
 * 只按 server:port 会误判成重复节点并静默丢一个。
 */
export const nodeKey = (node: ProxyNode): string => {
  const options = node.options;
  const parts = [
    credentialOf(node),
    options?.sni,
    options?.transport,
    options?.path,
    options?.host,
    options?.flow,
    options?.reality?.publicKey,
    options?.reality?.shortId,
    options?.obfs?.type,
    options?.obfs?.password,
    options?.plugin,
    options?.pluginOpts?.mode,
    options?.pluginOpts?.host,
    options?.ports,
    options?.alpn?.join(','),
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return `${node.kind}:${node.server}:${node.port}:${fnv1a(parts.join('|'))}`;
};

export type ReadonlyDeep<T> = T extends readonly (infer U)[]
  ? readonly ReadonlyDeep<U>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
    : T;

export const deepFreeze = <T>(value: T): ReadonlyDeep<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value as ReadonlyDeep<T>;
};
