import type { Diagnostic } from '../core/index.ts';

/** 诊断文本可能含订阅密钥：URL userinfo、query 里的 token / password 一律脱敏。 */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
    .replace(/([?&](?:token|key|password|pwd|secret|auth|access_token)=)[^&\s#]+/gi, '$1***')
    .replace(/\b([a-f0-9]{32,})\b/gi, (match) => `${match.slice(0, 8)}…`);
}

/**
 * 脱敏值不能当作新配置写回库。redact() 有三种痕迹：userinfo / query 的 `***`，
 * 以及路径里 32 位 hex 被截成的 `abcdef01…`。早期防线只认 `***`，漏了省略号形态，
 * 旧缓存页面照样能把被截断的订阅链接写回去。
 */
export function hasRedactionMarkers(value: string): boolean {
  return value.includes('***') || value.includes('\u2026');
}

export const redactDiagnostic = (diagnostic: Diagnostic): Diagnostic => ({
  stage: diagnostic.stage,
  target: diagnostic.target,
  subject: redact(diagnostic.subject),
  reason: redact(diagnostic.reason),
});
