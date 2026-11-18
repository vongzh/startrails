import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isPublicAddress } from './url-guard.ts';

/**
 * 服务端离线 IP 国家与 ASN 归属查询（按「手动标注 > 节点名 > 离线 IP 库」的最后兜底）。
 *
 * 数据源约定：
 * - 上游使用 `sapics/ip-location-db`（ODC PDDL 1.0），不打包进 git，
 *   运行脚本 `npm run geo:update` 或在设置页点「更新库」下载并编译为定长大端有序二进制到 `<dataDir>/geo/`；
 * - 未下载时 `status().available === false`，所有查询零开销安全返回空结果。
 *
 * 二进制布局：
 * - `country-v4.bin`：`[4B start BE][4B end BE][2B ASCII code]`（10 B / 条）
 * - `country-v6.bin`：`[16B start][16B end][2B ASCII code]`（34 B / 条）
 * - `asn-v4.bin`：`[4B start BE][4B end BE][4B asn BE][4B nameOffset BE][2B nameLen BE]`（18 B / 条）
 * - `asn-v6.bin`：`[16B start][16B end][4B asn BE][4B nameOffset BE][2B nameLen BE]`（42 B / 条）
 * - `asn-names.bin`：去重后的 UTF-8 组织名池，命中范围后按切片解码，不在内存建全量字典。
 */

export const GEO_SOURCE_REPO = 'sapics/ip-location-db';

export const GEO_UPSTREAM_URLS = {
  countryV4: 'https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv4-num.csv',
  countryV6: 'https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv6.csv',
  asnV4: 'https://github.com/sapics/ip-location-db/releases/download/latest/origin-asn-ipv4-num.csv',
  asnV6: 'https://github.com/sapics/ip-location-db/releases/download/latest/origin-asn-ipv6.csv',
} as const;

const COUNTRY_V4_RECORD_BYTES = 10;
const COUNTRY_V6_RECORD_BYTES = 34;
const ASN_V4_RECORD_BYTES = 18;
const ASN_V6_RECORD_BYTES = 42;

const FILES = {
  countryV4: 'country-v4.bin',
  countryV6: 'country-v6.bin',
  asnV4: 'asn-v4.bin',
  asnV6: 'asn-v6.bin',
  asnNames: 'asn-names.bin',
  manifest: 'manifest.json',
} as const;

export interface GeoCounts {
  readonly countryV4: number;
  readonly countryV6: number;
  readonly asnV4: number;
  readonly asnV6: number;
}

export interface GeoStatus {
  readonly available: boolean;
  readonly geoDir: string;
  readonly updatedAt: string | null;
  readonly source: string;
  readonly counts: GeoCounts;
  readonly bytes: number;
  readonly filesPresent: readonly string[];
}

export interface GeoHostInfo {
  readonly country?: string;
  readonly asn?: number;
  readonly org?: string;
  readonly addresses: readonly string[];
  readonly conflict: boolean;
}

export interface GeoServiceOptions {
  readonly resolver?: (host: string) => Promise<readonly string[]>;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly dnsTimeoutMs?: number;
  readonly maxCacheEntries?: number;
}

export interface GeoService {
  readonly status: () => GeoStatus;
  readonly reload: () => GeoStatus;
  readonly update: () => Promise<GeoStatus>;
  readonly lookupCountryIp: (ip: string) => string | undefined;
  readonly lookupAsnIp: (ip: string) => { readonly asn: number; readonly org: string } | undefined;
  readonly peekHost: (host: string) => GeoHostInfo | undefined;
  readonly lookupHost: (host: string) => Promise<GeoHostInfo>;
}

/**
 * Startrails 内部统一用 `UK` 表示英国（对齐 REGION_CODES / RegionMap / NodesView），
 * 而 ISO 3166-1 alpha-2 IP 库返回 `GB`。查询出口统一归一回 `UK`。
 */
export function normalizeCountryRegion(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return undefined;
  return upper === 'GB' ? 'UK' : upper;
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim().replace(/^\[|\]$/g, '');
  const zoneIndex = trimmed.indexOf('%');
  const withoutZone = zoneIndex >= 0 ? trimmed.slice(0, zoneIndex) : trimmed;
  return withoutZone.toLowerCase();
}

export function parseIPv4Num(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function parseIPv6Bytes(raw: string): Uint8Array | null {
  const ip = normalizeHost(raw);
  if (isIP(ip) !== 6) return null;

  // 处理 IPv4 嵌尾写法（例如 ::ffff:1.2.3.4 或 2001:db8::192.0.2.1）
  let normalized = ip;
  const lastColon = normalized.lastIndexOf(':');
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4Num(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dbl = normalized.indexOf('::');
  let groups: number[] = [];
  if (dbl >= 0) {
    const leftRaw = normalized.slice(0, dbl);
    const rightRaw = normalized.slice(dbl + 2);
    const left = leftRaw === '' ? [] : leftRaw.split(':');
    const right = rightRaw === '' ? [] : rightRaw.split(':');
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const parsedLeft = left.map((part) => Number.parseInt(part, 16));
    const parsedRight = right.map((part) => Number.parseInt(part, 16));
    if (
      parsedLeft.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ||
      parsedRight.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)
    ) {
      return null;
    }
    groups = [...parsedLeft, ...new Array<number>(missing).fill(0), ...parsedRight];
  } else {
    const parts = normalized.split(':');
    if (parts.length !== 8) return null;
    groups = parts.map((part) => Number.parseInt(part, 16));
    if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  }

  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const word = groups[i] ?? 0;
    out[i * 2] = (word >>> 8) & 0xff;
    out[i * 2 + 1] = word & 0xff;
  }
  return out;
}

function mappedIPv4FromBytes16(bytes: Uint8Array): number | null {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return (
    ((bytes[12] ?? 0) * 0x1000000) +
    ((bytes[13] ?? 0) << 16) +
    ((bytes[14] ?? 0) << 8) +
    (bytes[15] ?? 0)
  ) >>> 0;
}

function compareBytes16(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 16; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function compareBytes16Buf(addr: Uint8Array, buf: Buffer, offset: number): number {
  for (let i = 0; i < 16; i += 1) {
    const av = addr[i] ?? 0;
    const bv = buf[offset + i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

function isNext128(prevEnd: Uint8Array, nextStart: Uint8Array): boolean {
  let carry = 1;
  for (let i = 15; i >= 0; i -= 1) {
    const sum = (prevEnd[i] ?? 0) + carry;
    const byte = sum & 0xff;
    carry = sum >>> 8;
    if (byte !== (nextStart[i] ?? 0)) return false;
  }
  return carry === 0;
}

function forEachLine(text: string, visitor: (line: string) => void): void {
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0 && !line.startsWith('#')) visitor(line);
    if (nl < 0) break;
    start = nl + 1;
  }
}

/** RFC-4180 单行解析：处理 `"Cloudflare, Inc."` 与双引号转义 `""`。 */
function parseCsvFields(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      i += 1;
      let cell = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else {
            i += 1;
            break;
          }
        } else {
          cell += line[i] ?? '';
          i += 1;
        }
      }
      out.push(cell);
      if (line[i] === ',') i += 1;
      else break;
    } else {
      const comma = line.indexOf(',', i);
      if (comma < 0) {
        out.push(line.slice(i));
        break;
      }
      out.push(line.slice(i, comma));
      i = comma + 1;
    }
  }
  return out;
}

function parseUint32Field(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return n >>> 0;
  }
  return parseIPv4Num(raw);
}

export function compileCountryV4Csv(csv: string): { readonly buffer: Buffer; readonly count: number } {
  interface RowV4 {
    start: number;
    end: number;
    c0: number;
    c1: number;
  }
  const rows: RowV4[] = [];
  forEachLine(csv, (line) => {
    const fields = parseCsvFields(line);
    if (fields.length < 3) return;
    const start = parseUint32Field(fields[0]?.trim());
    const end = parseUint32Field(fields[1]?.trim());
    const code = (fields[2] ?? '').trim().toUpperCase();
    if (start === null || end === null || end < start || !/^[A-Z]{2}$/.test(code)) return;
    rows.push({ start, end, c0: code.charCodeAt(0), c1: code.charCodeAt(1) });
  });

  rows.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const merged: RowV4[] = [];
  for (const row of rows) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      prev.c0 === row.c0 &&
      prev.c1 === row.c1 &&
      prev.end + 1 >= row.start
    ) {
      if (row.end > prev.end) prev.end = row.end;
    } else {
      merged.push({ ...row });
    }
  }

  const buffer = Buffer.allocUnsafe(merged.length * COUNTRY_V4_RECORD_BYTES);
  for (let i = 0; i < merged.length; i += 1) {
    const r = merged[i]!;
    const offset = i * COUNTRY_V4_RECORD_BYTES;
    buffer.writeUInt32BE(r.start, offset);
    buffer.writeUInt32BE(r.end, offset + 4);
    buffer[offset + 8] = r.c0;
    buffer[offset + 9] = r.c1;
  }
  return { buffer, count: merged.length };
}

export function compileCountryV6Csv(csv: string): { readonly buffer: Buffer; readonly count: number } {
  interface RowV6 {
    start: Uint8Array;
    end: Uint8Array;
    c0: number;
    c1: number;
  }
  const rows: RowV6[] = [];
  forEachLine(csv, (line) => {
    const fields = parseCsvFields(line);
    if (fields.length < 3) return;
    const start = parseIPv6Bytes(fields[0] ?? '');
    const end = parseIPv6Bytes(fields[1] ?? '');
    const code = (fields[2] ?? '').trim().toUpperCase();
    if (start === null || end === null || compareBytes16(start, end) > 0 || !/^[A-Z]{2}$/.test(code)) return;
    rows.push({ start, end, c0: code.charCodeAt(0), c1: code.charCodeAt(1) });
  });

  rows.sort((a, b) => compareBytes16(a.start, b.start) || compareBytes16(a.end, b.end));
  const merged: RowV6[] = [];
  for (const row of rows) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      prev.c0 === row.c0 &&
      prev.c1 === row.c1 &&
      (isNext128(prev.end, row.start) || compareBytes16(prev.end, row.start) >= 0)
    ) {
      if (compareBytes16(row.end, prev.end) > 0) prev.end = row.end;
    } else {
      merged.push({ ...row });
    }
  }

  const buffer = Buffer.allocUnsafe(merged.length * COUNTRY_V6_RECORD_BYTES);
  for (let i = 0; i < merged.length; i += 1) {
    const r = merged[i]!;
    const offset = i * COUNTRY_V6_RECORD_BYTES;
    buffer.set(r.start, offset);
    buffer.set(r.end, offset + 16);
    buffer[offset + 32] = r.c0;
    buffer[offset + 33] = r.c1;
  }
  return { buffer, count: merged.length };
}

export function compileAsnCsvs(
  v4Csv: string,
  v6Csv: string,
): {
  readonly v4: Buffer;
  readonly v6: Buffer;
  readonly names: Buffer;
  readonly v4Count: number;
  readonly v6Count: number;
} {
  const poolChunks: Buffer[] = [];
  const poolIndex = new Map<string, { readonly offset: number; readonly length: number }>();
  let poolCursor = 0;

  const internOrg = (raw: string): { readonly offset: number; readonly length: number } | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const hit = poolIndex.get(trimmed);
    if (hit !== undefined) return hit;
    let bytes = Buffer.from(trimmed, 'utf8');
    if (bytes.length > 0xffff) bytes = bytes.subarray(0, 0xffff);
    const entry = { offset: poolCursor, length: bytes.length };
    poolChunks.push(bytes);
    poolIndex.set(trimmed, entry);
    poolCursor += bytes.length;
    return entry;
  };

  interface AsnV4Row {
    start: number;
    end: number;
    asn: number;
    nameOffset: number;
    nameLength: number;
  }
  const rows4: AsnV4Row[] = [];
  forEachLine(v4Csv, (line) => {
    const fields = parseCsvFields(line);
    if (fields.length < 4) return;
    const start = parseUint32Field(fields[0]?.trim());
    const end = parseUint32Field(fields[1]?.trim());
    const asnRaw = (fields[2] ?? '').trim().replace(/^AS/i, '');
    const asn = Number.parseInt(asnRaw, 10);
    const org = internOrg(fields.slice(3).join(','));
    if (start === null || end === null || end < start || !Number.isInteger(asn) || asn <= 0 || org === null) return;
    rows4.push({ start, end, asn: asn >>> 0, nameOffset: org.offset, nameLength: org.length });
  });
  rows4.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const merged4: AsnV4Row[] = [];
  for (const row of rows4) {
    const prev = merged4[merged4.length - 1];
    if (
      prev !== undefined &&
      prev.asn === row.asn &&
      prev.nameOffset === row.nameOffset &&
      prev.nameLength === row.nameLength &&
      prev.end + 1 >= row.start
    ) {
      if (row.end > prev.end) prev.end = row.end;
    } else {
      merged4.push({ ...row });
    }
  }
  const v4 = Buffer.allocUnsafe(merged4.length * ASN_V4_RECORD_BYTES);
  for (let i = 0; i < merged4.length; i += 1) {
    const r = merged4[i]!;
    const offset = i * ASN_V4_RECORD_BYTES;
    v4.writeUInt32BE(r.start, offset);
    v4.writeUInt32BE(r.end, offset + 4);
    v4.writeUInt32BE(r.asn, offset + 8);
    v4.writeUInt32BE(r.nameOffset, offset + 12);
    v4.writeUInt16BE(r.nameLength, offset + 16);
  }

  interface AsnV6Row {
    start: Uint8Array;
    end: Uint8Array;
    asn: number;
    nameOffset: number;
    nameLength: number;
  }
  const rows6: AsnV6Row[] = [];
  forEachLine(v6Csv, (line) => {
    const fields = parseCsvFields(line);
    if (fields.length < 4) return;
    const start = parseIPv6Bytes(fields[0] ?? '');
    const end = parseIPv6Bytes(fields[1] ?? '');
    const asnRaw = (fields[2] ?? '').trim().replace(/^AS/i, '');
    const asn = Number.parseInt(asnRaw, 10);
    const org = internOrg(fields.slice(3).join(','));
    if (
      start === null ||
      end === null ||
      compareBytes16(start, end) > 0 ||
      !Number.isInteger(asn) ||
      asn <= 0 ||
      org === null
    ) {
      return;
    }
    rows6.push({ start, end, asn: asn >>> 0, nameOffset: org.offset, nameLength: org.length });
  });
  rows6.sort((a, b) => compareBytes16(a.start, b.start) || compareBytes16(a.end, b.end));
  const merged6: AsnV6Row[] = [];
  for (const row of rows6) {
    const prev = merged6[merged6.length - 1];
    if (
      prev !== undefined &&
      prev.asn === row.asn &&
      prev.nameOffset === row.nameOffset &&
      prev.nameLength === row.nameLength &&
      (isNext128(prev.end, row.start) || compareBytes16(prev.end, row.start) >= 0)
    ) {
      if (compareBytes16(row.end, prev.end) > 0) prev.end = row.end;
    } else {
      merged6.push({ ...row });
    }
  }
  const v6 = Buffer.allocUnsafe(merged6.length * ASN_V6_RECORD_BYTES);
  for (let i = 0; i < merged6.length; i += 1) {
    const r = merged6[i]!;
    const offset = i * ASN_V6_RECORD_BYTES;
    v6.set(r.start, offset);
    v6.set(r.end, offset + 16);
    v6.writeUInt32BE(r.asn, offset + 32);
    v6.writeUInt32BE(r.nameOffset, offset + 36);
    v6.writeUInt16BE(r.nameLength, offset + 40);
  }

  return {
    v4,
    v6,
    names: Buffer.concat(poolChunks),
    v4Count: merged4.length,
    v6Count: merged6.length,
  };
}

function writeAtomic(targetPath: string, data: Buffer | string): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, targetPath);
}

interface ManifestData {
  readonly version: number;
  readonly updatedAt: string;
  readonly source: string;
  readonly counts: GeoCounts;
  readonly bytes: number;
  readonly sha256: string;
}

export function compileGeoFromCsv(
  geoDir: string,
  inputs: {
    readonly countryV4: string;
    readonly countryV6: string;
    readonly asnV4: string;
    readonly asnV6: string;
  },
): GeoStatus {
  mkdirSync(geoDir, { recursive: true });
  const c4 = compileCountryV4Csv(inputs.countryV4);
  const c6 = compileCountryV6Csv(inputs.countryV6);
  const asn = compileAsnCsvs(inputs.asnV4, inputs.asnV6);

  writeAtomic(join(geoDir, FILES.countryV4), c4.buffer);
  writeAtomic(join(geoDir, FILES.countryV6), c6.buffer);
  writeAtomic(join(geoDir, FILES.asnV4), asn.v4);
  writeAtomic(join(geoDir, FILES.asnV6), asn.v6);
  writeAtomic(join(geoDir, FILES.asnNames), asn.names);

  const bytes = c4.buffer.length + c6.buffer.length + asn.v4.length + asn.v6.length + asn.names.length;
  const updatedAt = new Date().toISOString();
  const digest = createHash('sha256')
    .update(c4.buffer)
    .update(c6.buffer)
    .update(asn.v4)
    .update(asn.v6)
    .update(asn.names)
    .digest('hex')
    .slice(0, 16);

  const manifest: ManifestData = {
    version: 1,
    updatedAt,
    source: GEO_SOURCE_REPO,
    counts: {
      countryV4: c4.count,
      countryV6: c6.count,
      asnV4: asn.v4Count,
      asnV6: asn.v6Count,
    },
    bytes,
    sha256: digest,
  };
  writeAtomic(join(geoDir, FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

  return readGeoStatus(geoDir);
}

async function fetchCsvText(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Startrails-GeoUpdater/1.0' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`geo-fetch-failed:${response.status}:${url}`);
  }
  return response.text();
}

export async function downloadAndCompileGeoDatabases(geoDir: string): Promise<GeoStatus> {
  const [countryV4, countryV6, asnV4, asnV6] = await Promise.all([
    fetchCsvText(GEO_UPSTREAM_URLS.countryV4),
    fetchCsvText(GEO_UPSTREAM_URLS.countryV6),
    fetchCsvText(GEO_UPSTREAM_URLS.asnV4),
    fetchCsvText(GEO_UPSTREAM_URLS.asnV6),
  ]);
  return compileGeoFromCsv(geoDir, { countryV4, countryV6, asnV4, asnV6 });
}

function readOptionalFile(path: string): Buffer {
  try {
    return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function readGeoStatus(geoDir: string): GeoStatus {
  const binFiles = [FILES.countryV4, FILES.countryV6, FILES.asnV4, FILES.asnV6, FILES.asnNames];
  const filesPresent: string[] = [];
  let bytes = 0;
  let newestMtime: Date | null = null;
  for (const name of binFiles) {
    const full = join(geoDir, name);
    if (!existsSync(full)) continue;
    try {
      const st = statSync(full);
      filesPresent.push(name);
      bytes += st.size;
      if (newestMtime === null || st.mtime > newestMtime) newestMtime = st.mtime;
    } catch {
      // 忽略瞬间不可读
    }
  }

  let updatedAt: string | null = newestMtime?.toISOString() ?? null;
  let manifestCounts: GeoCounts | null = null;
  let source = GEO_SOURCE_REPO;
  const manifestPath = join(geoDir, FILES.manifest);
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<ManifestData>;
      if (typeof parsed.updatedAt === 'string') updatedAt = parsed.updatedAt;
      if (typeof parsed.source === 'string') source = parsed.source;
      if (parsed.counts !== undefined) manifestCounts = parsed.counts;
    } catch {
      // 坏 manifest 回退从二进制大小算条数
    }
  }

  const statCount = (file: string, recordBytes: number): number => {
    const full = join(geoDir, file);
    if (!existsSync(full)) return 0;
    try {
      const size = statSync(full).size;
      return size % recordBytes === 0 ? size / recordBytes : 0;
    } catch {
      return 0;
    }
  };

  const counts: GeoCounts = manifestCounts ?? {
    countryV4: statCount(FILES.countryV4, COUNTRY_V4_RECORD_BYTES),
    countryV6: statCount(FILES.countryV6, COUNTRY_V6_RECORD_BYTES),
    asnV4: statCount(FILES.asnV4, ASN_V4_RECORD_BYTES),
    asnV6: statCount(FILES.asnV6, ASN_V6_RECORD_BYTES),
  };
  const available = counts.countryV4 > 0 || counts.countryV6 > 0 || counts.asnV4 > 0 || counts.asnV6 > 0;

  return {
    available,
    geoDir,
    updatedAt,
    source,
    counts,
    bytes,
    filesPresent,
  };
}

interface LoadedBuffers {
  readonly countryV4: Buffer;
  readonly countryV6: Buffer;
  readonly asnV4: Buffer;
  readonly asnV6: Buffer;
  readonly asnNames: Buffer;
  readonly available: boolean;
}

function loadBuffers(geoDir: string): LoadedBuffers {
  const countryV4 = readOptionalFile(join(geoDir, FILES.countryV4));
  const countryV6 = readOptionalFile(join(geoDir, FILES.countryV6));
  const asnV4 = readOptionalFile(join(geoDir, FILES.asnV4));
  const asnV6 = readOptionalFile(join(geoDir, FILES.asnV6));
  const asnNames = readOptionalFile(join(geoDir, FILES.asnNames));
  const available =
    countryV4.length >= COUNTRY_V4_RECORD_BYTES ||
    countryV6.length >= COUNTRY_V6_RECORD_BYTES ||
    asnV4.length >= ASN_V4_RECORD_BYTES ||
    asnV6.length >= ASN_V6_RECORD_BYTES;
  return { countryV4, countryV6, asnV4, asnV6, asnNames, available };
}

function lookupCountryV4(buf: Buffer, address: number): string | undefined {
  if (buf.length < COUNTRY_V4_RECORD_BYTES || buf.length % COUNTRY_V4_RECORD_BYTES !== 0) return undefined;
  let low = 0;
  let high = buf.length / COUNTRY_V4_RECORD_BYTES - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const offset = mid * COUNTRY_V4_RECORD_BYTES;
    const start = buf.readUInt32BE(offset);
    if (address < start) {
      high = mid - 1;
      continue;
    }
    const end = buf.readUInt32BE(offset + 4);
    if (address > end) {
      low = mid + 1;
      continue;
    }
    const raw = String.fromCharCode(buf[offset + 8] ?? 0, buf[offset + 9] ?? 0);
    return normalizeCountryRegion(raw);
  }
  return undefined;
}

function lookupCountryV6(buf: Buffer, addr: Uint8Array): string | undefined {
  if (buf.length < COUNTRY_V6_RECORD_BYTES || buf.length % COUNTRY_V6_RECORD_BYTES !== 0) return undefined;
  let low = 0;
  let high = buf.length / COUNTRY_V6_RECORD_BYTES - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const offset = mid * COUNTRY_V6_RECORD_BYTES;
    if (compareBytes16Buf(addr, buf, offset) < 0) {
      high = mid - 1;
      continue;
    }
    if (compareBytes16Buf(addr, buf, offset + 16) > 0) {
      low = mid + 1;
      continue;
    }
    const raw = String.fromCharCode(buf[offset + 32] ?? 0, buf[offset + 33] ?? 0);
    return normalizeCountryRegion(raw);
  }
  return undefined;
}

function decodeAsnOrg(names: Buffer, asn: number, nameOffset: number, nameLength: number): { asn: number; org: string } | undefined {
  if (asn <= 0 || nameLength <= 0 || nameOffset + nameLength > names.length) return undefined;
  const org = names.toString('utf8', nameOffset, nameOffset + nameLength).trim();
  return org.length === 0 ? undefined : { asn, org };
}

function lookupAsnV4(buf: Buffer, names: Buffer, address: number): { asn: number; org: string } | undefined {
  if (buf.length < ASN_V4_RECORD_BYTES || buf.length % ASN_V4_RECORD_BYTES !== 0) return undefined;
  let low = 0;
  let high = buf.length / ASN_V4_RECORD_BYTES - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const offset = mid * ASN_V4_RECORD_BYTES;
    const start = buf.readUInt32BE(offset);
    if (address < start) {
      high = mid - 1;
      continue;
    }
    const end = buf.readUInt32BE(offset + 4);
    if (address > end) {
      low = mid + 1;
      continue;
    }
    const asn = buf.readUInt32BE(offset + 8);
    const nameOffset = buf.readUInt32BE(offset + 12);
    const nameLength = buf.readUInt16BE(offset + 16);
    return decodeAsnOrg(names, asn, nameOffset, nameLength);
  }
  return undefined;
}

function lookupAsnV6(buf: Buffer, names: Buffer, addr: Uint8Array): { asn: number; org: string } | undefined {
  if (buf.length < ASN_V6_RECORD_BYTES || buf.length % ASN_V6_RECORD_BYTES !== 0) return undefined;
  let low = 0;
  let high = buf.length / ASN_V6_RECORD_BYTES - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const offset = mid * ASN_V6_RECORD_BYTES;
    if (compareBytes16Buf(addr, buf, offset) < 0) {
      high = mid - 1;
      continue;
    }
    if (compareBytes16Buf(addr, buf, offset + 16) > 0) {
      low = mid + 1;
      continue;
    }
    const asn = buf.readUInt32BE(offset + 32);
    const nameOffset = buf.readUInt32BE(offset + 36);
    const nameLength = buf.readUInt16BE(offset + 40);
    return decodeAsnOrg(names, asn, nameOffset, nameLength);
  }
  return undefined;
}

const EMPTY_HOST_INFO: GeoHostInfo = {
  addresses: [],
  conflict: false,
};

async function defaultResolve(host: string, timeoutMs: number): Promise<readonly string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      dnsLookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns-timeout')), timeoutMs);
      }),
    ]);
    const unique: string[] = [];
    for (const entry of entries) {
      const ip = normalizeHost(entry.address);
      if (ip.length > 0 && !unique.includes(ip)) unique.push(ip);
    }
    return unique;
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createGeoService(geoDir: string, options: GeoServiceOptions = {}): GeoService {
  const successTtlMs = options.successTtlMs ?? 3_600_000;
  const failureTtlMs = options.failureTtlMs ?? 30_000;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 2_000;
  const maxCacheEntries = options.maxCacheEntries ?? 8_000;
  const resolver =
    options.resolver ?? ((host: string) => defaultResolve(host, dnsTimeoutMs));

  let buffers = loadBuffers(geoDir);
  let updatePromise: Promise<GeoStatus> | null = null;
  const hostCache = new Map<string, { readonly info: GeoHostInfo; readonly expiresAt: number }>();
  const inFlight = new Map<string, Promise<GeoHostInfo>>();

  const lookupCountryIp = (rawIp: string): string | undefined => {
    const ip = normalizeHost(rawIp);
    const v4 = parseIPv4Num(ip);
    if (v4 !== null) return lookupCountryV4(buffers.countryV4, v4);
    const v6 = parseIPv6Bytes(ip);
    if (v6 === null) return undefined;
    const mapped = mappedIPv4FromBytes16(v6);
    if (mapped !== null) {
      return lookupCountryV4(buffers.countryV4, mapped) ?? lookupCountryV6(buffers.countryV6, v6);
    }
    return lookupCountryV6(buffers.countryV6, v6);
  };

  const lookupAsnIp = (rawIp: string): { readonly asn: number; readonly org: string } | undefined => {
    const ip = normalizeHost(rawIp);
    const v4 = parseIPv4Num(ip);
    if (v4 !== null) return lookupAsnV4(buffers.asnV4, buffers.asnNames, v4);
    const v6 = parseIPv6Bytes(ip);
    if (v6 === null) return undefined;
    const mapped = mappedIPv4FromBytes16(v6);
    if (mapped !== null) {
      return (
        lookupAsnV4(buffers.asnV4, buffers.asnNames, mapped) ??
        lookupAsnV6(buffers.asnV6, buffers.asnNames, v6)
      );
    }
    return lookupAsnV6(buffers.asnV6, buffers.asnNames, v6);
  };

  const summarizeAddresses = (addresses: readonly string[]): GeoHostInfo => {
    const publicIps = addresses.filter((ip) => isPublicAddress(ip));
    if (publicIps.length === 0) {
      return { addresses: [], conflict: false };
    }
    const countries = new Set<string>();
    const orgs: { readonly asn: number; readonly org: string }[] = [];
    for (const ip of publicIps) {
      const c = lookupCountryIp(ip);
      if (c !== undefined) countries.add(c);
      const a = lookupAsnIp(ip);
      if (a !== undefined) orgs.push(a);
    }
    const conflict = countries.size > 1;
    const country = countries.size === 1 ? [...countries][0] : undefined;
    orgs.sort((left, right) => left.asn - right.asn);
    const primaryOrg = orgs[0];
    return {
      ...(country === undefined ? {} : { country }),
      ...(primaryOrg === undefined ? {} : { asn: primaryOrg.asn, org: primaryOrg.org }),
      addresses: publicIps,
      conflict,
    };
  };

  const setCached = (host: string, info: GeoHostInfo): void => {
    const now = Date.now();
    if (hostCache.size >= maxCacheEntries) {
      for (const [key, entry] of hostCache) {
        if (entry.expiresAt <= now) hostCache.delete(key);
      }
      if (hostCache.size >= maxCacheEntries) {
        const firstKey = hostCache.keys().next().value;
        if (firstKey !== undefined) hostCache.delete(firstKey);
      }
    }
    const ttl = info.addresses.length === 0 || info.conflict ? failureTtlMs : successTtlMs;
    hostCache.set(host, { info, expiresAt: now + ttl });
  };

  const peekHost = (rawHost: string): GeoHostInfo | undefined => {
    if (!buffers.available) return undefined;
    const host = normalizeHost(rawHost);
    if (host.length === 0) return undefined;
    const cached = hostCache.get(host);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.info;
    if (isIP(host) !== 0) {
      const info = summarizeAddresses([host]);
      setCached(host, info);
      return info;
    }
    return undefined;
  };

  const lookupHost = async (rawHost: string): Promise<GeoHostInfo> => {
    if (!buffers.available) return EMPTY_HOST_INFO;
    const host = normalizeHost(rawHost);
    if (host.length === 0) return EMPTY_HOST_INFO;

    const cached = hostCache.get(host);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.info;

    if (isIP(host) !== 0) {
      const info = summarizeAddresses([host]);
      setCached(host, info);
      return info;
    }

    const existing = inFlight.get(host);
    if (existing !== undefined) return existing;

    const task = (async (): Promise<GeoHostInfo> => {
      try {
        const resolved = await resolver(host);
        const normalized = [...new Set(resolved.map(normalizeHost).filter((ip) => isIP(ip) !== 0))];
        const info = summarizeAddresses(normalized);
        setCached(host, info);
        return info;
      } finally {
        inFlight.delete(host);
      }
    })();

    inFlight.set(host, task);
    return task;
  };

  const reload = (): GeoStatus => {
    buffers = loadBuffers(geoDir);
    hostCache.clear();
    return readGeoStatus(geoDir);
  };

  const update = (): Promise<GeoStatus> => {
    if (updatePromise !== null) return updatePromise;
    updatePromise = downloadAndCompileGeoDatabases(geoDir)
      .then((nextStatus) => {
        buffers = loadBuffers(geoDir);
        hostCache.clear();
        return nextStatus;
      })
      .finally(() => {
        updatePromise = null;
      });
    return updatePromise;
  };

  return {
    status: () => readGeoStatus(geoDir),
    reload,
    update,
    lookupCountryIp,
    lookupAsnIp,
    peekHost,
    lookupHost,
  };
}
