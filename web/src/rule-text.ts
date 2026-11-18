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
  HOST: 'domain',
  'DOMAIN-SUFFIX': 'domainSuffix',
  'HOST-SUFFIX': 'domainSuffix',
  'DOMAIN-KEYWORD': 'domainKeyword',
  'HOST-KEYWORD': 'domainKeyword',
  GEOSITE: 'geosite',
  GEOIP: 'geoip',
  'IP-CIDR': 'ipCidr',
  'IP-CIDR6': 'ipCidr6',
  'IP6-CIDR': 'ipCidr6',
};

const NO_RESOLVE_TYPES = new Set(['ipCidr', 'ipCidr6', 'geoip']);

const SUBCONVERTER_PREFIXES: readonly {
  readonly prefix: string;
  readonly shape: ExternalRuleView['shape'];
}[] = [
  { prefix: 'clash-domain:', shape: 'domain' },
  { prefix: 'clash-ipcidr:', shape: 'ipcidr' },
  { prefix: 'clash-classic:', shape: 'rules' },
  { prefix: 'surge:', shape: 'rules' },
  { prefix: 'quanx:', shape: 'rules' },
];

function formatCondition(condition: RuleConditionView, nested = false): string {
  const noResolve = nested && NO_RESOLVE_TYPES.has(condition.type) && condition.noResolve === true ? ',no-resolve' : '';
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
      return `GEOIP,${condition.value ?? ''}${noResolve}`;
    case 'ipCidr':
      return `IP-CIDR,${condition.value ?? ''}${noResolve}`;
    case 'ipCidr6':
      return `IP-CIDR6,${condition.value ?? ''}${noResolve}`;
    case 'match':
      return 'MATCH';
    case 'and':
    case 'or': {
      const children = (condition.children ?? []).map((child) => `(${formatCondition(child, true)})`).join(',');
      return `${condition.type.toUpperCase()},(${children})`;
    }
    case 'not':
      return `NOT,((${condition.child !== undefined ? formatCondition(condition.child, true) : ''}))`;
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
  return `${formatCondition(rule.condition, false)},${rule.policy}${noResolve ? ',no-resolve' : ''}`;
}

export function formatRuleText(rules: readonly RuleView[]): string {
  return rules.map(formatRuleLine).join('\n');
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 仅剥离引号与括号外的行尾注释（`#`、`;`、`//`），避免误伤 `https://` 或引号内字面量。 */
function stripTrailingComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if ((ch === '#' || ch === ';') && i > 0 && /\s/.test(line[i - 1]!)) {
      return line.slice(0, i).trim();
    }
    if (
      ch === '/' &&
      line[i + 1] === '/' &&
      line[i - 1] !== ':' &&
      (i === 0 || /[\s,'"]/.test(line[i - 1]!))
    ) {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

function normalizeRuleLine(original: string): string {
  let line = original.trim();
  if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) return '';
  if (line.startsWith('- ') || line.startsWith('-\t')) {
    line = line.slice(1).trim();
  } else if (line === '-') {
    return '';
  }
  if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) return '';
  line = stripTrailingComment(line);
  if (line.endsWith(',')) {
    line = line.slice(0, -1).trim();
  }
  return stripOuterQuotes(line);
}

/** 按顶层逗号切分，尊重引号与成对括号（支持 AND/OR/NOT 嵌套）。 */
function splitTopLevelCsv(text: string): { parts: string[]; error?: string } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return { parts: [], error: '括号不匹配（多余右括号）' };
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(stripOuterQuotes(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) return { parts: [], error: '引号未闭合' };
  if (depth !== 0) return { parts: [], error: '括号未闭合' };
  parts.push(stripOuterQuotes(current));
  return { parts };
}

/** 仅当首尾这一对括号包裹住整段文本时剥除（不会破坏 `(a),(b)`）。 */
function unwrapOuterParens(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote !== null) {
      if (ch === quote && trimmed[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && i < trimmed.length - 1) return null;
    }
  }
  return depth === 0 ? trimmed.slice(1, -1).trim() : null;
}

function parseConditionExpr(
  expr: string,
): { condition: RuleConditionView } | { error: string } {
  const split = splitTopLevelCsv(expr);
  if (split.error !== undefined) return { error: split.error };
  const parts = split.parts;
  const head = (parts[0] ?? '').toUpperCase();

  if (head === 'AND' || head === 'OR' || head === 'NOT') {
    const rawGroup = parts[1] ?? '';
    const inner = unwrapOuterParens(rawGroup);
    if (inner === null || inner === '' || parts.length !== 2) {
      return { error: `${head} 条件语法错误，需要 ${head},((...))` };
    }
    const itemsSplit = splitTopLevelCsv(inner);
    if (itemsSplit.error !== undefined) return { error: itemsSplit.error };

    // 支持 `NOT,((DOMAIN,x))` 与 `NOT,(DOMAIN,x)` 两种写法
    if (head === 'NOT' && !inner.startsWith('(')) {
      const parsedChild = parseConditionExpr(inner);
      if ('error' in parsedChild) return parsedChild;
      return { condition: { type: 'not', child: parsedChild.condition } };
    }

    const children: RuleConditionView[] = [];
    for (const rawChild of itemsSplit.parts) {
      const unwrapped = unwrapOuterParens(rawChild);
      if (unwrapped === null || unwrapped === '') {
        return { error: `${head} 子条件需要用括号包裹` };
      }
      const parsedChild = parseConditionExpr(unwrapped);
      if ('error' in parsedChild) return parsedChild;
      children.push(parsedChild.condition);
    }
    if (head === 'NOT') {
      if (children.length !== 1 || children[0] === undefined) {
        return { error: 'NOT 条件只能包含 1 个子条件' };
      }
      return { condition: { type: 'not', child: children[0] } };
    }
    if (children.length === 0) {
      return { error: `${head} 至少需要 1 个子条件` };
    }
    return {
      condition: {
        type: head.toLowerCase(),
        children,
      },
    };
  }

  const mappedType = SIMPLE_RULE_TYPES[head];
  if (mappedType === undefined) {
    return { error: `不支持的子条件类型「${parts[0] ?? head}」` };
  }
  const value = parts[1] ?? '';
  if (value === '') {
    return { error: `${head} 缺少匹配值` };
  }
  const noResolve =
    NO_RESOLVE_TYPES.has(mappedType) &&
    parts.slice(2).some((extra) => extra.toLowerCase() === 'no-resolve');
  return {
    condition: {
      type: mappedType,
      value,
      ...(noResolve ? { noResolve: true } : {}),
    },
  };
}

function stripSubconverterPrefix(rawTarget: string): {
  url: string;
  inferredShape?: ExternalRuleView['shape'];
} {
  const lower = rawTarget.toLowerCase();
  for (const item of SUBCONVERTER_PREFIXES) {
    if (lower.startsWith(item.prefix)) {
      return {
        url: rawTarget.slice(item.prefix.length).trim(),
        inferredShape: item.shape,
      };
    }
  }
  return { url: rawTarget };
}

export function parseRuleText(text: string): RuleTextParseResult {
  const rules: RuleView[] = [];
  const skipped: ParsedRuleSkip[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const normalized = normalizeRuleLine(rawLine);
    if (normalized === '') continue;

    const split = splitTopLevelCsv(normalized);
    if (split.error !== undefined) {
      skipped.push({ line: i + 1, text: rawLine.trim(), reason: split.error });
      continue;
    }
    const parts = split.parts;
    const head = (parts[0] ?? '').toUpperCase();

    if (head === 'MATCH' || head === 'FINAL') {
      const policy = parts[1] ?? '';
      if (policy === '') {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: `${head} 缺少策略名` });
        continue;
      }
      rules.push({ kind: 'final', policy });
      continue;
    }

    if (head === 'RULE-SET') {
      const rawTarget = parts[1] ?? '';
      const policy = parts[2] ?? '';
      if (rawTarget === '' || policy === '') {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: 'RULE-SET 缺少地址或策略名' });
        continue;
      }
      const { url: target, inferredShape } = stripSubconverterPrefix(rawTarget);
      if (!/^https?:\/\//i.test(target)) {
        skipped.push({
          line: i + 1,
          text: rawLine.trim(),
          reason: 'RULE-SET 需要直接写 http(s) 规则集地址；仅写名称引用时暂无法独立解析',
        });
        continue;
      }
      let shape: ExternalRuleView['shape'] = inferredShape ?? 'domain';
      let format: ExternalRuleView['format'] = 'text';
      for (const extra of parts.slice(3)) {
        const lower = extra.toLowerCase();
        if (lower === 'domain' || lower === 'ipcidr' || lower === 'rules') shape = lower;
        else if (lower === 'text' || lower === 'yaml') format = lower;
      }
      rules.push({ kind: 'external', url: target, policy, shape, format });
      continue;
    }

    if (head === 'AND' || head === 'OR' || head === 'NOT') {
      const rawExpr = parts.slice(0, 2).join(',');
      const policy = parts[2] ?? '';
      if (parts.length < 3 || policy === '') {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: `${head} 缺少条件或策略名` });
        continue;
      }
      const parsedCond = parseConditionExpr(rawExpr);
      if ('error' in parsedCond) {
        skipped.push({ line: i + 1, text: rawLine.trim(), reason: parsedCond.error });
        continue;
      }
      rules.push({ kind: 'inline', condition: parsedCond.condition, policy });
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
