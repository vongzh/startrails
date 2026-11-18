import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  dedupeNodes,
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
import {
  CONTENT_TYPE_BY_FORMAT,
  SECURITY_HEADERS,
  absoluteUrlOf,
  ifNoneMatch,
  send,
  sendJson,
} from './http.ts';
import { guessTargetByUa, isTarget } from './input.ts';
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

export interface DeliveryRoutes {
  readonly serveRuleSet: (res: ServerResponse, rawKey: string) => Promise<void>;
  readonly renderSubscription: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
  readonly renderStateless: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
}

export function createDeliveryRoutes(deps: DeliveryDeps): DeliveryRoutes {
  const { store, buildCache, ruleSets, builder, allowPrivate, allowStateless, publicBaseUrl } = deps;
  let reportWritesSincePrune = 0;

  /**
   * 规则集镜像端点：客户端（Surge / Loon）直接来取，因此**不走管理令牌**——
   * 内容是公开的规则文本，key 是 URL 的哈希，拿到 key 也需要先知道原始 URL。
   * 上游取不到时回退旧内容；连旧内容都没有才 404。
   */
  const serveRuleSet = async (res: ServerResponse, rawKey: string): Promise<void> => {
    const key = rawKey.replace(/\.(txt|list|yaml|yml)$/i, '').replace(/[^0-9a-f]/gi, '');
    const entry = key.length === 0 ? undefined : ruleSets.get(key);
    if (entry === undefined) {
      send(res, 404, 'unknown-rule-set', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    const resolved = await ruleSets.resolve(entry.url);
    const body = resolved?.body ?? entry.body;
    if (body.length === 0) {
      send(res, 502, 'rule-set-unavailable', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    send(res, 200, body, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=600',
      ...(resolved?.etag === null || resolved?.etag === undefined ? {} : { etag: resolved.etag }),
    });
  };

  const renderSubscription = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const pathname = url.pathname;
    // 两种路径形态 × 两种后缀：
    //   /s/<token>                        按 UA 自适应
    //   /s/<token>/<profile>/<target>     锁定目标
    //   后缀 /diagnostics 出调试 JSON，/qr.svg 出二维码；后缀不参与 token 匹配。
    const adaptive = /^\/s\/([^/]+)(\/(diagnostics|qr\.svg))?$/.exec(pathname);
    const locked = /^\/s\/([^/]+)\/([^/]+)\/([^/]+)(\/(diagnostics|qr\.svg))?$/.exec(pathname);
    const match = adaptive ?? locked;
    if (match === null) {
      sendJson(res, 404, { error: 'invalid-subscription-path' });
      return;
    }
    // 最后一个捕获组是内层分组，取到的是不带斜杠的后缀名（`diagnostics` / `qr.svg`）。
    const suffix = match[match.length - 1] ?? '';
    const diagnosticsSuffix = suffix === 'diagnostics' ? suffix : undefined;
    const rawToken = decodeURIComponent(match[1] ?? '');
    const record = store.findTokenByHash(hashToken(rawToken));
    if (record === undefined || record.revoked) {
      sendJson(res, 404, { error: 'token-invalid-or-revoked' });
      return;
    }

    if (suffix === 'qr.svg') {
      // 二维码只编码「这个订阅地址本身」，不跑 Ingest / Plan / Emit。
      const subscriptionPath = pathname.replace(/\/qr\.svg$/, '');
      const targetUrl = absoluteUrlOf(req, subscriptionPath, url.search, publicBaseUrl);
      const svg = renderQrSvg(targetUrl, {
        ec: 'M',
        moduleSize: 4,
        title: `${record.profile} · 订阅二维码`,
      });
      send(res, 200, svg, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'private, max-age=300',
      });
      return;
    }

    let profileName: string;
    let target: ClientTarget;
    if (adaptive !== null) {
      profileName = record.profile;
      if (record.target !== 'auto') {
        target = record.target;
      } else {
        const guessed = guessTargetByUa(req.headers['user-agent'] ?? '');
        if (guessed === undefined) {
          sendJson(res, 400, {
            error: 'unknown-user-agent',
            hint: 'append /profile/target to the URL, or request with a known client UA',
          });
          return;
        }
        target = guessed;
      }
    } else {
      profileName = decodeURIComponent(match[2] ?? '');
      const rawTarget = match[3] ?? '';
      if (!isTarget(rawTarget)) {
        sendJson(res, 400, { error: 'unknown-target' });
        return;
      }
      target = rawTarget;
      if (record.profile !== profileName || (record.target !== 'auto' && record.target !== target)) {
        sendJson(res, 404, { error: 'token-invalid-or-revoked' });
        return;
      }
    }

    const state = await builder.prepareState(profileName);
    if (state === null) {
      sendJson(res, 404, { error: 'profile-not-found' });
      return;
    }

    // 参数化订阅：include / exclude / prefix / limit 只作用于本次响应，不改库、不进缓存。
    const include = url.searchParams.getAll('include').flatMap((value) => value.split(',')).filter((value) => value.trim().length > 0);
    const exclude = url.searchParams.getAll('exclude').flatMap((value) => value.split(',')).filter((value) => value.trim().length > 0);
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

    /**
     * ETag 必须标识「这次真正返回的表示」，而不只是上游状态。
     */
    const responseEtag = `"${sha256(
      JSON.stringify({
        state: state.etag,
        target,
        suffix: diagnosticsSuffix ?? 'subscription',
        filter: queryFilter ?? null,
      }),
    ).slice(0, 32)}"`;

    if (diagnosticsSuffix === undefined && ifNoneMatch(req.headers['if-none-match'], responseEtag)) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        ETag: responseEtag,
        Vary: 'User-Agent',
        'Cache-Control': 'no-cache',
      });
      res.end();
      return;
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

    if (diagnosticsSuffix !== undefined) {
      send(res, 200, JSON.stringify({
        buildId,
        target,
        etag: responseEtag,
        summary,
        report: {
          ...output.report,
          diagnostics: builder.redacted([...extraDiagnostics, ...output.report.diagnostics]),
        },
      }), {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
      });
      return;
    }

    const contentType = CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format];
    const download = url.searchParams.get('download');
    const disposition =
      download === null || download === '0' || download === 'false'
        ? null
        : `attachment; filename="${`${profileName}-${outputFilename(target)}`
            .replace(/[^A-Za-z0-9._-]+/g, '_')
            .slice(0, 80)}"`;
    send(res, 200, output.content, {
      ...headers,
      'content-type': contentType,
      ...(disposition === null ? {} : { 'content-disposition': disposition }),
    });
  };

  /**
   * 无状态一次性转换：`GET /sub?url=<订阅地址>&target=<客户端>`。
   */
  const renderStateless = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (!allowStateless) {
      sendJson(res, 404, {
        error: 'stateless-disabled',
        hint: 'GET /sub?url=&target= is off by default; enable allowStateless to open it',
      });
      return;
    }
    const rawUrl = (url.searchParams.get('url') ?? '').trim();
    if (rawUrl.length === 0) {
      sendJson(res, 400, { error: 'missing-url' });
      return;
    }
    const rawTarget = (url.searchParams.get('target') ?? 'auto').trim();
    let target: ClientTarget;
    if (rawTarget.length === 0 || rawTarget === 'auto') {
      const guessed = guessTargetByUa(req.headers['user-agent'] ?? '');
      if (guessed === undefined) {
        sendJson(res, 400, { error: 'unknown-target', hint: 'pass ?target=<client> or use a known client UA' });
        return;
      }
      target = guessed;
    } else if (isTarget(rawTarget)) {
      target = rawTarget;
    } else {
      sendJson(res, 400, { error: 'unknown-target', target: rawTarget });
      return;
    }

    let body: string;
    try {
      const fetched = await fetchSnapshot(rawUrl, null, { allowPrivate });
      if (fetched.body === null) throw new Error('upstream-empty');
      body = fetched.body;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      sendJson(res, 502, { error: 'upstream-failed', reason: redact(reason).slice(0, 160) });
      return;
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
    send(res, 200, output.content, {
      'content-type': CONTENT_TYPE_BY_FORMAT[verifiedCapabilityTables.output[target].format],
      'x-startrails-stateless': '1',
      'x-startrails-summary': `nodes=${output.report.passed} skipped=${output.report.skipped} sources=1 stale=0`,
      'cache-control': 'no-store',
    });
  };

  return { serveRuleSet, renderSubscription, renderStateless };
}
