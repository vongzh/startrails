import { join } from 'node:path';
import { Hono } from 'hono';
import { nodeKey, parseNodeTransforms, regionOf } from '../../core/index.ts';
import { mapConcurrent } from '../async.ts';
import type { GeoHostInfo } from '../geo.ts';
import type { AppEnv } from '../http.ts';
import { readJsonObject } from '../http.ts';
import { asString } from '../input.ts';
import { probeAll } from '../probe.ts';
import type { ProbeSample, ProbeTarget } from '../probe.ts';
import { redact } from '../redact.ts';
import type { AdminDeps } from './admin-context.ts';
import { queryProfileName } from './admin-context.ts';

export function nodesRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, builder, dataDir, geo } = deps;

  router.get('/nodes', async (c) => {
    const profileName = queryProfileName(c);
    const definition = builder.findProfile(profileName);
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const state = await builder.prepareState(profileName);
    if (state === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const composed = builder.composeProfile(definition, state.snapshots);
    const orderByKey = new Map<string, number>();
    const regionByKey = new Map<string, string>();
    for (const annotation of store.listAnnotations(definition.id)) {
      if (annotation.order !== undefined) orderByKey.set(annotation.nodeKey, annotation.order);
      if (annotation.region !== undefined && annotation.region.length > 0) {
        regionByKey.set(annotation.nodeKey, annotation.region);
      }
    }
    const orderedNodes = composed.profile.nodes
      .map((node, index) => ({ node, sortOrder: orderByKey.get(nodeKey(node)) ?? index }))
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((entry) => entry.node);

    const geoByServer = new Map<string, GeoHostInfo>();
    if (geo !== undefined && geo.status().available) {
      const uniqueServers = [...new Set(orderedNodes.map((node) => node.server))].slice(0, 200);
      const resolved = await mapConcurrent(uniqueServers, 8, (server) => geo.lookupHost(server));
      for (let i = 0; i < uniqueServers.length; i += 1) {
        const server = uniqueServers[i];
        const info = resolved[i];
        if (server !== undefined && info !== undefined) geoByServer.set(server, info);
      }
    }

    return c.json({
      configVersion: state.configVersion,
      nodes: orderedNodes.map((node) => {
        const key = nodeKey(node);
        const manualRegion = regionByKey.get(key);
        const nameRegion = regionOf(node.name);
        const ipInfo = geoByServer.get(node.server) ?? geo?.peekHost(node.server);
        const country = manualRegion ?? nameRegion ?? ipInfo?.country;
        const source: 'manual' | 'name' | 'ip' | undefined =
          manualRegion !== undefined
            ? 'manual'
            : nameRegion !== undefined
              ? 'name'
              : ipInfo?.country !== undefined
                ? 'ip'
                : undefined;
        const conflict = manualRegion === undefined && nameRegion === undefined && ipInfo?.conflict === true;
        const hasGeo = country !== undefined || ipInfo?.asn !== undefined || conflict;
        return {
          nodeKey: key,
          kind: node.kind,
          name: node.name,
          address: `${node.server}:${node.port}`,
          options: node.options ?? {},
          sources: composed.provenance.get(key) ?? [],
          ...(hasGeo
            ? {
                geo: {
                  ...(country === undefined ? {} : { country }),
                  ...(ipInfo?.asn === undefined ? {} : { asn: ipInfo.asn }),
                  ...(ipInfo?.org === undefined ? {} : { org: ipInfo.org }),
                  ...(source === undefined ? {} : { source }),
                  ...(conflict ? { conflict: true } : {}),
                },
              }
            : {}),
        };
      }),
      diagnostics: builder.redacted([...state.diagnostics, ...composed.diagnostics]),
    });
  });

  router.get('/geo/status', (c) => {
    if (geo === undefined) {
      return c.json({
        available: false,
        geoDir: join(dataDir, 'geo'),
        updatedAt: null,
        source: 'sapics/ip-location-db',
        counts: { countryV4: 0, countryV6: 0, asnV4: 0, asnV6: 0 },
        bytes: 0,
        filesPresent: [],
      });
    }
    return c.json(geo.status());
  });

  router.post('/geo/update', async (c) => {
    if (geo === undefined) {
      return c.json({ error: 'geo-service-unavailable' }, 501);
    }
    try {
      const status = await geo.update();
      return c.json({ ok: true, status });
    } catch (error) {
      return c.json(
        {
          error: 'geo-update-failed',
          reason: error instanceof Error ? redact(error.message).slice(0, 160) : 'unknown',
        },
        502,
      );
    }
  });

  router.post('/annotations', async (c) => {
    const profileName = queryProfileName(c);
    const definition = builder.findProfile(profileName);
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const body = await readJsonObject(c);
    const key = asString(body['nodeKey']);
    if (key === undefined) {
      return c.json({ error: 'nodeKey-required' }, 400);
    }
    const alias = asString(body['alias']);
    const tag = asString(body['tag']);
    const region = asString(body['region']);
    store.putAnnotation(definition.id, {
      nodeKey: key,
      ...(typeof body['excluded'] === 'boolean' ? { excluded: body['excluded'] } : {}),
      ...(alias === undefined ? {} : { alias }),
      ...(tag === undefined ? {} : { tag }),
      ...(region === undefined ? {} : { region }),
      ...(typeof body['order'] === 'number' ? { order: body['order'] } : {}),
    });
    return c.json({ ok: true });
  });

  router.get('/node-transforms', (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    return c.json({ transforms: store.listNodeTransforms(definition.id) });
  });

  router.put('/node-transforms', async (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const body = await readJsonObject(c);
    try {
      const parsed = parseNodeTransforms(body['transforms'] ?? []);
      store.replaceNodeTransforms(definition.id, parsed);
      return c.json({ ok: true, transforms: parsed });
    } catch (error) {
      return c.json(
        {
          error: 'invalid-node-transforms',
          detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
        400,
      );
    }
  });

  router.post('/probe', async (c) => {
    const body = await readJsonObject(c);
    const profileName = asString(body['profile']) ?? store.listProfiles()[0]?.name ?? 'default';
    const probeState = await builder.prepareState(profileName);
    if (probeState === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const built = await builder.buildFromSnapshots(probeState, 'surge', undefined, false);
    const groups = new Map<
      string,
      {
        readonly target: ProbeTarget;
        readonly members: {
          readonly nodeKey: string;
          readonly name: string;
          readonly server: string;
          readonly port: number;
        }[];
      }
    >();
    const targets: ProbeTarget[] = [];
    for (const node of built.profile.nodes) {
      const id = `${node.kind}:${node.server}:${node.port}`;
      const key = nodeKey(node);
      const existing = groups.get(id);
      if (existing !== undefined) {
        existing.members.push({ nodeKey: key, name: node.name, server: node.server, port: node.port });
        continue;
      }
      if (targets.length >= 200) continue;
      const target: ProbeTarget = {
        nodeKey: key,
        name: node.name,
        server: node.server,
        port: node.port,
        kind: node.kind,
      };
      groups.set(id, {
        target,
        members: [{ nodeKey: key, name: node.name, server: node.server, port: node.port }],
      });
      targets.push(target);
    }
    const probed = await probeAll(targets, { timeoutMs: 1_000, attempts: 2, concurrency: 16 });
    const sampleById = new Map<string, ProbeSample>();
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const sample = probed[index];
      if (target !== undefined && sample !== undefined) {
        sampleById.set(`${target.kind}:${target.server}:${target.port}`, sample);
      }
    }
    const samples: ProbeSample[] = [];
    for (const [id, group] of groups) {
      const sample = sampleById.get(id);
      if (sample === undefined) continue;
      for (const member of group.members) {
        samples.push({
          ...sample,
          nodeKey: member.nodeKey,
          name: member.name,
          server: member.server,
          port: member.port,
        });
      }
    }
    return c.json({
      note: 'TCP 握手延迟（主控机 → 节点 server:port），不是代理链路测速，也不代表落地出口质量',
      samples,
    });
  });

  return router;
}
