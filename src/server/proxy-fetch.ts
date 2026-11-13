import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Agent } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';

/**
 * 代理拉取：部分机场按来源 IP 限区，必须换出口才能拿到正确内容。
 * 只实现「客户端到代理」这一段，不引入第三方依赖：
 *  - http / https 代理：CONNECT 隧道；
 *  - socks5：无认证或用户名密码认证。
 * 目标为 https 时在隧道上再做 TLS，servername 用目标域名（不是代理域名）。
 */

export interface ProxySpec {
  readonly protocol: 'http:' | 'https:' | 'socks5:';
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
}

export function parseProxyUrl(raw: string | undefined | null): ProxySpec | null {
  if (raw === undefined || raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
    return {
      protocol: 'socks5:',
      host: url.hostname,
      port: url.port.length === 0 ? 1080 : Number(url.port),
      ...(url.username.length === 0 ? {} : { username: decodeURIComponent(url.username) }),
      ...(url.password.length === 0 ? {} : { password: decodeURIComponent(url.password) }),
    };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return {
      protocol: url.protocol,
      host: url.hostname,
      port: url.port.length === 0 ? (url.protocol === 'https:' ? 443 : 8080) : Number(url.port),
      ...(url.username.length === 0 ? {} : { username: decodeURIComponent(url.username) }),
      ...(url.password.length === 0 ? {} : { password: decodeURIComponent(url.password) }),
    };
  }
  return null;
}

const connectWithTimeout = (host: string, port: number, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('proxy-connect-timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

async function httpConnectTunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs);
  const target = `${host}:${port}`;
  const headers: Record<string, string> = { host: target };
  if (proxy.username !== undefined) {
    const credential = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64');
    headers['proxy-authorization'] = `Basic ${credential}`;
  }
  const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: target,
    headers,
    agent: false,
    // 已经建好 socket，直接接管，避免二次连接。
    createConnection: () => socket,
  } as unknown as Parameters<typeof httpRequest>[0]);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      request.destroy();
      socket.destroy();
      reject(new Error('proxy-connect-timeout'));
    }, timeoutMs);
    request.once('connect', (response, tunnelled) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        tunnelled.destroy();
        reject(new Error(`proxy-connect-status:${response.statusCode}`));
        return;
      }
      resolve(tunnelled);
    });
    request.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    request.end();
  });
}

/** 逐步读够 n 字节；SOCKS5 的应答是定长或带长度前缀的，必须精确读。 */
async function readExactly(socket: Socket, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < n) {
    const chunk = socket.read() as Buffer | null;
    if (chunk !== null) {
      chunks.push(chunk);
      total += chunk.length;
      continue;
    }
    await once(socket, 'readable');
  }
  const merged = Buffer.concat(chunks);
  return merged.subarray(0, n);
}

async function socks5Tunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs);
  socket.setTimeout(timeoutMs);
  const wantsAuth = proxy.username !== undefined;
  socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const greeting = await readExactly(socket, 2);
  if (greeting[0] !== 0x05) throw new Error('socks5-version-mismatch');
  if (greeting[1] === 0x02) {
    if (!wantsAuth) throw new Error('socks5-auth-required');
    const user = Buffer.from(proxy.username ?? '', 'utf8');
    const pass = Buffer.from(proxy.password ?? '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const authReply = await readExactly(socket, 2);
    if (authReply[1] !== 0x00) throw new Error('socks5-auth-failed');
  } else if (greeting[1] !== 0x00) {
    throw new Error('socks5-method-rejected');
  }

  const hostBytes = Buffer.from(host, 'utf8');
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
    hostBytes,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
  socket.write(request);
  const head = await readExactly(socket, 4);
  if (head[0] !== 0x05 || head[1] !== 0x00) throw new Error(`socks5-connect-failed:${head[1] ?? 0}`);
  const addressType = head[3];
  const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (await readExactly(socket, 1))[0] ?? 0;
  await readExactly(socket, addressLength + 2);
  socket.setTimeout(0);
  return socket;
}

async function openTunnel(
  proxy: ProxySpec,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  const port = target.port.length === 0 ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const tunnel =
    proxy.protocol === 'socks5:'
      ? await socks5Tunnel(proxy, host, port, timeoutMs)
      : await httpConnectTunnel(proxy, host, port, timeoutMs);
  if (target.protocol !== 'https:') return tunnel;
  const secure = tlsConnect({ socket: tunnel, servername: host });
  await once(secure, 'secureConnect');
  return secure;
}

export interface ProxiedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface ProxiedRequest {
  readonly url: URL;
  readonly proxy: ProxySpec;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export async function fetchThroughProxy(request: ProxiedRequest): Promise<ProxiedResponse> {
  const timeoutMs = request.timeoutMs ?? 10_000;
  const socket = await openTunnel(request.proxy, request.url, timeoutMs);
  const secure = request.url.protocol === 'https:';
  const agent = secure
    ? Object.assign(new (await import('node:https')).Agent({ keepAlive: false }), {
        createConnection: () => socket,
      })
    : Object.assign(new (await import('node:http')).Agent({ keepAlive: false }), {
        createConnection: () => socket,
      });

  const port = request.url.port.length === 0 ? (secure ? 443 : 80) : Number(request.url.port);
  const headers = { host: request.url.host, connection: 'close', ...(request.headers ?? {}) };

  return new Promise<ProxiedResponse>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)({
      host: request.url.hostname.replace(/^\[|\]$/g, ''),
      port,
      path: `${request.url.pathname}${request.url.search}`,
      method: 'GET',
      headers,
      agent: agent as Agent,
      servername: secure ? request.url.hostname.replace(/^\[|\]$/g, '') : undefined,
    } as unknown as Parameters<typeof httpsRequest>[0]);
    const timer = setTimeout(() => {
      req.destroy(new Error('proxy-request-timeout'));
      socket.destroy();
    }, timeoutMs);
    req.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    req.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        clearTimeout(timer);
        socket.destroy();
        const collected: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') collected[key.toLowerCase()] = value;
          else if (Array.isArray(value)) collected[key.toLowerCase()] = value.join(', ');
        }
        resolve({
          status: response.statusCode ?? 0,
          headers: collected,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.once('error', (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
    req.end();
  });
}
