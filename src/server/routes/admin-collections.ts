import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { composeCollection } from '../../core/index.ts';
import type { CollectionMember } from '../../core/index.ts';
import type { AppEnv } from '../http.ts';
import { readJsonObject } from '../http.ts';
import { asString, buildFilter } from '../input.ts';
import type { AdminDeps } from './admin-context.ts';

export function collectionsRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, builder } = deps;

  router.get('/collections', (c) => {
    const collections = store.listCollections();
    return c.json({
      collections: collections.map((collection) => ({
        ...collection,
        previewCount: composeCollection(collection, builder.offlineNodesOf(collection)).nodes.length,
      })),
    });
  });

  router.post('/collections', async (c) => {
    const body = await readJsonObject(c);
    const name = asString(body['name']);
    if (name === undefined) {
      return c.json({ error: 'name-required' }, 400);
    }
    const members: CollectionMember[] = [];
    for (const entry of Array.isArray(body['members']) ? body['members'] : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const sourceId = asString(record['sourceId']);
      if (sourceId === undefined) continue;
      const rawFilter = record['filter'];
      if (typeof rawFilter !== 'object' || rawFilter === null) {
        members.push({ sourceId });
        continue;
      }
      const filter = buildFilter(rawFilter as Record<string, unknown>);
      members.push(filter === undefined ? { sourceId } : { sourceId, filter });
    }
    const dedupeRaw = asString(body['dedupe']);
    const id = asString(body['id']) ?? `col-${randomUUID().slice(0, 8)}`;
    const current = store.getCollection(id);
    store.putCollection({
      id,
      name,
      members,
      dedupe: dedupeRaw === 'name' || dedupeRaw === 'none' ? dedupeRaw : 'nodeKey',
      order:
        current?.order ??
        store.listCollections().reduce((max, item) => Math.max(max, item.order), -1) + 1,
    });
    return c.json({ id, name, members: members.length }, 201);
  });

  router.delete('/collections/:id', (c) => {
    const id = c.req.param('id');
    store.removeCollection(id);
    return c.json({ ok: true, detached: { profiles: builder.detachCollectionRefs(id) } });
  });

  return router;
}
