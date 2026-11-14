import { compileMatcher, nodeKey, regionOfNode } from '../core/index.ts';
import type { DnsPolicy, InlineRule, PolicyGroup, ProxyNode, RuleSource, RuntimePolicy } from '../core/index.ts';
import type {
  OverlayMode,
  PersistedGroupOverride,
  PersistedProfile,
  SectionModes,
  StoredMember,
  StoredRule,
} from '../store/port.ts';

const BUILTIN = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

export function effectiveModes(
  profile: PersistedProfile,
  hasGroupRows: boolean,
  hasRules: boolean,
): SectionModes {
  const stored = profile.sectionModes;
  return {
    groups: stored?.groups ?? (hasGroupRows ? 'replace' : 'inherit'),
    rules: stored?.rules ?? (hasRules ? 'merge' : 'inherit'),
    rulePlacement: stored?.rulePlacement ?? 'after',
    dns: stored?.dns ?? (profile.runtime?.dns !== undefined ? 'replace' : 'inherit'),
  };
}

function memberName(member: StoredMember): string | undefined {
  if (typeof member === 'string') return member;
  if (member.kind === 'ref') return member.name;
  return undefined;
}

/** 把匹配和地区展开成节点名。引用保留到第二轮，对不上节点、组或内置策略的丢掉。 */
export function expandGroup(
  group: PersistedGroupOverride,
  nodes: readonly ProxyNode[],
  groupNames: ReadonlySet<string>,
): PolicyGroup {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const member of group.members) {
    if (typeof member === 'string' || member.kind === 'ref') {
      const name = memberName(member);
      if (name !== undefined) add(name);
      continue;
    }
    if (member.kind === 'match') {
      const matcher = compileMatcher(member.pattern);
      if (matcher === null) continue;
      for (const node of nodes) {
        if (matcher.test(node.name)) add(node.name);
      }
      continue;
    }
    if (member.kind === 'rest') continue;
    for (const node of nodes) {
      if (regionOfNode(node) === member.code) add(node.name);
    }
  }
  const nodeNames = new Set(nodes.map((node) => node.name));
  const members = names.filter((name) => nodeNames.has(name) || groupNames.has(name) || BUILTIN.has(name));
  return {
    name: group.name,
    members: members.length > 0 ? members : ['DIRECT'],
    ...(group.strategy === undefined ? {} : { strategy: group.strategy }),
    ...(group.testUrl === undefined ? {} : { testUrl: group.testUrl }),
    ...(group.interval === undefined ? {} : { interval: group.interval }),
    ...(group.tolerance === undefined ? {} : { tolerance: group.tolerance }),
    ...(group.lazy === true ? { lazy: true } : {}),
    ...(group.hidden === true ? { hidden: true } : {}),
  };
}

const wantsRest = (group: PersistedGroupOverride): boolean =>
  group.members.some((member) => typeof member !== 'string' && member.kind === 'rest');

/** 其余节点 = 当前名单里还没被任何组点名的节点。先收完明确成员，再填这个集合。 */
function fillRest(
  groups: readonly PolicyGroup[],
  restNames: ReadonlySet<string>,
  nodes: readonly ProxyNode[],
): PolicyGroup[] {
  const nodeNames = new Set(nodes.map((node) => node.name));
  const claimed = new Set<string>();
  for (const group of groups) {
    for (const member of group.members) {
      if (nodeNames.has(member)) claimed.add(member);
    }
  }
  return groups.map((group) => {
    if (!restNames.has(group.name)) return group;
    const extra = nodes.map((node) => node.name).filter((name) => !claimed.has(name) && !group.members.includes(name));
    const concrete = group.members.filter((member) => member !== 'DIRECT');
    const members = [...concrete, ...extra];
    return { ...group, members: members.length > 0 ? members : ['DIRECT'] };
  });
}

/**
 * 节点改名之后，继承来的组成员还指着旧名字。按 nodeKey 把成员改成现在的名字。
 * 匹配和其余节点不走这里，它们在改名之后才展开。
 */
export function alignInheritedMembers(
  groups: readonly PolicyGroup[],
  before: readonly ProxyNode[],
  after: readonly ProxyNode[],
): PolicyGroup[] {
  const afterName = new Map(after.map((node) => [nodeKey(node), node.name]));
  const oldToNew = new Map<string, string>();
  for (const node of before) {
    const next = afterName.get(nodeKey(node));
    if (next !== undefined && next !== node.name) oldToNew.set(node.name, next);
  }
  if (oldToNew.size === 0) return [...groups];
  return groups.map((group) => ({
    ...group,
    members: group.members.map((member) => oldToNew.get(member) ?? member),
  }));
}

export function applyGroupOverlay(
  base: readonly PolicyGroup[],
  overrides: readonly PersistedGroupOverride[],
  nodes: readonly ProxyNode[],
  mode: OverlayMode,
): PolicyGroup[] {
  if (mode === 'inherit') return [...base];
  const names = new Set<string>([
    ...base.map((group) => group.name),
    ...overrides.map((group) => group.name),
  ]);
  const restNames = new Set(overrides.filter(wantsRest).map((group) => group.name));
  const expanded = overrides.map((group) => expandGroup(group, nodes, names));
  const selected =
    mode === 'replace'
      ? expanded
      : (() => {
          const byName = new Map(expanded.map((group) => [group.name, group]));
          const merged: PolicyGroup[] = base.map((group) => byName.get(group.name) ?? group);
          const known = new Set(base.map((group) => group.name));
          for (const group of expanded) {
            if (!known.has(group.name)) merged.push(group);
          }
          return merged;
        })();
  return fillRest(selected, restNames, nodes);
}

export function storedRulesToSources(rules: readonly StoredRule[]): RuleSource[] {
  const sources: RuleSource[] = [];
  let inline: InlineRule[] = [];
  const flush = (): void => {
    if (inline.length === 0) return;
    sources.push({ kind: 'inline', rules: inline });
    inline = [];
  };
  for (const rule of rules) {
    if ('kind' in rule && rule.kind === 'external') {
      flush();
      sources.push({
        kind: 'external',
        url: rule.url,
        policy: rule.policy,
        ...(rule.shape === undefined ? {} : { shape: rule.shape }),
        ...(rule.format === undefined ? {} : { encoding: rule.format }),
      });
      continue;
    }
    if ('kind' in rule && rule.kind === 'final') {
      inline.push({ condition: { type: 'match' }, policy: rule.policy });
      continue;
    }
    inline.push(rule);
  }
  flush();
  return sources;
}

function hasFinal(sources: readonly RuleSource[]): boolean {
  return sources.some(
    (source) => source.kind === 'inline' && source.rules.some((rule) => rule.condition.type === 'match'),
  );
}

function stripFinal(sources: readonly RuleSource[]): RuleSource[] {
  const result: RuleSource[] = [];
  for (const source of sources) {
    if (source.kind !== 'inline') {
      result.push(source);
      continue;
    }
    const rules = source.rules.filter((rule) => rule.condition.type !== 'match');
    if (rules.length > 0) result.push({ kind: 'inline', rules });
  }
  return result;
}

/** 兜底留在整份列表最后。用户写了兜底时，底稿里的 MATCH 去掉。 */
function moveFinalLast(sources: readonly RuleSource[]): RuleSource[] {
  const finals: InlineRule[] = [];
  const rest: RuleSource[] = [];
  for (const source of sources) {
    if (source.kind !== 'inline') {
      rest.push(source);
      continue;
    }
    const rules = source.rules.filter((rule) => {
      if (rule.condition.type !== 'match') return true;
      finals.push(rule);
      return false;
    });
    if (rules.length > 0) rest.push({ kind: 'inline', rules });
  }
  if (finals.length === 0) return rest;
  return [...rest, { kind: 'inline', rules: finals }];
}

function mergeDns(base: DnsPolicy | undefined, overlay: DnsPolicy | undefined): DnsPolicy | undefined {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  const nameserverPolicy = { ...(base.nameserverPolicy ?? {}), ...(overlay.nameserverPolicy ?? {}) };
  return {
    mode: overlay.mode,
    ...(overlay.nameserver !== undefined ? { nameserver: overlay.nameserver } : base.nameserver !== undefined ? { nameserver: base.nameserver } : {}),
    ...(overlay.proxyNameserver !== undefined
      ? { proxyNameserver: overlay.proxyNameserver }
      : base.proxyNameserver !== undefined
        ? { proxyNameserver: base.proxyNameserver }
        : {}),
    ...(overlay.directNameserver !== undefined
      ? { directNameserver: overlay.directNameserver }
      : base.directNameserver !== undefined
        ? { directNameserver: base.directNameserver }
        : {}),
    ...(overlay.fallback !== undefined ? { fallback: overlay.fallback } : base.fallback !== undefined ? { fallback: base.fallback } : {}),
    ...(overlay.ecs !== undefined ? { ecs: overlay.ecs } : base.ecs !== undefined ? { ecs: base.ecs } : {}),
    ...(overlay.fakeIpRange !== undefined
      ? { fakeIpRange: overlay.fakeIpRange }
      : base.fakeIpRange !== undefined
        ? { fakeIpRange: base.fakeIpRange }
        : {}),
    ...(overlay.ipv6 !== undefined ? { ipv6: overlay.ipv6 } : base.ipv6 !== undefined ? { ipv6: base.ipv6 } : {}),
    ...(Object.keys(nameserverPolicy).length === 0 ? {} : { nameserverPolicy }),
  };
}

/** DNS 按模式叠到订阅底稿上。TUN 始终来自配置里保存的值，订阅里没有这一段。 */
export function applyDnsOverlay(
  source: RuntimePolicy | undefined,
  saved: RuntimePolicy | undefined,
  mode: OverlayMode,
): RuntimePolicy | undefined {
  const tun = saved?.tun;
  const dns =
    mode === 'replace' ? saved?.dns : mode === 'merge' ? mergeDns(source?.dns, saved?.dns) : source?.dns;
  if (dns === undefined && tun === undefined) return undefined;
  return { ...(dns === undefined ? {} : { dns }), ...(tun === undefined ? {} : { tun }) };
}

export function applyRuleOverlay(
  base: readonly RuleSource[],
  stored: readonly StoredRule[],
  mode: OverlayMode,
  placement: 'before' | 'after',
): RuleSource[] {
  if (mode === 'inherit') return [...base];
  const overlay = storedRulesToSources(stored);
  if (mode === 'replace') return moveFinalLast(overlay);
  const baseRules = hasFinal(overlay) ? stripFinal(base) : [...base];
  const combined = placement === 'before' ? [...overlay, ...baseRules] : [...baseRules, ...overlay];
  return moveFinalLast(combined);
}
