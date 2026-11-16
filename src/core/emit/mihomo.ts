import YAML from 'yaml';
import type { NodeTransport, Profile, ProxyNode } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import type { NodeFeature } from '../capabilities/index.ts';
import { renderRule, ruleProviderName } from '../rules/index.ts';
import type { EmissionPlan } from '../plan/index.ts';
import { acceptedItems } from '../plan/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { descriptorOf } from '../targets.ts';
import type { EmitResult } from './index.ts';
import { tunFields } from './runtime.ts';

type Fields = Record<string, unknown>;

/** 各协议文档写明的 network 取值不同，不能跨协议硬塞。 */
const NETWORK_SUPPORT: Readonly<Record<'vmess' | 'vless' | 'trojan', readonly string[]>> = {
  vmess: ['ws', 'http', 'h2', 'grpc', 'mkcp', 'mekya', 'tcp'],
  vless: ['ws', 'http', 'h2', 'grpc', 'xhttp', 'tcp'],
  trojan: ['ws', 'grpc', 'tcp'],
};

const networkValue = (transport: NodeTransport): string =>
  transport === 'http2' ? 'h2' : transport;

interface Ctx {
  readonly node: ProxyNode;
  readonly usable: (feature: NodeFeature) => boolean;
  readonly diagnostics: Diagnostic[];
  readonly target: EmissionPlan['target'];
}

/** ws 用 ws-opts{path, headers.Host}，grpc 用 grpc-opts{grpc-service-name}。 */
function addNetwork(fields: Fields, kind: 'vmess' | 'vless' | 'trojan', ctx: Ctx): void {
  const options = ctx.node.options;
  const transport = options?.transport;
  if (transport === undefined || !ctx.usable('transport')) return;
  const value = networkValue(transport);
  if (!NETWORK_SUPPORT[kind].includes(value)) {
    ctx.diagnostics.push(
      makeDiagnostic('emit', ctx.target, ctx.node.name, `network-not-expressible:${kind}/${value}`),
    );
    return;
  }
  fields['network'] = value;

  if (value === 'ws') {
    const wsOpts: Fields = {};
    if (options?.path !== undefined && ctx.usable('path')) wsOpts['path'] = options.path;
    if (options?.host !== undefined && ctx.usable('host')) {
      wsOpts['headers'] = { Host: options.host };
    }
    if (Object.keys(wsOpts).length > 0) fields['ws-opts'] = wsOpts;
  }
  if (value === 'grpc' && options?.path !== undefined && ctx.usable('path')) {
    fields['grpc-opts'] = { 'grpc-service-name': options.path };
  }
}

function proxyFields(ctx: Ctx): Fields {
  const node = ctx.node;
  const options = node.options;
  const usable = ctx.usable;
  const base: Fields = { name: node.name, server: node.server, port: node.port };

  switch (node.kind) {
    case 'shadowsocks': {
      const fields: Fields = { ...base, type: 'ss', cipher: node.method, password: node.password };
      if (options?.udp !== undefined && usable('udp')) fields['udp'] = options.udp;
      // shadow-tls 与 obfs / v2ray-plugin 是两套字段，能力判定也分开（plugin vs shadowTls）。
      const pluginFeature = options?.plugin === 'shadow-tls' ? 'shadowTls' : 'plugin';
      if (options?.plugin !== undefined && usable(pluginFeature)) {
        fields['plugin'] = options.plugin;
        const opts: Fields = {};
        if (options.pluginOpts?.mode !== undefined) opts['mode'] = options.pluginOpts.mode;
        if (options.pluginOpts?.host !== undefined) opts['host'] = options.pluginOpts.host;
        if (options.pluginOpts?.path !== undefined) opts['path'] = options.pluginOpts.path;
        if (options.pluginOpts?.tls === true) opts['tls'] = true;
        if (options.pluginOpts?.password !== undefined) opts['password'] = options.pluginOpts.password;
        if (options.pluginOpts?.version !== undefined) opts['version'] = options.pluginOpts.version;
        if (Object.keys(opts).length > 0) fields['plugin-opts'] = opts;
      }
      return fields;
    }
    case 'vmess': {
      const fields: Fields = {
        ...base,
        type: 'vmess',
        uuid: node.uuid,
        alterId: options?.alterId !== undefined && usable('alterId') ? options.alterId : 0,
        cipher: options?.cipher !== undefined && usable('cipher') ? options.cipher : 'auto',
      };
      if (options?.tls === true && usable('tls')) fields['tls'] = true;
      if (options?.sni !== undefined && usable('sni')) fields['servername'] = options.sni;
      addNetwork(fields, 'vmess', ctx);
      return fields;
    }
    case 'vless': {
      const fields: Fields = { ...base, type: 'vless', uuid: node.uuid };
      if (options?.flow !== undefined && usable('flow')) fields['flow'] = options.flow;
      if (options?.tls === true && usable('tls')) fields['tls'] = true;
      if (options?.sni !== undefined && usable('sni')) fields['servername'] = options.sni;
      if (options?.reality !== undefined && usable('reality')) {
        fields['reality-opts'] = {
          'public-key': options.reality.publicKey,
          ...(options.reality.shortId === undefined ? {} : { 'short-id': options.reality.shortId }),
        };
      }
      const fingerprint = options?.reality?.fingerprint ?? options?.fingerprint;
      if (fingerprint !== undefined && usable('fingerprint')) {
        fields['client-fingerprint'] = fingerprint;
      }
      if (options?.insecure === true && usable('insecure')) fields['skip-cert-verify'] = true;
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        fields['alpn'] = [...options.alpn];
      }
      addNetwork(fields, 'vless', ctx);
      return fields;
    }
    case 'trojan': {
      const fields: Fields = { ...base, type: 'trojan', password: node.password };
      if (options?.sni !== undefined && usable('sni')) fields['sni'] = options.sni;
      if (options?.insecure === true && usable('insecure')) fields['skip-cert-verify'] = true;
      addNetwork(fields, 'trojan', ctx);
      return fields;
    }
    case 'hysteria2': {
      const fields: Fields = { ...base, type: 'hysteria2', password: node.password };
      if (options?.sni !== undefined && usable('sni')) fields['sni'] = options.sni;
      if (options?.insecure === true && usable('insecure')) fields['skip-cert-verify'] = true;
      if (options?.obfs !== undefined && usable('obfs')) {
        const type = options.obfs.type;
        if (type === 'salamander' || type === 'gecko') {
          fields['obfs'] = type;
          if (options.obfs.password !== undefined) fields['obfs-password'] = options.obfs.password;
        } else {
          ctx.diagnostics.push(
            makeDiagnostic('emit', ctx.target, node.name, `obfs-not-expressible:${type}`),
          );
        }
      }
      if (options?.bandwidth !== undefined && usable('bandwidth')) {
        if (options.bandwidth.up !== undefined) fields['up'] = `${options.bandwidth.up} Mbps`;
        if (options.bandwidth.down !== undefined) fields['down'] = `${options.bandwidth.down} Mbps`;
      }
      // 文档：填写 ports 后 port 被忽略并启用端口跳跃。
      if (options?.ports !== undefined && usable('ports')) fields['ports'] = options.ports;
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        fields['alpn'] = [...options.alpn];
      }
      return fields;
    }
    case 'tuic': {
      const fields: Fields = { ...base, type: 'tuic', uuid: node.uuid, password: node.password };
      if (options?.sni !== undefined && usable('sni')) fields['sni'] = options.sni;
      if (options?.insecure === true && usable('insecure')) fields['skip-cert-verify'] = true;
      if (options?.congestionControl !== undefined && usable('congestion')) {
        fields['congestion-controller'] = options.congestionControl;
      }
      if (options?.udpRelayMode !== undefined && usable('udpRelayMode')) {
        fields['udp-relay-mode'] = options.udpRelayMode;
      }
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        fields['alpn'] = [...options.alpn];
      }
      return fields;
    }
    case 'anytls': {
      const fields: Fields = { ...base, type: 'anytls', password: node.password };
      if (options?.sni !== undefined && usable('sni')) fields['sni'] = options.sni;
      if (options?.insecure === true && usable('insecure')) fields['skip-cert-verify'] = true;
      if (options?.idleSessionTimeout !== undefined && usable('idleSession')) {
        fields['idle-session-timeout'] = options.idleSessionTimeout;
      }
      if (options?.fingerprint !== undefined && usable('fingerprint')) {
        fields['client-fingerprint'] = options.fingerprint;
      }
      if (options?.alpn !== undefined && usable('alpn') && options.alpn.length > 0) {
        fields['alpn'] = [...options.alpn];
      }
      return fields;
    }
    case 'snell': {
      const fields: Fields = { ...base, type: 'snell', psk: node.psk };
      if (options?.version !== undefined && usable('version')) fields['version'] = options.version;
      if (options?.obfs !== undefined && usable('obfs')) {
        const type = options.obfs.type;
        if (type === 'http' || type === 'tls') {
          fields['obfs-opts'] = {
            mode: type,
            ...(options.obfs.host === undefined ? {} : { host: options.obfs.host }),
          };
        } else {
          ctx.diagnostics.push(
            makeDiagnostic('emit', ctx.target, node.name, `obfs-not-expressible:${type}`),
          );
        }
      }
      return fields;
    }
    case 'wireguard': {
      const fields: Fields = {
        ...base,
        type: 'wireguard',
        'private-key': node.privateKey,
        'public-key': node.peerPublicKey,
        ip: node.addresses[0] ?? '',
        'allowed-ips': [...(node.allowedIps ?? ['0.0.0.0/0', '::/0'])],
        udp: true,
      };
      if (node.addresses.length > 1) {
        fields['ipv6'] = node.addresses[1];
      }
      if (node.preSharedKey !== undefined) fields['pre-shared-key'] = node.preSharedKey;
      if (node.reserved !== undefined && node.reserved.length > 0) fields['reserved'] = [...node.reserved];
      if (node.mtu !== undefined) fields['mtu'] = node.mtu;
      return fields;
    }
    case 'socks5':
    case 'http': {
      const fields: Fields = { ...base, type: node.kind === 'socks5' ? 'socks5' : 'http' };
      if (node.username !== undefined) fields['username'] = node.username;
      if (node.password !== undefined) fields['password'] = node.password;
      return fields;
    }
    default:
      return assertNever(node);
  }
}

export const mihomoEmitter = (
  profile: Readonly<Profile>,
  emissionPlan: EmissionPlan,
): EmitResult => {
  const target = emissionPlan.target;
  const diagnostics: Diagnostic[] = [...emissionPlan.diagnostics];
  const proxies: Fields[] = [];

  for (const item of acceptedItems(emissionPlan)) {
    const node = profile.nodes[item.index];
    if (node === undefined) continue;
    proxies.push(
      proxyFields({
        node,
        usable: (feature) => !item.droppedFeatures.includes(feature),
        diagnostics,
        target,
      }),
    );
  }

  const groups = profile.policyGroups.map((group) => {
    const strategy = group.strategy ?? 'select';
    const auto = strategy !== 'select';
    const url = group.testUrl;
    if (auto && (url === undefined || url.length === 0)) {
      diagnostics.push(makeDiagnostic('emit', target, group.name, 'group-strategy-missing-url'));
    }
    const useAuto = auto && url !== undefined && url.length > 0;
    return {
      name: group.name,
      type: useAuto ? strategy : 'select',
      proxies: group.members,
      ...(useAuto ? { url, interval: group.interval ?? 300 } : {}),
      ...(useAuto && strategy === 'url-test' && group.tolerance !== undefined ? { tolerance: group.tolerance } : {}),
      ...(useAuto && group.lazy === true ? { lazy: true } : {}),
      ...(group.hidden === true ? { hidden: true } : {}),
    };
  });

  const rules: string[] = [];

  /**
   * dns 段。键名全部取自 mihomo 官方 dns 页（enable 刻意不写：
   * 只要存在 dns 段即生效，而 Stash 的官方示例里没有这个键，写了反而多一处不确定）。
   */
  const dnsBlock: Fields = {};
  const dns = emissionPlan.runtime.dns;
  if (dns !== null) {
    if (dns.mode === 'fake-ip') {
      if (emissionPlan.runtime.explicitFakeIpMode) dnsBlock['enhanced-mode'] = 'fake-ip';
      if (dns.fakeIpRange !== undefined) dnsBlock['fake-ip-range'] = dns.fakeIpRange;
    } else if (dns.mode === 'redir-host' && emissionPlan.runtime.explicitFakeIpMode) {
      dnsBlock['enhanced-mode'] = 'redir-host';
    }
    if (dns.ipv6 !== undefined) dnsBlock['ipv6'] = dns.ipv6;
    if (dns.nameserver !== undefined) dnsBlock['nameserver'] = [...dns.nameserver];
    if (dns.proxyNameserver !== undefined) dnsBlock['proxy-server-nameserver'] = [...dns.proxyNameserver];
    if (dns.directNameserver !== undefined) dnsBlock['direct-nameserver'] = [...dns.directNameserver];
    if (dns.fallback !== undefined) dnsBlock['fallback'] = [...dns.fallback];
    if (dns.nameserverPolicy !== undefined && Object.keys(dns.nameserverPolicy).length > 0) {
      dnsBlock['nameserver-policy'] = { ...dns.nameserverPolicy };
    }
    // 以下高级字段只在 clash-yaml 方言写出（plan 已在其余方言剥掉并记诊断）。
    if (dns.defaultNameserver !== undefined) dnsBlock['default-nameserver'] = [...dns.defaultNameserver];
    if (dns.fakeIpFilter !== undefined) dnsBlock['fake-ip-filter'] = [...dns.fakeIpFilter];
    if (dns.useHosts !== undefined) dnsBlock['use-hosts'] = dns.useHosts;
    if (dns.useSystemHosts !== undefined) dnsBlock['use-system-hosts'] = dns.useSystemHosts;
    if (dns.respectRules !== undefined) dnsBlock['respect-rules'] = dns.respectRules;
    if (dns.fallbackFilter !== undefined) {
      const filter = dns.fallbackFilter;
      dnsBlock['fallback-filter'] = {
        ...(filter.geoip === undefined ? {} : { geoip: filter.geoip }),
        ...(filter.geoipCode === undefined ? {} : { 'geoip-code': filter.geoipCode }),
        ...(filter.ipCidr === undefined ? {} : { ipcidr: [...filter.ipCidr] }),
        ...(filter.domain === undefined ? {} : { domain: [...filter.domain] }),
      };
    }
  }

  /**
   * 外部规则集 → `rule-providers` + `RULE-SET,<name>,<policy>`。
   *
   * 这条以前是诚实缺口（只做文本搬运，Clash 方言直接丢弃）。补齐的前提是三个**已知**：
   * 有 url、有 policy、知道文件里装的是什么形态（`shape`）。三者缺一就不写，并留下能看懂的诊断：
   * - 缺 policy → 写不出 `RULE-SET` 行，provider 成了没人引用的死下载；
   * - 缺 shape → `behavior` 写错会让 mihomo **拒绝加载整份配置**，这不是少一条规则的问题。
   *
   * `format: text` 是刻意的：我们镜像的就是原始文本，转 yaml/mrs 需要另一个编译器。
   */
  const providers: Fields = {};
  const usedNames = new Set<string>();
  const inlineLines = new Map<number, string[]>();
  for (const item of emissionPlan.ruleItems) {
    if (!item.decision.accepted) continue;
    const rendered = renderRule(target, item.rule);
    if (rendered === null) {
      diagnostics.push(
        makeDiagnostic('emit', target, `rule:${item.sourceIndex}:${item.index}`, 'rule-not-renderable'),
      );
      continue;
    }
    const bucket = inlineLines.get(item.sourceIndex) ?? [];
    bucket.push(rendered);
    inlineLines.set(item.sourceIndex, bucket);
  }
  const ordered: string[] = [];
  profile.ruleSources.forEach((source, index) => {
    if (source.kind === 'inline') {
      ordered.push(...(inlineLines.get(index) ?? []));
      return;
    }
    if (source.policy === undefined) {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-policy-missing'));
      return;
    }
    if (source.shape === undefined) {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-shape-unknown'));
      return;
    }
    const name = ruleProviderName(source.url);
    if (usedNames.has(name)) {
      diagnostics.push(makeDiagnostic('emit', target, source.url, 'external-ruleset-name-collision'));
      return;
    }
    usedNames.add(name);
    providers[name] = {
      type: 'http',
      behavior: source.shape === 'rules' ? 'classical' : source.shape,
      format: source.encoding ?? 'text',
      url: source.url,
      path: `./ruleset/${name}.list`,
      interval: 86_400,
    };
    ordered.push(`RULE-SET,${name},${source.policy}`);
  });
  // 兜底必须在最后。用户已经写了 MATCH 时不再补一条 DIRECT，否则会盖住他的兜底。
  if (!ordered.some((line) => line.startsWith('MATCH,'))) ordered.push('MATCH,DIRECT');
  rules.push(...ordered);

  const doc: Fields = {
    ...(Object.keys(dnsBlock).length === 0 ? {} : { dns: dnsBlock }),
    ...(emissionPlan.runtime.tun === null ? {} : { tun: tunFields(emissionPlan.runtime.tun) }),
    proxies,
    'proxy-groups': groups,
    ...(Object.keys(providers).length === 0 ? {} : { 'rule-providers': providers }),
    rules,
  };

  const header = [
    `# Generated by Startrails for ${descriptorOf(target).name}`,
    `# Field mapping basis: ${descriptorOf(target).basis}`,
  ].join('\n');
  return { content: `${header}\n${YAML.stringify(doc, { lineWidth: 0 })}`, diagnostics };
};
