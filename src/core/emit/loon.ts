import type { Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { descriptorOf } from '../targets.ts';
import { partitionServers, sanitizeIniName, schemeOf } from './runtime.ts';
import type { EmissionPlan, PlanItem } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { EmitResult } from './index.ts';

/**
 * Loon [Proxy] 方言，依据 https://nsloon.app/en/docs/Node/ ：
 *   Name = Shadowsocks,server,port,method,"password",...
 *   Name = VMess,server,port,method,"UUID",transport=...,over-tls=true,...
 *   Name = VLESS,server,port,"UUID",transport=...,flow=...,public-key=...,short-id=...
 *   Name = Hysteria2,server,port,"password",sni=...,salamander-password=...,server-ports=...
 *   Name = AnyTLS,server,port,"password",sni=...,idle-session-timeout=...
 * 该页明确只写 [Proxy] 段，未给 [Proxy Group] / [Rule]，因此两者不编造，
 * 只输出注释与诊断，说明策略组和规则需用户自行补入。
 */
const quoteValue = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Loon 的端口跳跃写作 `20000:20100`；多点写法未在官方页出现，遇到就跳过并诊断。 */
const loonPorts = (ports: string): string | null =>
  ports.includes(';') ? null : ports.replace(/-/g, ':');

interface Ctx {
  readonly node: ProxyNode;
  readonly usable: (feature: NodeFeature) => boolean;
  readonly diagnostics: Diagnostic[];
  readonly target: EmissionPlan['target'];
}

/** 通用参数：sni / skip-cert-verify / tls-profile / udp。 */
function commonParams(ctx: Ctx): string[] {
  const options = ctx.node.options;
  const params: string[] = [];
  if (options?.sni !== undefined && ctx.usable('sni')) params.push(`sni=${options.sni}`);
  if (options?.insecure === true && ctx.usable('insecure')) params.push('skip-cert-verify=true');
  const fingerprint = options?.reality?.fingerprint ?? options?.fingerprint;
  if (fingerprint !== undefined && ctx.usable('fingerprint')) params.push(`tls-profile=${fingerprint}`);
  if (options?.alpn !== undefined && ctx.usable('alpn') && options.alpn.length > 0) {
    params.push(`alpn=${quoteValue(options.alpn.join(','))}`);
  }
  if (options?.udp !== undefined && ctx.usable('udp')) params.push(`udp=${options.udp}`);
  return params;
}

/** Reality 在 Loon 是平铺的 public-key / short-id，不是子对象。 */
function realityParams(ctx: Ctx): string[] {
  const reality = ctx.node.options?.reality;
  if (reality === undefined || !ctx.usable('reality')) return [];
  return [
    `public-key=${quoteValue(reality.publicKey)}`,
    ...(reality.shortId === undefined ? [] : [`short-id=${reality.shortId}`]),
  ];
}

function loonLine(ctx: Ctx): string | null {
  const node = ctx.node;
  const name = sanitizeIniName(node.name).replace(/,/g, '，');
  const options = node.options;
  const usable = ctx.usable;
  const params: string[] = [];

  if (options?.transport !== undefined && usable('transport')) {
    params.push(`transport=${options.transport === 'http2' ? 'http' : options.transport}`);
    if (options.path !== undefined && usable('path')) params.push(`path=${options.path}`);
    if (options.host !== undefined && usable('host')) params.push(`host=${options.host}`);
  }
  if (options?.tls === true && usable('tls')) params.push('over-tls=true');
  params.push(...realityParams(ctx), ...commonParams(ctx));

  switch (node.kind) {
    case 'shadowsocks': {
      const method = options?.cipher !== undefined && usable('cipher') ? options.cipher : node.method;
      return `${name} = Shadowsocks,${node.server},${node.port},${method},${quoteValue(node.password)}${params.length > 0 ? `,${params.join(',')}` : ''}`;
    }
    case 'vmess': {
      const method = options?.cipher !== undefined && usable('cipher') ? options.cipher : 'auto';
      const tail = [...params];
      if (options?.alterId !== undefined && usable('alterId')) tail.push(`alterId=${options.alterId}`);
      return `${name} = VMess,${node.server},${node.port},${method},${quoteValue(node.uuid)}${tail.length > 0 ? `,${tail.join(',')}` : ''}`;
    }
    case 'vless': {
      const tail = [...params];
      if (options?.flow !== undefined && usable('flow')) tail.push(`flow=${options.flow}`);
      return `${name} = VLESS,${node.server},${node.port},${quoteValue(node.uuid)}${tail.length > 0 ? `,${tail.join(',')}` : ''}`;
    }
    case 'trojan':
      return `${name} = Trojan,${node.server},${node.port},${quoteValue(node.password)}${params.length > 0 ? `,${params.join(',')}` : ''}`;
    case 'hysteria2': {
      const tail = [...params];
      if (options?.obfs !== undefined && usable('obfs')) {
        if (options.obfs.type === 'salamander' && options.obfs.password !== undefined) {
          tail.push(`salamander-password=${options.obfs.password}`);
        } else {
          ctx.diagnostics.push(
            makeDiagnostic('emit', ctx.target, node.name, `obfs-not-expressible:${options.obfs.type}`),
          );
        }
      }
      if (options?.ports !== undefined && usable('ports')) {
        const ports = loonPorts(options.ports);
        if (ports === null) {
          ctx.diagnostics.push(
            makeDiagnostic('emit', ctx.target, node.name, 'ports-not-expressible:multi-range'),
          );
        } else {
          tail.push(`server-ports=${quoteValue(ports)}`);
        }
      }
      if (options?.bandwidth?.down !== undefined && usable('bandwidth')) {
        tail.push(`download-bandwidth=${options.bandwidth.down}`);
      }
      return `${name} = Hysteria2,${node.server},${node.port},${quoteValue(node.password)}${tail.length > 0 ? `,${tail.join(',')}` : ''}`;
    }
    case 'anytls': {
      const tail = [...params];
      if (options?.idleSessionTimeout !== undefined && usable('idleSession')) {
        tail.push(`idle-session-timeout=${options.idleSessionTimeout}`);
      }
      return `${name} = AnyTLS,${node.server},${node.port},${quoteValue(node.password)}${tail.length > 0 ? `,${tail.join(',')}` : ''}`;
    }
    // 能力表判 unverified：Loon 官方 Node 页未覆盖 TUIC / Snell / WireGuard / SOCKS5 / HTTP 行格式。
    case 'tuic':
    case 'snell':
    case 'wireguard':
    case 'socks5':
    case 'http':
      return null;
    default:
      return assertNever(node);
  }
}

export const loonEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  /**
   * [General] 段：Loon 把明文与加密 DNS 分成四个键
   * （dns-server / doh-server / doq-server / doh3-server），必须按 scheme 分流。
   */
  const general: string[] = [];
  const dns = emissionPlan.runtime.dns;
  if (dns !== null) {
    const { plain, encrypted } = partitionServers(dns.nameserver);
    // Loon 的 dns-server 接受 `system` 关键字，与 Surge 不同；明文条目与 system 可以并列。
    if (plain.length > 0) general.push(`dns-server = ${plain.join(',')}`);
    const doh = encrypted.filter((server) => schemeOf(server) === 'https');
    const doh3 = encrypted.filter((server) => schemeOf(server) === 'h3');
    const doq = encrypted.filter((server) => schemeOf(server) === 'quic');
    if (doh.length > 0) general.push(`doh-server = ${doh.join(',')}`);
    if (doh3.length > 0) general.push(`doh3-server = ${doh3.join(',')}`);
    if (doq.length > 0) general.push(`doq-server = ${doq.join(',')}`);
    const unsupported = encrypted.filter((server) => schemeOf(server) === 'tcp');
    if (unsupported.length > 0) {
      diagnostics.push(makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-scheme-unsupported:tcp'));
    }
    if (dns.proxyNameserver !== undefined) {
      diagnostics.push(
        makeDiagnostic('emit', target, 'runtime:dns', 'runtime-dns-proxy-nameserver-unsupported'),
      );
    }
  }

  const lines: string[] = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    `# Field mapping basis: ${descriptorOf(target).basis}`,
    '# [Proxy Group] / [Rule] syntax not verified in the official Node page; not emitted.',
    ...(general.length === 0 ? [] : ['', '[General]', ...general]),
    '',
    '[Proxy]',
  ];

  for (const item of acceptedItems(emissionPlan) as readonly PlanItem[]) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    const line = loonLine({
      node,
      usable: (feature) => !item.droppedFeatures.includes(feature),
      diagnostics,
      target,
    });
    if (line !== null) lines.push(line);
  }

  diagnostics.push(
    makeDiagnostic('emit', target, 'config', 'partial-config: policy-groups/rules not emitted (syntax unverified)'),
  );
  for (const source of profile.ruleSources) {
    if (source.kind === 'external') {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-passthrough-skipped'));
    }
  }

  return { content: `${lines.join('\n')}\n`, diagnostics };
};
