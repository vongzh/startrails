import { buildReport, emit, plan } from './core/index.ts';
import { CLIENT_TARGETS } from './core/targets.ts';
import type { BuildReport, ClientTarget, Profile } from './core/index.ts';

export { outputFilename } from './core/targets.ts';

export interface BuildOutput {
  readonly target: ClientTarget;
  readonly content: string;
  readonly report: BuildReport;
}

export interface PipelineOptions {
  readonly buildId?: string;
}

/** 单点构建：服务端订阅 URL / 预览只跑请求的那个 Target，不扇出全部客户端。 */
export function buildOne(
  profile: Readonly<Profile>,
  target: ClientTarget,
  options: PipelineOptions = {},
): BuildOutput {
  const emissionPlan = plan(profile, target);
  const result = emit(profile, emissionPlan);
  const skipped = emissionPlan.items.filter((item) => item.action === 'reject').length;
  return {
    target,
    content: result.content,
    report: buildReport(
      target,
      result.diagnostics,
      emissionPlan.items.length - skipped,
      skipped,
      options.buildId ?? null,
    ),
  };
}

/**
 * 唯一的构建编排：同一份 IR 扇出到 N 个 Target，各自独立跑 Plan + Emit。
 * CLI / golden 调用它；服务端订阅 URL 与 UI 预览用 buildOne 只构建所需目标。
 */
export function buildAll(profile: Readonly<Profile>, options: PipelineOptions = {}): readonly BuildOutput[] {
  return CLIENT_TARGETS.map((target) => buildOne(profile, target, options));
}
