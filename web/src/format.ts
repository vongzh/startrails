/** 展示层的纯格式化函数。 */

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

/** 流量口径：机场按 GB 计费，超过 1024 GB 收成 TB——不要出现 12345.67 MB 这种读不出量级的数字。 */
export function formatTraffic(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** 到期时间：上游给的是 unix 秒。剩余不足 7 天单独提示，别等过期才发现。 */
export function formatExpire(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '未知';
  const days = Math.floor((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return '已过期';
  if (days === 0) return '今天到期';
  if (days <= 7) return `${days} 天后到期`;
  return `${date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })} 到期`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function timeAgo(iso: string): string {
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return iso;
  const diff = Date.now() - date;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(iso);
}

/** 时长的紧凑中文写法（毫秒入）：用于「快照有多旧」这类扫读场景，不做精确到秒的表演。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '不到 1 分钟';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} 天` : `${days} 天 ${hours % 24} 小时`;
}

/** 从订阅 URL 里提取主机名，用于列表副标题（凭据已被服务端脱敏）。 */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}

export function initialOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '·';
  // 不能用 slice(0, 1)：名字以 emoji 开头会截出半个代理对，浏览器渲染成菱形替换字符，
  // 源头像看起来就像「图标坏了」。Array.from 按完整码点迭代，取得到整字。
  const [first] = Array.from(trimmed);
  return first ?? '·';
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/** 阶段中文名：诊断列表按此分组，避免直接暴露内部代码。 */
export const STAGE_LABELS: Record<string, string> = {
  ingest: '采集',
  process: '加工',
  plan: '规划',
  emit: '导出',
};

export type Severity = 'danger' | 'warn' | 'muted' | 'accent';

/**
 * 代码级诊断原因 → 人话。没映射到的（例如 `upstream-failed:xxx`）原样显示，
 * 保留可对照日志的原文；只把「用户看得见但看不懂」的那几个翻译掉。
 */
export const REASON_LABELS: Record<string, string> = {
  'profile-empty': '当前配置还没有任何订阅',
  'profile-no-nodes': '构成里有订阅，但一个节点都没解析出来',
  'source-not-found': '引用的订阅已不存在',
  'source-disabled': '订阅已停用',
  'source-unavailable': '订阅内容不可用',
  'source-payload-empty': '订阅没有正文',
  'collection-not-found': '引用的组合订阅已不存在',
  'collection-member-missing': '组合订阅的成员已不存在',
};

export const reasonLabel = (reason: string): string => REASON_LABELS[reason] ?? reason;

/** 按诊断原因推断严重程度：丢弃节点 > 字段降级 > 跳过 > 信息。 */
export function severityOf(reason: string): Severity {
  if (reason === 'profile-empty' || reason === 'profile-no-nodes') return 'danger';
  if (reason.includes('unsupported') || reason.includes('reject')) return 'danger';
  if (reason.startsWith('upstream-failed:') || reason.startsWith('拉取失败')) return 'danger';
  if (reason.startsWith('upstream-stale:') || reason.startsWith('回退旧快照')) return 'warn';
  if (reason.includes('unverified') || reason.includes('downgrade') || reason.includes('not-expressible')) {
    return 'warn';
  }
  if (reason.includes('skipped') || reason.includes('excluded')) return 'muted';
  return 'accent';
}
