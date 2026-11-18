import { resolveGroupIcon } from '../groups/icons.ts';
import type { Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { descriptorOf } from '../targets.ts';
import { partitionServers, schemeOf } from './runtime.ts';
import { renderRule } from '../rules/index.ts';
import type { EmissionPlan, PlanItem } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { EmitResult } from './index.ts';

/**
 * Quantumult X 方言，依据官方 sample.conf：
 *   [server_local] shadowsocks=host:port, method=..., password=..., tag=Name
 *                  vmess=host:port, method=none, password=UUID, obfs=wss, obfs-uri=/ws, tag=Name
 *                  vless=host:port, method=none, password=UUID, vless-flow=..., tag=Name
 *                  trojan=host:port, password=..., over-tls=true, tls-host=..., tag=Name
 *   [policy]       static = PROXY, tag1, tag2
 *   [filter_local] host, x, proxy / host-suffix, x, proxy / final, proxy
 */
const comma = (value: string): string => (value.includes(',') ? `"${value}"` : value);

function quanxLine(node: ProxyNode, dropped: readonly NodeFeature[]): string | null {
  const options = node.options;
  const usable = (feature: NodeFeature): boolean => !dropped.includes(feature);
  const tail: string[] = [];

  if (options?.tls === true && usable('tls')) tail.push('over-tls=true');
  if (options?.sni !== undefined && usable('sni')) tail.push(`tls-host=${options.sni}`);
  if (options?.host !== undefined && usable('host')) tail.push(`obfs-host=${options.host}`);
  if (options?.transport !== undefined && usable('transport')) {
    tail.push(`obfs=${options?.tls === true && usable('tls') ? 'wss' : 'ws'}`);
    if (options.path !== undefined && usable('path')) tail.push(`obfs-uri=${options.path}`);
  }
  if (options?.udp !== undefined && usable('udp')) tail.push(`udp-relay=${options.udp}`);

  switch (node.kind) {
    case 'shadowsocks': {
      const method = options?.cipher !== undefined && usable('cipher') ? options.cipher : node.method;
      return `shadowsocks=${node.server}:${node.port}, method=${method}, password=${comma(node.password)}${tail.length > 0 ? `, ${tail.join(', ')}` : ''}, tag=${comma(node.name)}`;
    }
    case 'vmess': {
      const method = options?.cipher !== undefined && usable('cipher') ? options.cipher : 'none';
      return `vmess=${node.server}:${node.port}, method=${method}, password=${node.uuid}${tail.length > 0 ? `, ${tail.join(', ')}` : ''}, tag=${comma(node.name)}`;
    }
    case 'vless': {
      const flow = options?.flow !== undefined && usable('flow') ? `, vless-flow=${options.flow}` : '';
      return `vless=${node.server}:${node.port}, method=none, password=${node.uuid}${flow}${tail.length > 0 ? `, ${tail.join(', ')}` : ''}, tag=${comma(node.name)}`;
    }
    case 'trojan':
      return `trojan=${node.server}:${node.port}, password=${comma(node.password)}${tail.length > 0 ? `, ${tail.join(', ')}` : ''}, tag=${comma(node.name)}`;
    // 能力表判 reject/unverified：sample.conf 的 [server_local] 无这些协议。
    case 'hysteria2':
    case 'tuic':
    case 'anytls':
    case 'snell':
    case 'wireguard':
    case 'socks5':
    case 'http':
      return null;
    default:
      return assertNever(node);
  }
}

export const quanxEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  /**
   * [dns] 段。QuanX 默认会**同时**使用系统 DNS 与我们写的服务器；
   * 用户既然显式指定了服务器，就加 `no-system` 让结果可预期——这一点在 sample.conf 的注释里写明。
   * `no-ipv6` 是裸开关（无值），不能在后面加 `= true`。
   */
  const dnsLines: string[] = [];
  const dns = emissionPlan.runtime.dns;
  if (dns !== null) {
    const { plain, encrypted } = partitionServers(dns.nameserver);
    const encryptedOk = encrypted.filter((server) => {
      const scheme = schemeOf(server);
      return scheme === 'https' || scheme === 'quic';
    });
    const skipped = encrypted.filter((server) => {
      const scheme = schemeOf(server);
      return scheme === 'tls' || scheme === 'tcp' || scheme === 'h3';
    });
    if (skipped.length > 0) {
      // sample.conf 只给出 doh-server / doq-server，DoT / DoH3 / DNS-over-TCP 无对应键。
      diagnostics.push(
        makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-scheme-unsupported:tls/tcp/h3'),
      );
    }
    if (plain.length > 0 || encryptedOk.length > 0) {
      dnsLines.push('no-system');
      for (const server of plain) dnsLines.push(`server = ${server}`);
      const doh = encryptedOk.filter((server) => schemeOf(server) === 'https');
      const doq = encryptedOk.filter((server) => schemeOf(server) === 'quic');
      if (doh.length > 0) dnsLines.push(`doh-server = ${doh.join(', ')}`);
      if (doq.length > 0) dnsLines.push(`doq-server = ${doq.join(', ')}`);
    }
    if (dns.ipv6 === false) dnsLines.push('no-ipv6');
    if (dns.proxyNameserver !== undefined) {
      diagnostics.push(
        makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-proxy-nameserver-unsupported'),
      );
    }
  }

  const lines: string[] = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    `# Field mapping basis: ${descriptorOf(target).basis}`,
    ...(dnsLines.length === 0 ? [] : ['', '[dns]', ...dnsLines]),
    '',
    '[server_local]',
  ];
  const included: string[] = [];

  for (const item of acceptedItems(emissionPlan) as readonly PlanItem[]) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    const line = quanxLine(node, item.droppedFeatures);
    if (line !== null) {
      lines.push(line);
      included.push(node.name);
    }
  }

  const QUANX_TERMINAL_POLICIES: Readonly<Record<string, string>> = {
    DIRECT: 'direct',
    REJECT: 'reject',
  };
  const groupNames = new Set(profile.policyGroups.map((group) => group.name));
  lines.push('', '[policy]');
  for (const group of profile.policyGroups) {
    const members = group.members.flatMap((member) => {
      const upper = member.toUpperCase();
      const terminal = QUANX_TERMINAL_POLICIES[upper];
      if (terminal !== undefined) return [terminal];
      if (included.includes(member) || (member !== group.name && groupNames.has(member))) {
        return [comma(member)];
      }
      if (upper === 'PROXY') return ['proxy'];
      return [];
    });
    const quanxIcon =
      group.icon !== undefined && group.icon.length > 0
        ? resolveGroupIcon(group, profile.ruleSources).quanx
        : undefined;
    const iconSuffix = quanxIcon !== undefined && quanxIcon.length > 0 ? `, img-url=${quanxIcon}` : '';
    lines.push(`static = ${comma(group.name)}, ${members.join(', ') || 'direct'}${iconSuffix}`);
  }

  lines.push('', '[filter_local]');
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
    if (source.kind === 'external') {
      lines.push(`# external rule set not emitted (content not evaluable): ${source.url}`);
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-passthrough-skipped'));
    }
  }
  lines.push('final, proxy');

  return { content: `${lines.join('\n')}\n`, diagnostics };
};
