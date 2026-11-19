import type { DnsPolicy, TunPolicy } from '../ir/index.ts';
import type { RuntimePlan } from '../plan/index.ts';

/**
 * DNS 条目的形态判断。各客户端对「明文 IP」与「加密 URL」分属不同字段
 * （Surge 的 `dns-server` 只收 IP，加密的必须写 `encrypted-dns-server`），
 * 因此必须按 scheme 分流，不能整串照抄。
 */
const ENCRYPTED_SCHEMES = ['https://', 'h3://', 'quic://', 'tls://', 'tcp://'] as const;

export type ServerScheme = 'https' | 'h3' | 'quic' | 'tls' | 'tcp' | 'plain';

export const schemeOf = (server: string): ServerScheme => {
  const lower = server.toLowerCase();
  for (const scheme of ENCRYPTED_SCHEMES) {
    if (!lower.startsWith(scheme)) continue;
    if (scheme === 'https://') return 'https';
    if (scheme === 'h3://') return 'h3';
    if (scheme === 'quic://') return 'quic';
    if (scheme === 'tls://') return 'tls';
    return 'tcp';
  }
  return 'plain';
};

export const partitionServers = (
  servers: readonly string[] | undefined,
): { readonly plain: readonly string[]; readonly encrypted: readonly string[] } => {
  const plain: string[] = [];
  const encrypted: string[] = [];
  for (const server of servers ?? []) {
    if (schemeOf(server) === 'plain') plain.push(server);
    else encrypted.push(server);
  }
  return { plain, encrypted };
};

/** 从加密 URL 里取主机名（`https://dns.alidns.com/dns-query` → `dns.alidns.com`）。 */
export const hostOfServer = (server: string): string | null => {
  const scheme = schemeOf(server);
  if (scheme === 'plain') return server;
  try {
    return new URL(server).hostname;
  } catch {
    return null;
  }
};

/** 主机名是否需要先被解析（IP 字面量不需要，也就不必再挂 bootstrap 解析器）。 */
export const needsResolution = (host: string): boolean =>
  !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':') && host !== 'system' && host !== 'local';

/** 明文 UDP 引导解析器：从 nameserver 里挑，挑不到就返回空——不替用户编造一个公共 DNS。 */
export const bootstrapServers = (dns: DnsPolicy): readonly string[] => {
  const { plain } = partitionServers(dns.nameserver);
  return plain.filter((server) => server !== 'system');
};

export const emptyRuntime: RuntimePlan = { dns: null, tun: null, explicitFakeIpMode: false };

export const hasRuntime = (runtime: RuntimePlan): boolean =>
  runtime.dns !== null || runtime.tun !== null;

/** TUN 段在 Clash 方言里的写法（mihomo `tun:` 顶层键）。 */
export const tunFields = (tun: TunPolicy): Record<string, unknown> => ({
  enable: tun.enabled,
  ...(tun.stack === undefined ? {} : { stack: tun.stack }),
  ...(tun.strictRoute === undefined ? {} : { 'strict-route': tun.strictRoute }),
  ...(tun.mtu === undefined ? {} : { mtu: tun.mtu }),
});

/**
 * 清洗 INI 方言（Surge / Loon / Quantumult X）里的节点名与策略组名：
 *  - `//`（Surge 行内/行首注释符）、`#`、`;` 会把同一行节点与策略组成员截断；
 *  - `[` / `]` 在 INI 里开启新段，会把后续节点孤立；
 *  - `=` 与换行符会破坏 `Name = Proto, ...` 的键值分割。
 * 转成全角字符与连字符以保语义可读且不断行、不截断。
 */
export const sanitizeIniName = (value: string): string =>
  value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/=/g, '－')
    .replace(/#/g, '＃')
    .replace(/;/g, '；')
    .replace(/\/\//g, '／／')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .trim();

export const formatHostPort = (host: string, port: number): string => {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${bracketed}:${port}`;
};
