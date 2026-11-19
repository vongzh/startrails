import type { Profile } from '../ir/index.ts';
import { dialectOf } from '../targets.ts';
import type { Dialect } from '../targets.ts';
import type { EmissionPlan } from '../plan/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { surgeEmitter } from './surge.ts';
import { mihomoEmitter } from './mihomo.ts';
import { singBoxEmitter } from './sing-box.ts';
import { loonEmitter } from './loon.ts';
import { quanxEmitter } from './quanx.ts';
import { egernEmitter } from './egern.ts';
import { uriListEmitter } from './uri-list.ts';

export { encodeUriSubscriptionBase64 } from './uri-list.ts';

export interface EmitResult {
  readonly content: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Emitter 只读 IR，返回全新文本与诊断，永不改写传入对象。 */
export type Emitter = (profile: Readonly<Profile>, emissionPlan: EmissionPlan) => EmitResult;

/**
 * 按「方言」而非「客户端」注册：19 个 Target 共享 7 个 Emitter。
 * 新增客户端只加 TARGETS 一行与能力表差异，不改这里的控制流。
 */
export const emitters: Readonly<Record<Dialect, Emitter>> = {
  'surge-ini': surgeEmitter,
  'clash-yaml': mihomoEmitter,
  'sing-box-json': singBoxEmitter,
  'loon-ini': loonEmitter,
  'quanx-ini': quanxEmitter,
  'egern-yaml': egernEmitter,
  'uri-list': uriListEmitter,
};

export const emit = (profile: Readonly<Profile>, emissionPlan: EmissionPlan): EmitResult =>
  emitters[dialectOf(emissionPlan.target)](profile, emissionPlan);
