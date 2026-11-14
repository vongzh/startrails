import type { NodeFeature, ProtocolKind } from './index.ts';

/** 抽成独立模块，避免 capabilities/index.ts 与 verified.ts 的 ESM 循环初始化。 */
export const NODE_FEATURES = [
  'tls',
  'sni',
  'transport',
  'path',
  'host',
  'flow',
  'alterId',
  'cipher',
  'udp',
  'plugin',
  'reality',
  'obfs',
  'alpn',
  'insecure',
  'fingerprint',
  'bandwidth',
  'ports',
  'congestion',
  'udpRelayMode',
  'version',
  'idleSession',
  /** shadow-tls 是 SS 的 SIP003 插件里唯一「独立认证」的一种：缺参数就必然连不上。 */
  'shadowTls',
] as const satisfies readonly NodeFeature[];

export const PROTOCOL_KINDS: readonly ProtocolKind[] = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria2',
  'tuic',
  'anytls',
  'snell',
  'wireguard',
  'socks5',
  'http',
];

/**
 * 运行时段的能力轴（与节点特性正交）。
 * 语义：`support` = 会写；`unverified` = 没有官方依据，不写；`reject` = 该客户端/该产物形态里没有这段。
 */
export const RUNTIME_FEATURES = ['dns', 'tun', 'fakeIp', 'ecs', 'enhancedMode', 'nameserverPolicy'] as const;

/**
 * 认证/握手级特性：丢弃它们不是「少一个字段」，而是节点直接连不上。
 * 因此这类特性在目标不支持时必须拒绝节点，而不是静默降级 —— 降级产物看起来正常但必然失败。
 */
export const CRITICAL_FEATURES: readonly NodeFeature[] = ['reality', 'obfs', 'plugin', 'shadowTls'];
