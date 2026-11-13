import type { ClientTarget, InlineRule, RuleCondition } from '../ir/index.ts';
import { assertNever } from '../ir/index.ts';
import { dialectOf } from '../targets.ts';
import type { CapabilityValue } from '../capabilities/index.ts';

export * from './shape.ts';

export type RuleConditionKind = RuleCondition['type'];

export const RULE_CONDITION_KINDS: readonly RuleConditionKind[] = [
  'domain',
  'domainSuffix',
  'ipCidr',
  'and',
  'or',
  'not',
];

export type RuleCapabilityTable = Readonly<
  Record<ClientTarget, Readonly<Record<RuleConditionKind, CapabilityValue>>>
>;

export interface RuleDecision {
  readonly accepted: boolean;
  readonly reason: string;
}

/** 逐条判定条件树能否在目标客户端表达；任一子节点不可表达即整条拒绝。 */
export function evaluateRule(
  condition: RuleCondition,
  target: ClientTarget,
  table: RuleCapabilityTable,
): RuleDecision {
  const value = table[target][condition.type];
  if (value !== 'support') {
    return { accepted: false, reason: `rule-capability:${value}:${condition.type}` };
  }
  switch (condition.type) {
    case 'and':
    case 'or':
      for (const child of condition.children) {
        const decision = evaluateRule(child, target, table);
        if (!decision.accepted) return decision;
      }
      return { accepted: true, reason: 'rule-capability:support' };
    case 'not':
      return evaluateRule(condition.child, target, table);
    case 'domain':
    case 'domainSuffix':
    case 'ipCidr':
      return { accepted: true, reason: 'rule-capability:support' };
    default:
      return assertNever(condition);
  }
}

/** Surge / Clash 系 CSV 方言：DOMAIN-SUFFIX,x,PROXY。 */
const renderCondition = (condition: RuleCondition): string => {
  switch (condition.type) {
    case 'domain':
      return `DOMAIN,${condition.value}`;
    case 'domainSuffix':
      return `DOMAIN-SUFFIX,${condition.value}`;
    case 'ipCidr':
      return `IP-CIDR,${condition.value}`;
    case 'and':
    case 'or': {
      const type = condition.type.toUpperCase();
      const payload = condition.children.map((child) => `(${renderCondition(child)})`).join(',');
      return `${type},(${payload})`;
    }
    case 'not':
      return `NOT,((${renderCondition(condition.child)}))`;
    default:
      return assertNever(condition);
  }
};

/**
 * QuanX [filter_local] 方言，依据官方 sample.conf：
 * host / host-suffix / ip-cidr 行格式与 final 兜底；策略用小写内置名。
 * 逻辑规则在能力表已判 unverified，这里返回 null 而不是猜测语法。
 */
const QUANX_POLICY: Readonly<Record<string, string>> = {
  DIRECT: 'direct',
  REJECT: 'reject',
  PROXY: 'proxy',
};

const quanxPolicy = (policy: string): string => QUANX_POLICY[policy.toUpperCase()] ?? policy;

const renderQuanxRule = (rule: InlineRule): string | null => {
  const condition = rule.condition;
  switch (condition.type) {
    case 'domain':
      return `host, ${condition.value}, ${quanxPolicy(rule.policy)}`;
    case 'domainSuffix':
      return `host-suffix, ${condition.value}, ${quanxPolicy(rule.policy)}`;
    case 'ipCidr':
      return `ip-cidr, ${condition.value}, ${quanxPolicy(rule.policy)}`;
    case 'and':
    case 'or':
    case 'not':
      return null;
    default:
      return assertNever(condition);
  }
};

/**
 * 按方言渲染规则。依据：
 * - Surge rules/overview.html、mihomo rules/（CSV + LOGIC_TYPE 模板）
 * - QuanX sample.conf [filter_local]（小写类型与小写内置策略）
 * - Loon / Egern / sing-box 的规则段本次未取得官方依据，返回 null 而不是编造。
 */
export function renderRule(target: ClientTarget, rule: InlineRule): string | null {
  const dialect = dialectOf(target);
  switch (dialect) {
    case 'surge-ini':
    case 'clash-yaml':
      return `${renderCondition(rule.condition)},${rule.policy}`;
    case 'quanx-ini':
      return renderQuanxRule(rule);
    case 'loon-ini':
    case 'egern-yaml':
    case 'sing-box-json':
    case 'uri-list':
      return null;
    default:
      return assertNever(dialect);
  }
}
