import assert from 'node:assert/strict';
import test from 'node:test';
import { emit, parseProfile, plan } from '../src/core/index.ts';

/**
 * 运行时段（DNS / TUN）的落地验证。
 * 重点不是「字段写出来了」，而是三件事：
 * 1. 按方言分流到正确的键（Surge 的明文与加密是两个字段）；
 * 2. 客户端不支持时不写、并留下能看懂的诊断（而不是静默丢或硬写）；
 * 3. 改了 DNS 会换 configVersion（在 server 侧验证，这里只保证 IR 会带上它）。
 */
// 运行时段不来自订阅内容（ingest 会把它丢掉），只来自设置接口，所以这里直接构造 IR。
const build = (runtime: unknown, target: Parameters<typeof plan>[1]) => {
  const profile = parseProfile({
    nodes: [
      {
        kind: 'shadowsocks',
        name: 'HK-01',
        server: 'hk.example.invalid',
        port: 8388,
        method: 'aes-128-gcm',
        password: 'pw',
      },
    ],
    ruleSources: [],
    policyGroups: [{ name: 'PROXY', members: ['HK-01'] }],
    ...(runtime === undefined ? {} : { runtime }),
  });
  const emissionPlan = plan(profile, target);
  return { profile, emissionPlan, content: emit(profile, emissionPlan).content, diagnostics: emissionPlan.diagnostics };
};

const reasons = (diagnostics: readonly { reason: string }[]): string[] =>
  diagnostics.map((item) => item.reason);

test('mihomo：fake-ip + nameserver 写成 dns 段，tun 写成顶层 tun 段', () => {
  const { content } = build(
    {
      dns: {
        mode: 'fake-ip',
        nameserver: ['223.5.5.5', 'https://dns.alidns.com/dns-query'],
        proxyNameserver: ['223.5.5.5'],
        fakeIpRange: '198.18.0.1/16',
        ipv6: false,
      },
      tun: { enabled: true, stack: 'gvisor', strictRoute: true },
    },
    'mihomo',
  );
  assert.match(content, /^dns:/m);
  assert.match(content, /enhanced-mode: fake-ip/);
  assert.match(content, /fake-ip-range: 198\.18\.0\.1\/16/);
  assert.match(content, /proxy-server-nameserver:/);
  assert.match(content, /ipv6: false/);
  assert.match(content, /^tun:/m);
  assert.match(content, /stack: gvisor/);
});

test('Stash：没有 enhanced-mode 这个键，但 fake-ip-range 照样要写', () => {
  const { content, diagnostics } = build(
    { dns: { mode: 'fake-ip', nameserver: ['223.5.5.5'], fakeIpRange: '198.18.0.1/16' } },
    'clash',
  );
  assert.match(content, /fake-ip-range: 198\.18\.0\.1\/16/);
  assert.doesNotMatch(content, /enhanced-mode/, 'Stash 官方示例没有这个键，写了只会被忽略甚至报错');
  assert.ok(reasons(diagnostics).includes('runtime-dns-fakeip-implicit'));
});

test('Surge：明文与加密 DNS 必须分流到 dns-server / encrypted-dns-server', () => {
  const { content } = build(
    {
      dns: {
        mode: 'redir-host',
        nameserver: ['223.5.5.5', 'https://dns.alidns.com/dns-query'],
        ipv6: false,
      },
    },
    'surge',
  );
  assert.match(content, /^dns-server = 223\.5\.5\.5$/m);
  assert.match(content, /^encrypted-dns-server = https:\/\/dns\.alidns\.com\/dns-query$/m);
  assert.match(content, /^ipv6 = false$/m);
  // 明文与加密不能混在同一个键里：Surge 的 dns-server 明确「Hostnames are not allowed」。
  assert.doesNotMatch(content, /^dns-server = .*https:/m);
});

test('Surge / Loon / QuanX 不支持 fake-ip：降级为 redir-host 并记诊断，而不是硬写', () => {
  for (const target of ['surge', 'loon', 'quanx'] as const) {
    const { diagnostics, content } = build(
      { dns: { mode: 'fake-ip', nameserver: ['223.5.5.5'] } },
      target,
    );
    assert.ok(
      reasons(diagnostics).includes('runtime-dns-fakeip-unsupported'),
      `${target} 应当明确告知 fake-ip 被降级`,
    );
    assert.doesNotMatch(content, /fake-ip/);
  }
});

test('Loon / QuanX：加密 DNS 走各自的上游键', () => {
  const loon = build(
    { dns: { mode: 'redir-host', nameserver: ['system', 'https://doh.pub/dns-query', 'quic://dns.adguard.com'] } },
    'loon',
  );
  assert.match(loon.content, /dns-server = system/);
  assert.match(loon.content, /doh-server = https:\/\/doh\.pub\/dns-query/);
  assert.match(loon.content, /doq-server = quic:\/\/dns\.adguard\.com/);

  const quanx = build(
    { dns: { mode: 'redir-host', nameserver: ['223.5.5.5', 'https://doh.pub/dns-query'], ipv6: false } },
    'quanx',
  );
  assert.match(quanx.content, /^\[dns\]$/m);
  assert.match(quanx.content, /^no-system$/m, '用户显式给了服务器，就不该再叠加系统 DNS');
  assert.match(quanx.content, /^server = 223\.5\.5\.5$/m);
  assert.match(quanx.content, /^doh-server = https:\/\/doh\.pub\/dns-query$/m);
  assert.match(quanx.content, /^no-ipv6$/m);
});

test('sing-box：只写 typed server（legacy 的 address 已在 1.14 移除）', () => {
  const { content } = build(
    {
      dns: {
        mode: 'fake-ip',
        nameserver: ['https://dns.alidns.com/dns-query', '223.5.5.5'],
        ecs: '114.114.114.0/24',
      },
    },
    'sing-box',
  );
  const doc = JSON.parse(content) as {
    dns: {
      servers: { type: string; tag: string; server?: string; domain_resolver?: string }[];
      rules?: { query_type: string[]; server: string }[];
      client_subnet?: string;
    };
  };
  const types = doc.dns.servers.map((server) => server.type);
  assert.deepEqual(types, ['local', 'https', 'udp', 'fakeip'], '含域名的 DoH 必须先有 bootstrap 解析器');
  assert.equal(doc.dns.servers[0]?.tag, 'dns-bootstrap');
  assert.equal(doc.dns.servers[1]?.domain_resolver, 'dns-bootstrap', '域名服务器必须挂 domain_resolver');
  assert.equal(doc.dns.client_subnet, '114.114.114.0/24');
  assert.deepEqual(doc.dns.rules, [{ query_type: ['A', 'AAAA'], server: 'fakeip' }]);
  assert.doesNotMatch(content, /"address"/, '不能写 legacy address 格式');
});

test('Egern：bootstrap + upstreams + 通配 forward，且不写 fake-ip', () => {
  const { content, diagnostics } = build(
    { dns: { mode: 'fake-ip', nameserver: ['223.5.5.5', 'https://dns.alidns.com/dns-query'] } },
    'egern',
  );
  assert.match(content, /^dns:$/m);
  assert.match(content, /bootstrap:/);
  assert.match(content, /- 223\.5\.5\.5/);
  assert.match(content, /startrails:/);
  assert.match(content, /domain_wildcard:/);
  assert.doesNotMatch(content, /fake-ip/);
  assert.ok(reasons(diagnostics).includes('runtime-dns-fakeip-unsupported'));
});

test('uri-list 目标：没有配置段可写，如实报「不适用」而不是静默丢弃', () => {
  const { diagnostics, content } = build(
    { dns: { mode: 'redir-host', nameserver: ['223.5.5.5'] } },
    'shadowrocket',
  );
  assert.ok(reasons(diagnostics).includes('runtime-dns-not-expressible'));
  assert.doesNotMatch(content, /dns/i);
});

test('未设置运行时段时不产生任何 DNS / TUN 段（默认行为不被打扰）', () => {
  for (const target of ['surge', 'mihomo', 'sing-box', 'loon', 'quanx', 'egern'] as const) {
    const { content, diagnostics } = build(undefined, target);
    assert.doesNotMatch(content, /dns-server|enhanced-mode|"dns"|^dns:/m, `${target} 不该凭空产生 DNS 段`);
    assert.equal(
      reasons(diagnostics).filter((reason) => reason.startsWith('runtime-')).length,
      0,
      `${target} 不该产生运行时段诊断`,
    );
  }
});

test('mode=system 且没给服务器：不写空段，只记一条说明', () => {
  const { content, diagnostics } = build({ dns: { mode: 'system' } }, 'mihomo');
  assert.doesNotMatch(content, /^dns:/m);
  assert.ok(reasons(diagnostics).includes('runtime-dns-system-default'));
});

test('设置接口：写入运行时段后，产物出现 dns 段且 configVersion 变化（否则 304 会命中旧产物）', async (t) => {
  const { createApp } = await import('../src/server/app.ts');
  const { openStore } = await import('../src/store/sqlite.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: nodeTest } = await import('node:test');
  void nodeTest;

  const dir = mkdtempSync(join(tmpdir(), 'startrails-runtime-'));
  const store = openStore(join(dir, 'state.db'), 'runtime-secret');
  store.putSource({
    id: 'inline-1',
    name: 'Inline',
    kind: 'inline',
    enabled: true,
  });
  store.writeSourcePayload(
    'inline-1',
    'ss://YWVzLTEyOC1nY206cHc@hk.example.invalid:8388#HK-01',
  );
  store.putProfile({ id: 'p', name: 'p', entries: [{ kind: 'source', id: 'inline-1' }] });
  const app = createApp({
    store,
    adminToken: 'runtime-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const auth = { authorization: 'Bearer runtime-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tokenResponse = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: 'p', target: 'mihomo' }),
  });
  const { url } = (await tokenResponse.json()) as { url: string };

  const before = await (await fetch(url)).text();
  assert.doesNotMatch(before, /^dns:/m);
  const versionBefore = ((await (await fetch(`${base}/health`)).json()) as { version: string }).version;

  const put = await fetch(`${base}/api/runtime?profile=p`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({
      runtime: { dns: { mode: 'fake-ip', nameserver: ['223.5.5.5'], fakeIpRange: '198.18.0.1/16' } },
    }),
  });
  assert.equal(put.status, 200);

  const after = await (await fetch(url)).text();
  assert.match(after, /^dns:/m, '写入设置后产物必须立刻带上 dns 段');
  assert.match(after, /enhanced-mode: fake-ip/);
  const versionAfter = ((await (await fetch(`${base}/health`)).json()) as { version: string }).version;
  assert.notEqual(versionAfter, versionBefore, 'configVersion 必须覆盖运行时段，否则客户端 304 拿到旧配置');

  // 非法策略当场拒绝，不能存一个「看起来存了但不会生效」的值。
  const bad = await fetch(`${base}/api/runtime?profile=p`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ runtime: { dns: { mode: 'not-a-mode' } } }),
  });
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, 'invalid-runtime-policy');

  // 清空后回到不写段的状态。
  const cleared = await fetch(`${base}/api/runtime?profile=p`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ runtime: null }),
  });
  assert.equal(cleared.status, 200);
  assert.doesNotMatch(await (await fetch(url)).text(), /^dns:/m);
});

test('mihomo 高级 DNS 字段：fallback-filter / fake-ip-filter / hosts 开关全部写出', () => {
  const { content, diagnostics } = build(
    {
      dns: {
        mode: 'fake-ip',
        nameserver: ['https://doh.pub/dns-query'],
        proxyNameserver: [],
        defaultNameserver: ['223.5.5.5', '119.29.29.29'],
        fakeIpFilter: ['*.lan', '+.msftconnecttest.com'],
        useHosts: false,
        useSystemHosts: false,
        respectRules: false,
        fallbackFilter: {
          geoip: true,
          geoipCode: 'CN',
          ipCidr: ['0.0.0.0/8', '10.0.0.0/8'],
          domain: ['+.google.com', '+.youtube.com'],
        },
      },
    },
    'mihomo',
  );
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  assert.match(text, /default-nameserver:/);
  assert.match(text, /223\.5\.5\.5/);
  assert.match(text, /proxy-server-nameserver: \[\]/, '显式空数组要写出来，不是省略');
  assert.match(text, /fake-ip-filter:/);
  assert.match(text, /fallback-filter:/);
  assert.match(text, /geoip-code: CN/);
  assert.match(text, /ipcidr:/);
  assert.match(text, /use-hosts: false/);
  assert.match(text, /respect-rules: false/);
  assert.ok(!diagnostics.some((d) => d.reason === 'runtime-dns-advanced-dropped'));
});

test('非 clash-yaml 目标：高级 DNS 字段整组剥掉并记诊断，不静默丢', () => {
  const { content, diagnostics } = build(
    {
      dns: {
        mode: 'system',
        nameserver: ['1.1.1.1'],
        fakeIpFilter: ['*.lan'],
        fallbackFilter: { geoip: true, geoipCode: 'CN' },
      },
    },
    'surge',
  );
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  assert.ok(
    diagnostics.some((d) => d.reason === 'runtime-dns-advanced-dropped'),
    `应有高级字段丢弃诊断，实际：${JSON.stringify(diagnostics.map((d) => d.reason))}`,
  );
  assert.doesNotMatch(text, /fake-ip-filter/);
  assert.doesNotMatch(text, /fallback-filter/);
});
