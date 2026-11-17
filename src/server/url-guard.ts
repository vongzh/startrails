import { lookup } from 'node:dns/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isIP } from 'node:net';
import { fetchThroughProxy, parseProxyUrl } from './proxy-fetch.ts';

/** 形态从 CLI 变成「用户在 UI 填 URL、服务端去拉」后引入的新攻击面：SSRF。 */

const isPrivateV4 = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
};

const isPublicV6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return !isPrivateV4(lower.slice(7));
  if (lower === '::' || lower === '::1') return false;
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return false; // fc00::/7, fe80::/10
  const first = lower[0];
  return first === '2' || first === '3'; // 2000::/3 全球单播
};

export const isPublicAddress = (ip: string): boolean =>
  isIP(ip) === 4 ? !isPrivateV4(ip) : isIP(ip) === 6 ? isPublicV6(ip) : false;

export interface SafeFetchOptions {
  readonly allowPrivate?: boolean;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** 单份上游正文上限；超过即中止，避免一个坏链接把进程内存打满。 */
  readonly maxBytes?: number;
  /** 上游按 UA 返回不同格式（Clash / Surge / base64）时，按源的设置伪装。 */
  readonly ua?: string | null;
  /** 源级代理（http / https / socks5），用于机场按出口 IP 限区的场景。 */
  readonly proxy?: string | null;
  /**
   * 附加请求头（如鉴权用的 Authorization）。调用方（app.ts）负责从源级与全局默认合并，
   * 这里只负责校验后写进请求。UA / If-None-Match 仍由上面单独处理，避免被同名的空值覆盖。
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** 与请求体上限保持一致：正常订阅远小于这个量级。 */
export const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

export async function assertPublicUrl(raw: string, options: SafeFetchOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('protocol-not-allowed');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('url-userinfo-not-allowed');
  }
  if (options.allowPrivate === true) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses =
    isIP(hostname) !== 0
      ? [hostname]
      : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error('dns-resolution-failed');
  for (const address of addresses) {
    if (!isPublicAddress(address)) throw new Error(`private-address-blocked:${address}`);
  }
  // 限制说明：fetch 会重新解析域名，DNS rebinding 未被完全消除，
  // 公网部署仍需出口防火墙配合；本地/内网测试可显式开 allowPrivate。
  return url;
}

/** 上游流量信息（`subscription-userinfo` 响应头），单位是字节与 unix 秒。 */
export interface SourceUserinfo {
  readonly upload?: number;
  readonly download?: number;
  readonly total?: number;
  readonly expire?: number;
}

const parseUserinfo = (raw: string | null): SourceUserinfo | null => {
  if (raw === null || raw.trim().length === 0) return null;
  const fields: Record<string, number> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value < 0) continue;
    fields[key] = value;
  }
  const userinfo: SourceUserinfo = {
    ...(fields['upload'] === undefined ? {} : { upload: fields['upload'] }),
    ...(fields['download'] === undefined ? {} : { download: fields['download'] }),
    ...(fields['total'] === undefined ? {} : { total: fields['total'] }),
    ...(fields['expire'] === undefined ? {} : { expire: fields['expire'] }),
  };
  return Object.keys(userinfo).length === 0 ? null : userinfo;
};

export interface FetchedSnapshot {
  readonly body: string | null;
  readonly etag: string | null;
  readonly notModified: boolean;
  readonly userinfo: SourceUserinfo | null;
  /** 上游通过 `profile-update-interval` 建议的刷新间隔（小时）。 */
  readonly suggestedRefreshHours: number | null;
}

const EMPTY_META = { userinfo: null, suggestedRefreshHours: null } as const;

/**
 * 流式读取并在超过上限时立刻取消，而不是 `response.text()` 读完再检查。
 * 后者对「无限输出」的上游没有防护意义：内存已经被打满。
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('upstream-body-too-large');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('upstream-body-too-large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchSnapshot(
  raw: string,
  etag: string | null,
  options: SafeFetchOptions = {},
  depth = 0,
): Promise<FetchedSnapshot> {
  const url = await assertPublicUrl(raw, options);
  const maxRedirects = options.maxRedirects ?? 3;
  const headers: Record<string, string> = {};
  if (etag !== null) headers['If-None-Match'] = etag;
  if (options.ua !== undefined && options.ua !== null && options.ua.length > 0) {
    headers['User-Agent'] = options.ua;
  }
  // 自定义头在直连路径上先校验一遍：fetch() 遇到非法头名/值会抛得晚且难定位，
  // 代理路径本身也做同样校验（proxy-fetch.ts），两处口径保持一致。
  // UA / If-None-Match 先写、自定义头后写，允许显式覆盖（例如统一鉴权头）。
  if (options.headers !== undefined) {
    for (const [name, value] of Object.entries(options.headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      headers[name] = value;
    }
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? MAX_UPSTREAM_BYTES;
  const proxy = parseProxyUrl(options.proxy);

  if (proxy !== null) {
    const response = await fetchThroughProxy({ url, proxy, headers, timeoutMs, maxBytes });
    if (response.status === 304) {
      return { body: null, etag, notModified: true, ...EMPTY_META };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      if (location === undefined || depth >= maxRedirects) {
        throw new Error('redirect-limit-or-missing-location');
      }
      return fetchSnapshot(new URL(location, url).toString(), etag, options, depth + 1);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`upstream-status:${response.status}`);
    }
    return {
      body: response.body,
      etag: response.headers['etag'] ?? null,
      notModified: false,
      userinfo: parseUserinfo(response.headers['subscription-userinfo'] ?? null),
      suggestedRefreshHours: suggestionOf(response.headers['profile-update-interval']),
    };
  }

  const response = await fetch(url, {
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 304 也是 3xx，必须先于重定向分支判断，否则条件请求会被误当作跳转。
  if (response.status === 304) {
    return { body: null, etag, notModified: true, ...EMPTY_META };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location === null || depth >= maxRedirects) {
      throw new Error('redirect-limit-or-missing-location');
    }
    return fetchSnapshot(new URL(location, url).toString(), etag, options, depth + 1);
  }
  if (!response.ok) {
    throw new Error(`upstream-status:${response.status}`);
  }
  return {
    body: await readCappedText(response, maxBytes),
    etag: response.headers.get('etag'),
    notModified: false,
    userinfo: parseUserinfo(response.headers.get('subscription-userinfo')),
    suggestedRefreshHours: suggestionOf(response.headers.get('profile-update-interval')),
  };
}

const suggestionOf = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null;
  const hours = Number(raw.trim());
  return Number.isFinite(hours) && hours > 0 ? hours : null;
};
