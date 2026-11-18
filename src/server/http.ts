import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/** 文件订阅通常是几百 KB 的 YAML / base64，1MB 不够；8MB 覆盖绝大多数订阅。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

export const send = (
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

export const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' });
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

export const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request-body-too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const raw = await readBody(req);
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
};

/**
 * 拼出「外部能打开」的绝对地址。二维码里必须是绝对 URL，否则扫出来是一段无法访问的相对路径。
 * 优先用部署时声明的 publicBaseUrl；没配则按请求本身推断（反向代理需要设置 X-Forwarded-Proto）。
 */
export const absoluteUrlOf = (
  req: IncomingMessage,
  pathname: string,
  search: string,
  publicBaseUrl?: string,
): string => {
  const configured = publicBaseUrl?.replace(/\/+$/, '');
  if (configured !== undefined && configured.length > 0) return `${configured}${pathname}${search}`;
  const forwarded = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ??
    ((req.socket as { encrypted?: boolean }).encrypted === true ? 'https' : 'http');
  return `${proto}://${req.headers.host ?? 'localhost'}${pathname}${search}`;
};

export const serveStatic = (webRoot: string | undefined, pathname: string, res: ServerResponse): void => {
  if (webRoot === undefined) {
    send(res, 404, 'UI bundle not built', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  const base = resolve(webRoot);
  let requested: string;
  try {
    requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\//, '');
  } catch {
    send(res, 400, 'invalid-url-encoding', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  let file = resolve(join(base, requested));
  if (file !== base && !file.startsWith(base + sep)) {
    send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(base, 'index.html'); // SPA fallback
  }
  if (!existsSync(file)) {
    send(res, 404, 'UI bundle not built', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  // 必须按字节读：图片 / 字体等二进制资源按 utf8 解码会损坏。
  send(res, 200, readFileSync(file), {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
  });
};
