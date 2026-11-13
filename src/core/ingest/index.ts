import type { Profile } from '../ir/index.ts';
import { parseProfile } from '../ir/validate.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';
import {
  parseClashYaml,
  parseSingBoxJson,
  parseStartrailsJson,
  parseSubscriptionUris,
  parseSurgeIni,
} from './parsers.ts';
import type { ParseOutcome } from './parsers.ts';

export type SourceFormat =
  | 'startrails-json'
  | 'sing-box-json'
  | 'subscription-uri'
  | 'clash-yaml'
  | 'surge-ini';

export const SOURCE_FORMATS: readonly SourceFormat[] = [
  'startrails-json',
  'sing-box-json',
  'subscription-uri',
  'clash-yaml',
  'surge-ini',
];

export interface IngestResult extends ParseOutcome {
  readonly profile: Profile;
  readonly format: SourceFormat | 'unknown';
}

export type Parser = (raw: string) => IngestResult;

export function detectFormat(raw: string): SourceFormat | 'unknown' {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const doc: unknown = JSON.parse(trimmed) as unknown;
      if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
        const record = doc as Record<string, unknown>;
        if (Array.isArray(record['nodes'])) return 'startrails-json';
        if (Array.isArray(record['outbounds'])) return 'sing-box-json';
        // JSON 是 YAML 的子集，Clash 也接受 JSON 配置：只认 `{` 开头会把它判成未知。
        if (Array.isArray(record['proxies']) || Array.isArray(record['proxy-groups'])) return 'clash-yaml';
      }
    } catch {
      return 'unknown';
    }
    return 'unknown';
  }
  if (/^[a-z0-9+.-]+:\/\//i.test(trimmed)) return 'subscription-uri';
  if (/^\[[^\]]+\]/m.test(trimmed)) return 'surge-ini';
  if (/^proxies\s*:/m.test(trimmed) || /^proxy-groups\s*:/m.test(trimmed)) return 'clash-yaml';
  // 整段 base64 订阅没有 URI 前缀，交给 URI parser 自己解码。
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 16) return 'subscription-uri';
  return 'unknown';
}

const emptyProfile = (): Profile =>
  parseProfile({ nodes: [], ruleSources: [], policyGroups: [] });

function parseByFormat(raw: string, format: SourceFormat | 'unknown'): ParseOutcome {
  switch (format) {
    case 'startrails-json':
      return parseStartrailsJson(raw);
    case 'sing-box-json':
      return parseSingBoxJson(raw);
    case 'subscription-uri':
      return parseSubscriptionUris(raw);
    case 'clash-yaml':
      return parseClashYaml(raw);
    case 'surge-ini':
      return parseSurgeIni(raw);
    case 'unknown':
      return {
        ...parseStartrailsJson('{"nodes":[],"ruleSources":[],"policyGroups":[]}'),
        diagnostics: [makeDiagnostic('ingest', null, 'input', 'unknown-source-format')],
        skipped: 1,
      };
  }
}

export function ingest(raw: string, forcedFormat?: SourceFormat): IngestResult {
  const format = forcedFormat ?? detectFormat(raw);
  let outcome: ParseOutcome;
  try {
    outcome = parseByFormat(raw, format);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    outcome = {
      ...parseStartrailsJson('{"nodes":[],"ruleSources":[],"policyGroups":[]}'),
      diagnostics: [makeDiagnostic('ingest', null, 'input', `parse-failed:${reason}`)],
      skipped: 1,
    };
  }

  let profile: Profile;
  let diagnostics: readonly Diagnostic[] = outcome.diagnostics;
  try {
    profile = parseProfile({
      nodes: outcome.nodes,
      ruleSources: outcome.ruleSources,
      policyGroups: outcome.policyGroups,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    profile = emptyProfile();
    diagnostics = [
      ...outcome.diagnostics,
      makeDiagnostic('ingest', null, 'profile', `schema-validation-failed:${reason.slice(0, 160)}`),
    ];
  }

  return { ...outcome, profile, diagnostics, format };
}

/** M0 兼容入口：读取 Startrails 内部 IR JSON。 */
export const parseProfileJson: Parser = (raw) => ingest(raw, 'startrails-json');
