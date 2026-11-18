import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../store/crypto.ts';
import { fetchSnapshot } from './url-guard.ts';

/**
 * 外部规则集的本地缓存与镜像。
 *
 * 为什么需要它：Surge / Loon 的 `RULE-SET,<url>` 指向的是**客户端**去拉的公网地址。
 * 机场下发的规则集地址常常是境外 CDN，客户端拉不到就是空规则；同一条地址还可能被
 * 多个源重复引用（机场把同一份广告规则挂了三遍）。
 *
 * 做法：服务端自己拉一次并落在 `data/cache/rulesets/<key>`，再通过 `/rules/<key>` 对外暴露，
 * 输出配置时把原始 URL 换成镜像 URL——客户端只连主控机，规则集命中率不再取决于机场 CDN。
 *
 * 边界：**不解析、不改写规则内容**。规则行是各客户端的方言，硬翻译必然出错；
 * 这里只做「搬运 + 去重 + 缓存」，语义解释仍归客户端。
 */
export interface RuleSetEntry {
  readonly key: string;
  readonly url: string;
  readonly body: string;
  readonly etag: string | null;
  readonly fetchedAt: number;
}

const TTL_MS = 6 * 3_600_000;
/** 单份规则集上限：超过这个量级基本不是规则文件，而是配错了链接。 */
const MAX_BYTES = 4 * 1024 * 1024;

export const ruleSetKey = (url: string): string => sha256(url).slice(0, 16);

export class RuleSetCache {
  private readonly entries = new Map<string, RuleSetEntry>();
  private readonly inflight = new Map<string, Promise<RuleSetEntry | null>>();
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly allowPrivate: boolean;

  // 注意：运行环境是 Node 的 strip-only TS，不支持构造函数参数属性，字段必须显式声明。
  constructor(dir: string, ttlMs: number = TTL_MS, allowPrivate = false) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.allowPrivate = allowPrivate;
  }

  /**
   * 登记待拉取的地址。即使磁盘上没有缓存也要占位——否则 `/rules/<key>` 收到请求时
   * 只拿到一个 key，不知道原始 URL 就没法回源。
   */
  register(url: string): string {
    const key = ruleSetKey(url);
    if (!this.entries.has(key)) {
      const fromDisk = this.readDisk(key);
      this.entries.set(
        key,
        fromDisk === null
          ? { key, url, body: '', etag: null, fetchedAt: 0 }
          : { ...fromDisk, url: fromDisk.url.length === 0 ? url : fromDisk.url },
      );
    }
    return key;
  }

  get(key: string): RuleSetEntry | undefined {
    const cached = this.entries.get(key);
    if (cached !== undefined) return cached;
    if (!/^[0-9a-f]{16}$/i.test(key)) return undefined;
    const fromDisk = this.readDisk(key);
    if (fromDisk === null) return undefined;
    this.entries.set(key, fromDisk);
    return fromDisk;
  }

  /**
   * 只读缓存，不碰网络。给「看一眼形状就够」的交互端点用：判断 classical/domain 只需要内容，
   * 不需要最新，过期内容也够用。真正的回源交给订阅渲染或下面的后台预热。
   */
  peek(url: string): RuleSetEntry | null {
    const key = ruleSetKey(url);
    const cached = this.entries.get(key) ?? this.readDisk(key);
    return cached !== null && cached.body.length > 0 ? cached : null;
  }

  /**
   * 取一份规则集：内存 → 磁盘 → 上游。上游失败时**回退到旧内容**，
   * 因为「规则集是三天前的」远好于「规则集 404 导致客户端配置文件整份失效」。
   */
  async resolve(url: string): Promise<RuleSetEntry | null> {
    const key = ruleSetKey(url);
    const cached = this.entries.get(key) ?? this.readDisk(key);
    const now = Date.now();
    if (cached !== null && now - cached.fetchedAt < this.ttlMs) return cached;

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const task = (async (): Promise<RuleSetEntry | null> => {
      try {
        const fetched = await fetchSnapshot(url, cached?.etag ?? null, {
          timeoutMs: 15_000,
          maxBytes: MAX_BYTES,
          allowPrivate: this.allowPrivate,
        });
        if (fetched.notModified && cached !== null) {
          const refreshed: RuleSetEntry = { ...cached, fetchedAt: now };
          this.entries.set(key, refreshed);
          return refreshed;
        }
        if (fetched.body === null) return cached;
        if (Buffer.byteLength(fetched.body) > MAX_BYTES) throw new Error('ruleset-too-large');
        const entry: RuleSetEntry = {
          key,
          url,
          body: fetched.body,
          etag: fetched.etag,
          fetchedAt: now,
        };
        this.entries.set(key, entry);
        this.writeDisk(entry);
        return entry;
      } catch {
        return cached;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  private readDisk(key: string): RuleSetEntry | null {
    try {
      const body = readFileSync(join(this.dir, `${key}.txt`), 'utf8');
      const meta = JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8')) as {
        url?: string;
        etag?: string | null;
        fetchedAt?: number;
      };
      return {
        key,
        url: meta.url ?? '',
        body,
        etag: meta.etag ?? null,
        fetchedAt: meta.fetchedAt ?? 0,
      };
    } catch {
      return null;
    }
  }

  private writeDisk(entry: RuleSetEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${entry.key}.txt`), entry.body, 'utf8');
      writeFileSync(
        join(this.dir, `${entry.key}.json`),
        JSON.stringify({ url: entry.url, etag: entry.etag, fetchedAt: entry.fetchedAt }),
        'utf8',
      );
    } catch {
      // 落盘失败只影响重启后的首次命中率，不影响本次输出。
    }
  }
}
