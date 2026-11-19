import type { ClientTarget } from './targets.ts';

export interface ClientImportOptions {
  /** 客户端展示的配置文件名称，默认 `Startrails`。 */
  readonly name?: string;
  /** 防重复导入标识（Karing 会跳过同名/同 URL 订阅，需要每次变化）。 */
  readonly revision?: string;
}

const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function appendQuery(rawUrl: string, key: string, value: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}${encodeRfc3986(key)}=${encodeRfc3986(value)}`;
  }
}

/**
 * 生成各客户端的一键导入 URL Scheme（纯函数，零 IO）。
 *
 * 各客户端公开路由与导入规范说明：
 * - egern 使用单斜杠 `egern:/profiles/new?...`；
 * - hiddify 需要 authority（`hiddify://import/...`）；
 * - karing 会跳过重复 URL / 备注，需要附带本次导出标识；
 * - shadowrocket / v2box / anywhere 在 Startrails 为 nodes-only，走对应节点订阅导入格式；
 * - quanx 仅 `add-resource` 支持远端节点列表而不支持完整 `[policy]` 导入，返回 `null`。
 */
export function clientImportUrl(
  target: ClientTarget | 'auto',
  subscriptionUrl: string,
  options: ClientImportOptions = {},
): string | null {
  const url = subscriptionUrl.trim();
  if (url.length === 0) return null;
  const displayName = (options.name ?? '').trim() || 'Startrails';
  const encodedUrl = encodeRfc3986(url);
  const encodedName = encodeRfc3986(displayName);

  switch (target) {
    case 'surge':
      return `surge:///install-config?url=${encodedUrl}`;
    case 'surge-mac':
      return `surgeconfig:///install-config?url=${encodedUrl}`;
    case 'clash':
      return `stash://install-config?url=${encodedUrl}`;
    case 'clash-verge':
      return `clash-verge://install-config?url=${encodedUrl}`;
    case 'mihomo-party':
      return `mihomo://install-config?url=${encodedUrl}&name=${encodedName}`;
    case 'flclash':
      return `flclash://install-config?url=${encodedUrl}`;
    case 'clash-apple':
      return `clashmeta://install-config?url=${encodedUrl}`;
    case 'clash-mi':
      return `clashmi://install-config?url=${encodedUrl}&name=${encodedName}`;
    case 'karing': {
      const revision = (options.revision ?? '').trim() || '1';
      const uniqueUrl = appendQuery(url, 'st-import', revision);
      const uniqueName = `${displayName} ${revision.slice(-6)}`;
      return `karing://install-config?url=${encodeRfc3986(uniqueUrl)}&name=${encodeRfc3986(uniqueName)}`;
    }
    case 'sing-box':
      return `sing-box://import-remote-profile?url=${encodedUrl}#${encodedName}`;
    case 'hiddify':
      return `hiddify://import/${url}`;
    case 'loon':
      return `loon://import?sub=${encodedUrl}`;
    case 'egern':
      return `egern:/profiles/new?url=${encodedUrl}&name=${encodedName}`;
    case 'shadowrocket':
      return `shadowrocket://add/${url}#${encodedName}`;
    case 'v2box':
      return `v2box://install-sub?url=${encodedUrl}&name=${encodedName}`;
    case 'anywhere':
      return `anywhere://add-proxy?link=${encodedUrl}`;
    case 'quanx':
    case 'mihomo':
    case 'clashmac':
    case 'auto':
      return null;
  }
}

export function clientImportHint(target: ClientTarget | 'auto'): string | null {
  switch (target) {
    case 'quanx':
      return 'Quantumult X 一键链接只支持节点资源，完整配置请复制订阅地址或导出配置文件导入';
    case 'clashmac':
      return 'ClashMac 暂无官方 URL Scheme 一键导入，请复制订阅地址手动添加';
    case 'mihomo':
      return '通用 mihomo 地址请复制填入客户端；若用 Clash Verge / Clash Party / Clash Mi，可签发对应客户端地址直接一键导入';
    case 'auto':
      return 'UA 自识别链接用于客户端主动拉取订阅；签发具体客户端地址可启用一键导入';
    default:
      return null;
  }
}
