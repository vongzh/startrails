import type { NodeOptions, ProxyNode } from '../ir/index.ts';
import { nodeKey } from '../ir/index.ts';
import type { Diagnostic } from '../diagnostics/index.ts';
import { makeDiagnostic } from '../diagnostics/index.ts';

/**
 * 组合订阅 = 「多个数据源 + 每条源的加工规则 + 合并去重」，是一个可被多个 Profile 复用的单元。
 * 加工规则全部是声明式的：不执行用户脚本，因此没有沙箱逃逸面。
 */
/**
 * 单个加工算子。数组顺序即语义，同一算子可重复——这是与「固定五个字段」的本质区别：
 * 「先去重再改名」和「先改名再去重」结果不同，两者都必须能表达。
 *
 * 明确不做脚本类算子（Script / Response Transformer）：自建场景下等于把进程交给订阅作者。
 * 也不做「解析域名并改写 server」：那会把静态产物变成会过期的快照。
 */
export type Process =
  /** 按名字正则 / 地区 / 协议类型 / 有效性筛选。`keep:false` 表示命中即丢弃。 */
  | {
      readonly type: 'filter';
      readonly by: 'regex' | 'region' | 'type' | 'useless';
      readonly keep: boolean;
      /** regex 用模式串；region / type 用代码列表；useless 忽略此字段。 */
      readonly value?: readonly string[];
    }
  | { readonly type: 'rename'; readonly template: string }
  | { readonly type: 'prefix'; readonly value: string }
  | { readonly type: 'sort'; readonly by: 'name' | 'region' | 'kind'; readonly order: 'asc' | 'desc' }
  | { readonly type: 'dedupe'; readonly strategy: DedupeStrategy }
  | { readonly type: 'limit'; readonly count: number }
  /**
   * 批量改写节点属性（声明式属性覆写算子）。
   * 只接受 IR 里真实存在、且 emitter 会写出的字段，避免设置一个没人消费的死属性。
   * `key` 取值：`udp`（布尔）、`skip-cert-verify`（布尔 → options.insecure）、`alpn`（逗号分隔字符串）。
   */
  | { readonly type: 'set-property'; readonly key: 'udp' | 'skip-cert-verify' | 'alpn'; readonly value: boolean | string }
  /** 加 / 删节点名后缀标记；`value` 为空则删除该标记。 */
  | { readonly type: 'flag'; readonly value: string };

export interface MemberFilter {
  readonly enabled?: boolean;
  /** 可编排的加工链；存在时**忽略**下面的旧字段（由 compileLegacyFilter 负责换算）。 */
  readonly process?: readonly Process[];
  /** 节点名前缀，用于在合并后区分来源，例如 `HK-`。 */
  readonly prefix?: string;
  /** 命中任一即保留；为空表示不按此维度筛选。 */
  readonly include?: readonly string[];
  /** 命中任一即丢弃，优先级高于 include。 */
  readonly exclude?: readonly string[];
  /** 单源最多保留的节点数，按源内原始顺序截断。 */
  readonly limit?: number;
  /**
   * 改名模板，占位符：`{name}` 原名、`{index}` 保留后的序号（从 1 起）、`{source}` 源 id、`{prefix}` 前缀。
   * 声明式模板替代逐条别名；未知占位符原样保留，避免静默吞掉用户输入的 `{`。
   */
  readonly rename?: string;
}

export interface CollectionMember {
  readonly sourceId: string;
  readonly filter?: MemberFilter;
}

export type DedupeStrategy = 'nodeKey' | 'name' | 'none';

export interface CollectionSpec {
  readonly id: string;
  readonly name: string;
  readonly members: readonly CollectionMember[];
  readonly dedupe?: DedupeStrategy;
}

const RE_LITERAL = /^\/(.+)\/([gimsuy]*)$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 匹配语法三档，按用户实际写法自动判定：
 * - `/re/flags` 正则；
 * - 含 `*` / `?` 的 glob（整名锚定）；
 * - 其余为子串（大小写不敏感）。
 * 编译失败返回 null，由调用方记诊断而不是抛错——一条坏规则不该让整份订阅构建失败。
 */
export function compileMatcher(pattern: string): RegExp | null {
  const text = pattern.trim();
  if (text.length === 0) return null;
  const literal = RE_LITERAL.exec(text);
  if (literal !== null) {
    const body = literal[1] ?? '';
    const flags = (literal[2] ?? '').replace(/[gy]/g, '');
    try {
      return new RegExp(body, flags);
    } catch {
      return null;
    }
  }
  if (/[*?]/.test(text)) {
    const body = [...text]
      .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExp(char)))
      .join('');
    try {
      return new RegExp(`^${body}$`, 'i');
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(escapeRegExp(text), 'i');
  } catch {
    return null;
  }
}

export interface PatternCheck {
  readonly pattern: string;
  readonly valid: boolean;
  /** 命中的节点数，供 UI 在保存前展示「这条规则会筛掉多少」。 */
  readonly hits: number;
}

export function inspectPatterns(
  patterns: readonly string[],
  nodes: readonly ProxyNode[],
): readonly PatternCheck[] {
  return patterns.map((pattern) => {
    const matcher = compileMatcher(pattern);
    if (matcher === null) return { pattern, valid: false, hits: 0 };
    return { pattern, valid: true, hits: nodes.filter((node) => matcher.test(node.name)).length };
  });
}

/**
 * 地区识别：只看名字关键词，**不做 GeoIP**。
 * 理由：IP 库需要定期下载且会过期，把「地区」变成会漂移的运行时依赖不值得；
 * 而真实机场的节点名几乎都带地名或 IATA/国家码。识别不出来就返回 undefined，不猜。
 *
 * 口径：涉台一律「中国台湾」，代码用 TW，仅在 UI 上作为筛选标签使用。
 */
const REGION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  HK: ['香港', '港', 'HK', 'HKG', 'HongKong'],
  TW: ['中国台湾', '台湾', '台灣', 'TW', 'TWN', 'Taiwan'],
  JP: ['日本', '东京', '大阪', 'JP', 'JPN', 'Japan'],
  SG: ['新加坡', '狮城', 'SG', 'SGP', 'Singapore'],
  US: ['美国', '洛杉矶', '圣何塞', '西雅图', 'US', 'USA', 'UnitedStates', 'America'],
  UK: ['英国', '伦敦', 'UK', 'GB', 'GBR', 'London'],
  DE: ['德国', '法兰克福', 'DE', 'DEU', 'Germany'],
  KR: ['韩国', '首尔', 'KR', 'KOR', 'Korea'],
  CN: ['中国', '回国', '上海', '北京', '广州', '深圳', 'CN', 'CHN', 'China'],
};

export const REGION_CODES = Object.keys(REGION_KEYWORDS);

/** 关键词按长度降序预排：「香港」要先于「港」命中，否则永远只能得到「港」。 */
const REGION_MATCHERS: readonly { readonly code: string; readonly matcher: RegExp }[] = Object.entries(
  REGION_KEYWORDS,
)
  .flatMap(([code, keywords]) =>
    keywords.map((keyword) => ({
      code,
      // 纯 ASCII 的关键词加词边界，避免「Australia」里的 us 被判成美国。
      matcher: /^[A-Za-z]+$/.test(keyword)
        ? new RegExp(`\\b${keyword}\\b`, 'i')
        : new RegExp(keyword),
      weight: keyword.length,
    })),
  )
  .sort((left, right) => right.weight - left.weight);

export function regionOf(name: string): string | undefined {
  for (const item of REGION_MATCHERS) {
    if (item.matcher.test(name)) return item.code;
  }
  return undefined;
}

/** 节点的有效地区：手动覆盖（Annotation.region）优先，否则回退名字关键词。 */
export function regionOfNode(node: ProxyNode): string | undefined {
  if (node.region !== undefined && node.region !== '') return node.region;
  return regionOf(node.name);
}

/**
 * 机场信息节点识别。这类「节点」不是代理，而是广告位与账单：
 * 用户在客户端点上去连不通，然后会归咎于「配置是坏的」。
 *
 * 两类判定：
 * - 名字命中账单/广告词；
 * - 凭据或地址含非 ASCII（必然握手失败，没有一个协议能接受）。
 */
const USELESS_NAME = /网址|流量|时间|应急|过期|剩余|套餐|到期|重置|官网|客服|群组|订阅|Bandwidth|expire|traffic|remain|reset|official|website/i;

const hasNonAscii = (value: string): boolean => /[^\x00-\x7f]/.test(value);

export function isUselessNode(node: ProxyNode): boolean {
  if (USELESS_NAME.test(node.name)) return true;
  const credential =
    node.kind === 'tuic' ? `${node.uuid}${node.password}` : ('password' in node ? node.password : '');
  const fields = [
    node.server,
    credential,
    node.kind === 'shadowsocks' ? node.method : '',
    node.kind === 'wireguard' ? node.privateKey : '',
  ];
  return fields.some((field) => typeof field === 'string' && field.length > 0 && hasNonAscii(field));
}

const testAny = (name: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => {
    const matcher = compileMatcher(pattern);
    return matcher !== null && matcher.test(name);
  });

const uniqueDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
  const seen = new Set<string>();
  const kept: Diagnostic[] = [];
  for (const item of diagnostics) {
    const key = `${item.stage}|${item.subject}|${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
};

export interface MemberOutcome {
  readonly nodes: readonly ProxyNode[];
  readonly diagnostics: readonly Diagnostic[];
}

/** 模板渲染：只替换已知占位符，其余字符（含未知占位符）原样保留。 */
export function renderNameTemplate(
  template: string,
  values: { readonly name: string; readonly index: number; readonly sourceId: string; readonly prefix: string },
): string {
  return template
    .replaceAll('{name}', values.name)
    .replaceAll('{index}', String(values.index))
    .replaceAll('{source}', values.sourceId)
    .replaceAll('{prefix}', values.prefix);
}

/**
 * 旧字段 → 等价算子链。顺序与旧实现严格一致（exclude → include → rename → prefix → limit），
 * 因此老配置升级后行为不变，不需要迁移脚本：读库时换算即可。
 */
export function compileLegacyFilter(filter: MemberFilter): readonly Process[] {
  const process: Process[] = [];
  const exclude = filter.exclude ?? [];
  const include = filter.include ?? [];
  if (exclude.length > 0) process.push({ type: 'filter', by: 'regex', keep: false, value: exclude });
  if (include.length > 0) process.push({ type: 'filter', by: 'regex', keep: true, value: include });
  const template = filter.rename?.trim() ?? '';
  if (template.length > 0) process.push({ type: 'rename', template });
  const rawPrefix = filter.prefix ?? '';
  if (rawPrefix.trim().length > 0) process.push({ type: 'prefix', value: rawPrefix });
  if (typeof filter.limit === 'number' && filter.limit > 0) {
    process.push({ type: 'limit', count: filter.limit });
  }
  return process;
}

/** 生效的加工链：`process` 优先，没有就编译旧字段。 */
export const processesOf = (filter: MemberFilter | undefined): readonly Process[] => {
  if (filter === undefined) return [];
  if (filter.process !== undefined && filter.process.length > 0) return filter.process;
  return compileLegacyFilter(filter);
};

const sortValue = (node: ProxyNode, by: 'name' | 'region' | 'kind'): string =>
  by === 'name' ? node.name : by === 'kind' ? node.kind : (regionOfNode(node) ?? '\uffff');

/**
 * 单源加工：跑算子链。链可以任意长、任意顺序，这是它与旧「固定五步」的本质差别。
 * 前缀保留用户输入里的空格（`🇭🇰 ` 这种国旗前缀的尾随空格是有意义的），只把纯空白视为空。
 * 模板里写了 `{prefix}` 就不再自动叠加一次，否则前缀会出现两遍。
 */
export function applyMemberFilter(
  nodes: readonly ProxyNode[],
  filter: MemberFilter | undefined,
  sourceId: string,
): MemberOutcome {
  if (filter === undefined) return { nodes, diagnostics: [] };
  if (filter.enabled === false) {
    return {
      nodes: [],
      diagnostics: [makeDiagnostic('process', null, sourceId, 'member-disabled')],
    };
  }

  const diagnostics: Diagnostic[] = [];
  let current: ProxyNode[] = [...nodes];
  const steps = processesOf(filter);
  /**
   * 前缀先扫出来，而不是等执行到那一步才知道：
   * 旧字段编译出来的链是「改名 → 前缀」，若在执行改名时 prefix 还是空串，模板里的 `{prefix}` 就永远渲染为空。
   * 顺序只决定「要不要自动叠加」，不决定「这个值存不存在」。
   */
  const prefixStep = steps.find((step) => step.type === 'prefix');
  let prefix =
    prefixStep !== undefined && prefixStep.type === 'prefix' && prefixStep.value.trim().length > 0
      ? prefixStep.value
      : '';
  let hasRenamedWithPrefix = false;
  /**
   * 机场信息节点（「剩余流量：12GB」这类）**默认剔除**：它们不是代理，点上去必然连不上，
   * 而用户只会归咎于「这个工具生成的配置有问题」。
   * 想保留就显式写一条 `{ type:'filter', by:'useless', keep:true }`——那条步骤本身不再过滤。
   */
  const uselessStep = steps.find((step) => step.type === 'filter' && step.by === 'useless');
  const keepUseless = uselessStep !== undefined && uselessStep.type === 'filter' && uselessStep.keep;
  if (!keepUseless) {
    const before = current.length;
    current = current.filter((node) => !isUselessNode(node));
    const dropped = before - current.length;
    if (dropped > 0) {
      diagnostics.push(makeDiagnostic('process', null, sourceId, `useless-dropped:${dropped}`));
    }
  }

  for (const step of steps) {
    switch (step.type) {
      case 'filter': {
        if (step.by === 'useless') {
          // keep:true 是「不要剔除」的开关（默认剔除已在循环外做过），其余情况按常规筛选语义处理。
          if (step.keep) break;
          const before = current.length;
          current = current.filter((node) => isUselessNode(node));
          if (before !== current.length) {
            diagnostics.push(
              makeDiagnostic('process', null, sourceId, `useless-only:${current.length}/${before}`),
            );
          }
          break;
        }
        if (step.by === 'region') {
          const wanted = new Set((step.value ?? []).map((code) => code.toUpperCase()));
          const before = current.length;
          current = current.filter((node) => {
            const code = regionOfNode(node);
            const hit = code !== undefined && wanted.has(code);
            return step.keep ? hit : !hit;
          });
          diagnostics.push(
            makeDiagnostic('process', null, sourceId, `region-filter:${current.length}/${before}`),
          );
          break;
        }
        if (step.by === 'type') {
          const wanted = new Set((step.value ?? []).map((kind) => kind.toLowerCase()));
          const before = current.length;
          current = current.filter((node) => {
            const hit = wanted.has(node.kind);
            return step.keep ? hit : !hit;
          });
          diagnostics.push(
            makeDiagnostic('process', null, sourceId, `type-filter:${current.length}/${before}`),
          );
          break;
        }
        const patterns = step.value ?? [];
        for (const pattern of patterns) {
          if (compileMatcher(pattern) === null) {
            diagnostics.push(
              makeDiagnostic('process', null, sourceId, `invalid-regex-pattern:${pattern.slice(0, 40)}`),
            );
          }
        }
        const before = current.length;
        current = current.filter((node) => {
          const hit = testAny(node.name, patterns);
          return step.keep ? hit : !hit;
        });
        if (before !== current.length) {
          diagnostics.push(
            makeDiagnostic('process', null, sourceId, `filtered-out:${before - current.length}`),
          );
        }
        break;
      }
      case 'rename': {
        const template = step.template.trim();
        if (template.length === 0) break;
        hasRenamedWithPrefix = template.includes('{prefix}');
        current = current.map(
          (node, index) =>
            ({
              ...node,
              name: renderNameTemplate(template, {
                name: node.name,
                index: index + 1,
                sourceId,
                prefix,
              }),
            }) as ProxyNode,
        );
        break;
      }
      case 'prefix': {
        if (step.value.trim().length === 0 || prefix.length === 0) break;
        // 改名模板已经引用过 {prefix} 时，前缀在位，不能再叠加一次（否则「🇭🇰 🇭🇰 X」）。
        if (hasRenamedWithPrefix) break;
        current = current.map((node) => ({ ...node, name: `${prefix}${node.name}` }) as ProxyNode);
        break;
      }
      case 'sort': {
        const direction = step.order === 'desc' ? -1 : 1;
        current = [...current].sort((left, right) => {
          const a = sortValue(left, step.by);
          const b = sortValue(right, step.by);
          return a.localeCompare(b, 'zh-Hans-CN') * direction;
        });
        break;
      }
      case 'dedupe': {
        const outcome = dedupeNodes(current, step.strategy);
        if (outcome.dropped > 0) {
          diagnostics.push(
            makeDiagnostic('process', null, sourceId, `member-duplicate-dropped:${outcome.dropped}`),
          );
        }
        current = [...outcome.nodes];
        break;
      }
      case 'limit': {
        if (step.count <= 0 || current.length <= step.count) break;
        diagnostics.push(makeDiagnostic('process', null, sourceId, `truncated-to:${step.count}`));
        current = current.slice(0, step.count);
        break;
      }
      case 'set-property': {
        current = current.map((node) => {
          const options = { ...(node.options ?? {}) };
          if (step.key === 'udp') {
            options.udp = step.value === true;
          } else if (step.key === 'skip-cert-verify') {
            options.insecure = step.value === true;
          } else {
            // alpn：value 为逗号分隔串；空串表示清除。
            const list =
              typeof step.value === 'string'
                ? step.value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
                : [];
            if (list.length === 0) delete options.alpn;
            else options.alpn = list;
          }
          return { ...node, options } as ProxyNode;
        });
        diagnostics.push(
          makeDiagnostic('process', null, sourceId, `set-property:${step.key}`),
        );
        break;
      }
      case 'flag': {
        const mark = step.value.trim();
        if (mark.length === 0) break;
        // 标记形如 `|机场A`，已存在则移除（toggle），否则追加。
        current = current.map((node) => {
          const has = node.name.includes(mark);
          return has
            ? ({ ...node, name: node.name.split(mark).join('').trim() } as ProxyNode)
            : ({ ...node, name: `${node.name} ${mark}` } as ProxyNode);
        });
        diagnostics.push(makeDiagnostic('process', null, sourceId, `flag-toggled:${mark}`));
        break;
      }
    }
  }

  return { nodes: current, diagnostics };
}

export interface DedupeOutcome {
  readonly nodes: readonly ProxyNode[];
  readonly dropped: number;
}

export function dedupeNodes(
  nodes: readonly ProxyNode[],
  strategy: DedupeStrategy = 'nodeKey',
): DedupeOutcome {
  if (strategy === 'none') return { nodes, dropped: 0 };
  const seen = new Set<string>();
  const kept: ProxyNode[] = [];
  for (const node of nodes) {
    const key = strategy === 'name' ? node.name : nodeKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(node);
  }
  return { nodes: kept, dropped: nodes.length - kept.length };
}

export interface ComposeOutcome {
  readonly nodes: readonly ProxyNode[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * 按 spec 顺序展开成员并合并。resolve 返回 undefined 表示源不存在或解析失败，
 * 只记诊断并跳过该成员——组合订阅要能带着局部失败继续产出。
 */
export function composeCollection(
  spec: CollectionSpec,
  resolve: (sourceId: string) => readonly ProxyNode[] | undefined,
): ComposeOutcome {
  const collected: ProxyNode[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const member of spec.members) {
    const nodes = resolve(member.sourceId);
    if (nodes === undefined) {
      diagnostics.push(makeDiagnostic('process', null, `${spec.name}/${member.sourceId}`, 'collection-member-missing'));
      continue;
    }
    const outcome = applyMemberFilter(nodes, member.filter, member.sourceId);
    collected.push(...outcome.nodes);
    diagnostics.push(...outcome.diagnostics);
  }

  const deduped = dedupeNodes(collected, spec.dedupe ?? 'nodeKey');
  if (deduped.dropped > 0) {
    diagnostics.push(makeDiagnostic('process', null, spec.name, `duplicate-dropped:${deduped.dropped}`));
  }

  return { nodes: deduped.nodes, diagnostics: uniqueDiagnostics(diagnostics) };
}
