import type { ExternalRuleView, RuleConditionView, RuleView } from './api.ts';

export interface ParsedRuleSkip {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface RuleTextParseResult {
  readonly rules: RuleView[];
  readonly skipped: ParsedRuleSkip[];
}

const SIMPLE_RULE_TYPES: Readonly<Record<string, string>> = {
  DOMAIN: 'domain',
  'DOMAIN-SUFFIX': 'domainSuffix',
  'DOMAIN-KEYWORD': 'domainKeyword',
  GEOSITE: 'geosite',
  GEOIP: 'geoip',
  'IP-CIDR': 'ipCidr',
  'IP-CIDR6': 'ipCidr6',
};

const NO_RESOLVE_TYPES = new Set(['ipCidr', 'ipCidr6', 'geoip']);

function formatCondition(condition: RuleConditionView): string {
  switch (condition.type) {
    case 'domain':
      return `DOMAIN,${condition.value ?? ''}`;
    case 'domainSuffix':
      return `DOMAIN-SUFFIX,${condition.value ?? ''}`;
    case 'domainKeyword':
      return `DOMAIN-KEYWORD,${condition.value ?? ''}`;
    case 'geosite':
      return `GEOSITE,${condition.value ?? ''}`;
    case 'geoip':
      return `GEOIP,${condition.value ?? ''}`;
    case 'ipCidr':
      return `IP-CIDR,${condition.value ?? ''}`;
    case 'ipCidr6':
      return `IP-CIDR6,${condition.value ?? ''}`;
    case 'match':
      return 'MATCH';
    case 'and':
    case 'or': {
      const children = (condition.children ?? []).map((child) => `(${formatCondition(child)})`).join(',');
      return `${condition.type.toUpperCase()},(${children})`;
    }
    case 'not':
      return `NOT,((${condition.child !== undefined ? formatCondition(condition.child) : ''}))`;
    default:
      return condition.value !== undefined ? `${condition.type},${condition.value}` : condition.type;
  }
}

export function formatRuleLine(rule: RuleView): string {
  if (rule.kind === 'final') {
    return `MATCH,${rule.policy}`;
  }
  if (rule.kind === 'external') {
    const parts = ['RULE-SET', rule.url, rule.policy];
    if (rule.shape !== undefined) parts.push(rule.shape);
    if (rule.format !== undefined) parts.push(rule.format);
    return parts.join(',');
  }
  if (rule.condition.type === 'match') {
    return `MATCH,${rule.policy}`;
  }
  const noResolve = NO_RESOLVE_TYPES.has(rule.condition.type) && rule.condition.noResolve === true;
  return `${formatCondition(rule.condition)},${rule.policy}${noResolve ? ',no-resolve' : ''}`;
}

export function formatRuleText(rules: readonly RuleView[]): string {
  return rules.map(formatRuleLine).join('\n');
}

function normalizeRuleLine(original: string): string {
  let line = original.trim();
  if (line === '' || line.startsWith('#') || line.startsWith('//')) return '';
  if (line.startsWith('- ') || line.startsWith('-\t')) {
    line = line.slice(1).trim();
  } else if (line === '-') {
    return '';
  }
  if (line === '' || line.startsWith('#') || line.startsWith('//')) return '';
  // 剥离行尾注释（空白后的 # 或不跟在冒号后的 //），避免误伤 https:// 中的 //
  line = line.replace(/\s+#.*$/, '').replace(/(?:(?<=\s)|(?<=[,'"]))(?<!:)\/\/.*$/, '').trim();
  if (line.endsWith(',')) {
    line = line.slice(0, -1).trim();
  }
  if (
    line.length >= 2 &&
    ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'")))
  ) {
    line = line.slice(1, -1).trim();
  }
  return line;
}

export function parseRuleText(text: string): RuleTextParseResult {
  const rules: RuleView[] = [];
  const skipped: ParsedRuleSkip[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const normalized = normalizeRuleLine(rawLine);
    if (normalized === '') continue;

    const parts = normalized.split(',').map((part) => part.trim());
    const head = (parts[0] ?? '').toUpperCase();

    if (head === 'MATCH') {
      const policy = parts[1] ?? '';
      if (policy === '') {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: 'MATCH 缺少策略名' });
        continue;
      }
      rules.push({ kind: 'final', policy });
      continue;
    }

    if (head === 'RULE-SET') {
      const target = parts[1] ?? '';
      const policy = parts[2] ?? '';
      if (target === '' || policy === '') {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: 'RULE-SET 缺少地址或策略名' });
        continue;
      }
      if (!/^https?:\/\//i.test(target)) {
        skipped.push({
          line: i + 1,
          text: rawLine.trim(),
          reason: 'RULE-SET 需要直接写 http(s) 规则集地址；仅写名称引用时暂无法独立解析',
        });
        continue;
      }
      let shape: ExternalRuleView['shape'] = 'domain';
      let format: ExternalRuleView['format'] = 'text';
      for (const extra of parts.slice(3)) {
        const lower = extra.toLowerCase();
        if (lower === 'domain' || lower === 'ipcidr' || lower === 'rules') shape = lower;
        else if (lower === 'text' || lower === 'yaml') format = lower;
      }
      rules.push({ kind: 'external', url: target, policy, shape, format });
      continue;
    }

    const mappedType = SIMPLE_RULE_TYPES[head];
    if (mappedType === undefined) {
      skipped.push({
        line: i + 1,
        text: rawLine.trim(),
        reason: `暂不支持的规则类型「${parts[0] ?? head}」`,
      });
      continue;
    }

    const value = parts[1] ?? '';
    const policy = parts[2] ?? '';
    if (value === '' || policy === '') {
      skipped.push({ line: i + 1, text: rawLine.trim(), reason: '缺少匹配值或策略名' });
      continue;
    }

    const noResolve =
      NO_RESOLVE_TYPES.has(mappedType) &&
      parts.slice(3).some((extra) => extra.toLowerCase() === 'no-resolve');

    rules.push({
      kind: 'inline',
      condition: {
        type: mappedType,
        value,
        ...(noResolve ? { noResolve: true } : {}),
      },
      policy,
    });
  }

  return { rules, skipped };
}
