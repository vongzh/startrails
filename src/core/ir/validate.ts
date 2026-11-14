import { z } from 'zod';
import type {
  InlineRule,
  PolicyGroup,
  Profile,
  ProxyNode,
  RuleCondition,
  RuleSource,
  RuntimePolicy,
} from './index.ts';
import { deepFreeze } from './index.ts';

const realitySchema = z
  .object({
    publicKey: z.string().min(1),
    shortId: z.string().min(1).optional(),
    fingerprint: z.string().min(1).optional(),
    spiderX: z.string().min(1).optional(),
  })
  .strict();

const obfsSchema = z
  .object({
    type: z.enum(['salamander', 'gecko', 'http', 'tls']),
    password: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
  })
  .strict();

const pluginOptsSchema = z
  .object({
    mode: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    tls: z.boolean().optional(),
    password: z.string().min(1).optional(),
    version: z.number().int().min(1).max(3).optional(),
  })
  .strict();

const optionsSchema = z
  .object({
    tls: z.boolean().optional(),
    sni: z.string().min(1).optional(),
    transport: z.enum(['ws', 'grpc', 'http2']).optional(),
    path: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    flow: z.string().min(1).optional(),
    alterId: z.number().int().min(0).optional(),
    cipher: z.string().min(1).optional(),
    udp: z.boolean().optional(),
    plugin: z.string().min(1).optional(),
    pluginOpts: pluginOptsSchema.optional(),
    reality: realitySchema.optional(),
    obfs: obfsSchema.optional(),
    alpn: z.array(z.string().min(1)).optional(),
    insecure: z.boolean().optional(),
    fingerprint: z.string().min(1).optional(),
    bandwidth: z
      .object({ up: z.number().positive().optional(), down: z.number().positive().optional() })
      .strict()
      .optional(),
    ports: z.string().min(1).optional(),
    congestionControl: z.string().min(1).optional(),
    udpRelayMode: z.string().min(1).optional(),
    version: z.number().int().min(1).max(6).optional(),
    idleSessionTimeout: z.number().int().positive().optional(),
  })
  .strict();

const nodeBase = {
  name: z.string().min(1),
  server: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  options: optionsSchema.optional(),
};

export const proxyNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vless'), ...nodeBase, uuid: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('vmess'), ...nodeBase, uuid: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('trojan'), ...nodeBase, password: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('shadowsocks'),
      ...nodeBase,
      method: z.string().min(1),
      password: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('hysteria2'), ...nodeBase, password: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('tuic'),
      ...nodeBase,
      uuid: z.string().min(1),
      password: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('anytls'), ...nodeBase, password: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('snell'), ...nodeBase, psk: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('wireguard'),
      ...nodeBase,
      privateKey: z.string().min(1),
      peerPublicKey: z.string().min(1),
      preSharedKey: z.string().min(1).optional(),
      addresses: z.array(z.string().min(1)).min(1),
      mtu: z.number().int().min(576).max(1500).optional(),
      reserved: z.array(z.number().int().min(0).max(255)).optional(),
      allowedIps: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('socks5'),
      ...nodeBase,
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('http'),
      ...nodeBase,
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    })
    .strict(),
]);

const conditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('domain'), value: z.string().min(1) }),
    z.object({ type: z.literal('domainSuffix'), value: z.string().min(1) }),
    z.object({ type: z.literal('domainKeyword'), value: z.string().min(1) }),
    z.object({ type: z.literal('geosite'), value: z.string().min(1) }),
    z.object({ type: z.literal('geoip'), value: z.string().min(1), noResolve: z.boolean().optional() }),
    z.object({ type: z.literal('ipCidr'), value: z.string().min(1), noResolve: z.boolean().optional() }),
    z.object({ type: z.literal('ipCidr6'), value: z.string().min(1), noResolve: z.boolean().optional() }),
    z.object({ type: z.literal('match') }),
    z.object({ type: z.literal('and'), children: z.array(conditionSchema) }),
    z.object({ type: z.literal('or'), children: z.array(conditionSchema) }),
    z.object({ type: z.literal('not'), child: conditionSchema }),
  ]),
);

const ruleSourceSchema: z.ZodType<RuleSource> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), rules: z.array(z.object({ condition: conditionSchema, policy: z.string().min(1) })) }),
  z.object({
    kind: z.literal('external'),
    url: z.string().min(1),
    policy: z.string().min(1).optional(),
    shape: z.enum(['domain', 'ipcidr', 'rules']).optional(),
    encoding: z.enum(['text', 'yaml']).optional(),
  }),
]);

const policyGroupSchema: z.ZodType<PolicyGroup> = z.object({
  name: z.string().min(1),
  members: z.array(z.string().min(1)),
  strategy: z.enum(['select', 'url-test', 'fallback']).optional(),
  testUrl: z.string().min(1).optional(),
  interval: z.number().int().positive().optional(),
  tolerance: z.number().int().nonnegative().optional(),
  lazy: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

/** 非空字符串数组：`nameserver: []` 没有意义，写出来只会让客户端以为「配了但全是空」。 */
const serverList = z.array(z.string().min(1)).min(1);

const dnsSchema = z
  .object({
    mode: z.enum(['system', 'fake-ip', 'redir-host']),
    nameserver: serverList.optional(),
    proxyNameserver: serverList.optional(),
    directNameserver: serverList.optional(),
    fallback: serverList.optional(),
    nameserverPolicy: z.record(z.string().min(1), z.string().min(1)).optional(),
    ecs: z.string().min(1).optional(),
    fakeIpRange: z.string().min(1).optional(),
    ipv6: z.boolean().optional(),
  })
  .strict();

const tunSchema = z
  .object({
    enabled: z.boolean(),
    stack: z.enum(['gvisor', 'system', 'mixed']).optional(),
    strictRoute: z.boolean().optional(),
    mtu: z.number().int().min(576).max(9000).optional(),
  })
  .strict();

const runtimeSchema = z
  .object({
    dns: dnsSchema.optional(),
    tun: tunSchema.optional(),
  })
  .strict();

export const profileSchema = z.object({
  nodes: z.array(proxyNodeSchema),
  ruleSources: z.array(ruleSourceSchema),
  policyGroups: z.array(policyGroupSchema),
  runtime: runtimeSchema.optional(),
});

/** 严格校验 + 深层冻结。解析后任何写入都应在运行时抛错，Emitter 只能返回新对象。 */
export function parseProfile(value: unknown): Profile {
  const parsed = profileSchema.parse(value);
  return deepFreeze({
    nodes: parsed.nodes as ProxyNode[],
    ruleSources: parsed.ruleSources as RuleSource[],
    policyGroups: parsed.policyGroups as PolicyGroup[],
    ...(parsed.runtime === undefined ? {} : { runtime: parsed.runtime as RuntimePolicy }),
  }) as unknown as Profile;
}

/** 运行时段单独校验：它来自设置接口的 JSON，可能被手工改坏，必须在这里挡住。 */
export function parseRuntime(value: unknown): RuntimePolicy {
  return runtimeSchema.parse(value) as RuntimePolicy;
}

export function parseProfileText(raw: string): Profile {
  return parseProfile(JSON.parse(raw) as unknown);
}

export function safeParseProfileText(
  raw: string,
):
  | { readonly ok: true; readonly profile: Profile }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, profile: parseProfileText(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type InlineRuleType = InlineRule;
