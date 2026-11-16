import type { Annotation, NodeTransform, PolicyGroup, Profile, ProxyNode, RuleSource } from '../ir/index.ts';
import { nodeKey } from '../ir/index.ts';
import { deepFreeze } from '../ir/index.ts';
import { compileMatcher } from '../collections/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';

export interface ProcessContext {
  readonly configVersion: string;
}

export interface ProcessResult {
  readonly profile: Profile;
  readonly diagnostics: readonly Diagnostic[];
}

/** 纯函数管道：每个 Processor 返回新 Profile，禁止原地改写。 */
export type Processor = (
  profile: Readonly<Profile>,
  ctx: Readonly<ProcessContext>,
) => ProcessResult;

export const identityProcessor: Processor = (profile) => ({ profile, diagnostics: [] });

export function runProcessors(
  profile: Readonly<Profile>,
  ctx: Readonly<ProcessContext>,
  processors: readonly Processor[],
): ProcessResult {
  let current = profile;
  const diagnostics: Diagnostic[] = [];
  for (const processor of processors) {
    const result = processor(current, ctx);
    current = result.profile;
    diagnostics.push(...result.diagnostics);
  }
  return { profile: current, diagnostics };
}

/**
 * 处理器重建 Profile 时必须**原样带走运行时段**。
 * 曾经在这里漏掉 runtime，结果「配了 DNS 但产物里没有」——节点全对、段落全丢，
 * 排查时最难看出问题出在哪个环节。凡是重建 Profile 的地方都要带上它。
 */
const rebuild = (profile: Readonly<Profile>, nodes: readonly ProxyNode[]): ProcessResult => ({
  profile: deepFreeze({
    nodes: [...nodes],
    ruleSources: [...profile.ruleSources] as RuleSource[],
    policyGroups: [...profile.policyGroups] as PolicyGroup[],
    ...(profile.runtime === undefined ? {} : { runtime: profile.runtime }),
  }) as unknown as Profile,
  diagnostics: [],
});

/**
 * 塔台的优点：用户意图单独存 Annotation，以稳定 nodeKey 关联，刷新后不污染解析结果。
 * 排除 / 别名 / 排序都在这里以纯函数完成，绝不改写上游节点对象。
 */
export function applyAnnotations(annotations: readonly Annotation[]): Processor {
  return (profile) => {
    const byKey = new Map(annotations.map((annotation) => [annotation.nodeKey, annotation]));
    const kept: { node: ProxyNode; order: number }[] = [];
    const diagnostics: Diagnostic[] = [];

    profile.nodes.forEach((node, index) => {
      const annotation = byKey.get(nodeKey(node));
      if (annotation?.excluded === true) {
        diagnostics.push(makeDiagnostic('process', null, nodeKey(node), 'excluded-by-annotation'));
        return;
      }
      const renamed: ProxyNode = (() => {
        const withAlias = annotation?.alias === undefined ? node : ({ ...node, name: annotation.alias } as ProxyNode);
        if (annotation?.region === undefined || annotation.region === '') return withAlias;
        return { ...withAlias, region: annotation.region } as ProxyNode;
      })();
      kept.push({ node: renamed, order: annotation?.order ?? index });
    });

    kept.sort((left, right) => left.order - right.order);
    const result = rebuild(profile, kept.map((entry) => entry.node));
    return { profile: result.profile, diagnostics: [...result.diagnostics, ...diagnostics] };
  };
}

/**
 * 按节点名批量清洗（配置级）：与 annotation 匹配同口径的正则/glob/字面量，按顺序执行。
 *
 * 为什么排在 applyAnnotations 之前：清洗做「一类节点」的粗加工（剔除信息节点、加地区前缀），
 * 标注做「单个节点」的精修。改名用 `{name}` 占原名，且 nodeKey 不含 name——所以后续标注
 * 依然按原 nodeKey 命中，不会因为批量改名而失效。
 */
export function applyNodeTransforms(transforms: readonly NodeTransform[]): Processor {
  const ordered = [...transforms].sort((left, right) => left.order - right.order);
  return (profile) => {
    let nodes: readonly ProxyNode[] = profile.nodes;
    const diagnostics: Diagnostic[] = [];
    for (const transform of ordered) {
      const matcher = compileMatcher(transform.pattern);
      if (matcher === null) {
        diagnostics.push(makeDiagnostic('process', null, transform.id, 'invalid-transform-pattern'));
        continue;
      }
      if (transform.action === 'exclude') {
        const kept = nodes.filter((node) => !matcher.test(node.name));
        const removed = nodes.length - kept.length;
        if (removed > 0) {
          diagnostics.push(
            makeDiagnostic('process', null, transform.id, `excluded-by-transform:${removed}`),
          );
        }
        nodes = kept;
        continue;
      }
      const template = transform.replacement ?? '{name}';
      nodes = nodes.map((node) => {
        if (!matcher.test(node.name)) return node;
        const name = template.replaceAll('{name}', node.name);
        if (name === node.name) return node;
        return { ...node, name } as ProxyNode;
      });
    }
    const result = rebuild(profile, nodes);
    return { profile: result.profile, diagnostics: [...result.diagnostics, ...diagnostics] };
  };
}

export function filterByTag(tag: string): Processor {
  return (profile) => rebuild(profile, profile.nodes.filter((node) => node.name.includes(tag)));
}

export function sortByOrder(annotations: readonly Annotation[]): Processor {
  return applyAnnotations(annotations);
}
