import type { Annotation, BuildReport, ClientTarget, GroupStrategy, InlineRule, NodeTransform, RuleSetShape, RuntimePolicy } from '../core/index.ts';
import type { CollectionMember, DedupeStrategy } from '../core/index.ts';

export type OverlayMode = 'inherit' | 'replace' | 'merge';

export interface SectionModes {
  readonly groups: OverlayMode;
  readonly rules: OverlayMode;
  readonly rulePlacement: 'before' | 'after';
  readonly dns: OverlayMode;
}

export type StoredMember =
  | string
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'match'; readonly pattern: string }
  | { readonly kind: 'region'; readonly code: string }
  | { readonly kind: 'rest' };

export interface PersistedGroupOverride {
  readonly name: string;
  readonly members: readonly StoredMember[];
  readonly order: number;
  readonly strategy?: GroupStrategy;
  readonly testUrl?: string;
  readonly interval?: number;
  readonly tolerance?: number;
  readonly lazy?: boolean;
  readonly hidden?: boolean;
}

export type StoredRule =
  | InlineRule
  | {
      readonly kind: 'external';
      readonly url: string;
      readonly policy: string;
      readonly shape?: RuleSetShape;
      readonly format?: 'text' | 'yaml';
    }
  | { readonly kind: 'final'; readonly policy: string };

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
  /**
   * 这份配置的解析方式与 TUN 入站。曾经存在 app_setting 里全局一份，
   * 结果是改一次 DNS 让所有配置的产物都换版本；现在跟着配置走，留空即不写段。
   */
  readonly runtime?: RuntimePolicy | undefined;
  readonly sectionModes?: SectionModes | undefined;
  /** 按节点名批量剔除/改名，按顺序执行；缺省视为空数组。 */
  readonly nodeTransforms?: readonly NodeTransform[] | undefined;
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
  /**
   * 明文 token，仅在 store 内部加解密，用来让台账能重新拼出订阅地址与二维码。
   * 只存 hash 时，签发响应一关掉就再也拿不回链接；老记录没有这一列，读出来是 undefined。
   */
  readonly token?: string | undefined;
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
  /**
   * 用新密钥重加密全部已落盘正文。任何一行解不开都会抛错并回滚，
   * 因此调用方可以安全地在设置新密钥失败时继续使用旧密钥。
   *
   * 返回「撤销本次轮换」的函数：换密钥要同时改数据库和磁盘上的密钥文件，
   * 第二步失败时调用方必须把数据库退回旧密钥，否则重启后全部正文解不开。
   * 撤销函数自己失败时抛错，由调用方决定如何告知用户。
   */
  rotateSecret(secret: string): () => void;

  listCollections(): readonly PersistedCollection[];
  getCollection(id: string): PersistedCollection | undefined;
  putCollection(collection: PersistedCollection): void;
  removeCollection(id: string): void;

  listProfiles(): readonly PersistedProfile[];
  /** 只写身份与构成；运行时段有自己的写入口，保存构成时不该顺手把它清掉。 */
  putProfile(profile: PersistedProfile): void;
  /** `null` 表示主动清空：产物不再写 DNS / TUN 段，区别于「本次不涉及」。 */
  putProfileRuntime(profileId: string, runtime: RuntimePolicy | null): void;
  removeProfile(id: string): void;

  /**
   * 节点标注按配置隔离：排除、别名、地区、排序都只作用于这一份配置的产物。
   * 早期这三张表没有 profile 列，改一份会连带改掉所有配置的产物。
   */
  listAnnotations(profileId: string): readonly Annotation[];
  putAnnotation(profileId: string, annotation: Annotation): void;

  /** 节点批量清洗规则按配置隔离：一整份有序列表，整组替换。 */
  listNodeTransforms(profileId: string): readonly NodeTransform[];
  replaceNodeTransforms(profileId: string, transforms: readonly NodeTransform[]): void;

  /**
   * 通用键值设置。只放**实例级**的小对象（通知、WebDAV、管理面令牌哈希）。
   * 任何「只对某份配置成立」的东西都不要放这里——那会退化成全局共享。
   */
  getSetting(key: string): string | undefined;
  putSetting(key: string, value: string): void;
  /**
   * 一次性初始化：key 不存在或残留空值时写入，返回是否由本次调用写入。
   * 用单条 UPSERT 原子判定而不是「先读后写」，避免并发请求或重复提交覆盖已设定的值。
   */
  claimSetting(key: string, value: string): boolean;

  listRules(profileId: string): readonly StoredRule[];
  replaceRules(profileId: string, rules: readonly StoredRule[]): void;
  putSectionModes(profileId: string, modes: SectionModes): void;
  listGroupOverrides(profileId: string): readonly PersistedGroupOverride[];
  replaceGroupOverrides(profileId: string, overrides: readonly PersistedGroupOverride[]): void;

  createToken(token: PersistedToken): void;
  findTokenByHash(hash: string): PersistedToken | undefined;
  listTokens(): readonly PersistedToken[];
  revokeToken(id: string): void;
  /**
   * 配置改名要跟着改令牌的归属：令牌的 profile 存的是签发时的配置名，
   * 不级联的话 /s/ 交付链路与撤销匹配都按名字对不上，已签发地址会整体失效。
   * 返回改写的条数，供响应计数。
   */
  renameTokenProfile(from: string, to: string): number;

  saveBuildReport(report: PersistedBuildReport): void;
  getBuildReport(buildId: string): PersistedBuildReport | undefined;
  listBuildReports(limit: number): readonly PersistedBuildReport[];
  pruneBuildReports(max: number): void;

  backup(destination: string): Promise<void>;
  close(): void;
}
