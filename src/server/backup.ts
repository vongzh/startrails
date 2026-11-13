import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * 远端备份：WebDAV PUT 上传 `VACUUM INTO` 出来的单文件快照。
 *
 * 为什么是 WebDAV 而不是 Gist：备份里含加密后的订阅正文与全部凭据引用，
 * Gist 是**公开可达**的托管（secret gist 也只是「不出现在列表里」），不适合放这类数据；
 * WebDAV（Nextcloud / 群晖 / 坚果云 / 自建）是私有存储，权限模型与文件系统一致。
 *
 * 恢复方式刻意做成「不需要本工具」：把远端那份 .db 下载回来替换 `data/startrails.db`，
 * 用同一个 `STARTRAILS_TOKEN_SECRET` 启动即可（加密字段靠它解密），
 * 具体步骤见 `docs/BACKUP.md`。
 */
export interface WebDavConfig {
  /** 目标目录，末尾斜杠可有可无，例如 https://dav.example.com/remote.php/dav/files/me/startrails */
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly timeoutMs?: number;
}

export const parseWebDavUrl = (raw: string | undefined | null): URL | null => {
  if (raw === undefined || raw === null || raw.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
};

export interface UploadOutcome {
  readonly remoteUrl: string;
  readonly bytes: number;
}

export interface WebDavProbe {
  /** 原始 HTTP 状态码；0 表示请求根本没发出/超时。 */
  readonly status: number;
  readonly ok: boolean;
  /** 非 ok 时的归类：auth-rejected / path-not-found / timeout / webdav-status:xxx。 */
  readonly reason: string | null;
}

/**
 * 连通性测试：对目标目录发一次 PROPFIND（Depth: 0）。
 *
 * 为什么不是 OPTIONS：很多 WebDAV 服务对 OPTIONS 一律 200，即使目录不存在或密码错误，
 * 测了等于没测。PROPFIND 需要真实鉴权与目录存在，能同时验证「网络可达 + 凭据正确 + 目录存在」，
 * 且它是只读的——不会在用户远端留下任何垃圾文件。
 */
export async function probeWebDav(config: WebDavConfig): Promise<WebDavProbe> {
  const base = parseWebDavUrl(config.url);
  if (base === null) throw new Error('invalid-webdav-url');
  const timeoutMs = config.timeoutMs ?? 15_000;
  const headers: Record<string, string> = { depth: '0', 'content-length': '0' };
  if (config.username !== undefined && config.password !== undefined) {
    headers['authorization'] =
      `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
  }
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  let status = 0;
  try {
    status = await new Promise<number>((resolve, reject) => {
      const req = send(base, { method: 'PROPFIND', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('webdav-timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    return {
      status: 0,
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 120) : 'webdav-unreachable',
    };
  }
  if (status >= 200 && status < 300) return { status, ok: true, reason: null };
  if (status === 401 || status === 403) return { status, ok: false, reason: 'auth-rejected' };
  if (status === 404) return { status, ok: false, reason: 'path-not-found' };
  return { status, ok: false, reason: `webdav-status:${status}` };
}

export async function uploadToWebDav(
  config: WebDavConfig,
  localPath: string,
  remoteName: string,
): Promise<UploadOutcome> {
  const base = parseWebDavUrl(config.url);
  if (base === null) throw new Error('invalid-webdav-url');
  const target = new URL(remoteName, base.href.endsWith('/') ? base.href : `${base.href}/`);
  const info = await stat(localPath);
  const timeoutMs = config.timeoutMs ?? 60_000;

  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-length': String(info.size),
  };
  if (config.username !== undefined && config.password !== undefined) {
    headers['authorization'] =
      `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
  }

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = send(target, { method: 'PUT', headers }, (res) => {
      res.resume();
      // WebDAV 对已存在资源常回 204，新建回 201；两者都算成功。
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(`webdav-status:${status}`));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('webdav-timeout'));
    });
    req.on('error', reject);
    const stream = createReadStream(localPath);
    stream.on('error', reject);
    stream.pipe(req);
  });

  return { remoteUrl: target.toString(), bytes: info.size };
}
