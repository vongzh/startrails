import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const deriveKey = (secret: string): Buffer =>
  scryptSync(secret, 'startrails-store-v1', 32);

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export const hashToken = (token: string): string => sha256(`token:${token}`);

export const newToken = (): string => randomBytes(24).toString('base64url');

/** 长度无关的安全比较，避免 timingSafeEqual 因长度不同而抛错。 */
export const safeEqual = (left: string, right: string): boolean => {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
};

/** 应用层字段级 AES-256-GCM：只宣称「避免明文落盘与误读」，不宣称防主机入侵。 */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
