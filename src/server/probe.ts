import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect } from 'node:net';
import { isPublicAddress } from './url-guard.ts';

/**
 * 延迟探测：**只测 TCP 握手**，不是代理链路的真实速度。
 *
 * 说清楚的边界：
 * - 测的是「主控机 → 节点 server:port」的 TCP three-way handshake 往返，不含 TLS、不含代理协议、
 *   不含落地出口；它只能回答「这台服务器现在通不通、大概多远」；
 * - 真实可用带宽必须由客户端跑测速，服务端在别的机房/别的出口上测出来没有参考意义；
 * - 结果不落库：延迟随时间变化，持久化只会让人误以为是稳定属性。
 *
 * 还有一个必须点明的坑：**本机开着 TUN / DNS 劫持时（mihomo、Clash TUN、部分公司 DNS），
 * 任意域名都会解析到一个本地假 IP 并握手成功**，测出来的是「到本机的延迟」——
 * 数字漂亮但毫无意义。因此先解析一次：解析结果不是公网地址时标 `intercepted`，
 * 界面据此提示，而不是把 2ms 当成好节点。
 */
export interface ProbeTarget {
  readonly nodeKey: string;
  readonly name: string;
  readonly server: string;
  readonly port: number;
}

export interface ProbeSample {
  readonly nodeKey: string;
  readonly name: string;
  readonly server: string;
  readonly port: number;
  /** 多次握手里最快的一次（毫秒）；全部失败为 null。 */
  readonly latencyMs: number | null;
  readonly error: string | null;
  /**
   * 目标解析到了非公网地址（内网 / 回环 / fake-ip）。此时延迟反映的是到该地址的链路，
   * 可能是本机 TUN 代理的假 IP，不能当作节点质量。
   */
  readonly intercepted: boolean;
}

const probeOnce = (host: string, port: number, timeoutMs: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      socket.destroy();
      resolve(elapsed);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(error.code ?? 'connect-failed'));
    });
  });

export async function probeTcp(
  host: string,
  port: number,
  options: { readonly timeoutMs?: number; readonly attempts?: number } = {},
): Promise<{ readonly latencyMs: number | null; readonly error: string | null }> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const attempts = Math.min(Math.max(options.attempts ?? 2, 1), 5);
  let best: number | null = null;
  let lastError = 'connect-failed';
  for (let index = 0; index < attempts; index += 1) {
    try {
      const value = await probeOnce(host, port, timeoutMs);
      if (best === null || value < best) best = value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'connect-failed';
    }
  }
  return best === null
    ? { latencyMs: null, error: lastError }
    : { latencyMs: Math.round(best), error: null };
}

/** 目标是否落在非公网地址上；解析失败按「不是劫持」处理，让握手本身去报错。 */
async function detectInterception(host: string): Promise<boolean> {
  if (isIP(host) !== 0) return !isPublicAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

/** 并发探测：默认 16 路，够快且不会把本机 fd 打满。 */
export async function probeAll(
  targets: readonly ProbeTarget[],
  options: { readonly timeoutMs?: number; readonly attempts?: number; readonly concurrency?: number } = {},
): Promise<readonly ProbeSample[]> {
  const concurrency = Math.min(Math.max(options.concurrency ?? 16, 1), 64);
  const results: ProbeSample[] = new Array(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (target === undefined) return;
      const [outcome, intercepted] = await Promise.all([
        probeTcp(target.server, target.port, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
        }),
        detectInterception(target.server),
      ]);
      results[index] = { ...target, ...outcome, intercepted };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}
