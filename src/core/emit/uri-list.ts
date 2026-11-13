import type { NodeTransport, Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { descriptorOf } from '../targets.ts';
import type { EmissionPlan, PlanItem } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { EmitResult } from './index.ts';

/**
 * 节点分享 URI 列表，依据公开格式规范：
 *  - SIP002 https://shadowsocks.org/doc/sip002.html （ss://base64url(method:password)@host:port?plugin=…#tag）
 *  - Xray 分享链接规范 https://github.com/XTLS/Xray-core/discussions/716
 *    §4.2 协议段 type / encryption / flow；§4.3 传输段 path / host；§4.4 TLS 段 security / sni / alpn / pbk / sid / fp / spx
 *  - Hysteria 2 URI Scheme https://v2.hysteria.network/docs/developers/URI-Scheme/
 *    （userinfo=密码；obfs / obfs-password / sni / insecure / pinSHA256；官方明确不含 alpn 与带宽）
 *  - tuic:// 与 anytls:// 无官方规范，按 mihomo / sing-box 通行约定
 *    （tuic://uuid:password@host:port、anytls://password@host:port）
 *
 * 客户端完整配置格式对 Shadowrocket / V2Box / Anywhere 均未取得官方依据，因此只输出节点列表。
 * 每个 query 参数都必须先在能力表被判为 support，且未被 Plan 丢弃；未核实的字段一律不写。
 */
const base64url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fragment = (name: string): string => `#${encodeURIComponent(name)}`;

/** §4.2.1：tcp 为默认且可省略，其余必须显式写出。 */
const transportToken = (transport: NodeTransport): string =>
  transport === 'ws' ? 'ws' : transport === 'grpc' ? 'grpc' : 'http';

/** 传输段与 TLS 段参数，顺序按规范 4.3 → 4.4。 */
function connectionParams(node: ProxyNode, usable: (feature: NodeFeature) => boolean): string[] {
  const options = node.options;
  if (options === undefined) return [];
  const params: string[] = [];

  if (options.transport !== undefined && usable('transport')) {
    params.push(`type=${transportToken(options.transport)}`);
    if (options.path !== undefined && usable('path')) {
      params.push(`path=${encodeURIComponent(options.path)}`);
    }
    if (options.host !== undefined && usable('host')) {
      params.push(`host=${encodeURIComponent(options.host)}`);
    }
  }

  // Reality 优先于普通 TLS：两者同时出现时 Reality 才是实际握手方式。
  if (options.reality !== undefined && usable('reality')) {
    params.push('security=reality');
    if (options.sni !== undefined && usable('sni')) {
      params.push(`sni=${encodeURIComponent(options.sni)}`);
    }
    params.push(`pbk=${encodeURIComponent(options.reality.publicKey)}`);
    if (options.reality.shortId !== undefined) params.push(`sid=${options.reality.shortId}`);
    const fingerprint = options.reality.fingerprint ?? options.fingerprint;
    if (fingerprint !== undefined && usable('fingerprint')) params.push(`fp=${fingerprint}`);
    if (options.reality.spiderX !== undefined) {
      params.push(`spx=${encodeURIComponent(options.reality.spiderX)}`);
    }
  } else if (options.tls === true && usable('tls')) {
    params.push('security=tls');
    if (options.sni !== undefined && usable('sni')) {
      params.push(`sni=${encodeURIComponent(options.sni)}`);
    }
  }

  if (options.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
    params.push(`alpn=${encodeURIComponent(options.alpn.join(','))}`);
  }
  if (options.insecure === true && usable('insecure')) params.push('allowInsecure=1');
  return params;
}

function nodeUri(node: ProxyNode, usable: (feature: NodeFeature) => boolean): string | null {
  const authority = `${node.server}:${node.port}`;
  switch (node.kind) {
    case 'shadowsocks': {
      const query: string[] = [];
      const options = node.options;
      const pluginFeature = options?.plugin === 'shadow-tls' ? 'shadowTls' : 'plugin';
      if (options?.plugin !== undefined && usable(pluginFeature)) {
        // SIP002：plugin 值为「名称;键=值;…」，整体 percent-encode。
        const parts: string[] = [options.plugin];
        if (options.pluginOpts?.mode !== undefined) parts.push(`mode=${options.pluginOpts.mode}`);
        if (options.pluginOpts?.tls === true) parts.push('tls');
        if (options.pluginOpts?.host !== undefined) parts.push(`host=${options.pluginOpts.host}`);
        if (options.pluginOpts?.path !== undefined) parts.push(`path=${options.pluginOpts.path}`);
        if (options.pluginOpts?.password !== undefined) parts.push(`password=${options.pluginOpts.password}`);
        if (options.pluginOpts?.version !== undefined) parts.push(`version=${options.pluginOpts.version}`);
        query.push(`plugin=${encodeURIComponent(parts.join(';'))}`);
      }
      const suffix = query.length > 0 ? `/?${query.join('&')}` : '';
      return `ss://${base64url(`${node.method}:${node.password}`)}@${authority}${suffix}${fragment(node.name)}`;
    }
    case 'vmess': {
      // v2rayN 传统 JSON 载荷（net / tls / sni / path / host / aid / scy），与规范 §4.2 字段对齐。
      const options = node.options;
      const payload: Record<string, string> = {
        v: '2',
        ps: node.name,
        add: node.server,
        port: String(node.port),
        id: node.uuid,
        aid: options?.alterId === undefined ? '0' : String(options.alterId),
        scy: options?.cipher === undefined || !usable('cipher') ? 'auto' : options.cipher,
        net: options?.transport === undefined || !usable('transport') ? 'tcp' : transportToken(options.transport),
      };
      if (options?.tls === true && usable('tls')) {
        payload['tls'] = 'tls';
        if (options.sni !== undefined && usable('sni')) payload['sni'] = options.sni;
      }
      if (options?.transport !== undefined && usable('transport')) {
        if (options.path !== undefined && usable('path')) payload['path'] = options.path;
        if (options.host !== undefined && usable('host')) payload['host'] = options.host;
      }
      return `vmess://${base64url(JSON.stringify(payload))}`;
    }
    case 'vless': {
      const params = ['encryption=none'];
      if (node.options?.flow !== undefined && usable('flow')) {
        params.push(`flow=${encodeURIComponent(node.options.flow)}`);
      }
      params.push(...connectionParams(node, usable));
      return `vless://${node.uuid}@${authority}?${params.join('&')}${fragment(node.name)}`;
    }
    case 'trojan': {
      const params = connectionParams(node, usable);
      const query = params.length === 0 ? '' : `?${params.join('&')}`;
      return `trojan://${encodeURIComponent(node.password)}@${authority}${query}${fragment(node.name)}`;
    }
    case 'hysteria2': {
      const options = node.options;
      const params: string[] = [];
      if (options?.sni !== undefined && usable('sni')) params.push(`sni=${encodeURIComponent(options.sni)}`);
      if (options?.insecure === true && usable('insecure')) params.push('insecure=1');
      if (options?.obfs !== undefined && usable('obfs')) {
        const type = options.obfs.type;
        if (type === 'salamander' || type === 'gecko') {
          params.push(`obfs=${type}`);
          if (options.obfs.password !== undefined) {
            params.push(`obfs-password=${encodeURIComponent(options.obfs.password)}`);
          }
        }
      }
      const query = params.length === 0 ? '' : `/?${params.join('&')}`;
      return `hysteria2://${encodeURIComponent(node.password)}@${authority}${query}${fragment(node.name)}`;
    }
    case 'tuic': {
      const options = node.options;
      const params: string[] = [];
      if (options?.sni !== undefined && usable('sni')) params.push(`sni=${encodeURIComponent(options.sni)}`);
      if (options?.congestionControl !== undefined && usable('congestion')) {
        params.push(`congestion_control=${encodeURIComponent(options.congestionControl)}`);
      }
      if (options?.udpRelayMode !== undefined && usable('udpRelayMode')) {
        params.push(`udp_relay_mode=${encodeURIComponent(options.udpRelayMode)}`);
      }
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        params.push(`alpn=${encodeURIComponent(options.alpn.join(','))}`);
      }
      if (options?.insecure === true && usable('insecure')) params.push('allow_insecure=1');
      const query = params.length === 0 ? '' : `/?${params.join('&')}`;
      return `tuic://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}@${authority}${query}${fragment(node.name)}`;
    }
    case 'anytls': {
      const options = node.options;
      const params: string[] = [];
      if (options?.sni !== undefined && usable('sni')) params.push(`sni=${encodeURIComponent(options.sni)}`);
      if (options?.insecure === true && usable('insecure')) params.push('insecure=1');
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        params.push(`alpn=${encodeURIComponent(options.alpn.join(','))}`);
      }
      const query = params.length === 0 ? '' : `/?${params.join('&')}`;
      return `anytls://${encodeURIComponent(node.password)}@${authority}${query}${fragment(node.name)}`;
    }
    case 'snell':
      // 无公开分享链接规范：能力表已判 unverified，这里不编造。
      return null;
    case 'wireguard': {
      const params: string[] = [`publickey=${encodeURIComponent(node.peerPublicKey)}`];
      for (const address of node.addresses) params.push(`address=${encodeURIComponent(address)}`);
      if (node.preSharedKey !== undefined) {
        params.push(`psk=${encodeURIComponent(node.preSharedKey)}`);
      }
      if (node.mtu !== undefined) params.push(`mtu=${node.mtu}`);
      if (node.reserved !== undefined && node.reserved.length > 0) {
        params.push(`reserved=${node.reserved.join(',')}`);
      }
      if (node.allowedIps !== undefined && node.allowedIps.length > 0) {
        params.push(`allowedips=${encodeURIComponent(node.allowedIps.join(','))}`);
      }
      return `wireguard://${encodeURIComponent(node.privateKey)}@${authority}?${params.join('&')}${fragment(node.name)}`;
    }
    case 'socks5':
    case 'http': {
      const scheme = node.kind === 'socks5' ? 'socks5' : 'http';
      const userinfo =
        node.username === undefined
          ? ''
          : node.password === undefined
            ? `${encodeURIComponent(node.username)}@`
            : `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password)}@`;
      return `${scheme}://${userinfo}${authority}${fragment(node.name)}`;
    }
    default:
      return assertNever(node);
  }
}

export const uriListEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  const lines: string[] = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    `# Field mapping basis: ${descriptorOf(target).basis}`,
    '# Nodes-only export: full configuration syntax is unverified for this client.',
  ];

  for (const item of acceptedItems(emissionPlan) as readonly PlanItem[]) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    const dropped = item.droppedFeatures;
    const usable = (feature: NodeFeature): boolean => !dropped.includes(feature);
    const uri = nodeUri(node, usable);
    if (uri === null) {
      diagnostics.push(
        makeDiagnostic('emit', target, node.name, `share-link-not-available:${node.kind}`),
      );
      continue;
    }
    lines.push(uri);
  }

  diagnostics.push(
    makeDiagnostic('emit', target, 'config', 'nodes-only-export: full-configuration-syntax-unverified'),
  );
  for (const source of profile.ruleSources) {
    if (source.kind === 'external') {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-passthrough-skipped'));
    }
  }

  return { content: `${lines.join('\n')}\n`, diagnostics };
};
