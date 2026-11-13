import type { BuildReport, Diagnostic, Profile } from '../core/index.ts';

export interface CachedBuild {
  readonly content: string;
  readonly report: BuildReport;
  /** 构建前的 Ingest / Process 诊断，随产物一起缓存，保证诊断响应完整。 */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * L2：构建产物缓存（etag × target → 文本 + 报告），命中跳过 Plan/Emit。
 * L3：IR 快照缓存（configVersion + 上游内容 hash → Profile），命中跳过 Ingest。
 * 两者都是可重建产物，只放内存，不进 SQLite。
 */
export class BuildCache {
  private readonly l2 = new Map<string, CachedBuild>();
  private readonly l3 = new Map<string, Profile>();
  private readonly maxEntries: number;

  // 不用 constructor parameter property：Node 原生 TS 剥离（strip-only）不支持该语法。
  constructor(maxEntries: number = 64) {
    this.maxEntries = maxEntries;
  }

  private trim<T>(map: Map<string, T>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
    }
  }

  getL2(etag: string, target: string): CachedBuild | undefined {
    const value = this.l2.get(`${etag}:${target}`);
    if (value !== undefined) {
      this.l2.delete(`${etag}:${target}`);
      this.l2.set(`${etag}:${target}`, value); // LRU 提到队尾
    }
    return value;
  }

  setL2(etag: string, target: string, value: CachedBuild): void {
    this.l2.set(`${etag}:${target}`, value);
    this.trim(this.l2);
  }

  getL3(irKey: string): Profile | undefined {
    return this.l3.get(irKey);
  }

  setL3(irKey: string, profile: Profile): void {
    this.l3.set(irKey, profile);
    this.trim(this.l3);
  }

  clear(): void {
    this.l2.clear();
    this.l3.clear();
  }
}
