// 移动端专项审计：390px 视口逐页 DOM 测量，坐实可量化的问题。
// 用法：先起实例（STARTRAILS_DATA_DIR + STARTRAILS_ADMIN_TOKEN + ALLOW_PRIVATE=1 node src/server/index.ts），
//       再 `node scripts/mobile-audit.mjs`。
// 测量项：横向溢出 / 卡头控件越界 / 触控目标 < 44px / 弹窗 footer 可见性 / 底部遮挡。
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.STARTRAILS_CHROME ??
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'google-chrome');
const BASE = process.env.STARTRAILS_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.STARTRAILS_ADMIN_TOKEN ?? 'demo-admin';
const PORT = Number(process.env.STARTRAILS_CDP_PORT ?? 9444);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--hide-scrollbars',
  `--user-data-dir=${join(tmpdir(), 'sr-mobile-audit')}`,
  'about:blank',
], { stdio: 'ignore' });
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
    } catch { /* retry */ }
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

// 390px 手机视口
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId);

await send('Page.navigate', { url: `${BASE}/` }, sessionId);
await sleep(1200);
await send('Runtime.evaluate', {
  expression: `sessionStorage.setItem('startrails_admin','${TOKEN}'); localStorage.removeItem('startrails_palette'); localStorage.setItem('startrails_theme_mode','light');`,
}, sessionId);
await send('Page.navigate', { url: `${BASE}/` }, sessionId);
await sleep(2600);

async function evalJS(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  return result.value;
}

// 通用审计表达式：返回当前页的量化问题清单
const AUDIT_EXPR = `(() => {
  const out = { page: location.hash, docOverflow: document.documentElement.scrollWidth - window.innerWidth, issues: [] };

  // 1. 卡头控件越界：.card-head 内任意元素右缘超出卡片可视右缘
  document.querySelectorAll('.card-head').forEach((head) => {
    const card = head.closest('.card');
    if (!card) return;
    const cardRight = card.getBoundingClientRect().right;
    head.querySelectorAll('button, .n-button, .n-select, .n-switch, .head-actions').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > cardRight + 0.5) {
        out.issues.push('卡头越界: ' + (head.querySelector('h2')?.textContent || '?') + ' 元素右缘超出 ' + (r.right - cardRight).toFixed(1) + 'px');
      }
    });
  });

  // 2. 触控目标 < 40px（本项目定的拇指友好标准；图标按钮横向 < 40 更严格）
  const INTERACTIVE = 'button, .n-button, .n-switch, .n-radio-button, .n-checkbox, .tabbar-item, .target-item, .nav-item, .sn-item, .palette-item, [role="button"]';
  document.querySelectorAll(INTERACTIVE).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // 纯图标按钮（circle）必须双维 >= 40；文字按钮横向够宽即可，只看高度 < 32 才算小
    const isCircleIcon = el.classList.contains('n-button') && el.querySelector('.n-button__icon') && !el.textContent.trim();
    const tooSmall = isCircleIcon ? (r.width < 40 || r.height < 40) : (r.height < 32 && r.width < 44);
    if (tooSmall) {
      out.issues.push('触控目标小: ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 12) || el.className) + ' ' + r.width.toFixed(0) + 'x' + r.height.toFixed(0));
    }
  });

  // 3. 底部 tabbar 是否遮挡最后卡片
  const tabbar = document.querySelector('.tabbar');
  if (tabbar && getComputedStyle(tabbar).display !== 'none') {
    const tbTop = tabbar.getBoundingClientRect().top;
    const lastCard = [...document.querySelectorAll('.page > .card, .page > section')].pop();
    if (lastCard) {
      const lcBottom = lastCard.getBoundingClientRect().bottom;
      if (tbTop < lcBottom && tbTop < window.innerHeight) {
        out.issues.push('底部遮挡: tabbar top=' + tbTop.toFixed(0) + ' 卡片底=' + lcBottom.toFixed(0));
      }
    }
  }

  return out;
})()`;

const PAGES = ['overview', 'sources', 'config', 'output', 'publish', 'settings'];
const results = [];

for (const page of PAGES) {
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav="${page}"]')?.click()` }, sessionId);
  await sleep(800);
  const audit = await evalJS(AUDIT_EXPR);
  results.push(audit);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('out/mobile-audit', { recursive: true });
  writeFileSync(`out/mobile-audit/${page}.png`, Buffer.from(shot.data, 'base64'));
}

// 弹窗审计：订阅页打开「添加订阅」弹窗，测 footer 可见性与内容可滚动
await send('Runtime.evaluate', { expression: `document.querySelector('[data-nav="sources"]')?.click()` }, sessionId);
await sleep(700);
const modalAudit = await evalJS(`(async () => {
  const out = { open: false, footerVisible: false, scrollable: false, issues: [] };
  // 点击「添加订阅」
  const btns = [...document.querySelectorAll('button')];
  const add = btns.find(b => b.textContent.includes('添加订阅'));
  if (!add) { out.issues.push('找不到添加订阅按钮'); return out; }
  add.click();
  await new Promise(r => setTimeout(r, 400));
  const modal = document.querySelector('.n-modal');
  if (!modal) { out.issues.push('弹窗未打开'); return out; }
  out.open = true;
  const footer = modal.querySelector('.n-card__footer, .n-card-footer, [class*="footer"]');
  if (footer) {
    const fr = footer.getBoundingClientRect();
    out.footerVisible = fr.top >= 0 && fr.bottom <= window.innerHeight;
    if (!out.footerVisible) out.issues.push('footer 不可见: top=' + fr.top.toFixed(0) + ' bottom=' + fr.bottom.toFixed(0) + ' viewport=' + window.innerHeight);
  }
  const content = modal.querySelector('.n-card__content, .n-card-content');
  if (content) {
    out.scrollable = content.scrollHeight > content.clientHeight;
    out.contentH = content.clientHeight.toFixed(0);
    out.contentScrollH = content.scrollHeight.toFixed(0);
  }
  return out;
})()`, { awaitPromise: true });
results.push({ page: 'modal-add-source', ...modalAudit });

console.log(JSON.stringify(results, null, 2));
ws.close();
chrome.kill();
