/**
 * 产物语法着色。
 *
 * 为什么不用 highlight.js / Prism：这几类产物里最要紧的是 INI 系（Surge、Loon、
 * Quantumult X），而它是「位置语法」——一行的含义由逗号落在第几段决定。通用 tokenizer
 * 只会把整行涂成字符串，恰好抹平用户唯一在找的那三样（规则类型、匹配对象、目标策略）。
 *
 * 所以这里按行切结构，只输出四档语义：
 *   tk-c 注释 · tk-k 键与结构 · tk-n 名字（节点名、策略名）· tk-e 影响行为的标识（协议、规则类型、分节）
 *   默认色留给「值」，不再给它加料，否则一屏里每行都在抢注意力。
 * 不发散到通用配色，是为了守住「单强调色 + 中性灰」的观感。
 */

export type SegmentClass = 'c' | 'k' | 'e' | 'n';

export interface Segment {
  readonly text: string;
  readonly cls?: SegmentClass;
}

export interface Highlighted {
  /** 逐行 <div class="cv-line">，可直接 v-html。 */
  readonly html: string;
  readonly lines: number;
  /** true = 未着色（未知方言，或超出着色行数上限）。 */
  readonly plain: boolean;
}

/**
 * 超过这个行数就不再逐行着色。真实订阅 300 节点时产物 2000+ 行，
 * 每行再包 3–4 个 span 会到几万节点，滚动会掉帧；行号仍然保留。
 */
export const MAX_HIGHLIGHT_LINES = 2500;

const INI_DIALECTS: ReadonlySet<string> = new Set(['surge-ini', 'loon-ini', 'quanx-ini']);
const YAML_DIALECTS: ReadonlySet<string> = new Set(['clash-yaml', 'egern-yaml']);
const JSON_DIALECTS: ReadonlySet<string> = new Set(['sing-box-json']);
const URI_DIALECTS: ReadonlySet<string> = new Set(['uri-list']);

/** 出现在 `type:` 右侧时值得强调的协议与策略组类型。 */
const PROTOCOLS: ReadonlySet<string> = new Set([
  'ss', 'ssr', 'shadowsocks', 'shadowsocksr', 'vmess', 'vless', 'trojan', 'hysteria',
  'hysteria2', 'tuic', 'wireguard', 'snell', 'ssh', 'http', 'https', 'socks5', 'socks',
  'anytls', 'shadowtls', 'mieru', 'direct', 'reject', 'select', 'selector', 'url-test',
  'fallback', 'load-balance', 'relay', 'smart',
]);

const ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (ch) => ESCAPE[ch] ?? ch);

const renderSegments = (segments: readonly Segment[]): string =>
  segments
    .map((segment) =>
      segment.cls === undefined
        ? escapeHtml(segment.text)
        : `<span class="tk-${segment.cls}">${escapeHtml(segment.text)}</span>`,
    )
    .join('');

const leadingSpace = (line: string): string => /^\s*/.exec(line)?.[0] ?? '';

const unquote = (text: string): string => text.trim().replace(/^["']/, '').replace(/["']$/, '');

/* ---------- INI 系：Surge / Loon / Quantumult X ---------- */

/** 规则小节：首段是规则类型，末段是目标策略。 */
const INI_RULE_SECTION = /^\[(rule|rules|filter|filter_local|filter_remote|url rewrite|host|mitm|rewrite|map local|map remote|script)/i;

/** 这些小节里「等号左侧」是类型而不是名字（Quantumult X 的风格）。 */
const INI_TYPE_ON_LEFT = /^\[(server_local|server_remote|policy|policygroup|server)/i;

/** 这些小节里「等号右侧首段」是协议或策略组类型。 */
const INI_TYPE_ON_RIGHT = /^\[(proxy|proxy group|policygroup|rule)/i;

interface IniState {
  section: string;
}

const splitByComma = (segments: Segment[], text: string, first: SegmentClass | null, last: SegmentClass | null): void => {
  const parts = text.split(',');
  parts.forEach((part, index) => {
    if (index > 0) segments.push({ text: ',' });
    if (index === 0 && first !== null && part.trim() !== '') {
      segments.push({ text: part, cls: first });
      return;
    }
    if (index === parts.length - 1 && index > 0 && last !== null && part.trim() !== '') {
      segments.push({ text: part, cls: last });
      return;
    }
    segments.push({ text: part });
  });
};

const tokenizeIni = (line: string, state: IniState): Segment[] => {
  const indent = leadingSpace(line);
  const body = line.slice(indent.length);
  if (body === '') return [{ text: line }];

  const segments: Segment[] = [];
  if (indent !== '') segments.push({ text: indent });

  if (body.startsWith('#') || body.startsWith(';') || body.startsWith('//')) {
    segments.push({ text: body, cls: 'c' });
    return segments;
  }

  const sectionHead = /^\[[^\]]*\]/.exec(body);
  if (sectionHead !== null) {
    state.section = sectionHead[0].toLowerCase();
    segments.push({ text: body, cls: 'e' });
    return segments;
  }

  if (INI_RULE_SECTION.test(state.section)) {
    // 规则：TYPE, 匹配对象, 目标策略 —— 首段与末段才是用户扫的东西。
    splitByComma(segments, body, 'e', 'n');
    return segments;
  }

  const equalsAt = body.indexOf('=');
  if (equalsAt > 0) {
    const head = body.slice(0, equalsAt);
    const left = head.trimEnd();
    const tail = body.slice(equalsAt);
    const typeOnLeft = INI_TYPE_ON_LEFT.test(state.section);

    if (left !== '') segments.push({ text: left, cls: typeOnLeft ? 'e' : INI_TYPE_ON_RIGHT.test(state.section) ? 'n' : 'k' });
    segments.push({ text: head.slice(left.length) + '=' });

    const value = tail.slice(1);
    if (!typeOnLeft && INI_TYPE_ON_RIGHT.test(state.section) && value.includes(',')) {
      splitByComma(segments, value, 'e', null);
    } else {
      segments.push({ text: value });
    }
    return segments;
  }

  segments.push({ text: body });
  return segments;
};

/* ---------- YAML：mihomo / Stash / Egern ---------- */

const YAML_PAIR = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s:#][^:#]*?))(\s*:\s*)(.*)$/;

const tokenizeYaml = (line: string): Segment[] => {
  const indent = leadingSpace(line);
  let body = line.slice(indent.length);
  if (body === '') return [{ text: line }];

  const segments: Segment[] = [];
  if (indent !== '') segments.push({ text: indent });

  if (body.startsWith('#')) {
    segments.push({ text: body, cls: 'c' });
    return segments;
  }

  const dash = /^-\s+/.exec(body);
  if (dash !== null) {
    segments.push({ text: dash[0] });
    body = body.slice(dash[0].length);
  }

  const pair = YAML_PAIR.exec(body);
  if (pair === null) {
    segments.push({ text: body });
    return segments;
  }

  const key = pair[1] ?? '';
  const colon = pair[2] ?? ': ';
  const value = pair[3] ?? '';
  segments.push({ text: key, cls: 'k' });
  segments.push({ text: colon });
  if (key === 'type' && PROTOCOLS.has(unquote(value))) {
    segments.push({ text: value, cls: 'e' });
  } else if (key === 'name' && value.trim() !== '') {
    // 节点名是这一屏里唯一的「对象」，值得比键更重一档。
    segments.push({ text: value, cls: 'n' });
  } else {
    segments.push({ text: value });
  }
  return segments;
};

/* ---------- JSON：sing-box ---------- */

const JSON_PAIR = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/;

const tokenizeJson = (line: string): Segment[] => {
  const pair = JSON_PAIR.exec(line);
  if (pair === null) return [{ text: line }];

  const indent = pair[1] ?? '';
  const key = pair[2] ?? '';
  const colon = pair[3] ?? ': ';
  const value = pair[4] ?? '';
  const segments: Segment[] = [{ text: indent }, { text: key, cls: 'k' }, { text: colon }];

  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(value);
  const marksProtocol = key === '"type"' || key === '"protocol"';
  const marksName = key === '"tag"' || key === '"name"';
  if (marksProtocol && quoted !== null && PROTOCOLS.has(quoted[0].slice(1, -1))) {
    segments.push({ text: quoted[0], cls: 'e' });
    segments.push({ text: value.slice(quoted[0].length) });
  } else if (marksName && quoted !== null) {
    segments.push({ text: quoted[0], cls: 'n' });
    segments.push({ text: value.slice(quoted[0].length) });
  } else {
    segments.push({ text: value });
  }
  return segments;
};

/* ---------- 节点分享链接列表 ---------- */

const tokenizeUri = (line: string): Segment[] => {
  const indent = leadingSpace(line);
  const body = line.slice(indent.length);
  if (body === '') return [{ text: line }];

  const segments: Segment[] = [];
  if (indent !== '') segments.push({ text: indent });

  if (body.startsWith('#')) {
    segments.push({ text: body, cls: 'c' });
    return segments;
  }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(body);
  if (scheme === null) {
    segments.push({ text: body });
    return segments;
  }

  const protocol = scheme[1] ?? '';
  segments.push({ text: protocol, cls: 'e' });

  const rest = body.slice(protocol.length);
  const commentAt = rest.indexOf('#');
  if (commentAt < 0) {
    segments.push({ text: rest });
    return segments;
  }
  segments.push({ text: rest.slice(0, commentAt + 1) });
  segments.push({ text: rest.slice(commentAt + 1), cls: 'n' });
  return segments;
};

/* ---------- 入口 ---------- */

const tokenize = (line: string, dialect: string, state: IniState): Segment[] => {
  if (INI_DIALECTS.has(dialect)) return tokenizeIni(line, state);
  if (YAML_DIALECTS.has(dialect)) return tokenizeYaml(line);
  if (JSON_DIALECTS.has(dialect)) return tokenizeJson(line);
  if (URI_DIALECTS.has(dialect)) return tokenizeUri(line);
  return [{ text: line }];
};

const isKnownDialect = (dialect: string): boolean =>
  INI_DIALECTS.has(dialect) || YAML_DIALECTS.has(dialect) || JSON_DIALECTS.has(dialect) || URI_DIALECTS.has(dialect);

/** 去掉末尾换行产生的空行，让行号与「N 行」对得上。 */
const toRows = (text: string): string[] => {
  const rows = text.split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
};

export function highlight(text: string, dialect: string): Highlighted {
  const rows = toRows(text);
  const plain = !isKnownDialect(dialect) || rows.length > MAX_HIGHLIGHT_LINES;
  const state: IniState = { section: '' };
  const lines: string[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index] ?? '';
    const segments = plain ? [{ text: line }] : tokenize(line, dialect, state);
    lines.push(
      `<div class="cv-line"><span class="cv-n">${index + 1}</span><span class="cv-t">${renderSegments(segments)}</span></div>`,
    );
  }

  return { html: lines.join(''), lines: rows.length, plain };
}
