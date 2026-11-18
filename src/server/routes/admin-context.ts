import { createMiddleware } from 'hono/factory';
import type { Store } from '../../store/port.ts';
import { hashToken, safeEqual } from '../../store/crypto.ts';
import type { WebDavConfig } from '../backup.ts';
import type { BuildCache } from '../build-cache.ts';
import type { Builder } from '../builder.ts';
import type { GeoService } from '../geo.ts';
import type { AppContext, AppEnv } from '../http.ts';
import type { NotifyConfig } from '../notify.ts';

export const ADMIN_TOKEN_SETTING_KEY = 'admin.token.hash';
export const SETTING_NOTIFY = 'notify';
export const SETTING_WEBDAV = 'webdav';
export const MIN_ADMIN_TOKEN_LENGTH = 8;

export interface AdminDeps {
  readonly store: Store;
  readonly buildCache: BuildCache;
  readonly builder: Builder;
  readonly dataDir: string;
  readonly allowPrivate: boolean;
  readonly publicBaseUrl?: string | undefined;
  readonly envTokenHash?: string | undefined;
  readonly secretFile?: string | undefined;
  readonly isSecretConfigured: () => boolean;
  readonly markSecretConfigured: () => void;
  readonly notifyConfig: () => NotifyConfig | undefined;
  readonly envNotify?: NotifyConfig | undefined;
  readonly webdavConfig: () => WebDavConfig | undefined;
  readonly envWebdav?: WebDavConfig | undefined;
  readonly describeOps: () => {
    notify: { readonly enabled: boolean; readonly channels: readonly string[] };
    schedulerIntervalMs: number;
  };
  readonly geo?: GeoService | undefined;
}

export function activeAdminHashOf(deps: AdminDeps): string | undefined {
  const hash = deps.envTokenHash ?? deps.store.getSetting(ADMIN_TOKEN_SETTING_KEY);
  return hash === undefined || hash.length === 0 ? undefined : hash;
}

export function isAdminRequest(deps: AdminDeps, c: AppContext): boolean {
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = activeAdminHashOf(deps);
  return presented.length > 0 && expected !== undefined && safeEqual(hashToken(presented), expected);
}

/**
 * 统一鉴权与密钥就绪守卫：
 * 仅放行 `/api/setup/status` 与 `/api/setup`；其余管理端点要求有效 Bearer 令牌且数据加密密钥已落盘。
 */
export function adminAuthMiddleware(deps: AdminDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === '/api/setup/status' || pathname === '/api/setup') {
      await next();
      return;
    }
    if (!isAdminRequest(deps, c)) {
      return c.json({ error: 'admin-auth-required' }, 401);
    }
    if (!deps.isSecretConfigured()) {
      return c.json(
        {
          error: 'secret-setup-required',
          hint: '先在登录页设置数据加密密钥（或部署 STARTRAILS_TOKEN_SECRET）',
        },
        503,
      );
    }
    await next();
  });
}

export function queryProfileName(c: AppContext): string {
  return c.req.query('profile') ?? 'default';
}
