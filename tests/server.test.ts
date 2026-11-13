import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/sqlite.ts';
import { createApp } from '../src/server/app.ts';
import { assertPublicUrl, isPublicAddress } from '../src/server/url-guard.ts';
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
    store.putAnnotation({ nodeKey: 'k1', excluded: true, alias: 'Renamed', order: 2 });
    const row = readFileSync(join(dir, 'state.db'));
    assert.ok(!row.toString('latin1').includes('top-secret'), '源正文不应以明文出现在数据库文件');
    assert.equal(store.listSources()[0]?.kind, 'inline');
    assert.match(store.readSourcePayload('a') ?? '', /ss\.example\.invalid/);
    assert.equal(store.listCollections()[0]?.members.length, 1);
    assert.equal(store.listAnnotations()[0]?.alias, 'Renamed');
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
  const report = (await diagnostics.json()) as { report: { diagnostics: { reason: string }[] }; buildId: string };
  assert.ok(report.report.diagnostics.length > 0);
  assert.ok(report.buildId.length > 0);

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
  assert.match(await surge.text(), /A-HK-01/);
  const clash = await fetch(auto.url, { headers: { 'user-agent': 'ClashMetaForAndroid/2.10.1' } });
  assert.equal(clash.status, 200);
  assert.match(await clash.text(), /type: ss/);
  const unknown = await fetch(auto.url, { headers: { 'user-agent': 'curl/8.0' } });
  assert.equal(unknown.status, 400, '认不出客户端时明确拒绝，不猜格式');

  // 参数化订阅：include / prefix 只影响这次响应。
  const filtered = await fetch(`${auto.url}?include=HK&prefix=M-`, {
    headers: { 'user-agent': 'Surge iOS/3389' },
  });
  assert.equal(filtered.status, 200);
  const text = await filtered.text();
  assert.match(text, /M-A-HK-01/);
  assert.ok(!text.includes('JP-01'));

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
