import { randomUUID } from 'node:crypto';
import {
  applyAnnotations,
  applyMemberFilter,
  applyNodeTransforms,
  composeCollection,
  dedupeNodes,
  describeRuleSet,
  ingest,
  nodeKey,
  parseProfile,
  traceProcessors,
} from '../core/index.ts';
import type {
  ClientTarget,
  Diagnostic,
  MemberFilter,
  PolicyGroup,
  ProcessChange,
  ProcessTrace,
  Profile,
  ProxyNode,
  RuleSource,
} from '../core/index.ts';
import { buildOne } from '../pipeline.ts';
import type { BuildOutput } from '../pipeline.ts';
import { sha256 } from '../store/crypto.ts';
import type {
  PersistedCollection,
  PersistedProfile,
  PersistedSource,
  Store,
} from '../store/port.ts';
import { mapConcurrent } from './async.ts';
import type { BuildCache } from './build-cache.ts';
import type { SnapshotCache } from './cache.ts';
import { describeAge, fetchDefaults } from './input.ts';
import type { Notifier } from './notify.ts';
import { redactDiagnostic } from './redact.ts';
import type { RuleSetCache } from './ruleset.ts';
import { parseRefreshPolicy } from './schedule.ts';
import {
  alignInheritedMembers,
  applyDnsOverlay,
  applyGroupOverlay,
  applyRuleOverlay,
  effectiveModes,
} from './section-overlay.ts';
import { fetchSnapshot } from './url-guard.ts';

const FETCH_CONCURRENCY = 4;

export interface Snapshot {
  readonly id: string;
  readonly body: string;
}

export interface PreparedState {
  readonly profileName: string;
  readonly snapshots: readonly Snapshot[];
  readonly etag: string;
  readonly irKey: string;
  readonly configVersion: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface TraceStepView {
  readonly index: number;
  readonly diff: readonly ProcessChange[];
  readonly diagnostics: readonly Diagnostic[];
  readonly nodesBefore: number;
  readonly nodesAfter: number;
}

export interface TraceView {
  readonly steps: readonly TraceStepView[];
}

export interface BuiltState {
  readonly output: BuildOutput;
  /** 实际参与构建的 IR：延迟探测等旁路操作要按「客户端看到的同一份节点集合」来算。 */
  readonly profile: Profile;
  readonly buildId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly trace: TraceView;
}

/** Profile 的一项展开结果：源直接透传，组合订阅走成员合并；缺失的引用只记诊断。 */
export type Segment =
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'collection'; readonly collection: PersistedCollection }
  | { readonly kind: 'missing'; readonly id: string; readonly ref: string };

export interface BuilderDeps {
  readonly store: Store;
  readonly cache: SnapshotCache;
  readonly buildCache: BuildCache;
  readonly ruleSets: RuleSetCache;
  readonly notifier: Notifier;
  readonly allowPrivate: boolean;
  readonly publicBaseUrl?: string | undefined;
}

export interface Builder {
  readonly configVersion: (profileId: string) => string;
  readonly instanceVersion: () => string;
  readonly listProfiles: () => readonly PersistedProfile[];
  readonly findProfile: (name: string) => PersistedProfile | undefined;
  readonly segmentsOf: (profile: PersistedProfile) => readonly Segment[];
  readonly sourceIdsOf: (segments: readonly Segment[]) => readonly string[];
  readonly detachSourceRefs: (sourceId: string) => {
    collections: number;
    profiles: number;
    removedCollections: string[];
  };
  readonly detachCollectionRefs: (collectionId: string) => number;
  readonly sourceView: (source: PersistedSource) => Record<string, unknown>;
  readonly userinfoHeader: (sources: readonly PersistedSource[]) => string | null;
  readonly refreshSources: (ids: readonly string[]) => Promise<{ refreshed: number; failed: number }>;
  readonly inspectSource: (source: PersistedSource) => Promise<Record<string, unknown>>;
  readonly offlineNodesOf: (collection: PersistedCollection) => (sourceId: string) => readonly ProxyNode[] | undefined;
  readonly prepareState: (profileName: string) => Promise<PreparedState | null>;
  readonly composeProfile: (
    profile: PersistedProfile,
    snapshots: readonly Snapshot[],
  ) => {
    readonly profile: Profile;
    readonly diagnostics: readonly Diagnostic[];
    readonly provenance: ReadonlyMap<string, readonly string[]>;
  };
  readonly withRuleSetMirror: (profile: Readonly<Profile>, eager?: boolean) => Promise<Profile>;
  readonly buildFromSnapshots: (
    state: PreparedState,
    target: ClientTarget,
    queryFilter?: MemberFilter,
    eager?: boolean,
  ) => Promise<BuiltState>;
  readonly redacted: (diagnostics: readonly Diagnostic[]) => readonly Diagnostic[];
}

export function createBuilder(deps: BuilderDeps): Builder {
  const { store, cache, buildCache, ruleSets, notifier, allowPrivate, publicBaseUrl } = deps;

  /**
   * 配置指纹里必须剔除「运行态」字段（最近拉取时间 / 错误 / 流量信息 / 上游建议间隔）。
   * 否则每拉一次上游就换一次版本号 → ETag 永远对不上，L2/L3 缓存全部失效。
   */
  const stripRuntime = (
    source: PersistedSource,
  ): Omit<PersistedSource, 'lastFetchedAt' | 'lastError' | 'userinfo' | 'suggestedRefreshHours'> => {
    const { lastFetchedAt, lastError, userinfo, suggestedRefreshHours, ...definition } = source;
    void lastFetchedAt;
    void lastError;
    void userinfo;
    void suggestedRefreshHours;
    return definition;
  };

  /**
   * 指纹按配置算，不按实例算：改 A 的排除、规则或 DNS，不该让 B 的客户端判定产物过期而重新拉。
   * 源与组合订阅也只统计这份配置实际引用的闭包（直接引用的源 + 引用组合的成员源）——
   * 改一个没被任何配置引用的源，谁的产物都不该换版本。
   */
  const configVersion = (profileId: string): string => {
    const definition = store.listProfiles().find((item) => item.id === profileId) ?? null;
    const collections = store.listCollections();
    const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
    const sources = new Map(store.listSources().map((source) => [source.id, source]));
    const referencedCollections = new Set<string>();
    const referencedSources = new Set<string>();
    for (const entry of definition?.entries ?? []) {
      if (entry.kind === 'collection') {
        referencedCollections.add(entry.id);
        for (const member of collectionById.get(entry.id)?.members ?? []) referencedSources.add(member.sourceId);
      } else {
        referencedSources.add(entry.id);
      }
    }
    return sha256(
      JSON.stringify({
        // Set 按插入序遍历（entries 顺序 + 组合成员顺序），同一份库数据算出的指纹稳定。
        sources: [...referencedSources].flatMap((id) => {
          const source = sources.get(id);
          return source === undefined ? [] : [stripRuntime(source)];
        }),
        collections: [...referencedCollections].flatMap((id) => {
          const collection = collectionById.get(id);
          return collection === undefined ? [] : [collection];
        }),
        profile: definition,
        annotations: store.listAnnotations(profileId),
        rules: store.listRules(profileId),
        groups: store.listGroupOverrides(profileId),
      }),
    ).slice(0, 16);
  };

  /**
   * /health 没有配置上下文：把每份配置的版本拼起来再取 hash，
   * 任一配置变了都算实例版本变了，探活侧不需要知道有几种配置。
   */
  const instanceVersion = (): string =>
    sha256(store.listProfiles().map((profile) => configVersion(profile.id)).join('|')).slice(0, 16);

  const listProfiles = (): readonly PersistedProfile[] => store.listProfiles();

  const findProfile = (name: string): PersistedProfile | undefined =>
    listProfiles().find((profile) => profile.name === name);

  /** 把 Profile 的 items 展开成有序段落；组合订阅保留为一段，合并时才展开成员。 */
  const segmentsOf = (profile: PersistedProfile): readonly Segment[] =>
    profile.entries.map((entry): Segment => {
      if (entry.kind === 'source') return { kind: 'source', sourceId: entry.id };
      const collection = store.getCollection(entry.id);
      if (collection === undefined) return { kind: 'missing', id: entry.id, ref: 'collection-not-found' };
      return { kind: 'collection', collection };
    });

  /** 一次构建实际要用到的源 id 集合（去重，避免同一源被组合订阅重复拉取）。 */
  const sourceIdsOf = (segments: readonly Segment[]): readonly string[] => {
    const ids = new Set<string>();
    for (const segment of segments) {
      if (segment.kind === 'source') ids.add(segment.sourceId);
      if (segment.kind === 'collection') {
        for (const member of segment.collection.members) ids.add(member.sourceId);
      }
    }
    return [...ids];
  };

  /**
   * 删除源之后清理引用。留着悬空引用，构建只会吐 `source-not-found` /
   * `collection-member-missing` 这类代码级诊断，用户既看不懂也修不了——
   * 引用是工具自己写进去的，就该由工具负责收回。
   */
  const detachSourceRefs = (
    sourceId: string,
  ): { collections: number; profiles: number; removedCollections: string[] } => {
    let collectionHits = 0;
    const removedCollections: string[] = [];
    const removedIds: string[] = [];
    for (const collection of store.listCollections()) {
      const members = collection.members.filter((member) => member.sourceId !== sourceId);
      if (members.length === collection.members.length) continue;
      collectionHits += 1;
      if (members.length === 0) {
        // 成员被清空的组合订阅只剩空壳，留着只会让构成里多一段「0 节点」，一并删掉。
        store.removeCollection(collection.id);
        removedIds.push(collection.id);
        removedCollections.push(collection.name);
      } else {
        store.putCollection({ ...collection, members });
      }
    }

    let profileHits = 0;
    for (const profile of store.listProfiles()) {
      const entries = profile.entries.filter((entry) =>
        entry.kind === 'source' ? entry.id !== sourceId : !removedIds.includes(entry.id),
      );
      if (entries.length === profile.entries.length) continue;
      profileHits += 1;
      store.putProfile({ ...profile, entries });
    }
    return { collections: collectionHits, profiles: profileHits, removedCollections };
  };

  /** 删除组合订阅时同步摘掉 Profile 构成里的引用。 */
  const detachCollectionRefs = (collectionId: string): number => {
    let profileHits = 0;
    for (const profile of store.listProfiles()) {
      const entries = profile.entries.filter(
        (entry) => entry.kind !== 'collection' || entry.id !== collectionId,
      );
      if (entries.length === profile.entries.length) continue;
      profileHits += 1;
      store.putProfile({ ...profile, entries });
    }
    return profileHits;
  };

  /**
   * 拉一次远端源：结果写快照缓存与运行态（流量信息 / 最近拉取时间 / 最近错误）。
   * 失败向上抛，由调用方决定是记诊断还是直接回错误——调度器与构建共用这一条路径。
   */
  const fetchRemote = async (source: PersistedSource): Promise<string | null> => {
    if (source.url === undefined) throw new Error('source-missing-url');
    // ETag 取 lastGood 而不是 get：即使正文已过 TTL，用旧 ETag 做条件请求依然正确（能省一次全量传输），
    // 而 304 回来说明内容未变，正好把新鲜度重新续期。
    const cached = cache.lastGood(source.id);
    // 源级优先、全局回退：单独给某个源配的 UA / 代理压过实例默认；
    // headers 目前只在全局配置（源级没有这个字段），整份透传。
    const defaults = fetchDefaults(store);
    const fetched = await fetchSnapshot(source.url, cached?.etag ?? null, {
      allowPrivate,
      ua: source.ua ?? defaults.ua ?? null,
      proxy: source.proxy ?? defaults.proxy ?? null,
      headers: defaults.headers,
    });
    const body = fetched.notModified ? cached?.body : fetched.body;
    if (body === undefined || body === null) throw new Error('upstream-empty-after-304');
    cache.set(source.id, { body, etag: fetched.etag, fetchedAt: Date.now() });
    store.updateSourceState(source.id, {
      lastFetchedAt: new Date().toISOString(),
      lastError: null,
      ...(fetched.userinfo === null ? {} : { userinfo: fetched.userinfo }),
      ...(fetched.suggestedRefreshHours === null
        ? {}
        : { suggestedRefreshHours: fetched.suggestedRefreshHours }),
    });
    return body;
  };

  /** 取源正文：远端走带 ETag 的缓存，文件 / 粘贴源直接读库。 */
  const loadBody = async (
    source: PersistedSource,
    diagnostics: Diagnostic[],
  ): Promise<string | null> => {
    if (source.kind === 'remote') {
      try {
        return await fetchRemote(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
        // 失败也要落库：否则「昨天还好、今天挂了」在 UI 上完全看不出来。
        store.updateSourceState(source.id, {
          lastFetchedAt: new Date().toISOString(),
          lastError: reason,
        });
        /**
         * 上游挂了不等于没有数据可发。回退到最后一次成功的快照，
         * 但必须在诊断里带上「它有多旧」——静默使用旧数据比直接报错更坏。
         */
        const stale = cache.lastGood(source.id);
        if (stale === undefined) throw error;
        const ageMs = Math.max(0, Date.now() - stale.fetchedAt);
        diagnostics.push({
          stage: 'ingest',
          target: null,
          subject: source.id,
          reason: `upstream-stale:${describeAge(ageMs)}`,
        });
        void notifier.notify({
          key: `upstream-stale:${source.id}`,
          title: '订阅源拉取失败，已回退旧快照',
          body: `${source.name}（${source.id}）：${reason}；正在使用 ${describeAge(ageMs)}前的快照`,
        });
        return stale.body;
      }
    }
    const payload = store.readSourcePayload(source.id);
    if (payload === undefined) {
      diagnostics.push({ stage: 'ingest', target: null, subject: source.id, reason: 'source-payload-empty' });
      return null;
    }
    return payload;
  };

  /** 第一阶段：并发拉上游（有界并发，保持确定性顺序）+ 算轻量 ETag，命中可直接 304。 */
  const prepareState = async (profileName: string): Promise<PreparedState | null> => {
    const definition = findProfile(profileName);
    if (definition === undefined) return null;
    const byId = new Map(store.listSources().map((source) => [source.id, source]));
    const sourceIds = sourceIdsOf(segmentsOf(definition));

    const fetched = await mapConcurrent(sourceIds, FETCH_CONCURRENCY, async (sourceId) => {
      const localDiagnostics: Diagnostic[] = [];
      const source = byId.get(sourceId);
      if (source === undefined) {
        localDiagnostics.push({ stage: 'ingest', target: null, subject: sourceId, reason: 'source-not-found' });
        return { snapshot: null, diagnostics: localDiagnostics };
      }
      if (!source.enabled) {
        localDiagnostics.push({ stage: 'ingest', target: null, subject: sourceId, reason: 'source-disabled' });
        return { snapshot: null, diagnostics: localDiagnostics };
      }
      try {
        const body = await loadBody(source, localDiagnostics);
        return {
          snapshot: body === null ? null : { id: source.id, body },
          diagnostics: localDiagnostics,
        };
      } catch (error) {
        localDiagnostics.push({
          stage: 'ingest',
          target: null,
          subject: source.id,
          reason: `upstream-failed:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
        });
        return { snapshot: null, diagnostics: localDiagnostics };
      }
    });

    const snapshots: Snapshot[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const item of fetched) {
      diagnostics.push(...item.diagnostics);
      if (item.snapshot !== null) snapshots.push(item.snapshot);
    }

    const version = configVersion(definition.id);
    // irKey / ETag 只由「不跑 Ingest 就能算出」的量组成：配置版本 + 上游 body hash。
    const irKey = sha256([version, ...snapshots.map((s) => `${s.id}:${sha256(s.body)}`)].join('|'));
    const etag = `"${sha256(`${version}:${irKey}`).slice(0, 32)}"`;
    return { profileName, snapshots, etag, irKey, configVersion: version, diagnostics };
  };

  /**
   * 按段落顺序合成一份 IR：
   * - 单源 → 解析后直接进入结果；
   * - 组合订阅 → 成员逐条过滤 / 加前缀，再按策略去重；
   * - 全局再按 nodeKey 去重一次，避免同一源被多个组合订阅引用时重复出现。
   */
  const composeProfile = (
    profile: PersistedProfile,
    snapshots: readonly Snapshot[],
  ): {
    readonly profile: Profile;
    readonly diagnostics: readonly Diagnostic[];
    readonly provenance: ReadonlyMap<string, readonly string[]>;
  } => {
    const bodies = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.body]));
    const diagnostics: Diagnostic[] = [];
    const parsed = new Map<string, readonly ProxyNode[]>();
    const ruleSources: RuleSource[] = [];
    const groups = new Map<string, PolicyGroup>();
    const originalNames = new Map<string, string>();
    const provenance = new Map<string, string[]>();
    let sourceDns: Profile['runtime'] = undefined;
    const dnsSeen = new Set<string>();

    const ensureParsed = (sourceId: string): readonly ProxyNode[] | undefined => {
      const cached = parsed.get(sourceId);
      if (cached !== undefined) return cached;
      const body = bodies.get(sourceId);
      if (body === undefined) return undefined;
      const result = ingest(body);
      parsed.set(sourceId, result.profile.nodes);
      for (const node of result.profile.nodes) {
        if (!originalNames.has(nodeKey(node))) originalNames.set(nodeKey(node), node.name);
      }
      diagnostics.push(...result.diagnostics);
      // 规则集与策略组只按源取一次：同一源被两个组合订阅引用时不应翻倍。
      ruleSources.push(...result.profile.ruleSources);
      for (const group of result.profile.policyGroups) {
        const existing = groups.get(group.name);
        groups.set(
          group.name,
          existing === undefined
            ? group
            : { ...existing, members: [...new Set([...existing.members, ...group.members])] },
        );
      }
      if (!dnsSeen.has(sourceId)) {
        dnsSeen.add(sourceId);
        const incoming = result.profile.runtime?.dns;
        if (incoming !== undefined) {
          if (sourceDns?.dns === undefined) sourceDns = { dns: incoming };
          else {
            const incomingPolicy = incoming.nameserverPolicy;
            if (incomingPolicy !== undefined && Object.keys(incomingPolicy).length > 0) {
              sourceDns = {
                dns: {
                  ...sourceDns.dns,
                  nameserverPolicy: {
                    ...incomingPolicy,
                    ...(sourceDns.dns.nameserverPolicy ?? {}),
                  },
                },
              };
            }
            diagnostics.push({
              stage: 'ingest',
              target: null,
              subject: sourceId,
              reason: 'dns-ignored',
            });
          }
        }
      }
      return result.profile.nodes;
    };

    const collected: ProxyNode[] = [];
    const markProvenance = (nodes: readonly ProxyNode[], sourceId: string): void => {
      for (const node of nodes) {
        const key = nodeKey(node);
        const bucket = provenance.get(key) ?? [];
        if (!bucket.includes(sourceId)) bucket.push(sourceId);
        provenance.set(key, bucket);
      }
    };

    for (const segment of segmentsOf(profile)) {
      if (segment.kind === 'missing') {
        diagnostics.push({ stage: 'process', target: null, subject: segment.id, reason: segment.ref });
        continue;
      }
      if (segment.kind === 'source') {
        const nodes = ensureParsed(segment.sourceId);
        if (nodes === undefined) {
          diagnostics.push({
            stage: 'process',
            target: null,
            subject: segment.sourceId,
            reason: 'source-unavailable',
          });
          continue;
        }
        collected.push(...nodes);
        markProvenance(nodes, segment.sourceId);
        continue;
      }
      const composed = composeCollection(segment.collection, (sourceId) => ensureParsed(sourceId));
      collected.push(...composed.nodes);
      diagnostics.push(...composed.diagnostics);
      for (const member of segment.collection.members) {
        const nodes = ensureParsed(member.sourceId);
        if (nodes === undefined) continue;
        const filtered = applyMemberFilter(nodes, member.filter, member.sourceId).nodes;
        markProvenance(filtered, member.sourceId);
      }
    }

    // 全局去重：同名节点不合并，因为它们可能是不同落地机；按稳定 nodeKey 去重更安全。
    const deduped = dedupeNodes(collected, 'nodeKey');
    if (deduped.dropped > 0) {
      diagnostics.push({
        stage: 'process',
        target: null,
        subject: profile.name,
        reason: `duplicate-dropped:${deduped.dropped}`,
      });
    }

    /**
     * 「构建出来是 0 个节点」必须自己说出来。否则界面上只有一片空白：
     * 用户分不清是「还没加源」「源没进构成」还是「源解析失败」。
     */
    if (deduped.nodes.length === 0) {
      diagnostics.push({
        stage: 'process',
        target: null,
        subject: profile.name,
        reason: profile.entries.length === 0 ? 'profile-empty' : 'profile-no-nodes',
      });
    }

    const renamed = new Map<string, string>();
    for (const node of deduped.nodes) {
      const previous = originalNames.get(nodeKey(node));
      if (previous !== undefined && previous !== node.name) renamed.set(previous, node.name);
    }
    const alignedGroups = [...groups.values()].map((group) =>
      renamed.size === 0
        ? group
        : { ...group, members: group.members.map((member) => renamed.get(member) ?? member) },
    );
    return {
      profile: parseProfile({
        nodes: [...deduped.nodes],
        ruleSources,
        policyGroups: alignedGroups,
        ...(sourceDns === undefined ? {} : { runtime: sourceDns }),
      }),
      diagnostics,
      provenance,
    };
  };

  /**
   * 用户持久化意图注入解析产物：规则和 DNS 在这里按模式叠上去。
   * 策略组要等节点改名之后再展开，所以这里先留着订阅里的组。
   */
  const withOverrides = (profile: Readonly<Profile>, definition: PersistedProfile): Profile => {
    const rules = store.listRules(definition.id);
    const overrides = [...store.listGroupOverrides(definition.id)].sort((left, right) => left.order - right.order);
    const modes = effectiveModes(definition, overrides.length > 0, rules.length > 0);
    const ruleSources = applyRuleOverlay(profile.ruleSources, rules, modes.rules, modes.rulePlacement);
    const runtime = applyDnsOverlay(profile.runtime, definition.runtime, modes.dns);
    return parseProfile({
      nodes: [...profile.nodes],
      ruleSources,
      policyGroups: [...profile.policyGroups],
      ...(runtime === undefined ? {} : { runtime }),
    });
  };

  /**
   * 外部规则集去重 + 镜像 + 定性：同一 URL 在多个源里出现时只保留一条，改成 `${publicBaseUrl}/rules/<key>`。
   * 不配 publicBaseUrl 时仅去重、保留原 URL——镜像地址不可达就没有意义。
   *
   * `eager=false` 只给 /api/trace、/api/probe 这类「不产出配置正文」的交互端点：
   * 它们只需要 IR，不需要为了推断规则集形状去等一次可能 15 秒的上游请求。
   * 缓存里没有内容时挂一次后台预热，真正的订阅渲染下次就能命中。
   */
  const withRuleSetMirror = async (profile: Readonly<Profile>, eager = true): Promise<Profile> => {
    const base = publicBaseUrl?.replace(/\/+$/, '');
    const seen = new Set<string>();
    const externalToResolve = new Set<string>();
    const dedupedSources: { readonly source: RuleSource; readonly key?: string }[] = [];

    for (const source of profile.ruleSources) {
      if (source.kind !== 'external') {
        dedupedSources.push({ source });
        continue;
      }
      const key = ruleSets.register(source.url);
      const dedupeKey = `${key}:${source.policy ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      dedupedSources.push({ source, key });
      if (eager && (source.shape === undefined || source.encoding === undefined)) {
        externalToResolve.add(source.url);
      }
    }

    const resolvedMap = new Map<string, Awaited<ReturnType<RuleSetCache['resolve']>>>();
    if (eager && externalToResolve.size > 0) {
      const urls = [...externalToResolve];
      const entries = await mapConcurrent(urls, FETCH_CONCURRENCY, (u) => ruleSets.resolve(u));
      urls.forEach((u, index) => resolvedMap.set(u, entries[index] ?? null));
    }

    const ruleSources: RuleSource[] = [];
    for (const item of dedupedSources) {
      const source = item.source;
      if (source.kind !== 'external') {
        ruleSources.push(source);
        continue;
      }
      let shape = source.shape;
      let encoding = source.encoding;
      if (shape === undefined || encoding === undefined) {
        const entry = eager ? (resolvedMap.get(source.url) ?? null) : ruleSets.peek(source.url);
        const described = entry === null ? undefined : describeRuleSet(entry.body);
        if (shape === undefined) shape = described?.shape;
        if (encoding === undefined) encoding = described?.encoding;
        if (!eager && entry === null) void ruleSets.resolve(source.url);
      }
      ruleSources.push({
        ...source,
        ...(shape === undefined ? {} : { shape }),
        ...(encoding === undefined ? {} : { encoding }),
        ...(base === undefined ? {} : { url: `${base}/rules/${item.key}` }),
      });
    }
    return parseProfile({
      nodes: [...profile.nodes],
      ruleSources,
      policyGroups: [...profile.policyGroups],
      ...(profile.runtime === undefined ? {} : { runtime: profile.runtime }),
    });
  };

  const traceView = (trace: ProcessTrace): TraceView => ({
    steps: trace.steps.map((step) => ({
      index: step.index,
      diff: step.diff,
      diagnostics: step.diagnostics,
      nodesBefore: step.before.nodes.length,
      nodesAfter: step.after.nodes.length,
    })),
  });

  /**
   * 第二阶段：ETag 未命中才解析 IR、加工，并且只构建请求的那个 Target。
   * queryFilter 来自参数化订阅（?include=&exclude=&prefix=&limit=），只影响本次响应，不进缓存。
   */
  const buildFromSnapshots = async (
    state: PreparedState,
    target: ClientTarget,
    queryFilter?: MemberFilter,
    eager = true,
  ): Promise<BuiltState> => {
    // 标注按配置取，命中 L3 缓存时也要能拿到，所以 definition 提到分支外面。
    const definition = findProfile(state.profileName);
    if (definition === undefined) throw new Error('profile-not-found');
    // eager=false 的产物不含镜像后的规则集 URL，不能进 L3，否则会污染订阅渲染的缓存。
    let configured = eager ? buildCache.getL3(state.irKey) : undefined;
    const diagnostics: Diagnostic[] = [...state.diagnostics];
    if (configured === undefined) {
      const composed = composeProfile(definition, state.snapshots);
      configured = await withRuleSetMirror(withOverrides(composed.profile, definition), eager);
      diagnostics.push(...composed.diagnostics);
      if (eager) buildCache.setL3(state.irKey, configured);
    }
    const trace = traceProcessors(
      configured,
      { configVersion: state.configVersion },
      [
        applyNodeTransforms(store.listNodeTransforms(definition.id)),
        applyAnnotations(store.listAnnotations(definition.id)),
      ],
    );
    const groupOverrides = [...store.listGroupOverrides(definition.id)].sort((left, right) => left.order - right.order);
    const groupModes = effectiveModes(definition, groupOverrides.length > 0, store.listRules(definition.id).length > 0);
    const alignedGroups = alignInheritedMembers(trace.final.policyGroups, configured.nodes, trace.final.nodes);
    const grouped = applyGroupOverlay(alignedGroups, groupOverrides, trace.final.nodes, groupModes.groups);
    let final: Profile = parseProfile({
      nodes: [...trace.final.nodes],
      ruleSources: [...trace.final.ruleSources],
      policyGroups: grouped,
      ...(trace.final.runtime === undefined ? {} : { runtime: trace.final.runtime }),
    });
    if (queryFilter !== undefined) {
      const applied = applyMemberFilter(final.nodes, queryFilter, 'query');
      diagnostics.push(...applied.diagnostics);
      final = parseProfile({
        nodes: [...applied.nodes],
        ruleSources: [...final.ruleSources],
        policyGroups: [...final.policyGroups],
        ...(final.runtime === undefined ? {} : { runtime: final.runtime }),
      });
    }
    const buildId = randomUUID();
    const output = buildOne(final, target, { buildId });
    // 被「拒绝」的节点不是降级，是整条节点不可用；这类事件值得推一次（30 分钟内同类只推一条）。
    const rejected = output.report.diagnostics.filter((item) => item.reason.startsWith('feature-required:'));
    if (rejected.length > 0) {
      const features = [...new Set(rejected.map((item) => item.reason.slice('feature-required:'.length)))];
      void notifier.notify({
        key: `build-rejected:${target}`,
        title: '构建拒绝了节点',
        body: `${state.profileName} → ${target}：${rejected.length} 个节点缺少 ${features.join(' / ')}，已整条拒绝（降级会生成连不上的配置）`,
      });
    }

    return {
      output,
      profile: final,
      buildId,
      diagnostics: [...diagnostics, ...trace.steps.flatMap((step) => step.diagnostics)],
      trace: traceView(trace),
    };
  };

  const redacted = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
    diagnostics.map(redactDiagnostic);

  /**
   * 管理面（/api/*）整体在 401 闸门之后，这里的 url / proxy 返回明文。
   */
  const sourceView = (source: PersistedSource): Record<string, unknown> => {
    const info = store.sourcePayloadInfo(source.id);
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      enabled: source.enabled,
      url: source.url ?? null,
      format: source.format ?? null,
      ua: source.ua ?? null,
      refreshPolicy: source.refreshPolicy ?? null,
      refreshIntervalMs: parseRefreshPolicy(source.refreshPolicy),
      proxy: source.proxy ?? null,
      lastFetchedAt: source.lastFetchedAt ?? null,
      lastError: source.lastError ?? null,
      // 快照年龄 + 是否已超出 TTL：界面据此把「正在用旧数据」讲清楚，而不是只显示一个红点。
      snapshotAgeMs: cache.ageOf(source.id),
      snapshotStale: source.kind === 'remote' && cache.lastGood(source.id) !== undefined && !cache.isFresh(source.id),
      userinfo: source.userinfo ?? null,
      suggestedRefreshHours: source.suggestedRefreshHours ?? null,
      bytes: info?.bytes ?? 0,
      updatedAt: info?.updatedAt ?? null,
    };
  };

  /**
   * 把多个源的流量信息合成一个 `subscription-userinfo` 响应头。
   * 口径：上传 / 下载 / 总量按源累加（Profile 可能合并多个机场），到期取最早的一个。
   * 一个源都没有信息时返回 null，不下发空头——避免客户端把「未知」显示成「0」。
   */
  const userinfoHeader = (sources: readonly PersistedSource[]): string | null => {
    let upload = 0;
    let download = 0;
    let total = 0;
    let expire = 0;
    let seen = false;
    for (const source of sources) {
      const info = source.userinfo;
      if (info === undefined) continue;
      seen = true;
      upload += info.upload ?? 0;
      download += info.download ?? 0;
      total += info.total ?? 0;
      if (info.expire !== undefined && (expire === 0 || info.expire < expire)) expire = info.expire;
    }
    if (!seen) return null;
    return [
      `upload=${Math.round(upload)}`,
      `download=${Math.round(download)}`,
      `total=${Math.round(total)}`,
      ...(expire > 0 ? [`expire=${expire}`] : []),
    ].join('; ');
  };

  /** 刷新一批源（有界并发）；返回成功 / 失败计数，失败原因已落库不吞掉。 */
  const refreshSources = async (
    ids: readonly string[],
  ): Promise<{ refreshed: number; failed: number }> => {
    const outcomes = await mapConcurrent(ids, FETCH_CONCURRENCY, async (id): Promise<'refreshed' | 'failed' | 'skipped'> => {
      const source = store.getSource(id);
      if (source === undefined) return 'skipped';
      try {
        await fetchRemote(source);
        return 'refreshed';
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
        store.updateSourceState(id, {
          lastError: reason,
          lastFetchedAt: new Date().toISOString(),
        });
        // 失败必须推送出去：定时刷新是后台行为，用户不会盯着界面看。
        void notifier.notify({
          key: `refresh-failed:${id}`,
          title: '订阅源拉取失败',
          body: `${source.name}（${id}）：${reason}`,
        });
        return 'failed';
      }
    });
    let refreshed = 0;
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome === 'refreshed') refreshed += 1;
      else if (outcome === 'failed') failed += 1;
    }
    return { refreshed, failed };
  };

  /** 单源解析检查：给「文件到底解析出几个节点、前几个叫什么」一个直接答案。 */
  const inspectSource = async (
    source: PersistedSource,
  ): Promise<Record<string, unknown>> => {
    const diagnostics: Diagnostic[] = [];
    if (!source.enabled) {
      return { id: source.id, enabled: false, nodes: 0, skipped: 0, diagnostics: [], sample: [] };
    }
    let body: string | null = null;
    try {
      body = await loadBody(source, diagnostics);
    } catch (error) {
      diagnostics.push({
        stage: 'ingest',
        target: null,
        subject: source.id,
        reason: `upstream-failed:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      });
    }
    if (body === null) {
      return {
        id: source.id,
        enabled: true,
        nodes: 0,
        skipped: 0,
        diagnostics: redacted(diagnostics),
        sample: [],
      };
    }
    const result = ingest(body);
    return {
      id: source.id,
      enabled: true,
      format: result.format,
      nodes: result.profile.nodes.length,
      skipped: result.skipped,
      sample: result.profile.nodes.slice(0, 6).map((node) => node.name),
      bytes: Buffer.byteLength(body, 'utf8'),
      diagnostics: redacted([...diagnostics, ...result.diagnostics]),
    };
  };

  /** 组合订阅的节点数快速估算：本地正文直接读，远端源用最后成功快照兜底，不发网络请求。 */
  const offlineNodesOf = (_collection: PersistedCollection) => {
    const seen = new Map<string, readonly ProxyNode[]>();
    return (sourceId: string): readonly ProxyNode[] | undefined => {
      const cached = seen.get(sourceId);
      if (cached !== undefined) return cached;
      const source = store.getSource(sourceId);
      if (source === undefined) return undefined;
      const payload =
        source.kind === 'remote'
          ? cache.lastGood(sourceId)?.body
          : store.readSourcePayload(sourceId);
      if (payload === undefined) return undefined;
      const nodes = ingest(payload).profile.nodes;
      seen.set(sourceId, nodes);
      return nodes;
    };
  };

  return {
    configVersion,
    instanceVersion,
    listProfiles,
    findProfile,
    segmentsOf,
    sourceIdsOf,
    detachSourceRefs,
    detachCollectionRefs,
    sourceView,
    userinfoHeader,
    refreshSources,
    inspectSource,
    offlineNodesOf,
    prepareState,
    composeProfile,
    withRuleSetMirror,
    buildFromSnapshots,
    redacted,
  };
}
