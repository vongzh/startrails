import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../src/server/app.ts';
import { openStore } from '../src/store/sqlite.ts';

test('UI 构建产物可交付（构建后校验）', () => {
  const dist = fileURLToPath(new URL('../web/dist/index.html', import.meta.url));
  if (!existsSync(dist)) return; // 未构建时由 npm run verify 保证顺序
  const html = readFileSync(dist, 'utf8');
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /Startrails/);
});

test('静态服务：入口 / 资源 / SPA fallback / 路径穿越防护', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-ui-'));
  const webRoot = join(dir, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<div id="app">startrails-ui</div>');
  writeFileSync(join(webRoot, 'app.js'), 'console.log(1);');

  const store = openStore(join(dir, 'state.db'), 'ui-secret');
  const app = createApp({
    store,
    adminToken: 'ui-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    webRoot,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /startrails-ui/);

  const asset = await fetch(`${base}/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);

  const fallback = await fetch(`${base}/nodes/detail`);
  assert.equal(fallback.status, 200);
  assert.match(await fallback.text(), /startrails-ui/);

  // fetch/URL 会自行规范化 ..，用原始 HTTP 请求发编码后的穿越路径。
  const traversal = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/%2e%2e/state.db', method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(traversal, 403);
});
