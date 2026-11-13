import type { Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { renderRule } from '../rules/index.ts';
import type { EmissionPlan, PlanItem } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { descriptorOf } from '../targets.ts';
import type { EmitResult } from './index.ts';
import { partitionServers } from './runtime.ts';

/** 依据 profile/format.html：含逗号的值用双引号包裹，转义 \ 与 "。 */
const quote = (value: string): string =>
  value.includes(',')
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value;

const SURGE_VMESS_CIPHERS = new Set(['aes-128-gcm', 'chacha20-ietf-poly1305']);

/**
 * Surge 的 [WireGuard <Section>] 段名需与 [Proxy] 引用行的 `section-name` 一致。
 * 段名里不能带空格 / 逗号 / 等号，用短横线替换空格，并剔除可能破坏 ini 结构的字符。
 * 同名节点各自成段（Surge 每段一个 peer），故直接用节点名派生即可、无碰撞风险。
 */
function sectionNameFor(nodeName: string): string {
  const sanitized = nodeName.replace(/[ ,=]/g, '-');
  return `Startrails-${sanitized || 'wg'}`;
}

/** 通用 TLS 参数（依据 policies/tls.html）：sni / skip-cert-verify / alpn。 */
function tlsParams(
  node: ProxyNode,
  usable: (feature: NodeFeature) => boolean,
): string[] {
  const options = node.options;
  const params: string[] = [];
  if (options?.sni !== undefined && usable('sni')) params.push(`sni=${options.sni}`);
  if (options?.insecure === true && usable('insecure')) params.push('skip-cert-verify=true');
  if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
    params.push(`alpn=${quote(options.alpn.join(','))}`);
  }
  return params;
}

/** 依据 policies/hysteria2.html 与 policies/tuic.html 与 policies/snell.html 的 [Proxy] 行语法。 */
function surgeLine(
  node: ProxyNode,
  dropped: readonly NodeFeature[],
  diagnostics: Diagnostic[],
  target: EmissionPlan['target'],
): string | null {
  const name = quote(node.name);
  const options = node.options;
  const usable = (feature: NodeFeature): boolean => !dropped.includes(feature);

  switch (node.kind) {
    case 'shadowsocks':
      return `${name} = ss, ${node.server}, ${node.port}, encrypt-method=${node.method}, password=${node.password}`;

    case 'vmess': {
      const params = [`username=${node.uuid}`];
      if (options?.cipher !== undefined && usable('cipher') && SURGE_VMESS_CIPHERS.has(options.cipher)) {
        params.push(`encrypt-method=${options.cipher}`);
      }
      if (options?.tls === true && usable('tls')) params.push('tls=true');
      params.push(...tlsParams(node, usable));
      if (options?.transport !== undefined && usable('transport')) {
        if (options.transport === 'ws') {
          params.push('ws=true');
          if (options.path !== undefined && usable('path')) params.push(`ws-path=${options.path}`);
          if (options.host !== undefined && usable('host')) {
            params.push(`ws-headers=Host:${options.host}`);
          }
        } else {
          diagnostics.push(
            makeDiagnostic('emit', target, node.name, `transport-not-expressible:${options.transport}`),
          );
        }
      }
      return `${name} = vmess, ${node.server}, ${node.port}, ${params.join(', ')}`;
    }

    case 'hysteria2': {
      const params = [`password=${node.password}`, ...tlsParams(node, usable)];
      if (options?.bandwidth?.down !== undefined && usable('bandwidth')) {
        params.push(`download-bandwidth=${options.bandwidth.down}`);
      }
      if (options?.ports !== undefined && usable('ports')) params.push(`port-hopping=${options.ports}`);
      if (options?.obfs !== undefined && usable('obfs')) {
        if (options.obfs.type === 'salamander' && options.obfs.password !== undefined) {
          params.push(`salamander-password=${options.obfs.password}`);
        } else if (options.obfs.type === 'gecko' && options.obfs.password !== undefined) {
          params.push(`gecko-password=${options.obfs.password}`);
        } else {
          diagnostics.push(
            makeDiagnostic('emit', target, node.name, `obfs-not-expressible:${options.obfs.type}`),
          );
        }
      }
      return `${name} = hysteria2, ${node.server}, ${node.port}, ${params.join(', ')}`;
    }

    case 'tuic': {
      // 本 IR 只有 TUIC v5，Surge 的关键字是 tuic-v5（tuic 是 v4 token 模式）。
      const params = [`uuid=${node.uuid}`, `password=${node.password}`, ...tlsParams(node, usable)];
      return `${name} = tuic-v5, ${node.server}, ${node.port}, ${params.join(', ')}`;
    }

    case 'snell': {
      const params = [`psk=${node.psk}`];
      if (options?.version !== undefined && usable('version')) params.push(`version=${options.version}`);
      if (options?.obfs !== undefined && usable('obfs')) {
        if (options.obfs.type === 'http' || options.obfs.type === 'tls') {
          params.push(`obfs=${options.obfs.type}`);
          if (options.obfs.host !== undefined) params.push(`obfs-host=${options.obfs.host}`);
        } else {
          diagnostics.push(
            makeDiagnostic('emit', target, node.name, `obfs-not-expressible:${options.obfs.type}`),
          );
        }
      }
      return `${name} = snell, ${node.server}, ${node.port}, ${params.join(', ')}`;
    }

    // 能力表已拒绝：Surge 手册未列 VLESS / AnyTLS；Trojan 参数依据未核实。
    case 'vless':
    case 'trojan':
    case 'anytls':
      return null;

    // WireGuard：[Proxy] 段只写引用行（wireguard, section-name = …），
    // 真正的隧道参数在独立的 [WireGuard <section>] 段，由 emitter 主流程统一收集输出。
    case 'wireguard':
      return `${name} = wireguard, section-name = ${sectionNameFor(node.name)}`;

    // SOCKS5 直连节点（socks5 关键字）；HTTP 代理节点 Surge 无对应行，能力表已 reject。
    case 'socks5': {
      const params: string[] = [];
      if (node.username !== undefined) params.push(`username=${node.username}`);
      if (node.password !== undefined) params.push(`password=${node.password}`);
      return `${name} = socks5, ${node.server}, ${node.port}${params.length > 0 ? `, ${params.join(', ')}` : ''}`;
    }
    case 'http':
      return null;

    default:
      return assertNever(node);
  }
}

/**
 * 依据 manual.nssurge.com/policy/wireguard.html：把 IR 的 wireguard 节点渲染成独立
 * [WireGuard <Section>] 段。字段映射——
 *   privateKey → private-key；addresses[0](IPv4) → self-ip；addresses[1](IPv6) → self-ip-v6；
 *   peerPublicKey → peer.public-key；preSharedKey → peer.preshared-key；
 *   allowedIps → peer.allowed-ips（逗号分隔，含逗号故用双引号包裹）；server:port → peer.endpoint；
 *   mtu → mtu。
 * reserved（三字节）在 Surge 无对应字段，写不出即丢弃并记诊断，不静默降级。
 */
function surgeWireguardSection(
  node: Extract<ProxyNode, { kind: 'wireguard' }>,
  target: EmissionPlan['target'],
  diagnostics: Diagnostic[],
): string {
  const lines: string[] = [`[WireGuard ${sectionNameFor(node.name)}]`];
  lines.push(`private-key = ${node.privateKey}`);
  const addresses = node.addresses;
  if (addresses.length > 0 && addresses[0] !== undefined) {
    lines.push(`self-ip = ${addresses[0]}`);
  }
  if (addresses.length > 1 && addresses[1] !== undefined) {
    lines.push(`self-ip-v6 = ${addresses[1]}`);
  }
  if (node.mtu !== undefined) lines.push(`mtu = ${node.mtu}`);

  const peer: string[] = [`public-key = ${node.peerPublicKey}`];
  const allowedIps = node.allowedIps ?? ['0.0.0.0/0', '::/0'];
  peer.push(`allowed-ips = "${allowedIps.join(', ')}"`);
  peer.push(`endpoint = ${node.server}:${node.port}`);
  if (node.preSharedKey !== undefined) peer.push(`preshared-key = ${node.preSharedKey}`);
  lines.push(`peer = (${peer.join(', ')})`);

  if (node.reserved !== undefined && node.reserved.length > 0) {
    diagnostics.push(
      makeDiagnostic('emit', target, node.name, 'wireguard-reserved-not-expressible'),
    );
  }
  return lines.join('\n');
}

export const surgeEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  /**
   * [General] 段：DNS 按 Surge 的两套字段分流——
   * `dns-server` 只接受 IP 与 `system` 关键字（手册明确「Hostnames are not allowed」），
   * 加密 DNS 一律走 `encrypted-dns-server`（https / h3 / quic / tls / tcp）。
   */
  const general: string[] = ['loglevel = notify'];
  const dns = emissionPlan.runtime.dns;
  if (dns !== null) {
    const { plain, encrypted } = partitionServers(dns.nameserver);
    if (plain.length > 0) general.push(`dns-server = ${plain.join(', ')}`);
    if (encrypted.length > 0) general.push(`encrypted-dns-server = ${encrypted.join(', ')}`);
    if (dns.ipv6 !== undefined) general.push(`ipv6 = ${dns.ipv6 ? 'true' : 'false'}`);
    if (dns.proxyNameserver !== undefined) {
      // Surge 没有「解析代理节点域名」的独立字段，硬塞进 dns-server 会改变全局解析行为。
      diagnostics.push(
        makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-proxy-nameserver-unsupported'),
      );
    }
  }

  const lines: string[] = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    '# Field mapping basis: Surge official manual (policies/*.html, rules/overview.html)',
    '',
    '[General]',
    ...general,
    '',
    '[Proxy]',
  ];

  const included: string[] = [];
  const wireguardSections: string[] = [];
  for (const item of acceptedItems(emissionPlan) as readonly PlanItem[]) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    const line = surgeLine(node, item.droppedFeatures, diagnostics, target);
    if (line !== null) {
      lines.push(line);
      included.push(node.name);
      if (node.kind === 'wireguard') {
        wireguardSections.push(surgeWireguardSection(node, target, diagnostics));
      }
    }
  }

  lines.push('', '[Proxy Group]');
  for (const group of profile.policyGroups) {
    const members = group.members.filter((member) => included.includes(member));
    lines.push(`${quote(group.name)} = select, ${members.join(', ') || 'DIRECT'}`);
  }
  if (profile.policyGroups.length === 0 && included.length > 0) {
    lines.push(`PROXY = select, ${included.join(', ')}`);
  }

  lines.push('', '[Rule]');
  for (const item of emissionPlan.ruleItems) {
    if (!item.decision.accepted) continue;
    const rendered = renderRule(target, item.rule);
    if (rendered === null) {
      diagnostics.push(
        makeDiagnostic('emit', target, `rule:${item.sourceIndex}:${item.index}`, 'rule-not-renderable'),
      );
      continue;
    }
    lines.push(rendered);
  }
  for (const source of profile.ruleSources) {
    if (source.kind !== 'external') continue;
    if (source.policy === undefined) {
      // 没有策略就写不出 RULE-SET 行——策略是这一行的必需参数，不能替用户选一个。
      lines.push(`# external rule set skipped (no policy in source): ${source.url}`);
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-without-policy'));
      continue;
    }
    lines.push(`RULE-SET,${source.url},${source.policy}`);
  }
  lines.push('FINAL,DIRECT', '');

  // [WireGuard] 段放在 [Rule] 之后、文件末尾，紧跟前文——Surge 允许段顺序任意，放在末尾最稳。
  if (wireguardSections.length > 0) {
    lines.push(...wireguardSections, '');
  }

  return { content: lines.join('\n'), diagnostics };
};
