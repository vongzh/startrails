import type { ClientTarget, DnsPolicy, InlineRule, Profile, TunPolicy } from '../ir/index.ts';
import { nodeKey } from '../ir/index.ts';
import type { Action, CapabilityTables, NodeFeature } from '../capabilities/index.ts';
import { defaultCapabilityTables } from '../capabilities/index.ts';
import { CRITICAL_FEATURES } from '../capabilities/constants.ts';
import { requiredFeatures } from '../capabilities/features.ts';
import { evaluateRule } from '../rules/index.ts';
import type { RuleDecision } from '../rules/index.ts';
import type { Dialect } from '../targets.ts';
import { dialectOf } from '../targets.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';

/**
 * 哪些方言能直接引用外部规则集（把我们镜像的地址原样交给客户端去拉）。
 * 依据只有两条，都是官方文档写明的写法：
 * - Surge：`RULE-SET,<url>,<policy>`；
 * - mihomo：`rule-providers` 里给 `url`/`path`，再用 `RULE-SET,<name>,<policy>` 引用。
 * 其余方言（Loon / QuanX / Egern / sing-box / URI 列表）本次没有取得「引用远程规则集」的官方依据，
 * 保持 false：报一条 plan 诊断，由对应 emitter 决定是否写一行注释。
 */
const EXPRESSES_EXTERNAL_RULESET: Readonly<Record<Dialect, boolean>> = {
  'surge-ini': true,
  'clash-yaml': true,
  'loon-ini': false,
  'quanx-ini': false,
  'egern-yaml': false,
  'sing-box-json': false,
  'uri-list': false,
};

export interface PlanRuleItem {
  readonly sourceIndex: number;
  readonly index: number;
  readonly rule: InlineRule;
  readonly decision: RuleDecision;
}

export interface PlanItem {
  readonly ref: string;
  readonly index: number;
  readonly action: Action;
  readonly reason: string;
  /** 已决定丢弃的传输层特性；Emit 只能按此清单跳过字段，不得自行猜测降级。 */
  readonly droppedFeatures: readonly NodeFeature[];
}

/** 已按目标能力裁剪过的运行时段；Emit 只负责把它序列化，不再做能力判断。 */
export interface RuntimePlan {
  readonly dns: DnsPolicy | null;
  readonly tun: TunPolicy | null;
  /**
   * 该目标是否用显式字段开启 fake-ip（mihomo 的 `enhanced-mode`）。
   * Stash 的 fake-ip 是默认行为、没有这个键，Emit 需要据此决定写不写。
   */
  readonly explicitFakeIpMode: boolean;
}

/** Plan 只做决策，绝不改写 IR。降级/变换的表达发生在 Emit 内部。 */
export interface EmissionPlan {
  readonly target: ClientTarget;
  readonly items: readonly PlanItem[];
  readonly ruleItems: readonly PlanRuleItem[];
  readonly runtime: RuntimePlan;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * 运行时段的能力裁剪。
 *
 * 与节点特性遵循同一条纪律：**没有官方依据就不写**，但运行时段的失败代价不是「连不上」而是
 * 「解析走了不该走的路」，因此这里一律「丢字段 + 记诊断」，不拒绝整份配置——
 * 少了 DNS 段，节点依然可用；写错 DNS 段，反而可能让整机断网。
 */
function planRuntime(
  profile: Readonly<Profile>,
  target: ClientTarget,
  caps: CapabilityTables,
  diagnostics: Diagnostic[],
): RuntimePlan {
  const policy = profile.runtime;
  if (policy === undefined) return { dns: null, tun: null, explicitFakeIpMode: false };
  const table = caps.runtime[target];

  let dns: DnsPolicy | null = null;
  if (policy.dns !== undefined) {
    if (table.dns !== 'support') {
      diagnostics.push(
        makeDiagnostic(
          'plan',
          target,
          'runtime:dns',
          table.dns === 'unverified' ? 'runtime-dns-unverified' : 'runtime-dns-not-expressible',
        ),
      );
    } else if (policy.dns.mode === 'system' && policy.dns.nameserver === undefined) {
      // 「用系统 DNS」在不写任何字段时就是默认行为，写一段空的反而更糟。
      diagnostics.push(makeDiagnostic('plan', target, 'runtime:dns', 'runtime-dns-system-default'));
    } else {
      let next: DnsPolicy = policy.dns;
      if (next.mode === 'fake-ip' && table.fakeIp !== 'support') {
        diagnostics.push(
          makeDiagnostic('plan', target, 'runtime:dns', 'runtime-dns-fakeip-unsupported'),
        );
        next = { ...next, mode: 'redir-host' };
      }
      if (
        next.mode === 'fake-ip' &&
        table.fakeIp === 'support' &&
        table.enhancedMode !== 'support'
      ) {
        // Stash 这类客户端没有 enhanced-mode 键，fake-ip 由 fake-ip-range 隐含开启。
        diagnostics.push(makeDiagnostic('plan', target, 'runtime:dns', 'runtime-dns-fakeip-implicit'));
      }
      if (next.ecs !== undefined && table.ecs !== 'support') {
        diagnostics.push(makeDiagnostic('plan', target, 'runtime:dns', 'runtime-dns-ecs-dropped'));
        const { ecs: _ecs, ...rest } = next;
        next = rest;
      }
      if (next.nameserverPolicy !== undefined && table.nameserverPolicy !== 'support') {
        diagnostics.push(makeDiagnostic('plan', target, 'runtime:dns', 'runtime-dns-policy-dropped'));
        const { nameserverPolicy: _policy, ...rest } = next;
        next = rest;
      }
      dns = next;
    }
  }

  let tun: TunPolicy | null = null;
  if (policy.tun !== undefined && policy.tun.enabled) {
    if (table.tun !== 'support') {
      diagnostics.push(
        makeDiagnostic(
          'plan',
          target,
          'runtime:tun',
          table.tun === 'unverified' ? 'runtime-tun-unverified' : 'runtime-tun-not-expressible',
        ),
      );
    } else {
      tun = policy.tun;
    }
  }

  return { dns, tun, explicitFakeIpMode: table.enhancedMode === 'support' };
}

export function plan(
  profile: Readonly<Profile>,
  target: ClientTarget,
  caps: CapabilityTables = defaultCapabilityTables,
): EmissionPlan {
  const items: PlanItem[] = [];
  const ruleItems: PlanRuleItem[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [index, node] of profile.nodes.entries()) {
    const ref = nodeKey(node);
    const protocol = caps.node[target][node.kind];

    if (protocol === 'unverified' || protocol === 'reject') {
      const reason = protocol === 'unverified' ? 'capability-unverified' : 'protocol-unsupported';
      items.push({ ref, index, action: 'reject', reason, droppedFeatures: [] });
      diagnostics.push(
        makeDiagnostic('plan', target, ref, `${target}/${node.kind} ${reason}: ${node.name}`),
      );
      continue;
    }

    const droppedFeatures = requiredFeatures(node).filter(
      (feature) => caps.feature[target][feature] !== 'support',
    );

    // 认证/握手级特性无法「降级」：丢掉 reality / obfs / plugin 后配置看起来正常，但必然连不上。
    // 这类节点直接拒绝，诊断里写清缺哪一项，避免用户等到客户端报错才发现。
    const fatal = droppedFeatures.filter((feature) => CRITICAL_FEATURES.includes(feature));
    if (fatal.length > 0) {
      const reason = `feature-required:${fatal.join(',')}`;
      items.push({ ref, index, action: 'reject', reason, droppedFeatures: [] });
      diagnostics.push(
        makeDiagnostic('plan', target, ref, `${target}/${node.kind} ${reason}: ${node.name}`),
      );
      continue;
    }

    for (const feature of droppedFeatures) {
      diagnostics.push(
        makeDiagnostic(
          'plan',
          target,
          ref,
          `feature-not-expressible:${feature} (${node.name}) — 保留节点，导出时丢弃该字段`,
        ),
      );
    }

    const action: Action =
      droppedFeatures.length > 0 ? 'downgrade' : protocol === 'transform' ? 'transform' : 'support';
    items.push({
      ref,
      index,
      action,
      reason:
        droppedFeatures.length > 0
          ? `downgrade:${droppedFeatures.join(',')}`
          : `capability:${protocol}`,
      droppedFeatures,
    });
  }

  profile.ruleSources.forEach((source, sourceIndex) => {
    if (source.kind === 'external') {
      // 只有「能把外部规则集地址原样交给客户端」的方言才不报警：
      // Surge 有 `RULE-SET,<url>,<policy>`，mihomo 有 `rule-providers` + `RULE-SET,<name>,<policy>`。
      // 其余方言本次没有官方依据表达远程规则集引用，内容也判不了——如实报，不写占位行。
      if (!EXPRESSES_EXTERNAL_RULESET[dialectOf(target)]) {
        diagnostics.push(
          makeDiagnostic('plan', target, source.url, 'external-ruleset-not-evaluable'),
        );
      }
      return;
    }
    source.rules.forEach((rule, index) => {
      const decision = evaluateRule(rule.condition, target, caps.rule);
      ruleItems.push({ sourceIndex, index, rule, decision });
      if (!decision.accepted) {
        diagnostics.push(
          makeDiagnostic('plan', target, `rule:${sourceIndex}:${index}`, decision.reason),
        );
      }
    });
  });

  return { target, items, ruleItems, runtime: planRuntime(profile, target, caps, diagnostics), diagnostics };
}

export const acceptedItems = (emissionPlan: EmissionPlan): readonly PlanItem[] =>
  emissionPlan.items.filter((item) => item.action !== 'reject');

export const rejectedItems = (emissionPlan: EmissionPlan): readonly PlanItem[] =>
  emissionPlan.items.filter((item) => item.action === 'reject');
