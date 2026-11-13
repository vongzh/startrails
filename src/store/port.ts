import type { Annotation, BuildReport, ClientTarget, InlineRule } from '../core/index.ts';
import type { CollectionMember, DedupeStrategy } from '../core/index.ts';

export interface PersistedGroupOverride {
  readonly name: string;
  readonly members: readonly string[];
  readonly order: number;
}

/** 采集方式：远端链接 / 上传文件 / 直接粘贴。后两者内容存库（加密），不依赖外部可达性。 */
export type SourceKind = 'remote' | 'file' | 'inline';

/** 上游 `subscription-userinfo` 的流量信息；只存上游给的数值，不推算。 */
export interface SourceUserinfo {
  readonly upload?: number;
  readonly download?: number;
  readonly total?: number;
  /** unix 秒 */
  readonly expire?: number;
}

/**
 * 配置态：持久化在 SQLite。可重建产物（上游 body / 构建文本 / Profile）不进库，
 * 但「用户自己提供的文件与粘贴文本」是原始输入，不是可重建产物，必须进库。
 */
export interface PersistedSource {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  /** 仅 remote 使用。 */
  readonly url?: string;
  /** 仅 remote 使用：上游按 UA 返回不同格式时用于伪装。 */
  readonly ua?: string;
  /** 强制解析格式；缺省时按内容嗅探。 */
  readonly format?: string;
  readonly refreshPolicy?: string;
  readonly enabled: boolean;
  /** 源级代理（http / https / socks5），用于机场按出口 IP 限区的场景。 */
  readonly proxy?: string;
  /** 最近一次成功拉取的时间（ISO），调度器据此判断是否到期。 */
  readonly lastFetchedAt?: string;
  /** 最近一次拉取失败的原因；成功后清空。 */
  readonly lastError?: string;
  readonly userinfo?: SourceUserinfo;
  /** 上游 `profile-update-interval` 给的建议间隔（小时），仅作 UI 提示。 */
  readonly suggestedRefreshHours?: number;
}

/**
 * 只更新运行态字段，不动 updated_at（避免刷新把源顺序打乱）。
 * 用 null 表示「清空该列」，undefined 表示「本次不涉及」——两者语义不同，都必须能表达。
 */
export interface SourceRuntimeState {
  readonly lastFetchedAt?: string | null;
  readonly lastError?: string | null;
  readonly userinfo?: SourceUserinfo | null;
  readonly suggestedRefreshHours?: number | null;
}

export interface PersistedCollection {
  readonly id: string;
  readonly name: string;
  readonly members: readonly CollectionMember[];
  readonly dedupe: DedupeStrategy;
  readonly order: number;
}

/** Profile 的有序构成：可以直接引用源，也可以引用组合订阅。 */
export type ProfileEntryKind = 'source' | 'collection';

export interface ProfileEntry {
  readonly kind: ProfileEntryKind;
  readonly id: string;
}

export interface PersistedProfile {
  readonly id: string;
  readonly name: string;
  /** 顺序即合并顺序；同一源可被多个组合订阅重复引用。 */
  readonly entries: readonly ProfileEntry[];
}

/** auto = 一个链接喂所有客户端，按请求 UA 判定输出方言。 */
export type TokenTarget = ClientTarget | 'auto';

export interface PersistedToken {
  readonly id: string;
  readonly tokenHash: string;
  readonly profile: string;
  readonly target: TokenTarget;
  readonly revoked: boolean;
  readonly createdAt: string;
}

export interface PersistedBuildReport {
  readonly buildId: string;
  readonly target: ClientTarget;
  readonly report: BuildReport;
  readonly createdAt: string;
}

/** Store 端口隔离：驱动可换（better-sqlite3 / node:sqlite / 远程 SQLite），上层不感知。 */
export interface Store {
  listSources(): readonly PersistedSource[];
  getSource(id: string): PersistedSource | undefined;
  putSource(source: PersistedSource): void;
  /** 刷新结果落库：只写运行态列，不动配置态字段。 */
  updateSourceState(id: string, state: SourceRuntimeState): void;
  removeSource(id: string): void;

  /** 文件 / 粘贴源的正文；远端源返回 undefined。 */
  readSourcePayload(id: string): string | undefined;
  writeSourcePayload(id: string, content: string): void;
  sourcePayloadInfo(id: string): { readonly bytes: number; readonly updatedAt: string } | undefined;

  listCollections(): readonly PersistedCollection[];
  getCollection(id: string): PersistedCollection | undefined;
  putCollection(collection: PersistedCollection): void;
  removeCollection(id: string): void;

  listProfiles(): readonly PersistedProfile[];
  putProfile(profile: PersistedProfile): void;
  removeProfile(id: string): void;

  listAnnotations(): readonly Annotation[];
  putAnnotation(annotation: Annotation): void;
  removeAnnotation(nodeKey: string): void;

  /**
   * 通用键值设置。只放「整份配置级」的小对象（运行时段 DNS / TUN、通知、WebDAV、管理面令牌哈希）。
   * 值由调用方负责序列化与校验，Store 不解释内容——否则每加一种设置都要改一次驱动。
   */
  getSetting(key: string): string | undefined;
  putSetting(key: string, value: string): void;
  /**
   * 一次性初始化：key 不存在或残留空值时写入，返回是否由本次调用写入。
   * 用单条 UPSERT 原子判定而不是「先读后写」，避免并发请求或重复提交覆盖已设定的值。
   */
  claimSetting(key: string, value: string): boolean;

  listRules(): readonly InlineRule[];
  replaceRules(rules: readonly InlineRule[]): void;
  listGroupOverrides(): readonly PersistedGroupOverride[];
  replaceGroupOverrides(overrides: readonly PersistedGroupOverride[]): void;

  createToken(token: PersistedToken): void;
  findTokenByHash(hash: string): PersistedToken | undefined;
  listTokens(): readonly PersistedToken[];
  revokeToken(id: string): void;

  saveBuildReport(report: PersistedBuildReport): void;
  getBuildReport(buildId: string): PersistedBuildReport | undefined;
  listBuildReports(limit: number): readonly PersistedBuildReport[];
  pruneBuildReports(max: number): void;

  backup(destination: string): Promise<void>;
  close(): void;
}
