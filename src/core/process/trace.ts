import type { Profile } from '../ir/index.ts';
import { nodeKey } from '../ir/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import type { ProcessContext, Processor } from './index.ts';

export type ProcessChangeKind =
  | 'node-added'
  | 'node-removed'
  | 'node-renamed'
  | 'node-reordered'
  | 'rules-changed';

export interface ProcessChange {
  readonly kind: ProcessChangeKind;
  readonly ref: string;
  readonly detail: string;
}

export interface ProcessStep {
  readonly index: number;
  readonly before: Profile;
  readonly after: Profile;
  readonly diff: readonly ProcessChange[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProcessTrace {
  readonly steps: readonly ProcessStep[];
  readonly final: Profile;
}

/** 纯函数：只比较，不改写任何 Profile；快照保留冻结引用。 */
export function diffProfiles(before: Readonly<Profile>, after: Readonly<Profile>): readonly ProcessChange[] {
  const changes: ProcessChange[] = [];
  const left = new Map(before.nodes.map((node) => [nodeKey(node), node]));
  const right = new Map(after.nodes.map((node) => [nodeKey(node), node]));

  for (const [key, node] of right) {
    if (!left.has(key)) changes.push({ kind: 'node-added', ref: key, detail: node.name });
  }
  for (const [key, node] of left) {
    if (!right.has(key)) changes.push({ kind: 'node-removed', ref: key, detail: node.name });
    else {
      const renamed = right.get(key);
      if (renamed !== undefined && renamed.name !== node.name) {
        changes.push({ kind: 'node-renamed', ref: key, detail: `${node.name} → ${renamed.name}` });
      }
    }
  }

  const beforeOrder = before.nodes.map((node) => nodeKey(node)).join('|');
  const afterOrder = after.nodes.map((node) => nodeKey(node)).join('|');
  if (beforeOrder !== afterOrder) {
    changes.push({
      kind: 'node-reordered',
      ref: 'profile',
      detail: `${before.nodes.length} → ${after.nodes.length} 个节点，顺序或数量变化`,
    });
  }
  if (JSON.stringify(before.ruleSources) !== JSON.stringify(after.ruleSources)) {
    changes.push({ kind: 'rules-changed', ref: 'rules', detail: '规则来源发生变化' });
  }
  return changes;
}

/** 逐步快照 + diff：UI 可展示每一步做了什么，而不是只给最终结果。 */
export function traceProcessors(
  profile: Readonly<Profile>,
  ctx: Readonly<ProcessContext>,
  processors: readonly Processor[],
): ProcessTrace {
  let current: Readonly<Profile> = profile;
  const steps: ProcessStep[] = [];
  processors.forEach((processor, index) => {
    const result = processor(current, ctx);
    steps.push({
      index,
      before: current as Profile,
      after: result.profile,
      diff: diffProfiles(current, result.profile),
      diagnostics: result.diagnostics,
    });
    current = result.profile;
  });
  return { steps, final: current as Profile };
}
