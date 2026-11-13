// 用 CDP 截真实应用：先注入管理令牌到 sessionStorage，再逐页截图。
// 用法：先 `npm run serve` 起服务，再 `npm run shots [-- <输出目录>]`。
// 全部路径与凭据走环境变量，避免把本机路径写进仓库。
// 默认落到 `out/shots/`（已被忽略）：仓库里只放 README 真正引用的那张，
// 其余留作取材，挑中了再拷进 docs/screenshots，不让无人引用的图堆积。
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.STARTRAILS_CHROME ??
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
const BASE = process.env.STARTRAILS_BASE ?? 'http://127.0.0.1:8787';
const OUT = process.argv[2] ?? process.env.STARTRAILS_SHOTS_DIR ?? 'out/shots';
const PAGES = ['overview', 'sources', 'nodes', 'rules', 'publish', 'diagnostics', 'capabilities', 'settings'];
const TOKEN = process.env.STARTRAILS_ADMIN_TOKEN ?? 'demo-admin';

mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.STARTRAILS_CDP_PORT ?? 9333);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1440,960',
  `--user-data-dir=${join(tmpdir(), 'sr-shots')}`,
  'about:blank',
], { stdio: 'ignore' });

// 中途抛错也要收掉浏览器，否则会留一个占着调试端口的 headless 进程，下次跑直接连到旧会话上。
process.on('exit', () => chrome.kill());

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function json(path, init) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return response.json();
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const version = await json('/json/version');
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('chrome not ready');
}

const wsUrl = await waitReady();
const ws = new WebSocket(wsUrl);
await new Promise((done) => ws.addEventListener('open', done));

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false }, sessionId);

await send('Page.navigate', { url: `${BASE}/` }, sessionId);
await sleep(1200);
// 令牌之外还要清掉外观偏好：这个 user-data-dir 是复用的，上一轮留下的
// startrails_palette / startrails_theme_mode 会盖掉默认配色，截出来的图不是首装样子。
await send(
  'Runtime.evaluate',
  {
    expression: `sessionStorage.setItem('startrails_admin','${TOKEN}'); localStorage.removeItem('startrails_palette'); localStorage.removeItem('startrails_theme_mode');`,
  },
  sessionId,
);
await send('Page.navigate', { url: `${BASE}/` }, sessionId);
await sleep(2600);

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log(`shot ${name}`);
}

for (const page of PAGES) {
  await send(
    'Runtime.evaluate',
    { expression: `document.querySelector('[data-nav="${page}"]')?.click()` },
    sessionId,
  );
  await sleep(700);
  await shot(page);
}

// 深色 + 陶土
await send('Runtime.evaluate', { expression: `localStorage.setItem('startrails_theme_mode','dark'); localStorage.setItem('startrails_palette','clay'); location.reload()` }, sessionId);
await sleep(2600);
await shot('theme-clay-dark');
await send('Runtime.evaluate', { expression: `localStorage.setItem('startrails_theme_mode','light'); localStorage.setItem('startrails_palette','celadon'); location.reload()` }, sessionId);
await sleep(2400);
await shot('theme-celadon');

// 手机形态
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);
await send('Runtime.evaluate', { expression: `localStorage.removeItem('startrails_palette'); localStorage.setItem('startrails_theme_mode','light'); location.reload()` }, sessionId);
await sleep(2600);
for (const page of ['overview', 'sources', 'nodes', 'publish', 'settings']) {
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav="${page}"]')?.click()` }, sessionId);
  await sleep(700);
  await shot(`m-${page}`);
}

ws.close();
chrome.kill();
