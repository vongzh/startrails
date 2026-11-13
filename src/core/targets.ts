/**
 * 客户端目标注册表（纯数据，零 IO）。
 *
 * 设计要点：Target 是「身份 + 能力差异」，Dialect 是「输出方言」。
 * 一个 Emitter 服务一个 Dialect，多个 Target 共享它；新增客户端只需加一行 TARGETS，
 * 不需要改 Plan / Emit 的控制流。这与 Tower 的 usesClashFormat / usesSingBoxFormat
 * 分族思路一致，但差异用表表达，不用 switch。
 *
 * 合规：字段映射依据只取客户端官方文档与公开格式规范（见 basis）；
 * Tower（MIT）只用于确定客户端清单与格式族线索，不复制其生成器代码；
 * Sub-Store（AGPL-3.0）的 producer 不作为实现依据。
 */

export const CLIENT_TARGETS = [
  // Surge INI
  'surge',
  'surge-mac',
  // Clash / mihomo YAML
  'mihomo',
  'clash',
  'clash-apple',
  'clash-verge',
  'clashmac',
  'flclash',
  'mihomo-party',
  'clash-mi',
  'karing',
  // sing-box JSON
  'sing-box',
  'hiddify',
  // 独立 INI 方言
  'loon',
  'quanx',
  // 独立 YAML 方言
  'egern',
  // 节点分享 URI 列表
  'shadowrocket',
  'v2box',
  'anywhere',
] as const;

export type ClientTarget = (typeof CLIENT_TARGETS)[number];

export const DIALECTS = [
  'surge-ini',
  'clash-yaml',
  'sing-box-json',
  'loon-ini',
  'quanx-ini',
  'egern-yaml',
  'uri-list',
] as const;

export type Dialect = (typeof DIALECTS)[number];

/** full = 含节点/策略组/规则的完整配置；nodes-only = 仅节点列表。 */
export type ContentMode = 'full' | 'nodes-only';

export interface TargetDescriptor {
  readonly id: ClientTarget;
  readonly name: string;
  readonly dialect: Dialect;
  readonly fileExtension: string;
  readonly contentMode: ContentMode;
  /** 字段映射的官方依据；继承方言时写明方言规范来源。 */
  readonly basis: string;
  /** 本客户端是否有独立官方文档页；false 表示只继承方言规范，专属字段未核实。 */
  readonly independentEvidence: boolean;
}

const CLASH_BASIS = 'https://wiki.metacubex.one/config/proxies/';
const SINGBOX_BASIS = 'https://sing-box.sagernet.org/configuration/outbound/';
const SURGE_BASIS = 'https://manual.nssurge.com/policies/overview.html';
const LOON_BASIS = 'https://nsloon.app/en/docs/Node/';
const QUANX_BASIS = 'https://github.com/crossutility/Quantumult-X/blob/master/sample.conf';
const EGERN_BASIS = 'https://egernapp.com/docs/configuration/proxies';
const URI_BASIS =
  'https://shadowsocks.org/doc/sip002.html, https://github.com/XTLS/Xray-core/discussions/716';

export const TARGETS: readonly TargetDescriptor[] = [
  { id: 'surge', name: 'Surge', dialect: 'surge-ini', fileExtension: 'conf', contentMode: 'full', basis: SURGE_BASIS, independentEvidence: true },
  { id: 'surge-mac', name: 'Surge Mac', dialect: 'surge-ini', fileExtension: 'conf', contentMode: 'full', basis: SURGE_BASIS, independentEvidence: true },
  { id: 'mihomo', name: 'mihomo / Clash', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: CLASH_BASIS, independentEvidence: true },
  { id: 'clash', name: 'Stash', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: 'https://stash.wiki/en/proxy-protocols/proxy-types', independentEvidence: true },
  { id: 'clash-apple', name: 'Clash', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: 'https://clash.md/guide/config/', independentEvidence: true },
  { id: 'clash-verge', name: 'Clash Verge', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: CLASH_BASIS, independentEvidence: false },
  { id: 'clashmac', name: 'ClashMac', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: CLASH_BASIS, independentEvidence: false },
  { id: 'flclash', name: 'FlClash', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: CLASH_BASIS, independentEvidence: false },
  { id: 'mihomo-party', name: 'Clash Party', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: CLASH_BASIS, independentEvidence: false },
  { id: 'clash-mi', name: 'Clash Mi', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: 'https://clashmi.app/guide/', independentEvidence: false },
  { id: 'karing', name: 'Karing', dialect: 'clash-yaml', fileExtension: 'yaml', contentMode: 'full', basis: 'https://karing.app/clash', independentEvidence: false },
  { id: 'sing-box', name: 'sing-box', dialect: 'sing-box-json', fileExtension: 'json', contentMode: 'full', basis: SINGBOX_BASIS, independentEvidence: true },
  { id: 'hiddify', name: 'Hiddify', dialect: 'sing-box-json', fileExtension: 'json', contentMode: 'full', basis: SINGBOX_BASIS, independentEvidence: false },
  { id: 'loon', name: 'Loon', dialect: 'loon-ini', fileExtension: 'conf', contentMode: 'full', basis: LOON_BASIS, independentEvidence: true },
  { id: 'quanx', name: 'Quantumult X', dialect: 'quanx-ini', fileExtension: 'conf', contentMode: 'full', basis: QUANX_BASIS, independentEvidence: true },
  { id: 'egern', name: 'Egern', dialect: 'egern-yaml', fileExtension: 'yaml', contentMode: 'full', basis: EGERN_BASIS, independentEvidence: true },
  // Shadowrocket 无官方配置格式参考（Tower CLIENT-COMPATIBILITY.md 亦如此注明），
  // 因此只提供有公开规范的节点分享 URI 列表，不宣称能生成完整配置。
  { id: 'shadowrocket', name: 'Shadowrocket', dialect: 'uri-list', fileExtension: 'txt', contentMode: 'nodes-only', basis: URI_BASIS, independentEvidence: false },
  { id: 'v2box', name: 'V2Box', dialect: 'uri-list', fileExtension: 'txt', contentMode: 'nodes-only', basis: URI_BASIS, independentEvidence: false },
  { id: 'anywhere', name: 'Anywhere', dialect: 'uri-list', fileExtension: 'txt', contentMode: 'nodes-only', basis: URI_BASIS, independentEvidence: false },
];

const BY_ID = new Map<ClientTarget, TargetDescriptor>(TARGETS.map((item) => [item.id, item]));

export const descriptorOf = (target: ClientTarget): TargetDescriptor => {
  const descriptor = BY_ID.get(target);
  if (descriptor === undefined) throw new Error(`unregistered target: ${target}`);
  return descriptor;
};

export const dialectOf = (target: ClientTarget): Dialect => descriptorOf(target).dialect;

export const outputFilename = (target: ClientTarget): string =>
  `${target}.${descriptorOf(target).fileExtension}`;

export const targetsOfDialect = (dialect: Dialect): readonly TargetDescriptor[] =>
  TARGETS.filter((item) => item.dialect === dialect);
