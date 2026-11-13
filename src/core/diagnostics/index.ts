import type { ClientTarget } from '../ir/index.ts';

export type Stage = 'ingest' | 'process' | 'plan' | 'emit';

export interface Diagnostic {
  readonly stage: Stage;
  readonly target: ClientTarget | null;
  readonly subject: string;
  readonly reason: string;
}

export interface BuildReport {
  readonly target: ClientTarget;
  readonly buildId: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly skipped: number;
  readonly passed: number;
}

export const makeDiagnostic = (
  stage: Stage,
  target: ClientTarget | null,
  subject: string,
  reason: string,
): Diagnostic => ({ stage, target, subject, reason });

export function buildReport(
  target: ClientTarget,
  diagnostics: readonly Diagnostic[],
  passed: number,
  skipped: number,
  buildId: string | null = null,
): BuildReport {
  return { target, buildId, diagnostics, passed, skipped };
}
