import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Agent } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

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
  // userinfo 里的 % 编码可能不合法（URL 解析器不会拒绝 `%zz`），
  // decodeURIComponent 会抛 URIError。代理地址是用户输入，必须按「无效」处理而不是抛错。
  const decodePart = (value: string): string | null => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };
  const username = url.username.length === 0 ? undefined : decodePart(url.username);
  if (username === null) return null;
  const password = url.password.length === 0 ? undefined : decodePart(url.password);
  if (password === null) return null;
  const credentials = {
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
  // URL.hostname 对 IPv6 保留方括号，而 net.connect / TLS 的 host 不能带括号。
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
    return {
      protocol: 'socks5:',
      host,
      port: url.port.length === 0 ? 1080 : Number(url.port),
      ...credentials,
    };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return {
      protocol: url.protocol,
      host,
      port: url.port.length === 0 ? (url.protocol === 'https:' ? 443 : 8080) : Number(url.port),
      ...credentials,
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
interface SocketReader {
  readonly socket: Socket;
  readonly timeoutMs: number;
  buffer: Buffer;
}

/** 等可读、关闭或超时三者之一；不能只等 `readable`，否则对端提前关闭会永久挂住。 */
const waitForReadable = (socket: Socket, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.off('readable', onReadable);
      socket.off('close', onClose);
      socket.off('error', onError);
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onReadable = (): void => finish();
    const onClose = (): void => finish(new Error('proxy-socket-closed'));
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => finish(new Error('proxy-read-timeout')), timeoutMs);
    socket.once('readable', onReadable);
    socket.once('close', onClose);
    socket.once('error', onError);
  });

async function readExactly(reader: SocketReader, n: number): Promise<Buffer> {
  while (reader.buffer.length < n) {
    const chunk = reader.socket.read() as Buffer | null;
    if (chunk !== null) {
      reader.buffer = reader.buffer.length === 0 ? chunk : Buffer.concat([reader.buffer, chunk]);
      continue;
    }
    if (reader.socket.destroyed || reader.socket.readableEnded) {
      throw new Error('proxy-socket-closed');
    }
    await waitForReadable(reader.socket, reader.timeoutMs);
  }
  const out = reader.buffer.subarray(0, n);
  reader.buffer = reader.buffer.subarray(n);
  return out;
}

async function socks5Tunnel(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs);
  // 之前只在 socket 上 setTimeout，却从不监听 timeout / close：对端提前关闭时
  // `once(socket, 'readable')` 永远等不到，整次拉取会挂到调用方超时之外。
  const reader: SocketReader = { socket, timeoutMs, buffer: Buffer.alloc(0) };
  try {
    const wantsAuth = proxy.username !== undefined;
    socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const greeting = await readExactly(reader, 2);
    if (greeting[0] !== 0x05) throw new Error('socks5-version-mismatch');
    if (greeting[1] === 0x02) {
      if (!wantsAuth) throw new Error('socks5-auth-required');
      const user = Buffer.from(proxy.username ?? '', 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      if (user.length > 255 || pass.length > 255) throw new Error('socks5-credentials-too-long');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const authReply = await readExactly(reader, 2);
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
    const head = await readExactly(reader, 4);
    if (head[0] !== 0x05 || head[1] !== 0x00) throw new Error(`socks5-connect-failed:${head[1] ?? 0}`);
    const addressType = head[3];
    const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (await readExactly(reader, 1))[0] ?? 0;
    await readExactly(reader, addressLength + 2);
    // 一次 read 可能把 SOCKS 应答与后续数据一起读出来：多出来的字节必须塞回流里。
    if (reader.buffer.length > 0) socket.unshift(reader.buffer);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** TLS 握手也可能一直不返回；同样需要显式超时，否则隧道建成后仍会挂住。 */
const waitForSecureConnect = (
  secure: ReturnType<typeof tlsConnect>,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onConnect = (): void => {
      clearTimeout(timer);
      secure.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      clearTimeout(timer);
      secure.off('secureConnect', onConnect);
      reject(error);
    };
    const timer = setTimeout(() => {
      secure.off('secureConnect', onConnect);
      secure.off('error', onError);
      secure.destroy();
      reject(new Error('proxy-tls-timeout'));
    }, timeoutMs);
    secure.once('secureConnect', onConnect);
    secure.once('error', onError);
  });

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
  await waitForSecureConnect(secure, timeoutMs);
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
  /** 响应正文上限；超过即中止连接，避免代理链路把整个进程内存吃满。 */
  readonly maxBytes?: number;
}

export async function fetchThroughProxy(request: ProxiedRequest): Promise<ProxiedResponse> {
  const timeoutMs = request.timeoutMs ?? 10_000;
  const maxBytes = request.maxBytes ?? 8 * 1024 * 1024;
  const headers = { host: request.url.host, connection: 'close', ...(request.headers ?? {}) };
  // 源级 UA / If-None-Match 是用户或上游可控的。带换行等非法字符时 http.request
  // 会同步抛错；必须在建隧道前校验，否则 Promise executor 抛错后定时器还会引用未初始化的 req。
  for (const [name, value] of Object.entries(headers)) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
  }
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

  return new Promise<ProxiedResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('proxy-request-timeout')), timeoutMs);
    const req = (secure ? httpsRequest : httpRequest)({
      host: request.url.hostname.replace(/^\[|\]$/g, ''),
      port,
      path: `${request.url.pathname}${request.url.search}`,
      method: 'GET',
      headers,
      agent: agent as Agent,
      servername: secure ? request.url.hostname.replace(/^\[|\]$/g, '') : undefined,
    } as unknown as Parameters<typeof httpsRequest>[0]);
    req.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
    req.once('response', (response) => {
      const lengthHeader = response.headers['content-length'];
      if (lengthHeader !== undefined) {
        const declared = Number(lengthHeader);
        if (Number.isFinite(declared) && declared > maxBytes) {
          fail(new Error('upstream-body-too-large'));
          return;
        }
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          fail(new Error('upstream-body-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        if (settled) return;
        settled = true;
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
      // 代理提前断开时 Node 不一定触发 error；必须显式把 aborted 当作失败，
      // 否则调用方会一直等到整个请求超时。
      response.once('aborted', () => fail(new Error('proxy-response-aborted')));
      response.once('error', (error: Error) => fail(error));
    });
    req.end();
  });
}
