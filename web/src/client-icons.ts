/**
 * 客户端视觉标识注册表（纯数据、零 IO、零外部资源）。
 *
 * 为什么不打包各应用的真实 logo：商标授权、离线交付、以及暗色背景下的对比度都不可控，
 * 且无法保证 19 个客户端的图标资源都准确。这里改用内联 SVG 线性标记：
 * 形状贴近各应用的视觉特征（Surge 波纹、Clash 猫耳、Loon 气球、Shadowrocket 火箭…），
 * 色相按「输出方言」分族，这样同族客户端共享色系、不同族一眼可分。
 *
 * 品牌色只随明暗调亮度，不跟随 --accent：换强调色时图标仍然指向同一个应用。
 * 图标永远与文字标签同时出现，因此是装饰性的，不承担筛选/复制等逻辑，也不作为唯一信息。
 *
 * id 与 src/core/targets.ts 的 TARGETS 一一对应；新增客户端时两处都要补一行。
 */

export type IconTone = 'surge' | 'clash' | 'singbox' | 'loon' | 'quanx' | 'egern' | 'uri' | 'auto';

export interface ClientMark {
  /** 24×24 线性图标的 path（可含多段子路径）。 */
  readonly glyph: string;
  readonly tone: IconTone;
  /** 兜底显示名；权威显示名仍取 /api/state 的 clientTargets。 */
  readonly label: string;
}

/** 统一用描边绘制，明暗主题下都不需要额外的 fill 适配。 */
const G = {
  waves: 'M2 9c2.2-2.8 4.4-2.8 6.6 0 2.2 2.8 4.4 2.8 6.6 0 2.2-2.8 4.4-2.8 6.8 0 M2 15c2.2-2.8 4.4-2.8 6.6 0 2.2 2.8 4.4 2.8 6.6 0 2.2-2.8 4.4-2.8 6.8 0',
  window:
    'M4 3.5h16v17H4z M4 8h16 M7.2 5.8h.01 M10 5.8h.01 M7.5 14c1.5-1.9 3-1.9 4.5 0s3 1.9 4.5 0',
  cat: 'M5 10 4.5 4l4.7 2.6 M19 10l.5-6-4.7 2.6 M4.5 10.5c0 4.4 3.4 7.5 7.5 7.5s7.5-3.1 7.5-7.5 M9.5 13h.01 M14.5 13h.01',
  stack: 'M8.5 3.5h11a1 1 0 0 1 1 1v10 M3.5 8.5h11a1 1 0 0 1 1 1v10h-11a1 1 0 0 1-1-1z',
  circleC: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M15.5 9.5a4.4 4.4 0 1 0 0 5',
  vee: 'M3.5 6.5 12 19.5 20.5 6.5 M3.5 6.5h3.2 M17.3 6.5h3.2',
  squareC: 'M4 4h16v16H4z M14.8 9.3a4 4 0 1 0 0 5.4',
  bolt: 'M13.5 2.5 5 13.5h5.5L9.5 21.5 19 10.5h-5.5z',
  flag: 'M5 21V3.5 M5 4h13l-2.6 4L18 12H5',
  em: 'M3.5 18.5V5.5l4.2 7 4.3-7 4.3 7 4.2-7v13',
  diamond: 'M12 2.5 21.5 12 12 21.5 2.5 12z M12 8.5v7 M8.5 12h7',
  cube: 'M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9z M3.5 7.5 12 12.2l8.5-4.7 M12 12.2v9',
  eyeSlash:
    'M2.5 12C5 8 8.2 6.5 12 6.5s7 1.5 9.5 5.5C19 16 15.8 17.5 12 17.5S5 16 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z M4 20 20 4',
  balloon:
    'M12 2.8a6.4 6.4 0 0 1 6.4 6.4c0 4.2-4.1 7.2-6.4 9.3-2.3-2.1-6.4-5.1-6.4-9.3A6.4 6.4 0 0 1 12 2.8z M12 18.5v2.2 M10 21.2h4',
  xorbit: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z M8 8l8 8 M16 8l-8 8',
  leaf: 'M4.5 20C4.5 11 9.5 4.8 20 4c-.6 10.2-6 15.5-15.5 16z M4.5 20c3.2-4 7-7 11-9',
  rocket:
    'M12 2.5c3.4 2.6 5.4 6.5 5.4 10.8l-2.4 3.2h-6l-2.4-3.2C6.6 9 8.6 5.1 12 2.5z M9 16.5 6.6 19l.4-4 M15 16.5 17.4 19l-.4-4 M12 9.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z M9.4 19.4c.9 1.4 1.8 2.1 2.6 2.1s1.7-.7 2.6-2.1',
  boxV:
    'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z M3.5 7.5 12 12l8.5-4.5 M12 12v9 M8.2 9.4 12 15l3.8-5.6',
  compass: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z',
  sparkle: 'M12 2.5 14 9.3l6.8 2.7-6.8 2.7L12 21.5l-2-6.8L3.2 12 10 9.3z',
  unknown: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8v8 M8 12h8',
} as const;

type Glyph = keyof typeof G;

const MARKS: Record<string, { glyph: Glyph; tone: IconTone; label: string }> = {
  auto: { glyph: 'sparkle', tone: 'auto', label: '自动识别' },
  // Surge INI
  surge: { glyph: 'waves', tone: 'surge', label: 'Surge' },
  'surge-mac': { glyph: 'window', tone: 'surge', label: 'Surge Mac' },
  // Clash / mihomo YAML
  mihomo: { glyph: 'cat', tone: 'clash', label: 'mihomo / Clash' },
  clash: { glyph: 'stack', tone: 'clash', label: 'Stash' },
  'clash-apple': { glyph: 'circleC', tone: 'clash', label: 'Clash' },
  'clash-verge': { glyph: 'vee', tone: 'clash', label: 'Clash Verge' },
  clashmac: { glyph: 'squareC', tone: 'clash', label: 'ClashMac' },
  flclash: { glyph: 'bolt', tone: 'clash', label: 'FlClash' },
  'mihomo-party': { glyph: 'flag', tone: 'clash', label: 'Clash Party' },
  'clash-mi': { glyph: 'em', tone: 'clash', label: 'Clash Mi' },
  karing: { glyph: 'diamond', tone: 'clash', label: 'Karing' },
  // sing-box JSON
  'sing-box': { glyph: 'cube', tone: 'singbox', label: 'sing-box' },
  hiddify: { glyph: 'eyeSlash', tone: 'singbox', label: 'Hiddify' },
  // 独立 INI 方言
  loon: { glyph: 'balloon', tone: 'loon', label: 'Loon' },
  quanx: { glyph: 'xorbit', tone: 'quanx', label: 'Quantumult X' },
  // 独立 YAML 方言
  egern: { glyph: 'leaf', tone: 'egern', label: 'Egern' },
  // 节点分享 URI 列表
  shadowrocket: { glyph: 'rocket', tone: 'uri', label: 'Shadowrocket' },
  v2box: { glyph: 'boxV', tone: 'uri', label: 'V2Box' },
  anywhere: { glyph: 'compass', tone: 'uri', label: 'Anywhere' },
};

export const clientMarkOf = (id: string): ClientMark => {
  const found = MARKS[id];
  if (found === undefined) return { glyph: G.unknown, tone: 'auto', label: id };
  return { glyph: G[found.glyph], tone: found.tone, label: found.label };
};

/** 客户端名称优先取服务端注册表；表没覆盖时用图标表的兜底名。 */
export const clientLabelOf = (id: string, registeredName?: string): string =>
  registeredName ?? clientMarkOf(id).label;

const DIALECT_TONES: Record<string, IconTone> = {
  'surge-ini': 'surge',
  'clash-yaml': 'clash',
  'sing-box-json': 'singbox',
  'loon-ini': 'loon',
  'quanx-ini': 'quanx',
  'egern-yaml': 'egern',
  'uri-list': 'uri',
};

/** 分组标题的色点：与同组客户端图标同色系。 */
export const toneOfDialect = (dialect: string): IconTone => DIALECT_TONES[dialect] ?? 'auto';

/** 已注册的全部 id，用于 CI 检查注册表与后端 TARGETS 是否同步。 */
export const CLIENT_ICON_IDS: readonly string[] = Object.keys(MARKS).filter((id) => id !== 'auto');
