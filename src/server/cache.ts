import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface SnapshotEntry {
  readonly body: string;
  readonly etag: string | null;
  readonly fetchedAt: number;
}

/**
 * L1：上游订阅 body 只放内存 LRU + 本地文件，可重建，不进 SQLite。
 *
 * 两级语义（不要合并成一个 `get`，否则「新鲜」与「可用」会被混为一谈）：
 * - `get()`：**新鲜**条目（TTL 内）。用于「能不能直接 304」与正常构建的快速路径。
 * - `lastGood()`：**最后一次成功**的条目，**不过期**。只在上游拉取失败时兜底。
 *
 * 为什么必须分开：机场控制面板维护 30 分钟是常态。只有 TTL 缓存时，过期即失效，
 * 下一次构建就会把这个源的节点整段删掉——用户在客户端看到「节点没了」，而不是「拉取失败」。
 * 兜底不是「用旧数据糊过去」，而是「用旧数据 + 明确告知它有多旧」（见 prepareState 的 upstream-stale 诊断）。
 */
export class SnapshotCache {
  private readonly memory = new Map<string, SnapshotEntry>();
  private readonly directory: string;
  private readonly ttlMs: number;

  // 不用 constructor parameter property：Node 原生 TS 剥离（strip-only）不支持该语法。
  constructor(directory: string, ttlMs: number = 5 * 60_000) {
    this.directory = directory;
    this.ttlMs = ttlMs;
    mkdirSync(directory, { recursive: true });
  }

  private fileOf(id: string): string {
    const safe = createHash('sha256').update(id).digest('hex').slice(0, 24);
    return join(this.directory, `${safe}.snapshot`);
  }

  /** 不做过期判断的原始读取；只给 `get` / `lastGood` / `ageOf` 用。 */
  private read(id: string): SnapshotEntry | undefined {
    const inMemory = this.memory.get(id);
    if (inMemory !== undefined) return inMemory;
    const file = this.fileOf(id);
    if (!existsSync(file)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as SnapshotEntry;
      this.memory.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  /** 新鲜度判断：TTL 内才返回，供正常构建与 304 使用。 */
  get(id: string): SnapshotEntry | undefined {
    const entry = this.read(id);
    if (entry === undefined) return undefined;
    return Date.now() - entry.fetchedAt < this.ttlMs ? entry : undefined;
  }

  /**
   * 最后一次成功拉取的快照，**忽略 TTL**。
   * 调用方必须把 `fetchedAt` 的年龄讲给用户听，不要当作「当前数据」使用。
   */
  lastGood(id: string): SnapshotEntry | undefined {
    return this.read(id);
  }

  /** 条目的陈旧程度（毫秒）；无条目为 null。 */
  ageOf(id: string): number | null {
    const entry = this.read(id);
    return entry === undefined ? null : Math.max(0, Date.now() - entry.fetchedAt);
  }

  /** 是否仍在 TTL 内。与 `get() !== undefined` 等价，语义更直白，供展示层使用。 */
  isFresh(id: string): boolean {
    const entry = this.read(id);
    return entry !== undefined && Date.now() - entry.fetchedAt < this.ttlMs;
  }

  set(id: string, entry: SnapshotEntry): void {
    this.memory.set(id, entry);
    const file = this.fileOf(id);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), 'utf8');
    renameSync(temp, file); // 原子替换，避免半写文件
  }

  clear(): void {
    this.memory.clear();
  }
}
