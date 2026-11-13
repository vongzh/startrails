import type { NodeTransport, Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import type { EmissionPlan } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { EmitResult } from './index.ts';
import { hostOfServer, needsResolution, schemeOf } from './runtime.ts';

type Fields = Record<string, unknown>;

/**
 * 单个 DNS 服务器串 → sing-box **typed** server 对象。
 *
 * 只写 typed：legacy 的 `address` 写法 1.12 弃用、1.14 移除，写出来等于给新版本埋雷。
 * 含域名的服务器必须挂 `domain_resolver`，否则 sing-box 起不来——这不是可选字段。
 */
const dnsServerFields = (
  raw: string,
  index: number,
  bootstrapTag: string | null,
): Fields | null => {
  const tag = `dns-${index}`;
  const scheme = schemeOf(raw);
  if (scheme === 'plain') {
    if (raw === 'system' || raw === 'local') return { type: 'local', tag };
    const resolver =
      needsResolution(raw) && bootstrapTag !== null ? { domain_resolver: bootstrapTag } : {};
    return { type: 'udp', tag, server: raw, ...resolver };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname;
  // typed server 的 `server` 只放主机名，端口单独写 server_port。
  const port = url.port.length === 0 ? {} : { server_port: Number(url.port) };
  const resolver =
    needsResolution(host) && bootstrapTag !== null ? { domain_resolver: bootstrapTag } : {};
  if (scheme === 'https' || scheme === 'h3') {
    const path = url.pathname.length === 0 || url.pathname === '/' ? '/dns-query' : url.pathname;
    return {
      type: scheme,
      tag,
      server: host,
      ...port,
      path,
      tls: { enabled: true, server_name: host },
      ...resolver,
    };
  }
  // tls / quic 类型本身即加密，官方 typed 页未给出它们的 tls 子块，故不加（server_name 默认取 server）。
  return { type: scheme, tag, server: host, ...port, ...resolver };
};

interface Ctx {
  readonly node: ProxyNode;
  readonly usable: (feature: NodeFeature) => boolean;
  readonly diagnostics: Diagnostic[];
  readonly target: EmissionPlan['target'];
}

/**
 * 字段依据：sing-box 官方 outbound 各协议页 + shared/tls + shared/v2ray-transport。
 * 注意差异：ws 的 Host 写在 headers 里，grpc 的服务名是 service_name（不是 path）。
 */
function tlsBlock(ctx: Ctx): Fields | undefined {
  const options = ctx.node.options;
  const usable = ctx.usable;
  const block: Fields = { enabled: true };
  if (options?.sni !== undefined && usable('sni')) block['server_name'] = options.sni;
  if (options?.insecure === true && usable('insecure')) block['insecure'] = true;
  if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
    block['alpn'] = [...options.alpn];
  }
  if (options?.reality !== undefined && usable('reality')) {
    block['reality'] = {
      enabled: true,
      public_key: options.reality.publicKey,
      ...(options.reality.shortId === undefined ? {} : { short_id: options.reality.shortId }),
    };
    const fp = options.reality.fingerprint ?? options.fingerprint ?? 'chrome';
    block['utls'] = { enabled: true, fingerprint: fp };
  } else if (options?.fingerprint !== undefined && usable('fingerprint')) {
    block['utls'] = { enabled: true, fingerprint: options.fingerprint };
  }
  return Object.keys(block).length > 1 ? block : undefined;
}

function transportBlock(ctx: Ctx): Fields | undefined {
  const options = ctx.node.options;
  const transport: NodeTransport | undefined = options?.transport;
  if (transport === undefined || !ctx.usable('transport')) return undefined;
  if (transport === 'ws') {
    const block: Fields = { type: 'ws' };
    if (options?.path !== undefined && ctx.usable('path')) block['path'] = options.path;
    if (options?.host !== undefined && ctx.usable('host')) block['headers'] = { Host: options.host };
    return block;
  }
  if (transport === 'grpc') {
    const block: Fields = { type: 'grpc' };
    if (options?.path !== undefined && ctx.usable('path')) block['service_name'] = options.path;
    return block;
  }
  // IR 的 http2 对应 v2ray 的 h2；sing-box 侧统一走 http transport。
  const block: Fields = { type: 'http' };
  if (options?.host !== undefined && ctx.usable('host')) block['host'] = [options.host];
  if (options?.path !== undefined && ctx.usable('path')) block['path'] = options.path;
  return block;
}

/** SIP003：sing-box 只内置 obfs-local 与 v2ray-plugin，参数走分号串。 */
function pluginFields(ctx: Ctx): Fields {
  const options = ctx.node.options;
  const name = options?.plugin;
  if (name === undefined || !ctx.usable('plugin')) return {};
  const opts = options?.pluginOpts;
  if (name === 'obfs' || name === 'obfs-local' || name === 'simple-obfs') {
    const parts: string[] = [];
    if (opts?.mode !== undefined) parts.push(`obfs=${opts.mode}`);
    if (opts?.host !== undefined) parts.push(`obfs-host=${opts.host}`);
    return { plugin: 'obfs-local', ...(parts.length === 0 ? {} : { plugin_opts: parts.join(';') }) };
  }
  if (name === 'v2ray-plugin') {
    const parts: string[] = [];
    if (opts?.mode !== undefined) parts.push(`mode=${opts.mode}`);
    if (opts?.tls === true) parts.push('tls');
    if (opts?.host !== undefined) parts.push(`host=${opts.host}`);
    if (opts?.path !== undefined) parts.push(`path=${opts.path}`);
    return { plugin: 'v2ray-plugin', ...(parts.length === 0 ? {} : { plugin_opts: parts.join(';') }) };
  }
  ctx.diagnostics.push(
    makeDiagnostic('emit', ctx.target, ctx.node.name, `plugin-unsupported-by-target:${name}`),
  );
  return {};
}

function outboundFields(ctx: Ctx): Fields {
  const node = ctx.node;
  const options = node.options;
  const usable = ctx.usable;
  const base: Fields = {
    type: node.kind,
    tag: node.name,
    server: node.server,
    server_port: node.port,
  };
  const tls = tlsBlock(ctx);
  const transport = transportBlock(ctx);
  const withTransport = (fields: Fields): Fields =>
    transport === undefined ? fields : { ...fields, transport };
  const withTls = (fields: Fields): Fields => (tls === undefined ? fields : { ...fields, tls });

  switch (node.kind) {
    case 'shadowsocks': {
      const fields: Fields = { ...base, method: node.method, password: node.password };
      if (options?.udp !== undefined && usable('udp')) fields['network'] = options.udp ? 'tcp,udp' : 'tcp';
      return { ...fields, ...pluginFields(ctx) };
    }
    case 'vmess': {
      const fields: Fields = { ...base, uuid: node.uuid };
      if (options?.cipher !== undefined && usable('cipher')) fields['security'] = options.cipher;
      if (options?.alterId !== undefined && usable('alterId')) fields['alter_id'] = options.alterId;
      return withTls(withTransport(fields));
    }
    case 'vless': {
      const fields: Fields = { ...base, uuid: node.uuid };
      if (options?.flow !== undefined && usable('flow')) fields['flow'] = options.flow;
      return withTls(withTransport(fields));
    }
    case 'trojan':
      return withTls(withTransport({ ...base, password: node.password }));
    case 'hysteria2': {
      const fields: Fields = { ...base, password: node.password };
      if (options?.obfs !== undefined && usable('obfs')) {
        const type = options.obfs.type;
        if (type === 'salamander' || type === 'gecko') {
          fields['obfs'] = {
            type,
            ...(options.obfs.password === undefined ? {} : { password: options.obfs.password }),
          };
        } else {
          ctx.diagnostics.push(
            makeDiagnostic('emit', ctx.target, node.name, `obfs-not-expressible:${type}`),
          );
        }
      }
      if (options?.bandwidth !== undefined && usable('bandwidth')) {
        if (options.bandwidth.up !== undefined) fields['up_mbps'] = options.bandwidth.up;
        if (options.bandwidth.down !== undefined) fields['down_mbps'] = options.bandwidth.down;
      }
      return withTls(fields);
    }
    case 'tuic': {
      const fields: Fields = { ...base, uuid: node.uuid, password: node.password };
      if (options?.congestionControl !== undefined && usable('congestion')) {
        fields['congestion_control'] = options.congestionControl;
      }
      if (options?.udpRelayMode !== undefined && usable('udpRelayMode')) {
        fields['udp_relay_mode'] = options.udpRelayMode;
      }
      return withTls(fields);
    }
    case 'anytls': {
      const fields: Fields = { ...base, password: node.password };
      if (options?.idleSessionTimeout !== undefined && usable('idleSession')) {
        fields['idle_session_timeout'] = `${options.idleSessionTimeout}s`;
      }
      return withTls(fields);
    }
    case 'snell':
      // 能力表已判 reject，这里只是穷尽性兜底。
      return { ...base, psk: node.psk };
    case 'wireguard':
      // 能力表标 unverified（outbound 已废弃、写法迁至 endpoints），正常不会走到这里；
      // 兜底按旧版 outbound 字段拼出结构，仅供未来核实为 support 后启用。
      return {
        type: 'wireguard',
        tag: node.name,
        server: node.server,
        server_port: node.port,
        local_address: [...node.addresses],
        private_key: node.privateKey,
        peer_public_key: node.peerPublicKey,
        ...(node.preSharedKey === undefined ? {} : { pre_shared_key: node.preSharedKey }),
        ...(node.reserved === undefined || node.reserved.length === 0 ? {} : { reserved: [...node.reserved] }),
        ...(node.mtu === undefined ? {} : { mtu: node.mtu }),
      };
    case 'socks5':
    case 'http': {
      const fields: Fields = { ...base, type: node.kind === 'socks5' ? 'socks' : 'http' };
      if (node.username !== undefined) fields['username'] = node.username;
      if (node.password !== undefined) fields['password'] = node.password;
      return fields;
    }
    default:
      return assertNever(node);
  }
}

export const singBoxEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  const outbounds: Fields[] = [];

  for (const item of acceptedItems(emissionPlan)) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    outbounds.push(
      outboundFields({
        node,
        usable: (feature) => !item.droppedFeatures.includes(feature),
        diagnostics,
        target,
      }),
    );
  }

  outbounds.push({ type: 'direct', tag: 'direct' });
  for (const group of profile.policyGroups) {
    outbounds.push({ type: 'selector', tag: group.name, outbounds: group.members });
  }

  // sing-box 官方 configuration/ 页给出的顶层结构；页面未提供「可直接运行的最小配置」，
  // 因此 inbounds / route 保持空并显式标注，避免编造未经核实的字段。
  diagnostics.push(
    makeDiagnostic(
      'emit',
      target,
      'config',
      'partial-config: inbounds/route are empty; merge outbounds into your main config',
    ),
  );
  for (const item of emissionPlan.ruleItems) {
    diagnostics.push(
      makeDiagnostic(
        'emit',
        target,
        `rule:${item.sourceIndex}:${item.index}`,
        'rule-layer-not-implemented:route-structure-unverified',
      ),
    );
  }
  for (const source of profile.ruleSources) {
    if (source.kind === 'external') {
      diagnostics.push(
        makeDiagnostic('emit', target, source.url, 'external-ruleset-passthrough-skipped'),
      );
    }
  }

  /** dns 段：typed servers + fakeip + client_subnet（ECS）。 */
  const dnsBlock: Fields = {};
  const dns = emissionPlan.runtime.dns;
  if (dns !== null) {
    const names = dns.nameserver ?? [];
    const needsBootstrap = names.some((raw) => {
      const host = hostOfServer(raw);
      return host !== null && needsResolution(host);
    });
    const bootstrapTag = needsBootstrap ? 'dns-bootstrap' : null;
    const servers: Fields[] = [];
    if (bootstrapTag !== null) servers.push({ type: 'local', tag: bootstrapTag });
    names.forEach((raw, index) => {
      const fields = dnsServerFields(raw, index, bootstrapTag);
      if (fields === null) {
        diagnostics.push(makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-server-unparsable'));
        return;
      }
      servers.push(fields);
    });
    if (dns.mode === 'fake-ip') {
      servers.push({
        type: 'fakeip',
        tag: 'fakeip',
        inet4_range: dns.fakeIpRange ?? '198.18.0.0/15',
      });
    }
    if (servers.length > 0) {
      dnsBlock['servers'] = servers;
      const first = servers.find((server) => server['type'] !== 'fakeip');
      if (first !== undefined) dnsBlock['final'] = first['tag'] as string;
      if (dns.mode === 'fake-ip') {
        // fakeip 只有在规则把 A/AAAA 指向它时才生效（官方 migration 页的写法）。
        dnsBlock['rules'] = [{ query_type: ['A', 'AAAA'], server: 'fakeip' }];
      }
      if (dns.ecs !== undefined) dnsBlock['client_subnet'] = dns.ecs;
    }
    if (dns.proxyNameserver !== undefined) {
      diagnostics.push(
        makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-proxy-nameserver-needs-outbound-tag'),
      );
    }
  }

  const payload: Fields = {
    log: {},
    inbounds: [],
    ...(Object.keys(dnsBlock).length === 0 ? {} : { dns: dnsBlock }),
    outbounds,
    route: {},
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  return { content, diagnostics };
};
