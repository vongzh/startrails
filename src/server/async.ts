/**
 * 有界并发映射：按输入顺序返回结果，同时把并发数压在 `limit` 以内。
 * 用于上游源拉取、外部规则集预热等 IO 扇出场景，避免串行放大尾延迟或并发打爆远端。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => run()));
  return results;
}
