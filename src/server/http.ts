import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';

/** 文件订阅通常是几百 KB 的 YAML / base64，1MB 不够；8MB 覆盖绝大多数订阅。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type AppEnv = {
  Bindings: HttpBindings;
};

export type AppContext = Context<AppEnv>;

export const CONTENT_TYPE_BY_FORMAT: Readonly<Record<'ini' | 'yaml' | 'json' | 'uri', string>> = {
  ini: 'text/plain; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  uri: 'text/plain; charset=utf-8',
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 可预期的请求错误：外层统一转成 4xx，而不是把解析失败当成服务端 500。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 所有响应都带的最小安全头；不引入 CSP，避免误伤现有界面与内联样式。 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

/** If-None-Match 允许 `*`、逗号分隔与弱校验；只比字符串会让合法的条件请求全部落空。 */
export const ifNoneMatch = (header: string | undefined, etag: string): boolean => {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === `W/${etag}` || value.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
};

export async function readBodyText(c: AppContext): Promise<string> {
  const stream = c.req.raw.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError(413, 'request-body-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  const raw = await readBodyText(c);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid-json-body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body-must-be-object');
  }
  return parsed as Record<string, unknown>;
}

/** 可选 JSON 体：允许空体或非对象时安全回落为空对象，但超限仍返回 413。 */
export async function readJsonObjectOptional(c: AppContext): Promise<Record<string, unknown>> {
  try {
    return await readJsonObject(c);
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) throw error;
    return {};
  }
}

/**
 * 拼出「外部能打开」的绝对地址。二维码里必须是绝对 URL，否则扫出来是一段无法访问的相对路径。
 * 优先用部署时声明的 publicBaseUrl；没配则按请求本身推断（反向代理需要设置 X-Forwarded-Proto）。
 */
export function absoluteUrlOf(
  c: AppContext,
  pathname: string,
  search: string,
  publicBaseUrl?: string,
): string {
  const configured = publicBaseUrl?.replace(/\/+$/, '');
  if (configured !== undefined && configured.length > 0) return `${configured}${pathname}${search}`;
  const forwarded = c.req.header('x-forwarded-proto');
  const encrypted = (c.env.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const proto = forwarded?.split(',')[0]?.trim() || (encrypted ? 'https' : 'http');
  const host = c.req.header('host') ?? 'localhost';
  return `${proto}://${host}${pathname}${search}`;
}

export function serveStaticAsset(webRoot: string | undefined, c: AppContext): Response {
  if (webRoot === undefined) {
    return c.text('UI bundle not built', 404);
  }
  const base = resolve(webRoot);
  const url = new URL(c.req.url);
  let requested: string;
  try {
    requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\//, '');
  } catch {
    return c.text('invalid-url-encoding', 400);
  }
  let file = resolve(join(base, requested));
  if (file !== base && !file.startsWith(base + sep)) {
    return c.text('forbidden', 403);
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(base, 'index.html'); // SPA fallback
  }
  if (!existsSync(file)) {
    return c.text('UI bundle not built', 404);
  }
  // 必须按字节读：图片 / 字体等二进制资源按 utf8 解码会损坏。
  const data = readFileSync(file);
  return c.body(new Uint8Array(data), 200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
  });
}
