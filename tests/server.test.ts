import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/sqlite.ts';
import { createApp } from '../src/server/app.ts';
import { assertPublicUrl, fetchSnapshot, isPublicAddress } from '../src/server/url-guard.ts';
import { redact } from '../src/server/redact.ts';

const subscription = readFileSync(
  new URL('../testdata/fixtures/subscription.txt', import.meta.url),
  'utf8',
);

test('SSRF 防护：协议白名单、私网段、userinfo 全部拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /protocol-not-allowed/);
  await assert.rejects(() => assertPublicUrl('http://user:pass@example.com/sub'), /userinfo/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private-address-blocked/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/sub'), /private-address-blocked/);
  await assert.rejects(() => assertPublicUrl('http://localhost/sub'), /private-address-blocked/);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('2606:4700::1111'), true);
  assert.equal(isPublicAddress('fd00::1'), false);
  const ok = await assertPublicUrl('https://example.com/sub', { allowPrivate: true });
  assert.equal(ok.protocol, 'https:');
});

test('诊断输出脱敏：userinfo / token / 长十六进制串不落明文', () => {
  const text = redact('https://user:secret@host/x?token=abcdefghijklmnop&password=pwd');
  assert.ok(!text.includes('secret@'));
  assert.ok(!text.includes('abcdefghijklmnop'));
  assert.ok(!text.includes('password=pwd'));
});

test('SQLite Store：配置态持久化、正文加密、WAL 快照可恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-store-'));
  try {
    const store = openStore(join(dir, 'state.db'), 'unit-secret');
    store.putSource({ id: 'a', name: 'A', kind: 'inline', enabled: true });
    store.writeSourcePayload('a', 'ss://YWVzLTI1Ni1nY206dG9wLXNlY3JldA==@ss.example.invalid:443#A');
    store.putProfile({ id: 'default', name: 'default', entries: [{ kind: 'source', id: 'a' }] });
    store.putCollection({
      id: 'c1',
      name: '合并',
      members: [{ sourceId: 'a', filter: { include: ['A'] } }],
      dedupe: 'nodeKey',
      order: 0,
    });
    store.putAnnotation({ nodeKey: 'k1', excluded: true, alias: 'Renamed', order: 2, region: 'JP' });
    const row = readFileSync(join(dir, 'state.db'));
    assert.ok(!row.toString('latin1').includes('top-secret'), '源正文不应以明文出现在数据库文件');
    assert.equal(store.listSources()[0]?.kind, 'inline');
    assert.match(store.readSourcePayload('a') ?? '', /ss\.example\.invalid/);
    assert.equal(store.listCollections()[0]?.members.length, 1);
    assert.equal(store.listAnnotations()[0]?.alias, 'Renamed');
    // 手动覆盖地区必须落库：端口合同里有 region，适配器漏写会让「改地区」变成假动作。
    assert.equal(store.listAnnotations()[0]?.region, 'JP');
    const backup = join(dir, 'backup', 'snapshot.db');
    await store.backup(backup);
    assert.ok(existsSync(backup));
    const restored = openStore(backup, 'unit-secret');
    assert.match(restored.readSourcePayload('a') ?? '', /ss\.example\.invalid/);
    restored.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上游正文超过上限立即中止，不把整份响应读进内存', async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    // 分块发送且不声明 content-length，确保走流式上限而不是只看响应头。
    res.write('x'.repeat(512));
    res.end('x'.repeat(512));
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise<void>((done) => upstream.close(() => done()));
  });
  const port = (upstream.address() as AddressInfo).port;
  await assert.rejects(
    () =>
      fetchSnapshot(`http://127.0.0.1:${port}/sub`, null, {
        allowPrivate: true,
        maxBytes: 512,
      }),
    /upstream-body-too-large/,
  );
});

test('HTTP 契约：鉴权 / 订阅 URL / 304 / 诊断 / 撤销 / 备份', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-http-'));
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits += 1;
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { etag: '"v1"', 'content-type': 'text/plain; charset=utf-8' });
    res.end(subscription);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'http-secret');
  const app = createApp({
    store,
    adminToken: 'test-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer test-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => upstream.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown): Promise<Response> =>
    get(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/api/state')).status, 401, '管理面未授权必须拒绝');
  const stateBody = (await (await get('/api/state', { headers: auth })).json()) as { coreVersion: string };
  assert.equal(stateBody.coreVersion, '0.1.0');

  // 坏 body / 超大 body 是客户端错误：不能落到外层 catch 变成 500。
  const malformed = await get('/api/sources', {
    method: 'POST',
    headers: auth,
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as { error: string }).error, 'invalid-json-body');
  const oversized = await get('/api/sources', {
    method: 'POST',
    headers: auth,
    body: 'x'.repeat(8 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.equal(((await oversized.json()) as { error: string }).error, 'request-body-too-large');

  // Host 头由客户端控制；用它拼 URL 失败时必须是 400，而不是让请求回调同步抛错打崩进程。
  const port = Number(new URL(base).port);
  const badHostStatus = await new Promise<number>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '/health', headers: { host: 'bad host' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 400);

  assert.equal((await post('/api/sources', { id: 'a', url: `http://127.0.0.1:${upstreamPort}/sub` })).status, 201);
  assert.equal((await post('/api/profiles', { name: 'default', sourceIds: ['a'] })).status, 201);
  const tokenResponse = await post('/api/tokens', { profile: 'default', target: 'surge' });
  assert.equal(tokenResponse.status, 201);
  const created = (await tokenResponse.json()) as { id: string; url: string };

  const first = await fetch(created.url);
  assert.equal(first.status, 200);
  const content = await first.text();
  assert.match(content, /ss\.example\.invalid/);
  assert.match(content, /= vmess,/);
  const etag = first.headers.get('etag');
  assert.ok(etag !== null && etag.length > 0);
  assert.equal(upstreamHits, 1);

  const cached = await fetch(created.url, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304, '未变化应直接 304，不跑 Ingest');
  assert.equal(upstreamHits, 2, '第二次仍走上游条件请求，但上游返回 304');

  const diagnostics = await fetch(`${created.url}/diagnostics`);
  assert.equal(diagnostics.status, 200);
  const diagnosticsEtag = diagnostics.headers.get('etag');
  assert.ok(diagnosticsEtag !== null && diagnosticsEtag.length > 0);
  const report = (await diagnostics.json()) as { report: { diagnostics: { reason: string }[] }; buildId: string };
  assert.ok(report.report.diagnostics.length > 0);
  assert.ok(report.buildId.length > 0);

  // 诊断 JSON 含 `upstream-stale:45s` 这类随时间变化的字段，不能凭同一份 state.etag 回 304。
  const diagnosticsAgain = await fetch(`${created.url}/diagnostics`, {
    headers: { 'if-none-match': diagnosticsEtag },
  });
  assert.equal(diagnosticsAgain.status, 200, '诊断请求必须重新生成，不能 304');
  await diagnosticsAgain.text();

  const byBuild = await get(`/api/diagnostics?buildId=${report.buildId}`, { headers: auth });
  assert.equal(byBuild.status, 200);

  assert.equal((await post('/api/annotations', { nodeKey: 'vless:any', excluded: true })).status, 200);
  const afterEdit = await fetch(created.url, { headers: { 'if-none-match': etag } });
  assert.equal(afterEdit.status, 200, '配置变更后 ETag 必须失效');

  const revoked = await get(`/api/tokens/${created.id}`, { method: 'DELETE', headers: auth });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(created.url)).status, 404, '撤销后订阅 URL 立即失效');

  const backup = await post('/api/backup', {});
  assert.equal(backup.status, 200);
  const backupBody = (await backup.json()) as { destination: string };
  assert.ok(existsSync(backupBody.destination));

  const ruleSet = [
    { condition: { type: 'domain', value: 'ad.example.invalid' }, policy: 'REJECT' },
    {
      condition: {
        type: 'and',
        children: [
          { type: 'domain', value: 'x.example.invalid' },
          { type: 'ipCidr', value: '10.0.0.0/8' },
        ],
      },
      policy: 'PROXY',
    },
  ];
  assert.equal((await post('/api/rules', { rules: ruleSet })).status, 200);
  const savedRules = await get('/api/rules', { headers: auth });
  assert.equal(((await savedRules.json()) as { rules: unknown[] }).rules.length, 2);
  assert.equal((await post('/api/policy-groups', { groups: [{ name: 'PROXY', members: ['A', 'B'] }] })).status, 200);
  assert.equal((await get('/api/trace', { headers: auth })).status, 200);

  const mihomoPreview = await get('/api/preview?target=mihomo', { headers: auth });
  const previewBody = (await mihomoPreview.json()) as {
    content: string;
    trace: { steps: unknown[] };
  };
  assert.match(previewBody.content, /DOMAIN,ad\.example\.invalid,REJECT/);
  assert.match(previewBody.content, /AND,\(\(DOMAIN,x\.example\.invalid\),\(IP-CIDR,10\.0\.0\.0\/8\)\),PROXY/);
  assert.ok(previewBody.trace.steps.length > 0);
  assert.equal((await get('/api/capabilities', { headers: auth })).status, 200);

  // 新增方言的端到端：注册表下发 → 订阅 URL 内容 → Content-Type → 预览下载名。
  const registry = (await (await get('/api/state', { headers: auth })).json()) as {
    targets: string[];
    clientTargets: { id: string; name: string; fileExtension: string }[];
  };
  assert.equal(registry.targets.length, 19);
  assert.ok(registry.clientTargets.some((item) => item.id === 'quanx' && item.name === 'Quantumult X'));

  const cases = [
    { target: 'quanx', mime: /text\/plain/, pattern: /\[server_local\]/, file: 'quanx.conf' },
    { target: 'loon', mime: /text\/plain/, pattern: /\[Proxy\]/, file: 'loon.conf' },
    { target: 'egern', mime: /text\/yaml/, pattern: /shadowsocks:/, file: 'egern.yaml' },
    { target: 'v2box', mime: /text\/plain/, pattern: /^ss:\/\//m, file: 'v2box.txt' },
  ];
  for (const item of cases) {
    const token = (await (
      await post('/api/tokens', { profile: 'default', target: item.target })
    ).json()) as { url: string };
    const response = await fetch(token.url);
    assert.equal(response.status, 200, item.target);
    assert.match(response.headers.get('content-type') ?? '', item.mime, item.target);
    assert.match(await response.text(), item.pattern, item.target);
    const preview = await get(`/api/preview?target=${item.target}`, { headers: auth });
    assert.equal(((await preview.json()) as { filename: string }).filename, item.file, item.target);
  }
});

test('文件源 / 组合订阅 / UA 自适应 / 参数化订阅', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-compose-'));
  const store = openStore(join(dir, 'state.db'), 'compose-secret');
  const app = createApp({ store, adminToken: 'compose-admin', cacheDir: join(dir, 'cache'), dataDir: dir });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer compose-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (path: string, init?: RequestInit): Promise<Response> => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown): Promise<Response> =>
    call(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  const credential = Buffer.from('aes-256-gcm:pw').toString('base64');
  const sss = (host: string, tag: string): string =>
    `ss://${credential}@${host}:443#${encodeURIComponent(tag)}`;

  // 两个「上传文件」型源：内容直接随请求提交，不依赖外部可达性。
  assert.equal(
    (await post('/api/sources', {
      kind: 'file',
      name: '机场 A',
      content: [sss('a1.example.invalid', 'HK-01'), sss('a2.example.invalid', 'HK-02')].join('\n'),
    })).status,
    201,
  );
  const sourceB = (await (
    await post('/api/sources', {
      kind: 'inline',
      name: '机场 B',
      content: [sss('b1.example.invalid', 'JP-01'), sss('a1.example.invalid', 'HK-01-dup')].join('\n'),
    })
  ).json()) as { id: string };
  const sources = ((await (await call('/api/state', { headers: auth })).json()) as {
    sources: { id: string; name: string; kind: string; enabled: boolean; bytes: number }[];
  }).sources;
  assert.equal(sources.length, 2);
  assert.ok(sources.every((item) => item.kind === 'file' || item.kind === 'inline'));
  const foundA = sources.find((item) => item.name === '机场 A');
  assert.ok(foundA !== undefined, '按名称定位源 A');

  const inspect = ((await (await call('/api/sources/inspect', { headers: auth })).json()) as {
    sources: { id: string; nodes: number; sample: string[] }[];
  }).sources;
  assert.equal(inspect.length, 2);
  assert.ok(inspect.every((item) => item.nodes === 2));
  assert.ok(inspect.some((item) => item.sample.includes('HK-01')));

  // 组合订阅：A 加前缀，B 只保留 JP，再按 nodeKey 去重。
  const collection = (await (
    await post('/api/collections', {
      name: '合并机场',
      dedupe: 'nodeKey',
      members: [
        { sourceId: foundA.id, filter: { prefix: 'A-' } },
        { sourceId: sourceB.id, filter: { include: ['JP'] } },
      ],
    })
  ).json()) as { id: string };
  assert.ok(collection.id.length > 0);

  assert.equal(
    (await post('/api/profiles', { name: 'default', entries: [{ kind: 'collection', id: collection.id }] }))
      .status,
    201,
  );

  const nodes = ((await (await call('/api/nodes?profile=default', { headers: auth })).json()) as {
    nodes: { name: string; sources: string[] }[];
  }).nodes;
  assert.deepEqual(
    nodes.map((item) => item.name).sort(),
    ['A-HK-01', 'A-HK-02', 'JP-01'],
  );
  assert.ok(nodes.every((item) => item.sources.length === 1), '每个节点都能追到来源');

  // UA 自适应：一个链接喂所有客户端。
  const auto = (await (await post('/api/tokens', { profile: 'default', target: 'auto' })).json()) as {
    url: string;
    path: string;
  };
  assert.match(auto.path, /^\/s\/[A-Za-z0-9_-]+$/);
  assert.equal(auto.url, `${base}${auto.path}`, '响应里的地址必须能直接填进客户端，不能是相对路径');
  const surge = await fetch(auto.url, { headers: { 'user-agent': 'Surge iOS/3389' } });
  assert.equal(surge.status, 200);
  assert.match(surge.headers.get('content-type') ?? '', /text\/plain/);
  const surgeEtag = surge.headers.get('etag');
  assert.ok(surgeEtag !== null && surgeEtag.length > 0);
  assert.match(surge.headers.get('vary') ?? '', /user-agent/i, '自适应响应必须按 UA 区分缓存');
  assert.match(await surge.text(), /A-HK-01/);
  const clash = await fetch(auto.url, { headers: { 'user-agent': 'ClashMetaForAndroid/2.10.1' } });
  assert.equal(clash.status, 200);
  const clashEtag = clash.headers.get('etag');
  assert.ok(clashEtag !== null && clashEtag.length > 0);
  assert.notEqual(clashEtag, surgeEtag, '不同客户端方言必须是不同表示');
  assert.match(await clash.text(), /type: ss/);

  // 拿 Surge 的 ETag 去请求 mihomo：表示不同，绝不能回 304 让客户端保留旧格式。
  const crossTarget = await fetch(auto.url, {
    headers: { 'user-agent': 'ClashMetaForAndroid/2.10.1', 'if-none-match': surgeEtag },
  });
  assert.equal(crossTarget.status, 200, 'ETag 不能跨客户端复用');
  await crossTarget.text();

  // 诊断 JSON 与订阅正文也是不同表示：共用 state.etag 时这里会错误地 304。
  const wrongDiagnostics = await fetch(`${auto.url}/diagnostics`, {
    headers: { 'user-agent': 'Surge iOS/3389', 'if-none-match': surgeEtag },
  });
  assert.equal(wrongDiagnostics.status, 200, '诊断 JSON 不能命中订阅正文的 ETag');
  await wrongDiagnostics.text();

  const unknown = await fetch(auto.url, { headers: { 'user-agent': 'curl/8.0' } });
  assert.equal(unknown.status, 400, '认不出客户端时明确拒绝，不猜格式');

  // 参数化订阅：include / prefix 只影响这次响应。
  const filtered = await fetch(`${auto.url}?include=HK&prefix=M-`, {
    headers: { 'user-agent': 'Surge iOS/3389' },
  });
  assert.equal(filtered.status, 200);
  const filteredEtag = filtered.headers.get('etag');
  assert.ok(filteredEtag !== null && filteredEtag.length > 0);
  assert.notEqual(filteredEtag, surgeEtag, '过滤后的正文不能复用未过滤的 ETag');
  const text = await filtered.text();
  assert.match(text, /M-A-HK-01/);
  assert.ok(!text.includes('JP-01'));

  const filteredCached = await fetch(`${auto.url}?include=HK&prefix=M-`, {
    headers: { 'user-agent': 'Surge iOS/3389', 'if-none-match': filteredEtag },
  });
  assert.equal(filteredCached.status, 304, '同一过滤表示应能正常命中 304');
  await filteredCached.text();

  const filteredCross = await fetch(`${auto.url}?include=HK&prefix=M-`, {
    headers: { 'user-agent': 'Surge iOS/3389', 'if-none-match': surgeEtag },
  });
  assert.equal(filteredCross.status, 200, '过滤表示不能命中未过滤表示的 ETag');
  await filteredCross.text();

  // 源被删除后组合订阅仍可构建，只是少一段并留下诊断。
  assert.equal((await call(`/api/sources/${sourceB.id}`, { method: 'DELETE', headers: auth })).status, 200);
  const survivors = ((await (await call('/api/nodes?profile=default', { headers: auth })).json()) as {
    nodes: { name: string }[];
    diagnostics: { reason: string }[];
  }).nodes;
  assert.deepEqual(survivors.map((item) => item.name).sort(), ['A-HK-01', 'A-HK-02']);

  const mihomo = ((await (await call('/api/preview?target=mihomo', { headers: auth })).json()) as {
    content: string;
  }).content;
  assert.match(mihomo, /A-HK-01/);
});
