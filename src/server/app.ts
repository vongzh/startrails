import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { CORE_VERSION } from '../core/index.ts';
import { hashToken } from '../store/crypto.ts';
import type { Store } from '../store/port.ts';
import { parseWebDavUrl } from './backup.ts';
import type { WebDavConfig } from './backup.ts';
import { BuildCache } from './build-cache.ts';
import { createBuilder } from './builder.ts';
import { SnapshotCache } from './cache.ts';
import { HttpError, send, sendJson, serveStatic } from './http.ts';
import { describeAge } from './input.ts';
import { createNotifier } from './notify.ts';
import type { NotifyConfig } from './notify.ts';
import { redact } from './redact.ts';
import { ADMIN_TOKEN_SETTING_KEY, SETTING_NOTIFY, SETTING_WEBDAV, createAdminHandler } from './routes-admin.ts';
import { createDeliveryRoutes } from './routes-delivery.ts';
import { RuleSetCache } from './ruleset.ts';
import { dueSourceIds } from './schedule.ts';

export { ADMIN_TOKEN_SETTING_KEY, describeAge };

export interface AppOptions {
  readonly store: Store;
  /**
   * 环境变量注入的管理令牌，优先级最高。不传 / 空字符串 = 未配置：
   * 回退到数据库里首次设置时落下的哈希；两者都没有则开放一次性设置端点。
   */
  readonly adminToken?: string;
  readonly cacheDir: string;
  readonly dataDir: string;
  readonly webRoot?: string;
  readonly allowPrivate?: boolean;
  /**
   * 数据加密密钥是否已配置（环境变量或 `<data>/secret.key`）。false = 本次启动使用临时密钥，
   * 所有管理写入在 UI 设置密钥前都会被拒绝。
   */
  readonly secretConfigured?: boolean;
  /** UI 首次设置的密钥落盘路径；未提供时只允许由环境变量 / 既有文件提供密钥。 */
  readonly secretFile?: string;
  /** 运维通知（Telegram / Bark）；未配置时全部 send 走空实现。 */
  readonly notify?: NotifyConfig;
  /** WebDAV 远端备份目标；未配置时 /api/backup/remote 回 501。 */
  readonly webdav?: WebDavConfig;
  /**
   * 对外可达的基地址（例如 https://sub.example.com）。配置后外部规则集会改写成镜像地址
   * `${publicBaseUrl}/rules/<key>`；不配则保持原始 URL，镜像功能整块不启用。
   */
  readonly publicBaseUrl?: string;
  /**
   * 无状态一次性转换 `GET /sub?url=&target=` 是否开放。**默认关闭**：
   * 它等价于「让匿名请求用服务器身份去拉任意公网 URL 再原样吐回」，
   * 在没配 allowPrivate 的环境里也依然是一个可被滥用的出口。开启需要在部署侧显式表态。
   */
  readonly allowStateless?: boolean;
}

export interface App {
  readonly server: Server;
  readonly close: () => Promise<void>;
  /** 立即跑一轮「到期源刷新」，供测试与手动触发用；调度器内部也走这里。 */
  readonly refreshDue: () => Promise<{ refreshed: number; failed: number }>;
}

/** 调度器轮询粒度：到期判定按 lastFetchedAt 算，轮询只决定「多久检查一次」。 */
const SCHEDULER_INTERVAL_MS = 60_000;

export function createApp(options: AppOptions): App {
  const { store } = options;
  const cache = new SnapshotCache(options.cacheDir);
  const buildCache = new BuildCache();

  const envToken = options.adminToken?.trim() ?? '';
  const envTokenHash = envToken.length > 0 ? hashToken(envToken) : undefined;
  let secretConfigured = options.secretConfigured !== false;

  const notifyConfig = (): NotifyConfig | undefined => {
    const raw = store.getSetting(SETTING_NOTIFY);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as NotifyConfig;
        if (parsed.telegram !== undefined || parsed.bark !== undefined) return parsed;
      } catch {
        // 坏 JSON 按「没有界面覆盖」处理，回退环境变量。
      }
    }
    return options.notify;
  };
  const notifier = createNotifier(notifyConfig);

  const webdavConfig = (): WebDavConfig | undefined => {
    const raw = store.getSetting(SETTING_WEBDAV);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as WebDavConfig;
        if (parseWebDavUrl(parsed.url) !== null) return parsed;
      } catch {
        // 坏 JSON 回退环境变量。
      }
    }
    return options.webdav;
  };

  const allowPrivate = options.allowPrivate ?? false;
  const ruleSets = new RuleSetCache(join(options.dataDir, 'cache', 'rulesets'), undefined, allowPrivate);

  const builder = createBuilder({
    store,
    cache,
    buildCache,
    ruleSets,
    notifier,
    allowPrivate,
    publicBaseUrl: options.publicBaseUrl,
  });

  const handleApi = createAdminHandler({
    store,
    buildCache,
    builder,
    dataDir: options.dataDir,
    allowPrivate,
    publicBaseUrl: options.publicBaseUrl,
    envTokenHash,
    secretFile: options.secretFile,
    isSecretConfigured: () => secretConfigured,
    markSecretConfigured: () => {
      secretConfigured = true;
    },
    notifyConfig,
    envNotify: options.notify,
    webdavConfig,
    envWebdav: options.webdav,
    describeOps: () => ({
      notify: notifier.describe(),
      schedulerIntervalMs: SCHEDULER_INTERVAL_MS,
    }),
  });

  const delivery = createDeliveryRoutes({
    store,
    buildCache,
    ruleSets,
    builder,
    allowPrivate,
    allowStateless: options.allowStateless === true,
    publicBaseUrl: options.publicBaseUrl,
  });

  const refreshDue = async (): Promise<{ refreshed: number; failed: number }> => {
    const due = dueSourceIds(store.listSources(), Date.now());
    if (due.length === 0) return { refreshed: 0, failed: 0 };
    return builder.refreshSources(due);
  };

  const server = createServer((req, res) => {
    // URL 解析器会先把 %2e%2e 规范化掉，所以要在解析前检查原始路径。
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (/%2e%2e|\.\./i.test(rawPath)) {
      send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'invalid-request-url' });
      return;
    }
    const pathname = url.pathname;
    void (async () => {
      try {
        if (pathname === '/health') {
          sendJson(res, 200, { ok: true, version: builder.instanceVersion(), coreVersion: CORE_VERSION });
        } else if (pathname.startsWith('/rules/')) {
          await delivery.serveRuleSet(res, pathname.slice('/rules/'.length));
        } else if (pathname.startsWith('/api/')) {
          await handleApi(req, res, pathname, url);
        } else if (pathname.startsWith('/s/')) {
          await delivery.renderSubscription(req, res, url);
        } else if (pathname === '/sub') {
          await delivery.renderStateless(req, res, url);
        } else {
          serveStatic(options.webRoot, pathname, res);
        }
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message });
          return;
        }
        if (error instanceof URIError) {
          sendJson(res, 400, { error: 'invalid-url-encoding' });
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { error: 'internal-error', reason: redact(reason) });
      }
    })();
  });

  /**
   * 调度器：每 60 秒检查一次到期源。用 unref() 让定时器不阻止进程退出。
   */
  const scheduler = setInterval(() => {
    void refreshDue().catch(() => undefined);
  }, SCHEDULER_INTERVAL_MS);
  scheduler.unref();

  return {
    server,
    refreshDue,
    close: () =>
      new Promise<void>((done, reject) => {
        clearInterval(scheduler);
        if (!server.listening) {
          done();
          return;
        }
        server.close((error) => (error === undefined ? done() : reject(error)));
      }),
  };
}
