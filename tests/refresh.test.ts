import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyMemberFilter } from '../src/core/collections/index.ts';
import { ingest } from '../src/core/index.ts';
import { createApp } from '../src/server/app.ts';
import { dueSourceIds, parseRefreshPolicy } from '../src/server/schedule.ts';
import { fetchThroughProxy, parseProxyUrl } from '../src/server/proxy-fetch.ts';
import { openStore } from '../src/store/sqlite.ts';

const subscription = readFileSync(new URL('../testdata/fixtures/subscription.txt', import.meta.url), 'utf8');

test('刷新策略解析：只认「数字 + 单位」，非法与 off 一律不自动刷新', () => {
  assert.equal(parseRefreshPolicy('30m'), 1_800_000);
  assert.equal(parseRefreshPolicy('6h'), 21_600_000);
  assert.equal(parseRefreshPolicy('1d'), 86_400_000);
  assert.equal(parseRefreshPolicy(' 30S '), 60_000, '低于 1 分钟的下限抬到 60s，避免打爆上游');
  assert.equal(parseRefreshPolicy('off'), null);
  assert.equal(parseRefreshPolicy('manual'), null);
  assert.equal(parseRefreshPolicy(''), null);
  assert.equal(parseRefreshPolicy(undefined), null);
  assert.equal(parseRefreshPolicy('*/5 * * * *'), null, '不支持的 cron 表达式必须显式失效而不是猜');
  assert.equal(parseRefreshPolicy('0m'), null);
});

test('到期判定：只看启用中的远端源，且没有拉取记录视为立即到期', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const due = dueSourceIds(
    [
      { id: 'never', kind: 'remote', enabled: true, refreshPolicy: '1h' },
      { id: 'fresh', kind: 'remote', enabled: true, refreshPolicy: '1h', lastFetchedAt: '2026-01-01T11:30:00Z' },
      { id: 'stale', kind: 'remote', enabled: true, refreshPolicy: '1h', lastFetchedAt: '2026-01-01T09:00:00Z' },
      { id: 'off', kind: 'remote', enabled: true, refreshPolicy: 'off' },
      { id: 'disabled', kind: 'remote', enabled: false, refreshPolicy: '1h' },
      { id: 'inline', kind: 'inline', enabled: true, refreshPolicy: '1h' },
    ],
    now,
  );
  assert.deepEqual([...due], ['never', 'stale']);
});

test('改名模板：{index} / {name} / {source} / {prefix} 全部替换，且先改名后加前缀', () => {
  const profile = ingest(
    [
      'vless://11111111-1111-1111-1111-111111111111@a.example.invalid:443?encryption=none&security=tls&sni=a.example.invalid#原始A',
      'vless://22222222-2222-2222-2222-222222222222@b.example.invalid:443?encryption=none&security=tls&sni=b.example.invalid#原始B',
    ].join('\n'),
  ).profile;
  const renamed = applyMemberFilter(profile.nodes, { rename: '[{index}]{name}@{source}' }, 'src-1');
  assert.equal(renamed.nodes[0]?.name, '[1]原始A@src-1');
  assert.equal(renamed.nodes[1]?.name, '[2]原始B@src-1');

  const withPrefix = applyMemberFilter(profile.nodes, { rename: '{prefix}{name}', prefix: '🇭🇰 ' }, 'src-1');
  assert.equal(withPrefix.nodes[0]?.name, '🇭🇰 原始A', '模板里写了 {prefix} 时不能再被前缀叠加一次');

  const autoPrefix = applyMemberFilter(profile.nodes, { prefix: 'P-' }, 'src-1');
  assert.equal(autoPrefix.nodes[0]?.name, 'P-原始A');
});

test('源级代理 URL 解析：只接受 http / https / socks5，协议不认识就拒绝，端口走协议默认值', () => {
  assert.equal(parseProxyUrl('http://127.0.0.1:8080')?.protocol, 'http:');
  assert.equal(parseProxyUrl('socks5://user:pass@10.0.0.1:1080')?.protocol, 'socks5:');
  assert.equal(parseProxyUrl('socks5h://10.0.0.1:1080')?.protocol, 'socks5:', 'socks5h 语义等同远端解析');
  assert.equal(parseProxyUrl('https://proxy.example.invalid:443')?.protocol, 'https:');
  assert.equal(parseProxyUrl('socks5://10.0.0.1')?.port, 1080, 'socks5 缺省端口 1080');
  assert.equal(parseProxyUrl('http://10.0.0.1')?.port, 8080, 'http 缺省端口 8080');
  assert.equal(parseProxyUrl('socks5://[::1]:1080')?.host, '::1', 'IPv6 代理 host 不能带方括号');
  assert.equal(parseProxyUrl('ftp://10.0.0.1:21'), null);
  assert.equal(parseProxyUrl('not-a-url'), null);
  assert.equal(parseProxyUrl('socks5://user%zz@10.0.0.1:1080'), null, '坏 % 编码按无效代理处理，不能抛错');
  assert.equal(parseProxyUrl(null), null);
  assert.equal(parseProxyUrl('   '), null);
});

test('SOCKS5 对端提前关闭：按错误返回而不是挂住整次拉取', async (t) => {
  const proxy = createNetServer((socket) => {
    socket.once('data', () => {
      // 只回半个 greeting 就断开：旧实现会一直等 'readable'，请求挂到外层超时之外。
      socket.write(Buffer.from([0x05]));
      socket.end();
    });
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise<void>((done) => proxy.close(() => done()));
  });
  const port = (proxy.address() as AddressInfo).port;
  const spec = parseProxyUrl(`socks5://127.0.0.1:${port}`);
  assert.ok(spec !== null);
  const started = Date.now();
  await assert.rejects(
    () =>
      fetchThroughProxy({
        url: new URL('http://example.invalid/sub'),
        proxy: spec,
        timeoutMs: 300,
      }),
    /proxy-(socket-closed|read-timeout)/,
  );
  assert.ok(Date.now() - started < 2_000, '必须尽快失败，不能挂住');
});

test('代理请求头含非法字符：在建隧道前拒绝，不能把进程打崩', async () => {
  const spec = parseProxyUrl('socks5://127.0.0.1:1');
  assert.ok(spec !== null);
  await assert.rejects(
    () =>
      fetchThroughProxy({
        url: new URL('http://example.invalid/sub'),
        proxy: spec,
        headers: { 'User-Agent': 'bad\r\nX-Injected: 1' },
      }),
    /Invalid character|ERR_INVALID_CHAR/i,
  );
});

test('P1 运维闭环：代理入参 / 部分更新 / 手动刷新 / 流量信息透传', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-refresh-'));
  let upstreamHits = 0;
  let failNext = false;
  const upstream = createServer((req, res) => {
    upstreamHits += 1;
    if (failNext) {
      failNext = false;
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      etag: '"v1"',
      'subscription-userinfo': 'upload=1024; download=2048; total=1073741824; expire=1767225600',
      'profile-update-interval': '12',
    });
    res.end(subscription);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'refresh-secret');
  const app = createApp({
    store,
    adminToken: 'ops-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer ops-admin', 'content-type': 'application/json' };
  const call = (path: string, method: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  // 非法代理必须当场回 400：存进去等于埋一个运行时才炸的雷。
  const badProxy = await call('/api/sources', 'POST', {
    id: 'bad',
    url: `http://127.0.0.1:${upstreamPort}/sub`,
    proxy: 'ftp://127.0.0.1:21',
  });
  assert.equal(badProxy.status, 400);
  assert.equal(((await badProxy.json()) as { error: string }).error, 'invalid-proxy-url');

  const created = await call('/api/sources', 'POST', {
    id: 'a',
    url: `http://127.0.0.1:${upstreamPort}/sub`,
    refreshPolicy: '6h',
    proxy: 'socks5://user:pw@127.0.0.1:1080',
    ua: 'clash-verge/1.0',
  });
  assert.equal(created.status, 201);

  // 部分更新：只带 enabled 时不能把其余配置顺手清空（这是之前 PUT 全量覆盖的坑）。
  assert.equal((await call('/api/sources/a', 'PUT', { enabled: false })).status, 200);
  let saved = store.getSource('a');
  assert.equal(saved?.enabled, false);
  assert.equal(saved?.refreshPolicy, '6h');
  assert.equal(saved?.ua, 'clash-verge/1.0');
  assert.equal(saved?.proxy, 'socks5://user:pw@127.0.0.1:1080');
  assert.equal((await call('/api/sources/a', 'PUT', { enabled: true })).status, 200);

  // 显式传 null 才清除代理。
  assert.equal((await call('/api/sources/a', 'PUT', { proxy: null })).status, 200);
  saved = store.getSource('a');
  assert.equal(saved?.proxy, undefined);
  assert.equal(saved?.refreshPolicy, '6h', '清代理不能连带清刷新策略');

  // 手动刷新：拉一次上游并把运行态写回。
  const refresh = await call('/api/sources/a/refresh', 'POST', {});
  assert.equal(refresh.status, 200);
  assert.equal(upstreamHits, 1);
  saved = store.getSource('a');
  assert.ok(saved?.lastFetchedAt !== undefined);
  assert.equal(saved?.lastError, undefined);
  assert.equal(saved?.userinfo?.total, 1073741824);
  assert.equal(saved?.suggestedRefreshHours, 12);

  // 刷新失败要落 lastError，不能静默当成成功。
  failNext = true;
  const failed = (await (await call('/api/sources/a/refresh', 'POST', {})).json()) as {
    refreshed: number;
    failed: number;
  };
  assert.equal(failed.failed, 1);
  assert.match(store.getSource('a')?.lastError ?? '', /upstream-status:500/);

  // 流量信息透传到发布响应头：上传 / 下载 / 总量累加，到期取最早。
  await call('/api/profiles', 'POST', { name: 'ops', entries: [{ kind: 'source', id: 'a' }] });
  const tokenResponse = await call('/api/tokens', 'POST', { profile: 'ops', target: 'surge' });
  assert.equal(tokenResponse.status, 201);
  const { url } = (await tokenResponse.json()) as { url: string };
  const served = await fetch(url);
  assert.equal(served.status, 200);
  assert.equal(
    served.headers.get('subscription-userinfo'),
    'upload=1024; download=2048; total=1073741824; expire=1767225600',
  );

  // 没有流量信息的源不下发空头，避免客户端把「未知」显示成「0」。
  const plain = await call('/api/sources', 'POST', { id: 'inline-1', kind: 'inline', content: subscription });
  assert.equal(plain.status, 201);
  await call('/api/profiles', 'POST', { name: 'plain', entries: [{ kind: 'source', id: 'inline-1' }] });
  const plainToken = await call('/api/tokens', 'POST', { profile: 'plain', target: 'surge' });
  const plainUrl = ((await plainToken.json()) as { url: string }).url;
  const plainServed = await fetch(plainUrl);
  assert.equal(plainServed.status, 200);
  assert.equal(plainServed.headers.get('subscription-userinfo'), null);

  // 运行态不得进配置指纹：刷新过之后 ETag 必须保持不变，否则缓存全废。
  const etagBefore = plainServed.headers.get('etag');
  assert.ok(etagBefore !== null);
  const again = await fetch(plainUrl, { headers: { 'if-none-match': etagBefore } });
  assert.equal(again.status, 304);
});

test('调度器到期刷新可直接触发，且不阻塞进程退出', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-sched-'));
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(subscription);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'sched-secret');
  store.putSource({
    id: 'r',
    name: 'R',
    kind: 'remote',
    url: `http://127.0.0.1:${upstreamPort}/sub`,
    enabled: true,
    refreshPolicy: '30m',
  });
  store.putSource({ id: 'never', name: 'N', kind: 'remote', url: `http://127.0.0.1:${upstreamPort}/sub`, enabled: true, refreshPolicy: 'off' });
  const app = createApp({
    store,
    adminToken: 'sched-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await app.refreshDue();
  assert.deepEqual(first, { refreshed: 1, failed: 0 }, '只有策略可解析的源会被刷新');
  assert.equal(hits, 1);
  assert.ok(store.getSource('r')?.lastFetchedAt !== undefined);

  const second = await app.refreshDue();
  assert.deepEqual(second, { refreshed: 0, failed: 0 }, '刚拉过的源在间隔内不应重复拉取');
  assert.equal(hits, 1);
});

test('外部规则集：同 URL 去重、改写成镜像地址、镜像端点可取回内容', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-rules-'));
  const ruleList = 'DOMAIN-SUFFIX,ads.example.invalid\nIP-CIDR,10.0.0.0/8,no-resolve\n';
  const clashSource = [
    'proxies:',
    '  - {name: A, type: ss, server: a.example.invalid, port: 443, cipher: aes-256-gcm, password: pw}',
    'rule-providers:',
    '  ads: {type: http, behavior: domain, url: "http://127.0.0.1:UPSTREAM/rules/ads.list"}',
    '  ads-dup: {type: http, behavior: domain, url: "http://127.0.0.1:UPSTREAM/rules/ads.list"}',
    '  nopolicy: {type: http, behavior: domain, url: "http://127.0.0.1:UPSTREAM/rules/other.list"}',
    'rules:',
    '  - RULE-SET,ads,REJECT',
    '  - MATCH,DIRECT',
  ].join('\n');

  let ruleHits = 0;
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/rules/')) {
      ruleHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ruleList);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
    res.end(clashSource.replaceAll('UPSTREAM', String((upstream.address() as AddressInfo).port)));
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'rules-secret');
  store.putSource({ id: 'c', name: 'C', kind: 'remote', url: `http://127.0.0.1:${upstreamPort}/sub`, enabled: true });
  store.putProfile({ id: 'p', name: 'p', entries: [{ kind: 'source', id: 'c' }] });
  const app = createApp({
    store,
    adminToken: 'rules-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
    publicBaseUrl: 'https://mirror.example.invalid',
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer rules-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const tokenResponse = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: 'p', target: 'surge' }),
  });
  // 这里配了 publicBaseUrl（镜像地址要用），签发的绝对地址指向镜像域名、本机不可达；
  // 取 path 再拼本机 base，验证的是产物内容而不是反代配置。
  const { path } = (await tokenResponse.json()) as { path: string };
  const config = await (await fetch(`${base}${path}`)).text();

  const emitted = config.split('\n').filter((line) => line.startsWith('RULE-SET,'));
  assert.equal(emitted.length, 1, '同一 URL 被两个 provider 引用时只输出一条');
  const emittedLine = emitted[0] ?? '';
  const prefix = 'RULE-SET,https://mirror.example.invalid/rules/';
  assert.ok(
    emittedLine.startsWith(prefix) && emittedLine.endsWith(',REJECT'),
    `规则集地址应改写成镜像地址，实际：${emittedLine}`,
  );
  const key = emittedLine.slice(prefix.length, emittedLine.length - ',REJECT'.length);
  assert.match(key, /^[0-9a-f]{16}$/, '镜像 key 是原始 URL 的哈希前缀');
  assert.match(config, /external rule set skipped \(no policy in source\)/, '拿不到策略的规则集只留注释');

  // 镜像端点对外可读（不带管理令牌），并回源取回规则内容。
  const mirrored = await fetch(`${base}/rules/${key}`);
  assert.equal(mirrored.status, 200);
  assert.match(await mirrored.text(), /ads\.example\.invalid/);
  assert.ok(ruleHits >= 1);

  // 未知 key 直接 404，不做无谓的上游尝试。
  assert.equal((await fetch(`${base}/rules/deadbeefdeadbeef`)).status, 404);
});

test('上游失败时回退到最后一次成功的快照，并把「有多旧」写进诊断', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-stale-'));
  let healthy = true;
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    if (!healthy) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('maintenance');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(subscription);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'stale-secret');
  store.putSource({
    id: 'acme',
    name: 'Acme',
    kind: 'remote',
    url: `http://127.0.0.1:${upstreamPort}/sub`,
    enabled: true,
  });
  store.putProfile({ id: 'p', name: 'p', entries: [{ kind: 'source', id: 'acme' }] });
  const app = createApp({
    store,
    adminToken: 'stale-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer stale-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const tokenResponse = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: 'p', target: 'mihomo' }),
  });
  const { url } = (await tokenResponse.json()) as { url: string };

  const healthyConfig = await (await fetch(url)).text();
  const healthyNodes = healthyConfig.split('\n').filter((line) => line.trimStart().startsWith('- name:')).length;
  assert.ok(healthyNodes > 0, `首次拉取应当拿到节点，实际输出：${healthyConfig.slice(0, 300)}`);

  // 机场开始维护：此时若直接丢源，客户端会以为「节点没了」。
  healthy = false;
  const before = hits;
  const staleConfig = await (await fetch(url)).text();
  assert.ok(hits > before, '必须真的又打了一次上游，不能因为缓存还在就跳过');
  assertEquals(
    staleConfig.split('\n').filter((line) => line.trimStart().startsWith('- name:')).length,
    healthyNodes,
    '上游 503 时必须回退到上一次成功的快照，节点数量不变',
  );

  const preview = (await (
    await fetch(`${base}/api/sources/acme/preview`, { headers: auth })
  ).json()) as { diagnostics: { reason: string }[] };
  const stale = preview.diagnostics.find((item) => item.reason.startsWith('upstream-stale:'));
  assert.ok(stale !== undefined, `诊断里必须写明回退了旧快照，实际：${JSON.stringify(preview.diagnostics)}`);
  assert.match(stale.reason, /^upstream-stale:\d+[smhd]/, '年龄要能一眼读出来（2h05m / 45m / 3d2h 这种）');

  // 上游恢复后应当回到正常路径，不留「陈旧」痕迹。
  healthy = true;
  await fetch(`${base}/api/sources/acme/refresh`, { method: 'POST', headers: auth, body: '{}' });
  const recovered = (await (
    await fetch(`${base}/api/sources/acme/preview`, { headers: auth })
  ).json()) as { diagnostics: { reason: string }[] };
  assert.equal(
    recovered.diagnostics.filter((item) => item.reason.startsWith('upstream-stale:')).length,
    0,
    '恢复后不能再报旧快照',
  );
});

/** node:assert 的 message 参数位置与 assert.equal 一致，这里只是为了让上面的断言读起来更顺。 */
function assertEquals(actual: unknown, expected: unknown, message: string): void {
  assert.equal(actual, expected, message);
}
