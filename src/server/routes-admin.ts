import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import {
  CAPABILITY_EVIDENCE,
  CLIENT_TARGETS,
  CORE_VERSION,
  SOURCE_FORMATS,
  TARGETS,
  composeCollection,
  nodeKey,
  parseNodeTransforms,
  parseRuntime,
  regionOf,
  verifiedCapabilityTables,
} from '../core/index.ts';
import type { ClientTarget, CollectionMember } from '../core/index.ts';
import { outputFilename } from '../pipeline.ts';
import { hashToken, newToken, safeEqual } from '../store/crypto.ts';
import type { PersistedSource, Store } from '../store/port.ts';
import { mapConcurrent } from './async.ts';
import { parseWebDavUrl, probeWebDav, uploadToWebDav } from './backup.ts';
import type { WebDavConfig } from './backup.ts';
import type { BuildCache } from './build-cache.ts';
import type { Builder } from './builder.ts';
import type { GeoHostInfo, GeoService } from './geo.ts';
import { HttpError, absoluteUrlOf, readJson, sendJson } from './http.ts';
import {
  EMPTY_FETCH_DEFAULTS,
  SETTING_FETCH_DEFAULTS,
  asOverlayMode,
  asString,
  asStringArray,
  buildFilter,
  fetchDefaults,
  fetchDefaultsView,
  isSourceFormat,
  isTarget,
  notifyViewOf,
  parseFetchDefaults,
  parseNotifyConfig,
  parseStoredGroups,
  parseStoredRules,
  parseWebdavConfig,
  proxyFrom,
} from './input.ts';
import type { FetchDefaults } from './input.ts';
import { sendTestNotify } from './notify.ts';
import type { NotifyConfig } from './notify.ts';
import { probeAll } from './probe.ts';
import type { ProbeSample, ProbeTarget } from './probe.ts';
import { hasRedactionMarkers, redact } from './redact.ts';
import {
  MIN_TOKEN_SECRET_LENGTH,
  commitSecretFile,
  discardSecretFile,
  stageSecretFile,
} from './secret.ts';
import { effectiveModes } from './section-overlay.ts';
import { assertPublicUrl } from './url-guard.ts';

export const ADMIN_TOKEN_SETTING_KEY = 'admin.token.hash';
export const SETTING_NOTIFY = 'notify';
export const SETTING_WEBDAV = 'webdav';
const MIN_ADMIN_TOKEN_LENGTH = 8;

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
  readonly describeOps: () => { notify: { readonly enabled: boolean; readonly channels: readonly string[] }; schedulerIntervalMs: number };
  readonly geo?: GeoService | undefined;
}

export function createAdminHandler(deps: AdminDeps) {
  const {
    store,
    buildCache,
    builder,
    dataDir,
    allowPrivate,
    publicBaseUrl,
    envTokenHash,
    secretFile,
    isSecretConfigured,
    markSecretConfigured,
    notifyConfig,
    envNotify,
    webdavConfig,
    envWebdav,
    describeOps,
    geo,
  } = deps;

  const activeAdminHash = (): string | undefined => {
    const hash = envTokenHash ?? store.getSetting(ADMIN_TOKEN_SETTING_KEY);
    return hash === undefined || hash.length === 0 ? undefined : hash;
  };
  const setupRequired = (): boolean => activeAdminHash() === undefined;
  const secretSetupRequired = (): boolean => !isSecretConfigured();

  const isAdmin = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = activeAdminHash();
    return presented.length > 0 && expected !== undefined && safeEqual(hashToken(presented), expected);
  };

  return async (req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> => {
    const method = req.method ?? 'GET';

    // 首次设置必须在统一 401 之前分流：此时还没有任何凭据可供校验。
    if (method === 'GET' && pathname === '/api/setup/status') {
      sendJson(res, 200, {
        required: setupRequired(),
        secretRequired: secretSetupRequired(),
      });
      return;
    }
    if (method === 'POST' && pathname === '/api/setup') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 400;
        sendJson(res, status, { error: status === 413 ? 'request-body-too-large' : 'invalid-json-body' });
        return;
      }
      const adminMissing = setupRequired();
      const secretMissing = secretSetupRequired();
      if (!adminMissing && !secretMissing) {
        sendJson(res, 409, { error: 'already-initialized' });
        return;
      }
      if (!adminMissing && !isAdmin(req)) {
        sendJson(res, 401, { error: 'admin-auth-required' });
        return;
      }
      const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
      const nextSecret = typeof body['secret'] === 'string' ? body['secret'].trim() : '';
      if (adminMissing && token.length < MIN_ADMIN_TOKEN_LENGTH) {
        sendJson(res, 400, { error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH });
        return;
      }
      if (secretMissing) {
        if (nextSecret.length < MIN_TOKEN_SECRET_LENGTH) {
          sendJson(res, 400, {
            error: 'secret-too-short',
            minLength: MIN_TOKEN_SECRET_LENGTH,
          });
          return;
        }
        if (secretFile === undefined) {
          sendJson(res, 500, { error: 'secret-file-unavailable' });
          return;
        }
        let staged: string | null = null;
        let rollback: (() => void) | undefined;
        try {
          staged = stageSecretFile(secretFile, nextSecret);
          rollback = store.rotateSecret(nextSecret);
          commitSecretFile(secretFile, staged);
          staged = null;
          markSecretConfigured();
        } catch (error) {
          if (staged !== null) discardSecretFile(staged);
          let reverted = true;
          if (rollback !== undefined) {
            try {
              rollback();
            } catch {
              reverted = false;
            }
          }
          const reason = error instanceof Error ? error.message : 'unknown';
          if (/unable to authenticate|bad decrypt|wrong final block length/i.test(reason)) {
            sendJson(res, 422, {
              error: 'payload-undecryptable',
              hint: '已有正文无法用新密钥解密：请先用原 STARTRAILS_TOKEN_SECRET 启动，或从备份恢复',
            });
          } else if (!reverted) {
            sendJson(res, 500, {
              error: 'secret-file-desync',
              reason: redact(reason).slice(0, 160),
              hint: '数据库已切到新密钥但密钥文件未写入：重启前把密钥文件内容改成刚才设置的密钥，或用 STARTRAILS_TOKEN_SECRET 启动，否则已有正文将无法解密',
            });
          } else {
            sendJson(res, 500, {
              error: 'secret-persist-failed',
              reason: redact(reason).slice(0, 160),
            });
          }
          return;
        }
      }
      if (adminMissing && !store.claimSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(token))) {
        sendJson(res, 409, { error: 'admin-already-initialized' });
        return;
      }
      sendJson(res, 201, { ok: true });
      return;
    }

    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'admin-auth-required' });
      return;
    }

    if (secretSetupRequired()) {
      sendJson(res, 503, {
        error: 'secret-setup-required',
        hint: '先在登录页设置数据加密密钥（或部署 STARTRAILS_TOKEN_SECRET）',
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const requested = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(requested) ?? builder.findProfile('default');
      sendJson(res, 200, {
        version: definition === undefined ? builder.instanceVersion() : builder.configVersion(definition.id),
        coreVersion: CORE_VERSION,
        sources: store.listSources().map(builder.sourceView),
        collections: store.listCollections().map((collection) => ({
          ...collection,
          previewCount: composeCollection(collection, builder.offlineNodesOf(collection)).nodes.length,
        })),
        profiles: store.listProfiles(),
        annotations: definition === undefined ? [] : store.listAnnotations(definition.id),
        tokens: store.listTokens().map((token) => ({
          id: token.id,
          profile: token.profile,
          target: token.target,
          revoked: token.revoked,
          createdAt: token.createdAt,
          url:
            token.token === undefined
              ? null
              : absoluteUrlOf(
                  req,
                  token.target === 'auto'
                    ? `/s/${token.token}`
                    : `/s/${token.token}/${encodeURIComponent(token.profile)}/${token.target}`,
                  '',
                  publicBaseUrl,
                ),
        })),
        targets: CLIENT_TARGETS,
        sourceFormats: SOURCE_FORMATS,
        clientTargets: TARGETS.map((item) => ({
          id: item.id,
          name: item.name,
          dialect: item.dialect,
          fileExtension: item.fileExtension,
          contentMode: item.contentMode,
          basis: item.basis,
          independentEvidence: item.independentEvidence,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/nodes') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const state = await builder.prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
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

      sendJson(res, 200, {
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
      return;
    }

    if (method === 'GET' && pathname === '/api/geo/status') {
      if (geo === undefined) {
        sendJson(res, 200, {
          available: false,
          geoDir: join(dataDir, 'geo'),
          updatedAt: null,
          source: 'sapics/ip-location-db',
          counts: { countryV4: 0, countryV6: 0, asnV4: 0, asnV6: 0 },
          bytes: 0,
          filesPresent: [],
        });
        return;
      }
      sendJson(res, 200, geo.status());
      return;
    }

    if (method === 'POST' && pathname === '/api/geo/update') {
      if (geo === undefined) {
        sendJson(res, 501, { error: 'geo-service-unavailable' });
        return;
      }
      try {
        const status = await geo.update();
        sendJson(res, 200, { ok: true, status });
      } catch (error) {
        sendJson(res, 502, {
          error: 'geo-update-failed',
          reason: error instanceof Error ? redact(error.message).slice(0, 160) : 'unknown',
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/sources/inspect') {
      const sources = store.listSources();
      const results = await mapConcurrent(sources, 4, (source) => builder.inspectSource(source));
      sendJson(res, 200, { sources: results });
      return;
    }

    if (method === 'GET' && pathname === '/api/collections') {
      const collections = store.listCollections();
      sendJson(res, 200, {
        collections: collections.map((collection) => ({
          ...collection,
          previewCount: composeCollection(collection, builder.offlineNodesOf(collection)).nodes.length,
        })),
      });
      return;
    }

    if (pathname === '/api/collections' && method === 'POST') {
      const body = await readJson(req);
      const name = asString(body['name']);
      if (name === undefined) {
        sendJson(res, 400, { error: 'name-required' });
        return;
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
      sendJson(res, 201, { id, name, members: members.length });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/collections/')) {
      const id = decodeURIComponent(pathname.slice('/api/collections/'.length));
      store.removeCollection(id);
      sendJson(res, 200, { ok: true, detached: { profiles: builder.detachCollectionRefs(id) } });
      return;
    }

    if (pathname === '/api/rules') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const rules = store.listRules(definition.id);
        const modes = effectiveModes(definition, store.listGroupOverrides(definition.id).length > 0, rules.length > 0);
        sendJson(res, 200, { rules, mode: modes.rules, placement: modes.rulePlacement });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const rules = body['rules'];
        if (!Array.isArray(rules)) {
          sendJson(res, 400, { error: 'rules-must-be-array' });
          return;
        }
        const parsed = parseStoredRules(rules);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-rules' });
          return;
        }
        store.replaceRules(definition.id, parsed);
        const requested = asOverlayMode(body['mode']);
        if (requested !== undefined) {
          const current = effectiveModes(
            definition,
            store.listGroupOverrides(definition.id).length > 0,
            parsed.length > 0,
          );
          const placement = body['placement'] === 'before' ? 'before' : body['placement'] === 'after' ? 'after' : current.rulePlacement;
          store.putSectionModes(definition.id, { ...current, rules: requested, rulePlacement: placement });
        }
        sendJson(res, 200, { count: parsed.length });
        return;
      }
    }

    if (pathname === '/api/policy-groups') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const state = await builder.prepareState(profileName);
        if (state === null) {
          sendJson(res, 404, { error: 'profile-not-found' });
          return;
        }
        const base = builder.composeProfile(definition, state.snapshots).profile;
        const overrides = store.listGroupOverrides(definition.id);
        const modes = effectiveModes(definition, overrides.length > 0, store.listRules(definition.id).length > 0);
        sendJson(res, 200, {
          mode: modes.groups,
          groupIcons: modes.groupIcons ?? 'off',
          groups: overrides,
          base: base.policyGroups,
        });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const groups = body['groups'];
        if (!Array.isArray(groups)) {
          sendJson(res, 400, { error: 'groups-must-be-array' });
          return;
        }
        const parsedGroups = parseStoredGroups(groups);
        store.replaceGroupOverrides(definition.id, parsedGroups);
        const requested = asOverlayMode(body['mode']);
        const requestedIcons =
          body['groupIcons'] === 'auto' ? 'auto' : body['groupIcons'] === 'off' ? 'off' : undefined;
        if (requested !== undefined || requestedIcons !== undefined) {
          const current = effectiveModes(definition, parsedGroups.length > 0, store.listRules(definition.id).length > 0);
          store.putSectionModes(definition.id, {
            ...current,
            ...(requested === undefined ? {} : { groups: requested }),
            ...(requestedIcons === undefined ? {} : { groupIcons: requestedIcons }),
          });
        }
        sendJson(res, 200, { count: parsedGroups.length });
        return;
      }
    }

    if (method === 'GET' && pathname === '/api/trace') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const state = await builder.prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      sendJson(res, 200, {
        configVersion: state.configVersion,
        steps: (await builder.buildFromSnapshots(state, 'surge', undefined, false)).trace.steps,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/capabilities') {
      sendJson(res, 200, { evidence: CAPABILITY_EVIDENCE });
      return;
    }

    if (method === 'GET' && pathname === '/api/diagnostics') {
      const buildId = url.searchParams.get('buildId');
      if (buildId !== null) {
        const report = store.getBuildReport(buildId);
        if (report === undefined) {
          sendJson(res, 404, { error: 'build-not-found' });
        } else {
          sendJson(res, 200, {
            ...report,
            report: { ...report.report, diagnostics: builder.redacted(report.report.diagnostics) },
          });
        }
        return;
      }
      sendJson(res, 200, {
        reports: store.listBuildReports(10).map((report) => ({
          buildId: report.buildId,
          target: report.target,
          createdAt: report.createdAt,
          skipped: report.report.skipped,
          passed: report.report.passed,
        })),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/preview') {
      const target = url.searchParams.get('target') ?? 'surge';
      const profileName = url.searchParams.get('profile') ?? 'default';
      if (!isTarget(target)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      const state = await builder.prepareState(profileName);
      if (state === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const built = await builder.buildFromSnapshots(state, target);
      const output = built.output;
      sendJson(res, 200, {
        target,
        filename: outputFilename(target),
        content: output.content,
        trace: built.trace,
        report: {
          ...output.report,
          diagnostics: builder.redacted([...built.diagnostics, ...output.report.diagnostics]),
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/sources') {
      const body = await readJson(req);
      const kindRaw = asString(body['kind']) ?? 'remote';
      const kind = kindRaw === 'file' || kindRaw === 'inline' ? kindRaw : 'remote';
      const sourceUrl = asString(body['url']);
      const content = typeof body['content'] === 'string' ? body['content'] : undefined;

      if (kind === 'remote' && sourceUrl === undefined) {
        sendJson(res, 400, { error: 'url-required' });
        return;
      }
      if (kind !== 'remote' && (content === undefined || content.trim().length === 0)) {
        sendJson(res, 400, { error: 'content-required' });
        return;
      }
      if (sourceUrl !== undefined && hasRedactionMarkers(sourceUrl)) {
        sendJson(res, 400, {
          error: 'redacted-url-rejected',
          hint: '链接里是脱敏值，请粘贴完整订阅链接',
        });
        return;
      }
      if (kind === 'remote' && sourceUrl !== undefined) {
        try {
          await assertPublicUrl(sourceUrl, { allowPrivate });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : 'unsafe-url' });
          return;
        }
      }

      const formatRaw = asString(body['format']);
      if (formatRaw !== undefined && formatRaw !== '' && !isSourceFormat(formatRaw)) {
        sendJson(res, 400, { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' });
        return;
      }
      const format = formatRaw !== undefined && isSourceFormat(formatRaw) ? formatRaw : undefined;
      const ua = asString(body['ua']);
      const refreshPolicy = asString(body['refreshPolicy']);
      const proxy = proxyFrom(body['proxy']);
      if (!proxy.ok) {
        sendJson(res, 400, { error: 'invalid-proxy-url', hint: 'expect http://, https:// or socks5://host:port' });
        return;
      }
      if (proxy.value !== undefined && hasRedactionMarkers(proxy.value)) {
        sendJson(res, 400, { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' });
        return;
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
      sendJson(res, 201, {
        id,
        name,
        kind,
        url: source.url ?? null,
        attached,
      });
      return;
    }

    if (method === 'POST' && /^\/api\/sources\/[^/]+\/refresh$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice('/api/sources/'.length, -'/refresh'.length));
      const source = store.getSource(id);
      if (source === undefined) {
        sendJson(res, 404, { error: 'source-not-found' });
        return;
      }
      if (source.kind !== 'remote') {
        sendJson(res, 400, { error: 'source-not-remote' });
        return;
      }
      const outcome = await builder.refreshSources([id]);
      const updated = store.getSource(id);
      sendJson(res, 200, {
        ...outcome,
        lastError: updated?.lastError ?? null,
        userinfo: updated?.userinfo ?? null,
        lastFetchedAt: updated?.lastFetchedAt ?? null,
      });
      return;
    }

    if (pathname.startsWith('/api/sources/')) {
      const rest = pathname.slice('/api/sources/'.length);
      const [rawId, action] = rest.split('/');
      const id = decodeURIComponent(rawId ?? '');
      const existing = store.getSource(id);
      if (existing === undefined) {
        sendJson(res, 404, { error: 'source-not-found' });
        return;
      }
      if (method === 'GET' && action === 'preview') {
        sendJson(res, 200, await builder.inspectSource(existing));
        return;
      }
      if (method === 'GET' && action === undefined) {
        sendJson(res, 200, {
          source: builder.sourceView(existing),
          content: existing.kind === 'remote' ? null : (store.readSourcePayload(id) ?? ''),
        });
        return;
      }
      if (method === 'PUT' && action === undefined) {
        const body = await readJson(req);
        const urlProvided = 'url' in body;
        const nextUrl = urlProvided ? asString(body['url']) : existing.url;
        if (existing.kind === 'remote' && urlProvided && nextUrl === undefined) {
          sendJson(res, 400, { error: 'url-required' });
          return;
        }
        if (urlProvided && nextUrl !== undefined && hasRedactionMarkers(nextUrl)) {
          sendJson(res, 400, {
            error: 'redacted-url-rejected',
            hint: '链接里是脱敏值（可能被旧版页面写坏过），请在编辑抽屉重新粘贴完整订阅链接',
          });
          return;
        }
        if (existing.kind === 'remote' && nextUrl !== undefined && nextUrl !== existing.url) {
          try {
            await assertPublicUrl(nextUrl, { allowPrivate });
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : 'unsafe-url' });
            return;
          }
        }
        const name = 'name' in body ? asString(body['name']) : existing.name;
        if (name === undefined) {
          sendJson(res, 400, { error: 'name-required' });
          return;
        }
        if ('enabled' in body && typeof body['enabled'] !== 'boolean') {
          sendJson(res, 400, { error: 'invalid-enabled', hint: 'enabled 只能是布尔值' });
          return;
        }
        let format = existing.format;
        if ('format' in body) {
          const raw = asString(body['format']);
          if (raw !== undefined && !isSourceFormat(raw)) {
            sendJson(res, 400, { error: 'invalid-source-format', hint: '格式须为已支持的方言，或留空自动识别' });
            return;
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
            sendJson(res, 400, {
              error: 'invalid-proxy-url',
              hint: 'expect http://, https:// or socks5://host:port',
            });
            return;
          }
          if (parsed.value !== undefined && hasRedactionMarkers(parsed.value)) {
            sendJson(res, 400, { error: 'redacted-proxy-rejected', hint: '代理地址里是脱敏值，请重新粘贴完整地址' });
            return;
          }
          proxy = parsed.value;
        }
        if ('content' in body && existing.kind !== 'remote') {
          const content = body['content'];
          if (typeof content !== 'string' || content.trim().length === 0) {
            sendJson(res, 400, { error: 'content-required' });
            return;
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
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'DELETE' && action === undefined) {
        store.removeSource(id);
        sendJson(res, 200, { ok: true, detached: builder.detachSourceRefs(id) });
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/profiles') {
      const body = await readJson(req);
      const name = asString(body['name']);
      if (name === undefined) {
        sendJson(res, 400, { error: 'name-required' });
        return;
      }
      const entries: { kind: 'source' | 'collection'; id: string }[] = [];
      if (Array.isArray(body['entries'])) {
        for (const entry of body['entries']) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const id = asString(record['id']);
          const kind = record['kind'] === 'collection' ? 'collection' : 'source';
          if (id !== undefined) entries.push({ kind, id });
        }
      } else {
        for (const id of asStringArray(body['sourceIds'])) entries.push({ kind: 'source', id });
      }
      const id = asString(body['id']) ?? name;
      const nameTaken = store.listProfiles().some((profile) => profile.name === name && profile.id !== id);
      if (nameTaken) {
        sendJson(res, 409, { error: 'profile-name-taken', hint: '已有同名配置' });
        return;
      }
      const previous = store.listProfiles().find((profile) => profile.id === id);
      const existed = previous !== undefined;
      store.putProfile({ id, name, entries });
      if (existed && previous.name !== name) {
        store.renameTokenProfile(previous.name, name);
      }
      sendJson(res, 201, { name, id, entries: entries.length, created: !existed, renamed: existed && previous.name !== name });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
      const name = decodeURIComponent(pathname.slice('/api/profiles/'.length));
      const profile = builder.findProfile(name);
      if (profile === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (store.listProfiles().length <= 1) {
        sendJson(res, 409, { error: 'last-profile', hint: '至少要保留一个 Profile' });
        return;
      }
      const detached = {
        rules: store.listRules(profile.id).length,
        annotations: store.listAnnotations(profile.id).length,
        groupOverrides: store.listGroupOverrides(profile.id).length,
      };
      store.removeProfile(profile.id);
      const affected = store.listTokens().filter((token) => token.profile === profile.name && !token.revoked);
      for (const token of affected) store.revokeToken(token.id);
      sendJson(res, 200, { ok: true, detached, revoked: affected.length });
      return;
    }

    if (method === 'POST' && pathname === '/api/annotations') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      const body = await readJson(req);
      const key = asString(body['nodeKey']);
      if (key === undefined) {
        sendJson(res, 400, { error: 'nodeKey-required' });
        return;
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
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/node-transforms') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { transforms: store.listNodeTransforms(definition.id) });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        try {
          const parsed = parseNodeTransforms(body['transforms'] ?? []);
          store.replaceNodeTransforms(definition.id, parsed);
          sendJson(res, 200, { ok: true, transforms: parsed });
        } catch (error) {
          sendJson(res, 400, {
            error: 'invalid-node-transforms',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/tokens') {
      const body = await readJson(req);
      const profileName = asString(body['profile']) ?? 'default';
      const target = asString(body['target']) ?? '';
      if (target !== 'auto' && !isTarget(target)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (
        definition.entries.length === 0 &&
        store.listRules(definition.id).length === 0 &&
        store.listGroupOverrides(definition.id).length === 0
      ) {
        sendJson(res, 409, {
          error: 'profile-empty',
          hint: '当前 Profile 没有任何内容：先在订阅源页把源加入构成并保存，再签发地址',
        });
        return;
      }
      const token = newToken();
      const id = randomUUID();
      const resolvedTarget: ClientTarget | 'auto' = isTarget(target) ? target : 'auto';
      store.createToken({
        id,
        tokenHash: hashToken(token),
        token,
        profile: profileName,
        target: resolvedTarget,
        revoked: false,
        createdAt: new Date().toISOString(),
      });
      const path =
        resolvedTarget === 'auto'
          ? `/s/${token}`
          : `/s/${token}/${encodeURIComponent(profileName)}/${resolvedTarget}`;
      sendJson(res, 201, {
        id,
        token,
        url: absoluteUrlOf(req, path, '', publicBaseUrl),
        path,
        target: resolvedTarget,
        profile: profileName,
      });
      return;
    }

    if (method === 'DELETE' && pathname.startsWith('/api/tokens/')) {
      store.revokeToken(decodeURIComponent(pathname.slice('/api/tokens/'.length)));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/refresh') {
      buildCache.clear();
      const remoteIds = store
        .listSources()
        .filter((source) => source.enabled && source.kind === 'remote')
        .map((source) => source.id);
      const outcome = await builder.refreshSources(remoteIds);
      sendJson(res, 200, { ok: true, ...outcome });
      return;
    }

    if (method === 'POST' && pathname === '/api/backup') {
      const destination = join(dataDir, 'backup', `startrails-${Date.now()}.db`);
      await store.backup(destination);
      sendJson(res, 200, { destination });
      return;
    }

    if (method === 'POST' && pathname === '/api/backup/remote') {
      const webdav = webdavConfig();
      if (webdav === undefined || parseWebDavUrl(webdav.url) === null) {
        sendJson(res, 501, {
          error: 'webdav-not-configured',
          hint: '在设置页配置 WebDAV，或设置 STARTRAILS_WEBDAV_URL（可选 _USER / _PASS）',
        });
        return;
      }
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const destination = join(dataDir, 'backup', `startrails-${stamp}.db`);
      await store.backup(destination);
      try {
        const outcome = await uploadToWebDav(webdav, destination, basename(destination));
        sendJson(res, 200, { ok: true, ...outcome, local: destination });
      } catch (error) {
        sendJson(res, 502, {
          error: 'webdav-upload-failed',
          reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
          local: destination,
        });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/probe') {
      const body = await readJson(req);
      const profileName = asString(body['profile']) ?? store.listProfiles()[0]?.name ?? 'default';
      const probeState = await builder.prepareState(profileName);
      if (probeState === null) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
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
      sendJson(res, 200, {
        note: 'TCP 握手延迟（主控机 → 节点 server:port），不是代理链路测速，也不代表落地出口质量',
        samples,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/token') {
      if (envTokenHash !== undefined) {
        sendJson(res, 409, {
          error: 'admin-token-from-env',
          hint: '管理令牌来自环境变量 STARTRAILS_ADMIN_TOKEN，请在部署侧修改后重启',
        });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'invalid-json-body' });
        return;
      }
      const next = typeof body['token'] === 'string' ? body['token'].trim() : '';
      if (next.length < MIN_ADMIN_TOKEN_LENGTH) {
        sendJson(res, 400, { error: 'admin-token-too-short', minLength: MIN_ADMIN_TOKEN_LENGTH });
        return;
      }
      const current = activeAdminHash();
      if (current !== undefined && safeEqual(hashToken(next), current)) {
        sendJson(res, 400, { error: 'admin-token-unchanged' });
        return;
      }
      store.putSetting(ADMIN_TOKEN_SETTING_KEY, hashToken(next));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings/notify/test') {
      let body: Record<string, unknown> = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const candidate = body['notify'];
      const config =
        candidate === null || candidate === undefined ? notifyConfig() : (parseNotifyConfig(candidate) ?? undefined);
      if (config === undefined) {
        sendJson(res, 400, {
          error: 'notify-not-configured',
          hint: '先填 Telegram Bot Token + Chat ID，或 Bark 地址',
        });
        return;
      }
      const results = await sendTestNotify(config);
      const ok = results.length > 0 && results.every((item) => item.ok);
      sendJson(res, ok ? 200 : 502, { ok, results });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings/webdav/test') {
      let body: Record<string, unknown> = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const candidate = body['webdav'];
      let config: WebDavConfig | undefined;
      if (candidate !== undefined && candidate !== null) {
        config = parseWebdavConfig(candidate, webdavConfig()) ?? undefined;
        if (config === undefined) {
          sendJson(res, 400, { error: 'invalid-webdav-config' });
          return;
        }
      } else {
        config = webdavConfig();
      }
      if (config === undefined || parseWebDavUrl(config.url) === null) {
        sendJson(res, 400, { error: 'webdav-not-configured', hint: '先填写 WebDAV 地址' });
        return;
      }
      try {
        const probe = await probeWebDav(config);
        sendJson(res, probe.ok ? 200 : 502, probe);
      } catch (error) {
        sendJson(res, 502, {
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message.slice(0, 160) : 'webdav-unreachable',
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/ops') {
      const ops = describeOps();
      sendJson(res, 200, {
        notify: ops.notify,
        webdav: { configured: parseWebDavUrl(webdavConfig()?.url) !== null },
        scheduler: { intervalMs: ops.schedulerIntervalMs },
      });
      return;
    }

    if (pathname === '/api/runtime') {
      const profileName = url.searchParams.get('profile') ?? 'default';
      const definition = builder.findProfile(profileName);
      if (definition === undefined) {
        sendJson(res, 404, { error: 'profile-not-found' });
        return;
      }
      if (method === 'GET') {
        const modes = effectiveModes(
          definition,
          store.listGroupOverrides(definition.id).length > 0,
          store.listRules(definition.id).length > 0,
        );
        sendJson(res, 200, {
          runtime: definition.runtime ?? null,
          dnsMode: modes.dns,
          targets: Object.fromEntries(
            CLIENT_TARGETS.map((target) => [target, verifiedCapabilityTables.runtime[target]]),
          ),
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['runtime'];
        if (candidate === null || candidate === undefined) {
          store.putProfileRuntime(definition.id, null);
          const requested = asOverlayMode(body['dnsMode']);
          if (requested !== undefined) {
            const current = effectiveModes(
              definition,
              store.listGroupOverrides(definition.id).length > 0,
              store.listRules(definition.id).length > 0,
            );
            store.putSectionModes(definition.id, { ...current, dns: requested });
          }
          sendJson(res, 200, { ok: true, runtime: null });
          return;
        }
        try {
          const parsed = parseRuntime(candidate);
          store.putProfileRuntime(definition.id, parsed);
          const requested = asOverlayMode(body['dnsMode']);
          if (requested !== undefined) {
            const current = effectiveModes(
              definition,
              store.listGroupOverrides(definition.id).length > 0,
              store.listRules(definition.id).length > 0,
            );
            store.putSectionModes(definition.id, { ...current, dns: requested });
          }
          sendJson(res, 200, { ok: true, runtime: parsed });
        } catch (error) {
          sendJson(res, 400, {
            error: 'invalid-runtime-policy',
            detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
        return;
      }
    }

    if (pathname === '/api/settings/notify') {
      if (method === 'GET') {
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
        sendJson(res, 200, {
          value: stored,
          envDefaults: envNotify ?? null,
          effective: active ?? null,
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['notify'];
        if (candidate === null || candidate === undefined) {
          store.putSetting(SETTING_NOTIFY, 'null');
          sendJson(res, 200, { ok: true, value: null });
          return;
        }
        const parsed = parseNotifyConfig(candidate);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-notify-config' });
          return;
        }
        store.putSetting(SETTING_NOTIFY, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, value: notifyViewOf(parsed) });
        return;
      }
    }

    if (pathname === '/api/settings/webdav') {
      if (method === 'GET') {
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
        sendJson(res, 200, {
          value,
          envDefaults:
            envWebdav === undefined
              ? null
              : { url: envWebdav.url, hasPassword: envWebdav.password !== undefined },
          effective: active === undefined ? null : { url: active.url, hasCredentials: active.username !== undefined },
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['webdav'];
        if (candidate === null || candidate === undefined) {
          store.putSetting(SETTING_WEBDAV, 'null');
          sendJson(res, 200, { ok: true, webdav: null });
          return;
        }
        const existing = webdavConfig();
        const parsed = parseWebdavConfig(candidate, existing);
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-webdav-config' });
          return;
        }
        store.putSetting(SETTING_WEBDAV, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, webdav: { url: parsed.url, hasCredentials: parsed.username !== undefined } });
        return;
      }
    }

    if (pathname === '/api/settings/fetch-defaults') {
      if (method === 'GET') {
        const raw = store.getSetting(SETTING_FETCH_DEFAULTS);
        let stored: FetchDefaults = EMPTY_FETCH_DEFAULTS;
        if (raw !== undefined && raw !== 'null') {
          try {
            stored = parseFetchDefaults(JSON.parse(raw)) ?? EMPTY_FETCH_DEFAULTS;
          } catch {
            stored = EMPTY_FETCH_DEFAULTS;
          }
        }
        sendJson(res, 200, {
          value: raw === undefined || raw === 'null' ? null : fetchDefaultsView(stored),
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const candidate = body['defaults'];
        if (candidate === null || candidate === undefined) {
          store.putSetting(SETTING_FETCH_DEFAULTS, 'null');
          sendJson(res, 200, { ok: true, value: null });
          return;
        }
        const parsed = parseFetchDefaults(candidate, fetchDefaults(store));
        if (parsed === null) {
          sendJson(res, 400, { error: 'invalid-fetch-defaults' });
          return;
        }
        store.putSetting(SETTING_FETCH_DEFAULTS, JSON.stringify(parsed));
        sendJson(res, 200, { ok: true, value: fetchDefaultsView(parsed) });
        return;
      }
    }

    sendJson(res, 404, { error: 'unknown-api-route' });
  };
}
