/**
 * 运维通知：Telegram Bot / Bark。
 *
 * 三条纪律：
 * 1. **永不阻塞主流程**——发送失败只记日志，不能因为 TG 挂了就让订阅构建失败；
 * 2. **去重**——同一类事件在窗口期内只发一次，否则调度器每轮失败都会刷一条；
 * 3. **消息里不放凭据**——节点链接、token、代理口令都不进通知正文。
 */
export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export interface BarkConfig {
  /** 完整推送地址，例如 https://api.day.app/<key> */
  readonly url: string;
}

export interface NotifyConfig {
  /**
   * 总开关。false = 暂停推送但保留渠道配置（不删 token），界面上的「运维通知」就是它。
   * 缺省视为开启，兼容环境变量与旧记录。
   */
  readonly enabled?: boolean;
  readonly telegram?: TelegramConfig;
  readonly bark?: BarkConfig;
  /** 同一 key 的最短重发间隔，默认 30 分钟。 */
  readonly minIntervalMs?: number;
}

export interface NotifyEvent {
  /** 去重键：同一件事反复发生只发一次。 */
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface Notifier {
  notify: (event: NotifyEvent) => Promise<boolean>;
  /** 当前生效的渠道快照（供 /api/ops 展示），每次调用实时求值。 */
  describe: () => { readonly enabled: boolean; readonly channels: readonly string[] };
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;

/**
 * 配置可以是静态对象，也可以是「每次发送前求值」的 provider。
 * 后者用于「界面可配」场景：通知渠道存库后，无需重启即可生效，且去重状态（sentAt）不丢失。
 */
export type NotifyConfigSource = NotifyConfig | (() => NotifyConfig | undefined);

export function createNotifier(
  source: NotifyConfigSource | undefined,
  /** 仅测试注入：默认用全局 fetch，生产不要传。 */
  fetchImpl: typeof fetch = fetch,
): Notifier {
  const resolve = (): NotifyConfig | undefined =>
    typeof source === 'function' ? source() : source;
  const sentAt = new Map<string, number>();

  const current = (): {
    readonly config: NotifyConfig;
    readonly channels: string[];
    readonly interval: number;
  } | null => {
    const config = resolve();
    // enabled === false 时整条链路静默：配置留着，开关一开就恢复，不用重填 token。
    if (config === undefined || config.enabled === false) return null;
    const channels: string[] = [];
    if (config.telegram !== undefined) channels.push('telegram');
    if (config.bark !== undefined) channels.push('bark');
    if (channels.length === 0) return null;
    return { config, channels, interval: config.minIntervalMs ?? DEFAULT_INTERVAL_MS };
  };

  return {
    notify: async (event) => {
      const active = current();
      if (active === null) return false;
      const now = Date.now();
      const last = sentAt.get(event.key);
      if (last !== undefined && now - last < active.interval) return false;
      sentAt.set(event.key, now);

      const results = await Promise.allSettled([
        ...(active.config.telegram === undefined
          ? []
          : [sendTelegram(fetchImpl, active.config.telegram, `【${event.title}】\n${event.body}`)]),
        ...(active.config.bark === undefined
          ? []
          : [sendBark(fetchImpl, active.config.bark, event.title, event.body)]),
      ]);
      // 通知失败不影响调用方；只在控制台留痕，避免把运维问题变成业务错误。
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(`[startrails] 通知发送失败：${String(result.reason).slice(0, 160)}`);
        }
      }
      return results.some((result) => result.status === 'fulfilled');
    },
    describe: () => {
      const active = current();
      return { enabled: active !== null, channels: active?.channels ?? [] };
    },
  };
}

export interface NotifyTestResult {
  readonly channel: string;
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * 一次性测试发送：**不去重、不吞错**。
 * 与 notify() 的纪律相反——运维点「测试」要的就是「到底通没通、卡在哪」，
 * 所以每个渠道的结果原样回给调用方，由界面决定怎么说。
 */
export async function sendTestNotify(
  config: NotifyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly NotifyTestResult[]> {
  const jobs: { readonly channel: string; readonly run: Promise<void> }[] = [];
  if (config.telegram !== undefined) {
    jobs.push({
      channel: 'telegram',
      run: sendTelegram(
        fetchImpl,
        config.telegram,
        '【Startrails】测试通知\n收到这条说明通知渠道已连通，无需操作。',
      ),
    });
  }
  if (config.bark !== undefined) {
    jobs.push({ channel: 'bark', run: sendBark(fetchImpl, config.bark, 'Startrails 测试通知', '通知渠道已连通') });
  }
  return Promise.all(
    jobs.map(async (job) => {
      try {
        await job.run;
        return { channel: job.channel, ok: true, error: null };
      } catch (error) {
        return {
          channel: job.channel,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
        };
      }
    }),
  );
}

const sendTelegram = async (fetchImpl: typeof fetch, config: TelegramConfig, text: string): Promise<void> => {
  const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`telegram-status:${response.status}`);
};

const sendBark = async (fetchImpl: typeof fetch, config: BarkConfig, title: string, body: string): Promise<void> => {
  const endpoint = `${config.url.replace(/\/+$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`bark-status:${response.status}`);
};
