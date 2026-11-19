import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  dedupeNodes,
  encodeUriSubscriptionBase64,
  ingest,
  parseProfile,
  renderQrSvg,
  verifiedCapabilityTables,
} from '../core/index.ts';
import type { ClientTarget, Diagnostic, MemberFilter } from '../core/index.ts';
import { buildOne, outputFilename } from '../pipeline.ts';
import type { BuildOutput } from '../pipeline.ts';
import { hashToken, sha256 } from '../store/crypto.ts';
import type { Store } from '../store/port.ts';
import type { BuildCache } from './build-cache.ts';
import type { Builder } from './builder.ts';
import type { AppContext, AppEnv } from './http.ts';
import { CONTENT_TYPE_BY_FORMAT, absoluteUrlOf, ifNoneMatch } from './http.ts';
import { guessTargetByUa, isUriShareClientUa, resolveTargetSpec } from './input.ts';
import { redact } from './redact.ts';
import type { RuleSetCache } from './ruleset.ts';
import { fetchSnapshot } from './url-guard.ts';

const PRUNE_INTERVAL_WRITES = 20;

export interface DeliveryDeps {
  readonly store: Store;
  readonly buildCache: BuildCache;
  readonly ruleSets: RuleSetCache;
  readonly builder: Builder;
  readonly allowPrivate: boolean;
  readonly allowStateless: boolean;
  readonly publicBaseUrl?: string | undefined;
}

export function createDeliveryApp(deps: DeliveryDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { store, buildCache, ruleSets, builder, allowPrivate, allowStateless, publicBaseUrl } = deps;
  let reportWritesSincePrune = 0;

  /**
   * 规则集镜像端点：客户端（Surge / Loon）直接来取，因此**不走管理令牌**——
   * 内容是公开的规则文本，key 是 URL 的哈希，拿到 key 也需要先知道原始 URL。
   * 上游取不到时回退旧内容；连旧内容都没有才 404。
   */
  router.get('/rules/:key', async (c) => {
    const rawKey = c.req.param('key');
    const key = rawKey.replace(/\.(txt|list|yaml|yml)$/i, '').replace(/[^0-9a-f]/gi, '');
    const entry = key.length === 0 ? undefined : ruleSets.get(key);
    if (entry === undefined) {
      return c.text('unknown-rule-set', 404);
    }
    const resolved = entry.url.length > 0 ? await ruleSets.resolve(entry.url) : entry;
    const body = resolved?.body ?? entry.body;
    if (body.length === 0) {
      return c.text('rule-set-unavailable', 502);
    }
    return c.body(body, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...(resolved?.etag === null || resolved?.etag === undefined ? {} : { etag: resolved.etag }),
    });
  });

  async function renderSubscription(
    c: AppContext,
    params: {
      readonly rawToken: string;
      readonly profileParam?: string;
      readonly targetParam?: string;
      readonly suffix?: 'qr.svg' | 'diagnostics';
    },
  ): Promise<Response> {
    const record = store.findTokenByHash(hashToken(params.rawToken));
    if (record === undefined || record.revoked) {
      return c.json({ error: 'token-invalid-or-revoked' }, 404);
    }

    const url = new URL(c.req.url);
    if (params.suffix === 'qr.svg') {
      // 二维码只编码「这个订阅地址本身」，不跑 Ingest / Plan / Emit。
      const subscriptionPath = url.pathname.replace(/\/qr\.svg$/, '');
      const targetUrl = absoluteUrlOf(c, subscriptionPath, url.search, publicBaseUrl);
      const svg = renderQrSvg(targetUrl, {
        ec: 'M',
        moduleSize: 4,
        title: `${record.profile} · 订阅二维码`,
      });
      return c.body(svg, 200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'private, max-age=300',
      });
    }

    const userAgent = c.req.header('user-agent') ?? '';
    let profileName: string;
    let target: ClientTarget;
    let explicitBase64Links = false;
    if (params.profileParam === undefined || params.targetParam === undefined) {
      profileName = record.profile;
      if (record.target !== 'auto') {
        target = record.target;
      } else {
        const guessed = guessTargetByUa(userAgent);
        if (guessed === undefined) {
          return c.json(
            {
              error: 'unknown-user-agent',
              hint: 'append /profile/target to the URL, or request with a known client UA',
            },
            400,
          );
        }
        target = guessed;
      }
    } else {
      profileName = params.profileParam;
      const spec = resolveTargetSpec(params.targetParam);
      if (spec === undefined) {
        return c.json({ error: 'unknown-target' }, 400);
      }
      target = spec.target;
      explicitBase64Links = spec.base64Links;
      if (record.profile !== profileName || (record.target !== 'auto' && record.target !== target)) {
        return c.json({ error: 'token-invalid-or-revoked' }, 404);
      }
    }

    const formatParam = (url.searchParams.get('format') ?? url.searchParams.get('encoding') ?? '').trim().toLowerCase();
    const wantsBase64Links =
      target === 'v2box' &&
      (explicitBase64Links ||
        formatParam === 'base64' ||
        (formatParam !== 'plain' && formatParam !== 'raw' && isUriShareClientUa(userAgent)));

    const state = await builder.prepareState(profileName);
    if (state === null) {
      return c.json({ error: 'profile-not-found' }, 404);
    }

    // 参数化订阅：include / exclude / prefix / limit 只作用于本次响应，不改库、不进缓存。
    const include = url.searchParams
      .getAll('include')
      .flatMap((value) => value.split(','))
      .filter((value) => value.trim().length > 0);
    const exclude = url.searchParams
      .getAll('exclude')
      .flatMap((value) => value.split(','))
      .filter((value) => value.trim().length > 0);
    const prefix = (url.searchParams.get('prefix') ?? '').trim();
    const limitRaw = Number(url.searchParams.get('limit') ?? '0');
    const queryFilter: MemberFilter | undefined =
      include.length > 0 || exclude.length > 0 || prefix.length > 0 || limitRaw > 0
        ? {
            include,
            exclude,
            ...(prefix.length === 0 ? {} : { prefix }),
            ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
          }
        : undefined;

    /** ETag 必须标识「这次真正返回的表示」，而不只是上游状态。 */
    const responseEtag = `"${sha256(
      JSON.stringify({
        state: state.etag,
        target,
        encoding: wantsBase64Links ? 'base64' : 'plain',
        suffix: params.suffix ?? 'subscription',
        filter: queryFilter ?? null,
      }),
    ).slice(0, 32)}"`;

    if (params.suffix !== 'diagnostics' && ifNoneMatch(c.req.header('if-none-match'), responseEtag)) {
      return c.body(null, 304, {
        ETag: responseEtag,
        Vary: 'User-Agent',
        'Cache-Control': 'no-cache',
      });
    }

    const cachedBuild = queryFilter === undefined ? buildCache.getL2(state.etag, target) : undefined;
    let output: BuildOutput;
    let extraDiagnostics: readonly Diagnostic[];
    if (cachedBuild !== undefined) {
      output = { target, content: cachedBuild.content, report: cachedBuild.report };
      extraDiagnostics = cachedBuild.diagnostics;
    } else {
      const built = await builder.buildFromSnapshots(state, target, queryFilter);
      const found = built.output;
      output = found;
      extraDiagnostics = built.diagnostics;
      if (queryFilter === undefined) {
        buildCache.setL2(state.etag, target, {
          content: found.content,
          report: found.report,
          diagnostics: built.diagnostics,
        });
      }
    }

    const buildId = output.report.buildId ?? randomUUID();
    store.saveBuildReport({
      buildId,
      target,
      report: output.report,
      createdAt: new Date().toISOString(),
    });
    // 节流清理：高频拉取时不每次扫描删除，攒够一批再裁剪到最近 200 次构建。
    reportWritesSincePrune += 1;
    if (reportWritesSincePrune >= PRUNE_INTERVAL_WRITES) {
      reportWritesSincePrune = 0;
      store.pruneBuildReports(200);
    }

    const definition = builder.findProfile(profileName);
    const usedSources =
      definition === undefined
        ? []
        : store
            .listSources()
            .filter((source) => builder.sourceIdsOf(builder.segmentsOf(definition)).includes(source.id));
    const traffic = builder.userinfoHeader(usedSources);
    const staleCount = state.diagnostics.filter((item) => item.reason.startsWith('upstream-stale:')).length;
    const summary = `nodes=${output.report.passed} skipped=${output.report.skipped} sources=${state.snapshots.length} stale=${staleCount}`;
    const headers: Record<string, string> = {
      ETag: responseEtag,
      Vary: 'User-Agent',
      'Cache-Control': 'no-cache',
      'X-Startrails-Build-Id': buildId,
      'X-Startrails-Skipped': String(output.report.skipped),
      'X-Startrails-Summary': summary,
      ...(traffic === null ? {} : { 'subscription-userinfo': traffic }),
    };

    if (params.suffix === 'diagnostics') {
      return c.json(
        {
          buildId,
          target,
          etag: responseEtag,
          summary,
          report: {
            ...output.report,
            diagnostics: builder.redacted([...extraDiagnostics, ...output.report.diagnostics]),
          },
        },
        200,
        headers,
      );
    }

    const contentType = CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format];
    const download = url.searchParams.get('download');
    const disposition =
      download === null || download === '0' || download === 'false'
        ? null
        : `attachment; filename="${`${profileName}-${outputFilename(target)}`
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .slice(0, 80)}"`;
    const body = wantsBase64Links ? encodeUriSubscriptionBase64(output.content) : output.content;
    return c.body(body, 200, {
      ...headers,
      'content-type': contentType,
      ...(disposition === null ? {} : { 'content-disposition': disposition }),
    });
  }

  // 两种路径形态 × 两种后缀：/s/:token 与 /s/:token/:profile/:target（后可接 /qr.svg 或 /diagnostics）
  router.get('/s/:token/qr.svg', (c) =>
    renderSubscription(c, { rawToken: c.req.param('token'), suffix: 'qr.svg' }),
  );
  router.get('/s/:token/diagnostics', (c) =>
    renderSubscription(c, { rawToken: c.req.param('token'), suffix: 'diagnostics' }),
  );
  router.get('/s/:token', (c) =>
    renderSubscription(c, { rawToken: c.req.param('token') }),
  );
  router.get('/s/:token/:profile/:target/qr.svg', (c) =>
    renderSubscription(c, {
      rawToken: c.req.param('token'),
      profileParam: c.req.param('profile'),
      targetParam: c.req.param('target'),
      suffix: 'qr.svg',
    }),
  );
  router.get('/s/:token/:profile/:target/diagnostics', (c) =>
    renderSubscription(c, {
      rawToken: c.req.param('token'),
      profileParam: c.req.param('profile'),
      targetParam: c.req.param('target'),
      suffix: 'diagnostics',
    }),
  );
  router.get('/s/:token/:profile/:target', (c) =>
    renderSubscription(c, {
      rawToken: c.req.param('token'),
      profileParam: c.req.param('profile'),
      targetParam: c.req.param('target'),
    }),
  );
  router.all('/s/*', (c) => c.json({ error: 'invalid-subscription-path' }, 404));

  /**
   * 无状态一次性转换：`GET /sub?url=<订阅地址>&target=<客户端>`。
   */
  router.get('/sub', async (c) => {
    if (!allowStateless) {
      return c.json(
        {
          error: 'stateless-disabled',
          hint: 'GET /sub?url=&target= is off by default; enable allowStateless to open it',
        },
        404,
      );
    }
    const rawUrl = (c.req.query('url') ?? '').trim();
    if (rawUrl.length === 0) {
      return c.json({ error: 'missing-url' }, 400);
    }
    const userAgent = c.req.header('user-agent') ?? '';
    const rawTarget = (c.req.query('target') ?? 'auto').trim();
    let target: ClientTarget;
    let explicitBase64Links = false;
    if (rawTarget.length === 0 || rawTarget === 'auto') {
      const guessed = guessTargetByUa(userAgent);
      if (guessed === undefined) {
        return c.json(
          { error: 'unknown-target', hint: 'pass ?target=<client> or use a known client UA' },
          400,
        );
      }
      target = guessed;
    } else {
      const spec = resolveTargetSpec(rawTarget);
      if (spec === undefined) {
        return c.json({ error: 'unknown-target', target: rawTarget }, 400);
      }
      target = spec.target;
      explicitBase64Links = spec.base64Links;
    }

    const formatParam = (c.req.query('format') ?? c.req.query('encoding') ?? '').trim().toLowerCase();
    const wantsBase64Links =
      target === 'v2box' &&
      (explicitBase64Links ||
        formatParam === 'base64' ||
        (formatParam !== 'plain' && formatParam !== 'raw' && isUriShareClientUa(userAgent)));

    let body: string;
    try {
      const fetched = await fetchSnapshot(rawUrl, null, { allowPrivate });
      if (fetched.body === null) throw new Error('upstream-empty');
      body = fetched.body;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      return c.json({ error: 'upstream-failed', reason: redact(reason).slice(0, 160) }, 502);
    }

    const parsed = ingest(body);
    const deduped = dedupeNodes(parsed.profile.nodes, 'nodeKey');
    const profile = await builder.withRuleSetMirror(
      parseProfile({
        nodes: [...deduped.nodes],
        ruleSources: [...parsed.profile.ruleSources],
        policyGroups: [...parsed.profile.policyGroups],
      }),
    );
    const output = buildOne(profile, target);
    const bodyText = wantsBase64Links ? encodeUriSubscriptionBase64(output.content) : output.content;
    return c.body(bodyText, 200, {
      'content-type': CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format],
      'x-startrails-stateless': '1',
      'x-startrails-summary': `nodes=${output.report.passed} skipped=${output.report.skipped} sources=1 stale=0`,
      vary: 'User-Agent',
      'cache-control': 'no-store',
    });
  });

  return router;
}
