/**
 * 刷新策略：`15m` / `6h` / `1d` / `30s`，以及 `off` / `manual`。
 * 刻意不做 cron 表达式——订阅源的刷新需求只有「隔多久拉一次」这一种，
 * 引入五段 cron 只会让人写错，且难以在 UI 上一行说清。
 */
export const REFRESH_PRESETS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'off', label: '不自动刷新' },
  { value: '30m', label: '每 30 分钟' },
  { value: '2h', label: '每 2 小时' },
  { value: '6h', label: '每 6 小时' },
  { value: '12h', label: '每 12 小时' },
  { value: '1d', label: '每天' },
];

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 返回间隔毫秒；`off` / `manual` / 空 / 非法一律 null（表示不自动刷新）。 */
export function parseRefreshPolicy(policy: string | undefined | null): number | null {
  if (policy === undefined || policy === null) return null;
  const text = policy.trim().toLowerCase();
  if (text.length === 0 || text === 'off' || text === 'manual' || text === 'none') return null;
  const match = /^(\d+)\s*([smhd])$/.exec(text);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = UNIT_MS[match[2] ?? ''];
  if (!Number.isFinite(amount) || amount <= 0 || unit === undefined) return null;
  // 下限 60 秒：低于这个量级对上游不友好，也没有实际意义。
  return Math.max(amount * unit, 60_000);
}

export interface RefreshCandidate {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly refreshPolicy?: string;
  readonly lastFetchedAt?: string;
}

/** 到期的源：启用中、是远端源、策略可解析、且距上次拉取已超过间隔。 */
export function dueSourceIds(
  sources: readonly RefreshCandidate[],
  now: number,
): readonly string[] {
  const due: string[] = [];
  for (const source of sources) {
    if (!source.enabled || source.kind !== 'remote') continue;
    const interval = parseRefreshPolicy(source.refreshPolicy);
    if (interval === null) continue;
    const last = source.lastFetchedAt === undefined ? null : Date.parse(source.lastFetchedAt);
    if (last === null || Number.isNaN(last) || now - last >= interval) due.push(source.id);
  }
  return due;
}
