import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/sqlite.ts';
import { createApp } from '../src/server/app.ts';

const inlineSub = 'ss://YWVzLTI1Ni1nY206dG9wLXNlY3JldA==@ss.example.invalid:443#A';

test('指纹只覆盖配置实际引用的源：改未引用的源不换版本，改引用的源立即失效', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-fingerprint-'));
  const store = openStore(join(dir, 'state.db'), 'fp-secret');
  const app = createApp({
    store,
    adminToken: 'fp-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown): Promise<Response> =>
    get(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const put = (path: string, body: unknown): Promise<Response> =>
    get(path, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  const auth = { authorization: 'Bearer fp-admin', 'content-type': 'application/json' };

  assert.equal((await post('/api/sources', { id: 'used', kind: 'inline', content: inlineSub })).status, 201);
  assert.equal((await post('/api/sources', { id: 'unused', kind: 'inline', content: inlineSub })).status, 201);
  assert.equal((await post('/api/profiles', { name: 'default', sourceIds: ['used'] })).status, 201);
  const tokenResponse = await post('/api/tokens', { profile: 'default', target: 'surge' });
  assert.equal(tokenResponse.status, 201);
  const created = (await tokenResponse.json()) as { url: string };

  const first = await fetch(created.url);
  assert.equal(first.status, 200);
  await first.text();
  const etag = first.headers.get('etag');
  assert.ok(etag !== null && etag.length > 0);

  // 改一个没被任何配置引用的源：谁都不该被判过期。
  assert.equal((await put('/api/sources/unused', { name: '未引用-改名' })).status, 200);
  const untouched = await fetch(created.url, { headers: { 'if-none-match': etag } });
  assert.equal(untouched.status, 304, '未引用源变更不应让产物过期');
  await untouched.text();

  // 改被引用的源：产物必须换版本。
  assert.equal((await put('/api/sources/used', { name: '已引用-改名' })).status, 200);
  const touched = await fetch(created.url, { headers: { 'if-none-match': etag } });
  assert.equal(touched.status, 200, '被引用源变更必须让产物过期');
  await touched.text();
});
