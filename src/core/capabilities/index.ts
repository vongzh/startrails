import { CLIENT_TARGETS, TARGETS, dialectOf } from '../targets.ts';
import { NODE_FEATURES, PROTOCOL_KINDS, RUNTIME_FEATURES } from './constants.ts';
import type { ClientTarget, ProxyNode } from '../ir/index.ts';
import { RULE_CONDITION_KINDS } from '../rules/index.ts';
import type { RuleCapabilityTable } from '../rules/index.ts';
import { verifiedCapabilityTables } from './verified.ts';

export type Action = 'support' | 'downgrade' | 'transform' | 'reject' | 'passthrough';

/** unverified 是一等状态：未核实的能力不允许假装支持，也不静默丢弃。 */
export type CapabilityValue = Action | 'unverified';

export type ProtocolKind = ProxyNode['kind'];

/** 传输层特性：能力表按 target × feature 判断，M4 再细化到 target × protocol × feature。 */
export type NodeFeature =
  | 'tls'
  | 'sni'
  | 'transport'
  | 'path'
  | 'host'
  | 'flow'
  | 'alterId'
  | 'cipher'
  | 'udp'
  | 'plugin'
  | 'reality'
  | 'obfs'
  | 'alpn'
  | 'insecure'
  | 'fingerprint'
  | 'bandwidth'
  | 'ports'
  | 'congestion'
  | 'udpRelayMode'
  | 'version'
  | 'idleSession'
  | 'shadowTls';

export { CRITICAL_FEATURES, NODE_FEATURES, PROTOCOL_KINDS, RUNTIME_FEATURES } from './constants.ts';

/**
 * 运行时段特性。与 NodeFeature 分开是因为它们的判定对象不同：
 * NodeFeature 判「这个节点能不能写」，RuntimeFeature 判「这份配置能不能带这一段」。
 */
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number];

export type RuntimeCapabilityTable = Readonly<
  Record<ClientTarget, Readonly<Record<RuntimeFeature, CapabilityValue>>>
>;

export type NodeCapabilityTable = Readonly<
  Record<ClientTarget, Readonly<Record<ProtocolKind, CapabilityValue>>>
>;

export type FeatureCapabilityTable = Readonly<
  Record<ClientTarget, Readonly<Record<NodeFeature, CapabilityValue>>>
>;

export interface OutputCapability {
  readonly format: 'ini' | 'yaml' | 'json' | 'uri';
  readonly allowsComments: boolean;
  readonly allowsExternalRuleSet: boolean;
}

export type OutputCapabilityTable = Readonly<Record<ClientTarget, OutputCapability>>;

export interface CapabilityTables {
  readonly node: NodeCapabilityTable;
  readonly feature: FeatureCapabilityTable;
  readonly rule: RuleCapabilityTable;
  readonly runtime: RuntimeCapabilityTable;
  readonly output: OutputCapabilityTable;
}

const allUnverified = <T extends string>(keys: readonly T[]): Readonly<Record<T, CapabilityValue>> =>
  Object.fromEntries(keys.map((key) => [key, 'unverified'])) as Readonly<Record<T, CapabilityValue>>;

const fromTargets = <T>(build: (target: ClientTarget) => T): Readonly<Record<ClientTarget, T>> =>
  Object.fromEntries(CLIENT_TARGETS.map((target) => [target, build(target)])) as Readonly<
    Record<ClientTarget, T>
  >;

/** 测试专用：模拟「能力完全未核实」的初始状态，验证拒绝路径。自动覆盖所有已注册 Target。 */
export const unverifiedCapabilityTables: CapabilityTables = {
  node: fromTargets(() => allUnverified(PROTOCOL_KINDS)),
  feature: fromTargets(() => allUnverified(NODE_FEATURES)),
  rule: fromTargets(() => allUnverified(RULE_CONDITION_KINDS)),
  runtime: fromTargets(() => allUnverified(RUNTIME_FEATURES)),
  output: verifiedCapabilityTables.output,
};

/** M1 起默认使用已核实能力表；核实依据见 verified.ts 的 CAPABILITY_EVIDENCE。 */
export const defaultCapabilityTables: CapabilityTables = verifiedCapabilityTables;

/** 供测试与 UI 使用：某 Target 是否完整具备已核实的输出能力。 */
export const targetDialectSummary = (): readonly {
  readonly target: ClientTarget;
  readonly dialect: string;
  readonly basis: string;
  readonly independentEvidence: boolean;
}[] =>
  TARGETS.map((item) => ({
    target: item.id,
    dialect: dialectOf(item.id),
    basis: item.basis,
    independentEvidence: item.independentEvidence,
  }));
