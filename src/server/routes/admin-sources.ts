import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PersistedSource } from '../../store/port.ts';
import { mapConcurrent } from '../async.ts';
import type { AppEnv } from '../http.ts';
import { readJsonObject } from '../http.ts';
import { asString, isSourceFormat, proxyFrom } from '../input.ts';
import { hasRedactionMarkers } from '../redact.ts';
import { assertPublicUrl } from '../url-guard.ts';
import type { AdminDeps } from './admin-context.ts';

export function sourcesRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, buildCache, builder, allowPrivate } = deps;

  router.get('/sources/inspect', async (c) => {
    const sources = store.listSources();
    const results = await mapConcurrent(sources, 4, (source) => builder.inspectSource(source));
    return c.json({ sources: results });
  });

  router.post('/sources', async (c) => {
    const body = await readJsonObject(c);
    const kindRaw = asString(body['kind']) ?? 'remote';
    const kind = kindRaw === 'file' || kindRaw === 'inline' ? kindRaw : 'remote';
    const sourceUrl = asString(body['url']);
    const content = typeof body['content'] === 'string' ? body['content'] : undefined;

    if (kind === 'remote' && sourceUrl === undefined) {
      return c.json({ error: 'url-required' }, 400);
    }
    if (kind !== 'remote' && (content === undefined || content.trim().length === 0)) {
      return c.json({ error: 'content-required' }, 400);
    }
    if (sourceUrl !== undefined && hasRedactionMarkers(sourceUrl)) {
      return c.json(
        { error: 'redacted-url-rejected', hint: '链接里是脱敏值，请粘贴完整订阅链接' },
        400,
      );
    }
    if (kind === 'remote' && sourceUrl !== undefined) {
      try {
        await assertPublicUrl(sourceUrl, { allowPrivate });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'unsafe-url' }, 400);
      }
    }

    const formatRaw = asString(body['format']);
    if (formatRaw !== undefined && formatRaw !== '' && !isSourceFormat(formatRaw)) {
      return c.json(
        { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' },
        400,
      );
    }
    const format = formatRaw !== undefined && isSourceFormat(formatRaw) ? formatRaw : undefined;
    const ua = asString(body['ua']);
    const refreshPolicy = asString(body['refreshPolicy']);
    const proxy = proxyFrom(body['proxy']);
    if (!proxy.ok) {
      return c.json(
        { error: 'invalid-proxy-url', hint: 'expect http://, https:// or socks5://host:port' },
        400,
      );
    }
    if (proxy.value !== undefined && hasRedactionMarkers(proxy.value)) {
      return c.json(
        { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' },
        400,
      );
    }

    const id = asString(body['id']) ?? `${kind}-${randomUUID().slice(0, 8)}`;
    const name = asString(body['name']) ?? id;
    const source: PersistedSource = {
      id,
      name,
      kind,
      enabled: body['enabled'] === false ? false : true,
      ...(sourceUrl === undefined || kind !== 'remote' ? {} : { url: sourceUrl }),
      ...(ua === undefined ? {} : { ua }),
      ...(format === undefined ? {} : { format }),
      ...(refreshPolicy === undefined ? {} : { refreshPolicy }),
      ...(proxy.value === undefined ? {} : { proxy: proxy.value }),
    };
    store.putSource(source);
    if (content !== undefined && kind !== 'remote') store.writeSourcePayload(id, content);

    const attachTo = asString(body['profile']);
    const attachTarget = attachTo === undefined ? undefined : builder.findProfile(attachTo);
    const attached = attachTarget !== undefined && attachTarget.entries.length === 0;
    if (attached && attachTarget !== undefined) {
      store.putProfile({ ...attachTarget, entries: [{ kind: 'source', id }] });
    }

    return c.json(
      {
        id,
        name,
        kind,
        url: source.url ?? null,
        attached,
      },
      201,
    );
  });

  router.post('/sources/:id/refresh', async (c) => {
    const id = c.req.param('id');
    const source = store.getSource(id);
    if (source === undefined) {
      return c.json({ error: 'source-not-found' }, 404);
    }
    if (source.kind !== 'remote') {
      return c.json({ error: 'source-not-remote' }, 400);
    }
    const outcome = await builder.refreshSources([id]);
    const updated = store.getSource(id);
    return c.json({
      ...outcome,
      lastError: updated?.lastError ?? null,
      userinfo: updated?.userinfo ?? null,
      lastFetchedAt: updated?.lastFetchedAt ?? null,
    });
  });

  router.get('/sources/:id/preview', async (c) => {
    const id = c.req.param('id');
    const existing = store.getSource(id);
    if (existing === undefined) {
      return c.json({ error: 'source-not-found' }, 404);
    }
    return c.json(await builder.inspectSource(existing));
  });

  router.get('/sources/:id', (c) => {
    const id = c.req.param('id');
    const existing = store.getSource(id);
    if (existing === undefined) {
      return c.json({ error: 'source-not-found' }, 404);
    }
    return c.json({
      source: builder.sourceView(existing),
      content: existing.kind === 'remote' ? null : (store.readSourcePayload(id) ?? ''),
    });
  });

  router.put('/sources/:id', async (c) => {
    const id = c.req.param('id');
    const existing = store.getSource(id);
    if (existing === undefined) {
      return c.json({ error: 'source-not-found' }, 404);
    }
    const body = await readJsonObject(c);
    const urlProvided = 'url' in body;
    const nextUrl = urlProvided ? asString(body['url']) : existing.url;
    if (existing.kind === 'remote' && urlProvided && nextUrl === undefined) {
      return c.json({ error: 'url-required' }, 400);
    }
    if (urlProvided && nextUrl !== undefined && hasRedactionMarkers(nextUrl)) {
      return c.json(
        {
          error: 'redacted-url-rejected',
          hint: '链接里是脱敏值（可能被旧版页面写坏过），请在编辑抽屉重新粘贴完整订阅链接',
        },
        400,
      );
    }
    if (existing.kind === 'remote' && nextUrl !== undefined && nextUrl !== existing.url) {
      try {
        await assertPublicUrl(nextUrl, { allowPrivate });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'unsafe-url' }, 400);
      }
    }
    const name = 'name' in body ? asString(body['name']) : existing.name;
    if (name === undefined) {
      return c.json({ error: 'name-required' }, 400);
    }
    if ('enabled' in body && typeof body['enabled'] !== 'boolean') {
      return c.json({ error: 'invalid-enabled', hint: 'enabled 只能是布尔值' }, 400);
    }
    let format = existing.format;
    if ('format' in body) {
      const raw = asString(body['format']);
      if (raw !== undefined && !isSourceFormat(raw)) {
        return c.json(
          { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' },
          400,
        );
      }
      format = raw !== undefined && isSourceFormat(raw) ? raw : undefined;
    }
    const ua = 'ua' in body ? asString(body['ua']) : existing.ua;
    const refreshPolicy =
      existing.kind === 'remote'
        ? ('refreshPolicy' in body ? asString(body['refreshPolicy']) : existing.refreshPolicy)
        : undefined;
    let proxy: string | undefined = existing.proxy;
    if ('proxy' in body) {
      const parsed = proxyFrom(body['proxy']);
      if (!parsed.ok) {
        return c.json(
          { error: 'invalid-proxy-url', hint: 'expect http://, https:// or socks5://host:port' },
          400,
        );
      }
      if (parsed.value !== undefined && hasRedactionMarkers(parsed.value)) {
        return c.json(
          { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' },
          400,
        );
      }
      proxy = parsed.value;
    }
    if ('content' in body && existing.kind !== 'remote') {
      const content = body['content'];
      if (typeof content !== 'string' || content.trim().length === 0) {
        return c.json({ error: 'content-required' }, 400);
      }
    }
    const next: PersistedSource = {
      id,
      name,
      kind: existing.kind,
      enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : existing.enabled,
      ...(existing.kind === 'remote' && nextUrl !== undefined ? { url: nextUrl } : {}),
      ...(ua === undefined ? {} : { ua }),
      ...(format === undefined ? {} : { format }),
      ...(refreshPolicy === undefined ? {} : { refreshPolicy }),
      ...(proxy === undefined ? {} : { proxy }),
    };
    store.putSource(next);
    if (typeof body['content'] === 'string' && body['content'].length > 0 && existing.kind !== 'remote') {
      store.writeSourcePayload(id, body['content']);
    }
    return c.json({ ok: true });
  });

  router.delete('/sources/:id', (c) => {
    const id = c.req.param('id');
    const existing = store.getSource(id);
    if (existing === undefined) {
      return c.json({ error: 'source-not-found' }, 404);
    }
    store.removeSource(id);
    return c.json({ ok: true, detached: builder.detachSourceRefs(id) });
  });

  router.post('/refresh', async (c) => {
    buildCache.clear();
    const remoteIds = store
      .listSources()
      .filter((source) => source.enabled && source.kind === 'remote')
      .map((source) => source.id);
    const outcome = await builder.refreshSources(remoteIds);
    return c.json({ ok: true, ...outcome });
  });

  return router;
}
