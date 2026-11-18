import { Hono } from 'hono';
import {
  CAPABILITY_EVIDENCE,
  CLIENT_TARGETS,
  CORE_VERSION,
  SOURCE_FORMATS,
  TARGETS,
  composeCollection,
  parseRuntime,
  verifiedCapabilityTables,
} from '../../core/index.ts';
import { outputFilename } from '../../pipeline.ts';
import type { AppEnv } from '../http.ts';
import { absoluteUrlOf, readJsonObject } from '../http.ts';
import {
  asOverlayMode,
  asString,
  asStringArray,
  isTarget,
  parseStoredGroups,
  parseStoredRules,
} from '../input.ts';
import { effectiveModes } from '../section-overlay.ts';
import type { AdminDeps } from './admin-context.ts';
import { queryProfileName } from './admin-context.ts';

export function configRoutes(deps: AdminDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, builder, publicBaseUrl } = deps;

  router.get('/state', (c) => {
    const requested = queryProfileName(c);
    const definition = builder.findProfile(requested) ?? builder.findProfile('default');
    return c.json({
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
                c,
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
  });

  router.post('/profiles', async (c) => {
    const body = await readJsonObject(c);
    const name = asString(body['name']);
    if (name === undefined) {
      return c.json({ error: 'name-required' }, 400);
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
      return c.json({ error: 'profile-name-taken', hint: '已有同名配置' }, 409);
    }
    const previous = store.listProfiles().find((profile) => profile.id === id);
    const existed = previous !== undefined;
    store.putProfile({ id, name, entries });
    if (existed && previous.name !== name) {
      store.renameTokenProfile(previous.name, name);
    }
    return c.json(
      {
        name,
        id,
        entries: entries.length,
        created: !existed,
        renamed: existed && previous.name !== name,
      },
      201,
    );
  });

  router.delete('/profiles/:name', (c) => {
    const name = c.req.param('name');
    const profile = builder.findProfile(name);
    if (profile === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    if (store.listProfiles().length <= 1) {
      return c.json({ error: 'last-profile', hint: '至少要保留一个 Profile' }, 409);
    }
    const detached = {
      rules: store.listRules(profile.id).length,
      annotations: store.listAnnotations(profile.id).length,
      groupOverrides: store.listGroupOverrides(profile.id).length,
    };
    store.removeProfile(profile.id);
    const affected = store.listTokens().filter((token) => token.profile === profile.name && !token.revoked);
    for (const token of affected) store.revokeToken(token.id);
    return c.json({ ok: true, detached, revoked: affected.length });
  });

  router.get('/rules', (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const rules = store.listRules(definition.id);
    const modes = effectiveModes(definition, store.listGroupOverrides(definition.id).length > 0, rules.length > 0);
    return c.json({ rules, mode: modes.rules, placement: modes.rulePlacement });
  });

  router.post('/rules', async (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const body = await readJsonObject(c);
    const rules = body['rules'];
    if (!Array.isArray(rules)) {
      return c.json({ error: 'rules-must-be-array' }, 400);
    }
    const parsed = parseStoredRules(rules);
    if (parsed === null) {
      return c.json({ error: 'invalid-rules' }, 400);
    }
    store.replaceRules(definition.id, parsed);
    const requested = asOverlayMode(body['mode']);
    if (requested !== undefined) {
      const current = effectiveModes(
        definition,
        store.listGroupOverrides(definition.id).length > 0,
        parsed.length > 0,
      );
      const placement =
        body['placement'] === 'before'
          ? 'before'
          : body['placement'] === 'after'
            ? 'after'
            : current.rulePlacement;
      store.putSectionModes(definition.id, { ...current, rules: requested, rulePlacement: placement });
    }
    return c.json({ count: parsed.length });
  });

  router.get('/policy-groups', async (c) => {
    const profileName = queryProfileName(c);
    const definition = builder.findProfile(profileName);
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const state = await builder.prepareState(profileName);
    if (state === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const base = builder.composeProfile(definition, state.snapshots).profile;
    const overrides = store.listGroupOverrides(definition.id);
    const modes = effectiveModes(definition, overrides.length > 0, store.listRules(definition.id).length > 0);
    return c.json({
      mode: modes.groups,
      groupIcons: modes.groupIcons ?? 'off',
      groups: overrides,
      base: base.policyGroups,
    });
  });

  router.post('/policy-groups', async (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const body = await readJsonObject(c);
    const groups = body['groups'];
    if (!Array.isArray(groups)) {
      return c.json({ error: 'groups-must-be-array' }, 400);
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
    return c.json({ count: parsedGroups.length });
  });

  router.get('/runtime', (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const modes = effectiveModes(
      definition,
      store.listGroupOverrides(definition.id).length > 0,
      store.listRules(definition.id).length > 0,
    );
    return c.json({
      runtime: definition.runtime ?? null,
      dnsMode: modes.dns,
      targets: Object.fromEntries(
        CLIENT_TARGETS.map((target) => [target, verifiedCapabilityTables.runtime[target]]),
      ),
    });
  });

  router.put('/runtime', async (c) => {
    const definition = builder.findProfile(queryProfileName(c));
    if (definition === undefined) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const body = await readJsonObject(c);
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
      return c.json({ ok: true, runtime: null });
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
      return c.json({ ok: true, runtime: parsed });
    } catch (error) {
      return c.json(
        {
          error: 'invalid-runtime-policy',
          detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
        400,
      );
    }
  });

  router.get('/trace', async (c) => {
    const state = await builder.prepareState(queryProfileName(c));
    if (state === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    return c.json({
      configVersion: state.configVersion,
      steps: (await builder.buildFromSnapshots(state, 'surge', undefined, false)).trace.steps,
    });
  });

  router.get('/capabilities', (c) => c.json({ evidence: CAPABILITY_EVIDENCE }));

  router.get('/diagnostics', (c) => {
    const buildId = c.req.query('buildId');
    if (buildId !== undefined) {
      const report = store.getBuildReport(buildId);
      if (report === undefined) {
        return c.json({ error: 'build-not-found' }, 404);
      }
      return c.json({
        ...report,
        report: { ...report.report, diagnostics: builder.redacted(report.report.diagnostics) },
      });
    }
    return c.json({
      reports: store.listBuildReports(10).map((report) => ({
        buildId: report.buildId,
        target: report.target,
        createdAt: report.createdAt,
        skipped: report.report.skipped,
        passed: report.report.passed,
      })),
    });
  });

  router.get('/preview', async (c) => {
    const target = c.req.query('target') ?? 'surge';
    const profileName = queryProfileName(c);
    if (!isTarget(target)) {
      return c.json({ error: 'unknown-target' }, 400);
    }
    const state = await builder.prepareState(profileName);
    if (state === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }
    const built = await builder.buildFromSnapshots(state, target);
    const output = built.output;
    return c.json({
      target,
      filename: outputFilename(target),
      content: output.content,
      trace: built.trace,
      report: {
        ...output.report,
        diagnostics: builder.redacted([...built.diagnostics, ...output.report.diagnostics]),
      },
    });
  });

  return router;
}
