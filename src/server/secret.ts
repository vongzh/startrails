import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 数据加密密钥的来源与落盘。
 *
 * 优先级固定为：环境变量 > `<data>/secret.key` > 本次进程的临时密钥。
 * 临时密钥只用于「还没有任何加密数据」的首次启动：管理面必须先设置密钥，
 * 否则会写入一批重启后解不开的正文。
 *
 * 为什么允许落盘：多数自托管用户不会提前生成环境变量，而首次进入就要求填一个
 * 随机串再让他们自己保存，等于把密钥管理成本推给用户。落盘文件与数据库同在
 * data 目录；备份数据库时仍必须把密钥单独保存，不能只留 .db。环境变量覆盖
 * 方便容器编排。
 */

/** 只挡明显过短的密钥；真正的强度交给用户或生成器。 */
export const MIN_TOKEN_SECRET_LENGTH = 16;

export type TokenSecretSource = 'env' | 'file' | 'ephemeral';

export interface ResolvedTokenSecret {
  readonly secret: string;
  readonly source: TokenSecretSource;
  /** false 时本次启动使用的是临时密钥，UI 必须要求设置后才能写入数据。 */
  readonly configured: boolean;
  readonly file: string;
}

export function readSecretFile(file: string): string | null {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export function resolveTokenSecret(options: {
  readonly envSecret?: string | undefined;
  readonly file: string;
}): ResolvedTokenSecret {
  const envSecret = options.envSecret?.trim() ?? '';
  if (envSecret.length > 0) {
    return { secret: envSecret, source: 'env', configured: true, file: options.file };
  }
  const persisted = readSecretFile(options.file);
  if (persisted !== null) {
    return { secret: persisted, source: 'file', configured: true, file: options.file };
  }
  return {
    secret: randomBytes(32).toString('hex'),
    source: 'ephemeral',
    configured: false,
    file: options.file,
  };
}

/**
 * 先写临时文件、再原子 rename。调用方在数据库重加密成功后才提交；
 * 重加密失败时调用 discardSecretFile 删除临时文件，避免出现「文件是新密钥、库是旧密钥」。
 */
export function stageSecretFile(file: string, secret: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows 没有 POSIX 权限位；文件仍落在受保护的 data 目录里。
    }
    return temp;
  } catch (error) {
    // 写一半（例如磁盘满）时不要留下可能含密钥的残片。
    try {
      unlinkSync(temp);
    } catch {
      // 临时文件可能根本没创建成功。
    }
    throw error;
  }
}

export function commitSecretFile(file: string, temp: string): void {
  renameSync(temp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 同上。
  }
}

export function discardSecretFile(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // 临时文件本来就可能已经不存在；清理失败不改变主流程结论。
  }
}
