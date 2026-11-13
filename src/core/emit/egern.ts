import YAML from 'yaml';
import type { Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { descriptorOf } from '../targets.ts';
import type { EmissionPlan, PlanItem } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { EmitResult } from './index.ts';

type Fields = Record<string, unknown>;

/**
 * Egern 官方 proxies 页只给「单节点以协议名作 YAML 根键」的示例，明确未出现
 * proxies: / proxy_groups / rules 段。因此输出用 `---` 分隔的多个 YAML 文档，
 * 每个文档一个节点，并显式标注为片段级配置，不编造完整配置骨架。
 *
 * 依据：https://egernapp.com/docs/configuration/proxies
 *  - shadowsocks: name/method/password/server/port (Required)
 *  - vmess:       name/server/port/user_id/security (Required)
 *  - vless:       name/server/port/user_id (Required), flow
 *  - trojan:      name/server/port/password (Required), sni
 */
function egernDocument(node: ProxyNode, dropped: readonly NodeFeature[]): Fields | null {
  const options = node.options;
  const usable = (feature: NodeFeature): boolean => !dropped.includes(feature);
  const base = { name: node.name, server: node.server, port: node.port };

  switch (node.kind) {
    case 'shadowsocks': {
      const key = 'shadowsocks';
      const fields: Fields = { ...base, method: node.method, password: node.password };
      if (options?.udp !== undefined && usable('udp')) fields['udp_relay'] = options.udp;
      return { [key]: fields };
    }
    case 'vmess': {
      const fields: Fields = {
        ...base,
        user_id: node.uuid,
        security: options?.cipher !== undefined && usable('cipher') ? options.cipher : 'auto',
      };
      if (options?.udp !== undefined && usable('udp')) fields['udp_relay'] = options.udp;
      const transport = egernTransport(node, usable);
      if (transport !== null) fields['transport'] = transport;
      return { vmess: fields };
    }
    case 'vless': {
      const fields: Fields = { ...base, user_id: node.uuid };
      if (options?.flow !== undefined && usable('flow')) fields['flow'] = options.flow;
      if (options?.udp !== undefined && usable('udp')) fields['udp_relay'] = options.udp;
      if (options?.reality !== undefined && usable('reality')) {
        fields['reality'] = {
          public_key: options.reality.publicKey,
          ...(options.reality.shortId === undefined ? {} : { short_id: options.reality.shortId }),
        };
      }
      const transport = egernTransport(node, usable);
      if (transport !== null) fields['transport'] = transport;
      return { vless: fields };
    }
    case 'trojan': {
      const fields: Fields = { ...base, password: node.password };
      if (options?.sni !== undefined && usable('sni')) fields['sni'] = options.sni;
      if (options?.udp !== undefined && usable('udp')) fields['udp_relay'] = options.udp;
      if (options?.transport !== undefined && usable('transport')) {
        const ws: Fields = {};
        if (options.path !== undefined && usable('path')) ws['path'] = options.path;
        if (options.host !== undefined && usable('host')) ws['headers'] = { Host: options.host };
        fields['websocket'] = ws;
      }
      return { trojan: fields };
    }
    // 能力表判 unverified：官方 proxies 页只覆盖 ss / vmess / vless / trojan。
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

const egernTransport = (
  node: ProxyNode,
  usable: (feature: NodeFeature) => boolean,
): Fields | null => {
  const options = node.options;
  if (options?.transport === undefined || !usable('transport')) return null;
  if (options.transport === 'grpc') return { grpc: {} };
  const ws: Fields = {};
  if (options.path !== undefined && usable('path')) ws['path'] = options.path;
  if (options.host !== undefined && usable('host')) ws['headers'] = { Host: options.host };
  if (options.tls === true && usable('tls')) {
    const tls: Fields = {};
    if (options.sni !== undefined && usable('sni')) tls['sni'] = options.sni;
    return { wss: { ...ws, ...(Object.keys(tls).length > 0 ? tls : {}) } };
  }
  return { ws };
};

export const egernEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  const documents: string[] = [];

  for (const item of acceptedItems(emissionPlan) as readonly PlanItem[]) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    const document = egernDocument(node, item.droppedFeatures);
    if (document === null) continue;
    documents.push(YAML.stringify(document, { lineWidth: 0 }).trimEnd());
  }

  diagnostics.push(
    makeDiagnostic(
      'emit',
      target,
      'config',
      'partial-config: official page documents single-node root keys only; proxy_groups/rules not emitted',
    ),
  );
  for (const source of profile.ruleSources) {
    if (source.kind === 'external') {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-passthrough-skipped'));
    }
  }

  /**
   * dns 文档。Egern 的结构是 bootstrap（明文 UDP，启动期解析 / 兜底）+ upstreams（命名组）
   * + forward（按域名选组），**没有 fake-ip**——所以 fake-ip 模式在 plan 阶段已被降级为 redir-host。
   * 只写一个 `*` 通配 forward 把默认解析交给这组服务器，不替用户编造域名分流规则。
   */
  const dns = emissionPlan.runtime.dns;
  if (dns !== null && dns.nameserver !== undefined && dns.nameserver.length > 0) {
    const dnsDoc: Fields = { dns: {} as Fields };
    const block = dnsDoc['dns'] as Fields;
    const bootstrap = dns.nameserver.filter((server) => !server.includes('://') && server !== 'system');
    if (bootstrap.length > 0) block['bootstrap'] = bootstrap;
    block['upstreams'] = { startrails: [...dns.nameserver] };
    block['forward'] = [{ domain_wildcard: { match: '*', value: 'startrails' } }];
    if (dns.proxyNameserver !== undefined && dns.proxyNameserver.length > 0) {
      block['proxy_nameservers'] = [...dns.proxyNameserver];
    }
    documents.unshift(YAML.stringify(dnsDoc, { lineWidth: 0 }).trimEnd());
    if (dns.ipv6 === false) {
      diagnostics.push(makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-ipv6-flag-unsupported'));
    }
  } else if (dns !== null) {
    diagnostics.push(makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-nameserver-required'));
  }

  const header = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    `# Field mapping basis: ${descriptorOf(target).basis}`,
    '# Partial config: one YAML document per node; merge into your Egern profile.',
  ].join('\n');
  const body = documents.length > 0 ? documents.join('\n---\n') : '# no expressible nodes';

  return { content: `${header}\n---\n${body}\n`, diagnostics };
};
