import type { RuleSetShape } from '../ir/index.ts';

/**
 * 判定一份外部规则集「装的是什么」，以及给它一个稳定的 provider 名。
 *
 * 为什么需要判定：mihomo 的 `rule-providers` 要求声明 `behavior`（domain / ipcidr / classical），
 * 而**写错的后果是整份配置拒绝加载**。这一栏不能靠文件名猜，只能看内容；
 * 内容也判不出来时返回 undefined，由调用方跳过并写诊断——宁可少一条规则集，不要一份起不来的配置。
 *
 * 顺带说明为什么这不是「解析规则」：这里只区分三种**文件形状**，
 * 不解释任何一条规则的语义，也不改写内容（规则语义仍归客户端）。
 */

const COMMENT = /^\s*(#|\/\/|;)/;
/** 裸 CIDR：`10.0.0.0/8`、`2001:db8::/32`。 */
const CIDR = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)\/\d{1,3}$/;
/** 裸域名：允许 `example.com`、`+.example.com`、`*.example.com`、`_service._tcp.example.com`。 */
const DOMAIN = /^(\*\.|\+\.)?[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)+$/;

/** 切行并丢掉空行与注释行——注释行不代表任何规则，不该影响形状判定。 */
const meaningfulLines = (body: string): readonly string[] =>
  body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !COMMENT.test(line));

export interface RuleSetDescription {
  readonly shape: RuleSetShape;
  readonly encoding: 'text' | 'yaml';
}

/** `payload:` 列表里的条目。不是这种包装时返回 undefined，交给纯文本判定。 */
function payloadItems(body: string): readonly string[] | undefined {
  if (!/^\s*payload\s*:/m.test(body)) return undefined;
  const items: string[] = [];
  let inPayload = false;
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*payload\s*:/.test(raw)) {
      inPayload = true;
      continue;
    }
    if (!inPayload) continue;
    if (/^\S/.test(raw)) break;
    const item = /^\s*-\s+(.+?)\s*$/.exec(raw);
    if (item === null) continue;
    let value = item[1] ?? '';
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) items.push(value);
  }
  return items;
}

function classifyLines(lines: readonly string[]): RuleSetShape | undefined {
  if (lines.length === 0) return undefined;
  if (lines.every((line) => CIDR.test(line))) return 'ipcidr';
  if (lines.every((line) => DOMAIN.test(line))) return 'domain';
  if (lines.every((line) => line.includes(','))) return 'rules';
  return undefined;
}

/**
 * 形状和编码一起给出。`payload:` 包装必须标 yaml，否则 mihomo 会把 `payload:` 当成域名并拒载。
 * 判不出形状时返回 undefined，调用方跳过，不猜 behavior。
 */
export function describeRuleSet(body: string): RuleSetDescription | undefined {
  const payload = payloadItems(body);
  if (payload !== undefined) {
    const shape = classifyLines(payload);
    return shape === undefined ? undefined : { shape, encoding: 'yaml' };
  }
  const shape = inferRuleSetShape(body);
  return shape === undefined ? undefined : { shape, encoding: 'text' };
}

export function inferRuleSetShape(body: string): RuleSetShape | undefined {
  // Clash 的 YAML 包装（`payload:` + `- xxx`）无法用 `format: text` 表达：
  // 原样喂给 text 解析器会把它当成域名 `payload:`。这种直接判定「说不清」。
  if (/^\s*payload\s*:/m.test(body)) return undefined;
  // 二进制格式（mihomo .mrs / sing-box .srs）压根不是文本，别硬判。
  if (body.includes('\u0000') || body.includes('\uFFFD')) return undefined;

  const lines = meaningfulLines(body);
  if (lines.length === 0) return undefined;

  if (lines.every((line) => CIDR.test(line))) return 'ipcidr';
  if (lines.every((line) => DOMAIN.test(line))) return 'domain';
  // 含逗号的一律按「整条规则」处理：`IP-CIDR,10.0.0.0/8,no-resolve`、`DOMAIN,x,y` 都属于这一类。
  if (lines.every((line) => line.includes(','))) return 'rules';
  // 混合形态（一半域名一半 CIDR）无法用单一 behavior 表达。
  return undefined;
}

/** FNV-1a 32 位。只用于生成名字，不需要密码学强度，换来 core 不依赖 node:crypto。 */
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * 规则集的 provider 名：`rs_<8 位哈希>`。
 * 取哈希而不是文件名，是因为同名不同源的规则集（`ads.list` 有两个来源）必须能区分，
 * 而名称一旦撞车，`RULE-SET,<name>,<policy>` 会静默指向错误的规则集。
 */
export const ruleProviderName = (url: string): string => `rs_${fnv1a(url)}`;
