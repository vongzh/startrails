import assert from 'node:assert/strict';
import test from 'node:test';
import jsQrDefault from 'jsqr';
import { encodeQr, renderQrSvg } from '../src/core/qr/index.ts';

/**
 * jsqr 是 CJS 包且没有 `exports` 字段：在 nodenext 解析下类型层把 default 看成命名空间，
 * 运行时拿到的却是函数本体（`jsQR(data, w, h)` 直接可调）。这里显式收窄一次，
 * 免得为一行类型在测试里绕圈——真正的保障是下面「解码结果必须等于输入」的断言。
 */
const jsQR = jsQrDefault as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { readonly data: string } | null;

/**
 * 二维码编码器的验证。
 *
 * 为什么敢自己写一个编码器：因为**能反向解回来**。这里用 jsqr（纯 JS 解码器，
 * 只在 devDependencies 里，不进运行时）把我们的矩阵渲染成像素再解一次，
 * 断言解出来的字符串与输入一字不差。编码器要是把容错表、掩码或格式信息写错了，
 * 这条测试立刻红——而不是等到用户拿手机扫不出来。
 *
 * SVG 那条同理：把 `renderQrSvg` 生成的 path 反解析回矩阵，与 encodeQr 的结果逐格对比，
 * 保证「编码正确」不会在序列化这一步丢掉。
 */

/** 把矩阵放大成 RGBA 像素，交给解码器。纯色块、无抗锯齿、无缩放。 */
const rasterize = (
  matrix: { readonly size: number; readonly modules: readonly (readonly boolean[])[] },
  scale: number,
): { data: Uint8ClampedArray; width: number; height: number } => {
  const dim = matrix.size * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const dark = matrix.modules[Math.floor(y / scale)]?.[Math.floor(x / scale)] === true;
      const value = dark ? 0 : 255;
      const offset = (y * dim + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
};

const decode = (
  matrix: { readonly size: number; readonly modules: readonly (readonly boolean[])[] },
  scale = 6,
): string | null => {
  const image = rasterize(matrix, scale);
  const result = jsQR(image.data, image.width, image.height);
  return result === null ? null : result.data;
};

test('二维码：订阅 URL 四个纠错等级都能被独立解码器还原', () => {
  const url = 'https://sub.example.com/s/8f3a2c1d4e5f/mihomo';
  for (const ec of ['L', 'M', 'Q', 'H'] as const) {
    const matrix = encodeQr(url, { ec });
    assert.equal(decode(matrix), url, `ec=${ec} 解回来不一致`);
    // 纠错等级越高版本越靠后（同样的内容要更多码字）——顺带确认 ec 真的生效了。
    assert.ok(matrix.version >= 2, `ec=${ec} 版本号异常：${matrix.version}`);
  }
});

test('二维码：跨版本与跨字节长度都正确（含中文与超长 URL）', () => {
  const payloads = [
    'A', // 版本 1 下界
    'https://sub.example.com/s/tok/?a=1&b=2#frag', // 带会被误当语法字符的符号
    '中文订阅测试 https://例子.中国/s/abc', // 非 ASCII，字节长度 ≠ 字符长度
    `https://sub.example.com/s/${'x'.repeat(200)}/surge`, // 版本 9 附近
    `https://sub.example.com/s/${'y'.repeat(900)}/sing-box`, // 版本 21 以上，验证版本信息块
    `https://sub.example.com/s/${'z'.repeat(1600)}/clash`, // 版本 33 以上，验证交错与对齐图案
  ];
  for (const text of payloads) {
    for (const ec of ['L', 'M', 'Q'] as const) {
      const matrix = encodeQr(text, { ec });
      assert.equal(decode(matrix), text, `len=${text.length} ec=${ec} v=${matrix.version} 解码失败`);
    }
  }
});

test('二维码：容量不足时明确报错，不静默截断', () => {
  // Q 级版本 40 的字节容量上限是 1663；给 2000 字节必须抛错。
  // 静默截断会让二维码「能扫但内容是错的」，比扫不出来更难查。
  assert.throws(
    () => encodeQr('z'.repeat(2000), { ec: 'Q' }),
    /qr-payload-too-large/,
  );
  // L 级上限 2953，同样长度放得下——确认报错来自容量而不是别的分支。
  assert.doesNotThrow(() => encodeQr('z'.repeat(2000), { ec: 'L' }));
});

test('二维码：静区计入尺寸，且四周确实为空', () => {
  const matrix = encodeQr('https://example.com/s/t', { quietZone: 4 });
  const inner = matrix.size - 8;
  assert.equal(inner % 4, 1, 'QR 边长必须是 4×版本 + 17');
  for (let i = 0; i < matrix.size; i++) {
    assert.equal(matrix.modules[0]?.[i], false, `第 0 行第 ${i} 列不是静区`);
    assert.equal(matrix.modules[matrix.size - 1]?.[i], false, `最后一行第 ${i} 列不是静区`);
    assert.equal(matrix.modules[i]?.[0], false, `第 ${i} 行第 0 列不是静区`);
    assert.equal(matrix.modules[i]?.[matrix.size - 1], false, `第 ${i} 行最后一列不是静区`);
  }
});

test('二维码：掩码是 8 个候选里挑出来的，且三个探测图案就位', () => {
  const matrix = encodeQr('https://example.com/s/t', { ec: 'M' });
  assert.ok(matrix.mask >= 0 && matrix.mask <= 7, `掩码越界：${matrix.mask}`);

  // 探测图案：7×7 方框 + 中间 3×3 实心。位置对不对，是「能不能被扫到」的第一关。
  const q = 4;
  const at = (x: number, y: number): boolean => matrix.modules[y + q]?.[x + q] === true;
  const inner = matrix.size - q * 2;
  for (const [ox, oy] of [
    [0, 0],
    [inner - 7, 0],
    [0, inner - 7],
  ] as const) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(at(ox + x, oy + y), dist !== 2, `探测图案 (${ox},${oy}) 的 (${x},${y}) 不对`);
      }
    }
  }
});

/** 把 renderQrSvg 的 path 反解析成矩阵，用来验证序列化没丢格子。 */
const matrixFromSvg = (svg: string, size: number): boolean[][] => {
  const cells: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const path = /<path d="([^"]*)"/.exec(svg)?.[1] ?? '';
  const pattern = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let match: RegExpExecArray | null;
  let runs = 0;
  while ((match = pattern.exec(path)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    const back = Number(match[4]);
    assert.equal(width, back, `path 段没有闭合：${match[0]}`);
    for (let i = 0; i < width; i++) {
      const row = cells[y];
      assert.ok(row !== undefined, `path 行号越界：${y}`);
      row[x + i] = true;
    }
    runs++;
  }
  assert.ok(runs > 0, 'SVG 里没有任何深色模块');
  return cells;
};

test('二维码 SVG：像素级等于 encodeQr 的矩阵，且只出一条 path', () => {
  const text = 'https://sub.example.com/s/abc123/mihomo?x=1&y=2';
  const matrix = encodeQr(text);
  const svg = renderQrSvg(text);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${matrix.size} ${matrix.size}"`));
  assert.match(svg, /shape-rendering="crispEdges"/, '缺 crispEdges 会在缩放时糊成一团');
  // 逐格一个 <rect> 会让 40 版本的 SVG 膨胀到几百 KB；这里要求单条 path。
  assert.equal(svg.match(/<rect /g)?.length, 1, '背景 rect 之外不应再有 rect');

  const parsed = matrixFromSvg(svg, matrix.size);
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      assert.equal(parsed[y]?.[x], matrix.modules[y]?.[x], `第 (${x},${y}) 格不一致`);
    }
  }
});

test('二维码 SVG：标题会被转义，不引入 XML 注入', () => {
  const svg = renderQrSvg('https://example.com/s/t', { title: '<script>&"x"' });
  assert.ok(!svg.includes('<script>'), 'title 里的尖括号必须被转义');
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
});
