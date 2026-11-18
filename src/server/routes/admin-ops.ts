import { basename, join } from 'node:path';
import { Hono } from 'hono';
import { parseWebDavUrl, probeWebDav, uploadToWebDav } from '../backup.ts';
import type { WebDavConfig } from '../backup.ts';
import type { AppEnv } from '../http.ts';
import { readJsonObject, readJsonObjectOptional } from '../http.ts';
import {
  EMPTY_FETCH_DEFAULTS,
  SETTING_FETCH_DEFAULTS,
  fetchDefaults,
  fetchDefaultsView,
  notifyViewOf,
  parseFetchDefaults,
  parseNotifyConfig,
  parseWebdavConfig,
} from '../input.ts';
import type { FetchDefaults } from '../input.ts';
import { sendTestNotify } from '../notify.ts';
import type { NotifyConfig } from '../notify.ts';
import type { AdminDeps } from './admin-context.ts';
import { SETTING_NOTIFY, SETTING_WEBDAV } from './admin-context.ts';

export function opsRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, dataDir, notifyConfig, envNotify, webdavConfig, envWebdav, describeOps } = deps;

  router.get('/ops', (c) => {
    const ops = describeOps();
    return c.json({
      notify: ops.notify,
      webdav: { configured: parseWebDavUrl(webdavConfig()?.url) !== null },
      scheduler: { intervalMs: ops.schedulerIntervalMs },
    });
  });

  router.post('/backup', async (c) => {
    const destination = join(dataDir, 'backup', `startrails-${Date.now()}.db`);
    await store.backup(destination);
    return c.json({ destination });
  });

  router.post('/backup/remote', async (c) => {
    const webdav = webdavConfig();
    if (webdav === undefined || parseWebDavUrl(webdav.url) === null) {
      return c.json(
        {
          error: 'webdav-not-configured',
          hint: '在设置页配置 WebDAV，或设置 STARTRAILS_WEBDAV_URL（可选 _USER / _PASS）',
        },
        501,
      );
    }
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const destination = join(dataDir, 'backup', `startrails-${stamp}.db`);
    await store.backup(destination);
    try {
      const outcome = await uploadToWebDav(webdav, destination, basename(destination));
      return c.json({ ok: true, ...outcome, local: destination });
    } catch (error) {
      return c.json(
        {
          error: 'webdav-upload-failed',
          reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
          local: destination,
        },
        502,
      );
    }
  });

  router.post('/settings/notify/test', async (c) => {
    const body = await readJsonObjectOptional(c);
    const candidate = body['notify'];
    const config =
      candidate === null || candidate === undefined ? notifyConfig() : (parseNotifyConfig(candidate) ?? undefined);
    if (config === undefined) {
      return c.json(
        { error: 'notify-not-configured', hint: '先填 Telegram Bot Token + Chat ID，或 Bark 地址' },
        400,
      );
    }
    const results = await sendTestNotify(config);
    const ok = results.length > 0 && results.every((item) => item.ok);
    return c.json({ ok, results }, ok ? 200 : 502);
  });

  router.post('/settings/webdav/test', async (c) => {
    const body = await readJsonObjectOptional(c);
    const candidate = body['webdav'];
    let config: WebDavConfig | undefined;
    if (candidate !== undefined && candidate !== null) {
      config = parseWebdavConfig(candidate, webdavConfig()) ?? undefined;
      if (config === undefined) {
        return c.json({ error: 'invalid-webdav-config' }, 400);
      }
    } else {
      config = webdavConfig();
    }
    if (config === undefined || parseWebDavUrl(config.url) === null) {
      return c.json({ error: 'webdav-not-configured', hint: '先填写 WebDAV 地址' }, 400);
    }
    try {
      const probe = await probeWebDav(config);
      return c.json(probe, probe.ok ? 200 : 502);
    } catch (error) {
      return c.json(
        {
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message.slice(0, 160) : 'webdav-unreachable',
        },
        502,
      );
    }
  });

  router.get('/settings/notify', (c) => {
    const raw = store.getSetting(SETTING_NOTIFY);
    const active = notifyConfig();
    let stored: Record<string, unknown> | null = null;
    if (raw !== undefined) {
      try {
        stored = notifyViewOf(JSON.parse(raw) as NotifyConfig | null);
      } catch {
        stored = null;
      }
    }
    return c.json({
      value: stored,
      envDefaults: envNotify ?? null,
      effective: active ?? null,
    });
  });

  router.put('/settings/notify', async (c) => {
    const body = await readJsonObject(c);
    const candidate = body['notify'];
    if (candidate === null || candidate === undefined) {
      store.putSetting(SETTING_NOTIFY, 'null');
      return c.json({ ok: true, value: null });
    }
    const parsed = parseNotifyConfig(candidate);
    if (parsed === null) {
      return c.json({ error: 'invalid-notify-config' }, 400);
    }
    store.putSetting(SETTING_NOTIFY, JSON.stringify(parsed));
    return c.json({ ok: true, value: notifyViewOf(parsed) });
  });

  router.get('/settings/webdav', (c) => {
    const raw = store.getSetting(SETTING_WEBDAV);
    const active = webdavConfig();
    let value: { url: string; username?: string; hasPassword: boolean } | null = null;
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as WebDavConfig;
        if (parseWebDavUrl(parsed.url) !== null) {
          value = {
            url: parsed.url,
            ...(parsed.username === undefined ? {} : { username: parsed.username }),
            hasPassword: parsed.password !== undefined,
          };
        }
      } catch {
        value = null;
      }
    }
    return c.json({
      value,
      envDefaults:
        envWebdav === undefined
          ? null
          : { url: envWebdav.url, hasPassword: envWebdav.password !== undefined },
      effective: active === undefined ? null : { url: active.url, hasCredentials: active.username !== undefined },
    });
  });

  router.put('/settings/webdav', async (c) => {
    const body = await readJsonObject(c);
    const candidate = body['webdav'];
    if (candidate === null || candidate === undefined) {
      store.putSetting(SETTING_WEBDAV, 'null');
      return c.json({ ok: true, webdav: null });
    }
    const existing = webdavConfig();
    const parsed = parseWebdavConfig(candidate, existing);
    if (parsed === null) {
      return c.json({ error: 'invalid-webdav-config' }, 400);
    }
    store.putSetting(SETTING_WEBDAV, JSON.stringify(parsed));
    return c.json({ ok: true, webdav: { url: parsed.url, hasCredentials: parsed.username !== undefined } });
  });

  router.get('/settings/fetch-defaults', (c) => {
    const raw = store.getSetting(SETTING_FETCH_DEFAULTS);
    let stored: FetchDefaults = EMPTY_FETCH_DEFAULTS;
    if (raw !== undefined && raw !== 'null') {
      try {
        stored = parseFetchDefaults(JSON.parse(raw)) ?? EMPTY_FETCH_DEFAULTS;
      } catch {
        stored = EMPTY_FETCH_DEFAULTS;
      }
    }
    return c.json({
      value: raw === undefined || raw === 'null' ? null : fetchDefaultsView(stored),
    });
  });

  router.put('/settings/fetch-defaults', async (c) => {
    const body = await readJsonObject(c);
    const candidate = body['defaults'];
    if (candidate === null || candidate === undefined) {
      store.putSetting(SETTING_FETCH_DEFAULTS, 'null');
      return c.json({ ok: true, value: null });
    }
    const parsed = parseFetchDefaults(candidate, fetchDefaults(store));
    if (parsed === null) {
      return c.json({ error: 'invalid-fetch-defaults' }, 400);
    }
    store.putSetting(SETTING_FETCH_DEFAULTS, JSON.stringify(parsed));
    return c.json({ ok: true, value: fetchDefaultsView(parsed) });
  });

  return router;
}
