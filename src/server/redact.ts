import type { Diagnostic } from '../core/index.ts';

/** 诊断文本可能含订阅密钥：URL userinfo、query 里的 token / password 一律脱敏。 */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/([?&](?:token|key|password|pwd|secret|auth|access_token)=)[^&\s#]+/gi, '$1***')
    .replace(/\b([a-f0-9]{32,})\b/gi, (match) => `${match.slice(0, 8)}…`);
}

export const redactDiagnostic = (diagnostic: Diagnostic): Diagnostic => ({
  stage: diagnostic.stage,
  target: diagnostic.target,
  subject: redact(diagnostic.subject),
  reason: redact(diagnostic.reason),
});
