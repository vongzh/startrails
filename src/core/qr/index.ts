/**
 * 二维码编码器（纯算法，零依赖，零 IO）。
 *
 * 为什么自己写：交付形态里「扫一下」是手机端最高频的动作，而引一个二维码库只为一个
 * 功能会把运行时依赖面扩大一整类（图形/Canvas 依赖在 Node 里还要额外装原生包）。
 * 这里只做**字节模式 + 自动版本 + 自动掩码**这一条路径，够订阅 URL 用，且能被单测
 * 用一个独立解码器（jsqr，仅 devDependency）反向验证——编码器写错了测试就红。
 *
 * 依据：ISO/IEC 18004 的公开结构（版本容量、分块、Reed-Solomon 纠错、8 种掩码、
 * 4 条罚分规则），实现路径与 Nayuki 的参考实现一致（算法论文式描述，非代码复制）。
 */

/** 纠错等级。字母是 QR 规范里的叫法，不是我们的缩写。 */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** 边长（模块数），含 4 模块静区。 */
  readonly size: number;
  /** `modules[y][x]`，true = 深色。已含静区。 */
  readonly modules: readonly (readonly boolean[])[];
  readonly version: number;
  readonly mask: number;
}

export interface QrOptions {
  readonly ec?: QrEcLevel;
  /** 静区宽度，规范推荐 4；贴边排版时可给 0，但要保证四周留白。 */
  readonly quietZone?: number;
}

const QUIET_ZONE = 4;

/** 纠错等级在格式信息里的 2 bit 编码：L=1、M=0、Q=3、H=2（不是 0/1/2/3）。 */
const EC_FORMAT_BITS: Readonly<Record<QrEcLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };

/** 表索引顺序与 EC_FORMAT_BITS 无关，取 L/M/Q/H 的字母序方便查表。 */
const EC_INDEX: Readonly<Record<QrEcLevel, number>> = { L: 0, M: 1, Q: 2, H: 3 };

// prettier-ignore
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  // 版本 0 是占位（非法值），后面依次是版本 1..40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// prettier-ignore
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** 该版本里「能放数据 + 纠错」的模块总数（函数图案已扣除）。 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ec: QrEcLevel): number {
  const index = EC_INDEX[ec];
  const ecc = ECC_CODEWORDS_PER_BLOCK[index]?.[version] ?? 0;
  const blocks = NUM_ERROR_CORRECTION_BLOCKS[index]?.[version] ?? 1;
  return Math.floor(rawDataModules(version) / 8) - ecc * blocks;
}

/** 字节模式（0100）的字符计数位宽：版本 1–9 是 8 bit，10 以上是 16 bit。 */
const charCountBits = (version: number): number => (version <= 9 ? 8 : 16);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * 选版本：从 `minVersion` 起找第一个放得下的。放不下直接抛错——**不静默截断**，
 * 因为截断出来的二维码能扫，但扫出来的订阅 URL 是错的，比扫不出来更难排查。
 */
function chooseVersion(byteLength: number, ec: QrEcLevel): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const capacityBits = dataCodewords(version, ec) * 8;
    const neededBits = 4 + charCountBits(version) + byteLength * 8;
    if (neededBits <= capacityBits) return version;
  }
  throw new Error(`qr-payload-too-large: ${byteLength} bytes at ec=${ec}`);
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/** 数据码字 + 纠错码字，按规范交错。 */
function addEccAndInterleave(data: readonly number[], version: number, ec: QrEcLevel): number[] {
  const index = EC_INDEX[ec];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[index]?.[version] ?? 1;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[index]?.[version] ?? 0;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const length = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + length);
    k += chunk.length;
    const block = chunk.slice();
    // 短块多留一格占位，交错时才对齐（长块那一格才是真实数据）。
    block.length = shortBlockLen + 1;
    const ecc = rsRemainder(chunk, divisor);
    for (let j = 0; j < ecc.length; j++) block[block.length - blockEccLen + j] = ecc[j] ?? 0;
    blocks.push(block);
  }

  const result: number[] = [];
  for (let i = 0; i < (blocks[0]?.length ?? 0); i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        const value = blocks[j]?.[i];
        if (value !== undefined) result.push(value);
      }
    }
  }
  return result;
}

function buildCodewords(payload: Uint8Array, version: number, ec: QrEcLevel): number[] {
  const capacityBits = dataCodewords(version, ec) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // 字节模式
  push(payload.length, charCountBits(version));
  for (const byte of payload) push(byte, 8);

  // 终止符最多 4 bit，然后补到字节边界
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | (bits[i + j] ?? 0);
    codewords.push(value);
  }
  // 填充字节 0xEC / 0x11 交替，直到填满
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return addEccAndInterleave(codewords, version, ec);
}

/** 对齐图案的中心坐标；版本 1 没有。 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array<number>(numAlign).fill(0);
  result[0] = 6;
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

interface Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
}

/** 画完所有函数图案（探测/定时/对齐/格式占位/版本），data 与掩码留空。 */
function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size, modules, isFunction } = grid;
  const set = (x: number, y: number, dark: boolean): void => {
    const row = modules[y];
    if (row !== undefined) row[x] = dark;
    const flag = isFunction[y];
    if (flag !== undefined) flag[x] = true;
  };

  // 顺序有讲究：定时图案先画（它横穿整行整列），探测图案后画并**覆盖**它——
  // 反过来的话探测图案最外侧那一列/行会被定时图案擦成黑白相间，扫描器直接认不出。
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  const pos = alignmentPositions(version);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set((pos[i] ?? 0) + dx, (pos[j] ?? 0) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormatBits(grid, 'L', 0); // 占位，真正掩码定了会重画
  drawVersionBits(grid, version);
}

function drawFormatBits(grid: Grid, ec: QrEcLevel, mask: number): void {
  const { size, modules, isFunction } = grid;
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  // 格式信息区必须同时标 isFunction：否则数据填充会把码字写进这块区域，
  // 随后被格式信息覆盖，整条码字流错位。
  const set = (x: number, y: number, dark: boolean): void => {
    const row = modules[y];
    if (row !== undefined) row[x] = dark;
    const flag = isFunction[y];
    if (flag !== undefined) flag[x] = true;
  };

  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // 恒暗模块
}

function drawVersionBits(grid: Grid, version: number): void {
  if (version < 7) return;
  const { size, modules, isFunction } = grid;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  const set = (x: number, y: number, dark: boolean): void => {
    const row = modules[y];
    if (row !== undefined) row[x] = dark;
    const flag = isFunction[y];
    if (flag !== undefined) flag[x] = true;
  };
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, dark);
    set(b, a, dark);
  }
}

/** 数据按「右两列一组、蛇形上下」填入非函数模块。 */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size, modules, isFunction } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过垂直定时图案那一列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y]?.[x] !== false) continue;
        if (i < codewords.length * 8) {
          const row = modules[y];
          if (row !== undefined) row[x] = ((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7)) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  const { size, modules, isFunction } = grid;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y]?.[x] === true) continue;
      if (!maskBit(mask, x, y)) continue;
      const row = modules[y];
      if (row !== undefined) row[x] = !row[x];
    }
  }
}

/** 罚分：连续同色、2×2 同色块、类探测图案、深色占比偏离 50%。 */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;

  const runScore = (length: number): number => (length >= 5 ? 3 + (length - 5) : 0);

  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x <= size; x++) {
      if (x < size && modules[y]?.[x] === modules[y]?.[x - 1]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y <= size; y++) {
      if (y < size && modules[y]?.[x] === modules[y - 1]?.[x]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y]?.[x];
      if (v === modules[y]?.[x + 1] && v === modules[y + 1]?.[x] && v === modules[y + 1]?.[x + 1]) {
        score += 3;
      }
    }
  }

  const patterns: readonly (readonly boolean[])[] = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  const matches = (get: (i: number) => boolean | undefined, start: number): boolean =>
    patterns.some((pattern) => pattern.every((want, k) => get(start + k) === want));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      if (matches((i) => modules[y]?.[i], x)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      if (matches((i) => modules[i]?.[x], y)) score += 40;
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;

  return score;
}

const cloneGrid = (source: Grid): Grid => ({
  size: source.size,
  modules: source.modules.map((row) => row.slice()),
  isFunction: source.isFunction.map((row) => row.slice()),
});

/**
 * 编码为模块矩阵（含静区）。返回的矩阵已经掩码 + 写格式信息，可以直接渲染。
 */
export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
  const ec = options.ec ?? 'M';
  const quietZone = options.quietZone ?? QUIET_ZONE;
  const payload = utf8(text);
  const version = chooseVersion(payload.length, ec);
  const size = version * 4 + 17;

  const base: Grid = {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
  drawFunctionPatterns(base, version);
  drawCodewords(base, buildCodewords(payload, version, ec));

  // 逐掩码打分取最优——这一步不是可选优化，选错掩码会让扫描率明显下降。
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let best: Grid | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = cloneGrid(base);
    applyMask(candidate, mask);
    drawFormatBits(candidate, ec, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      best = candidate;
    }
  }

  const chosen = best ?? base;
  const total = size + quietZone * 2;
  const modules: boolean[][] = Array.from({ length: total }, () =>
    new Array<boolean>(total).fill(false),
  );
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = modules[y + quietZone];
      if (row !== undefined) row[x + quietZone] = chosen.modules[y]?.[x] === true;
    }
  }
  return { size: total, modules, version, mask: bestMask };
}

export interface QrSvgOptions extends QrOptions {
  /** 每模块像素数；SVG 是矢量，这个值只影响默认 width/height 属性。 */
  readonly moduleSize?: number;
  readonly dark?: string;
  readonly light?: string;
  /** 无障碍标题；不传则不输出 `<title>`。 */
  readonly title?: string;
}

/**
 * 输出 SVG 源码。用单条 `<path>` 拼所有深色模块（而不是每格一个 `<rect>`），
 * 40 版本的二维码也只有十几 KB，手机端渲染没有压力。
 */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const matrix = encodeQr(text, options);
  const moduleSize = options.moduleSize ?? 4;
  const dim = matrix.size * moduleSize;
  const dark = options.dark ?? '#111111';
  const light = options.light ?? '#ffffff';

  const segments: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y] ?? [];
    let x = 0;
    while (x < matrix.size) {
      if (row[x] !== true) {
        x++;
        continue;
      }
      const start = x;
      while (x < matrix.size && row[x] === true) x++;
      segments.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }

  const title = options.title === undefined ? '' : `<title>${escapeXml(options.title)}</title>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${matrix.size} ${matrix.size}" shape-rendering="crispEdges" role="img">`,
    title,
    `<rect width="${matrix.size}" height="${matrix.size}" fill="${light}"/>`,
    `<path d="${segments.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('');
}

const escapeXml = (raw: string): string =>
  raw.replace(/[<>&"']/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&apos;',
  );
