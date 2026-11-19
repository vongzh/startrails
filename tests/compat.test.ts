import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emit, encodeUriSubscriptionBase64, ingest, parseProfile, plan } from '../src/core/index.ts';
import type { ClientTarget } from '../src/core/index.ts';
import { createApp } from '../src/server/app.ts';
import { guessTargetByUa, resolveTargetSpec } from '../src/server/input.ts';
import {
  convertedSubscriptionURL,
  hasPlanDetail,
  parseUserinfo,
  quotaProbeUrl,
} from '../src/server/url-guard.ts';
import { openStore } from '../src/store/sqlite.ts';

test('订阅转换额度过滤与探测地址生成：过滤 total=1 占位头并提取内层机场链接', () => {
  // 在线订阅转换服务在未转发机场头时常写 upload=0; download=1; total=1（无到期时间），必须按无效处理。
  assert.equal(parseUserinfo('upload=0; download=1; total=1;'), null);
  assert.equal(parseUserinfo('upload=0; download=0; total=1'), null);
  // 若带了明确 expire（极少见或真实小流量测试套餐），仍按有效头解析。
  const withExpire = parseUserinfo('upload=0; download=1; total=1; expire=1790000000');
  assert.equal(withExpire?.total, 1);
  assert.equal(withExpire?.expire, 1790000000);
  assert.equal(hasPlanDetail(withExpire), true);
  assert.equal(hasPlanDetail({ upload: 10, download: 20 }), false);

  const converterUrl =
    'https://sub.example.invalid/sub?target=clash&url=https%3A%2F%2Fairport.example.invalid%2Fapi%2Fv1%2Fsub%3Ftoken%3Dabc';
  assert.equal(
    convertedSubscriptionURL(converterUrl),
    'https://airport.example.invalid/api/v1/sub?token=abc',
  );
  assert.equal(
    quotaProbeUrl(converterUrl),
    'https://airport.example.invalid/api/v1/sub?token=abc&flag=clash',
  );

  // 内层已有 flag 参数时不再重复追加，但依然探测原地址；多源合并（含 |）或非转换地址不探测。
  const pinnedFlag =
    'https://sub.example.invalid/sub?target=clash&url=https%3A%2F%2Fairport.example.invalid%2Fsub%3Ftoken%3Dabc%26flag%3Dmeta';
  assert.equal(quotaProbeUrl(pinnedFlag), 'https://airport.example.invalid/sub?token=abc&flag=meta');
  assert.equal(
    convertedSubscriptionURL('https://sub.example.invalid/sub?target=clash&url=https%3A%2F%2Fa.invalid%7Chttps%3A%2F%2Fb.invalid'),
    null,
  );
  assert.equal(quotaProbeUrl('https://airport.example.invalid/api/v1/sub?token=abc'), null);
  assert.equal(convertedSubscriptionURL('https://sub.example.invalid/sub?target=&url=https%3A%2F%2Fa.invalid'), null);
});

test('在线订阅转换端到端：主响应返回 total=1 时自动探测机场额度，且节点仍以转换地址为准', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-conv-quota-'));
  let airportHits = 0;
  let airportLastFlag: string | null = null;

  const airport = createServer((req, res) => {
    airportHits += 1;
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    airportLastFlag = reqUrl.searchParams.get('flag');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'subscription-userinfo': 'upload=1048576; download=2097152; total=53687091200; expire=1800000000',
    });
    // 返回与转换服务不同的节点，用于证明正文不会采用探测结果。
    res.end('ss://YWVzLTI1Ni1nY206cHc=@wrong-node.example.invalid:443#AirportOnly');
  });
  await new Promise<void>((done) => airport.listen(0, '127.0.0.1', done));
  const airportPort = (airport.address() as AddressInfo).port;

  const converter = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'subscription-userinfo': 'upload=0; download=1; total=1',
    });
    res.end('ss://YWVzLTI1Ni1nY206cHc=@converter-node.example.invalid:443#ConverterNode');
  });
  await new Promise<void>((done) => converter.listen(0, '127.0.0.1', done));
  const converterPort = (converter.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'conv-secret');
  const app = createApp({
    store,
    adminToken: 'conv-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer conv-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    await new Promise<void>((done) => converter.close(() => done()));
    await new Promise<void>((done) => airport.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const wrappedUrl = encodeURIComponent(`http://127.0.0.1:${airportPort}/sub?token=u1`);
  const created = await fetch(`${base}/api/sources`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      id: 'subconv',
      url: `http://127.0.0.1:${converterPort}/sub?target=clash&url=${wrappedUrl}`,
    }),
  });
  assert.equal(created.status, 201);

  const refreshed = await fetch(`${base}/api/sources/subconv/refresh`, {
    method: 'POST',
    headers: auth,
    body: '{}',
  });
  assert.equal(refreshed.status, 200);
  assert.equal(airportHits, 1, '应向内层机场发一次额度探测请求');
  assert.equal(airportLastFlag, 'clash');

  const source = store.getSource('subconv');
  assert.equal(source?.userinfo?.total, 53687091200);
  assert.equal(source?.userinfo?.expire, 1800000000);

  await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'default', entries: [{ kind: 'source', id: 'subconv' }] }),
  });
  const token = (await (
    await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profile: 'default', target: 'surge' }),
    })
  ).json()) as { url: string };

  const served = await fetch(token.url);
  assert.equal(served.status, 200);
  assert.equal(
    served.headers.get('subscription-userinfo'),
    'upload=1048576; download=2097152; total=53687091200; expire=1800000000',
  );
  const body = await served.text();
  assert.match(body, /converter-node\.example\.invalid/);
  assert.doesNotMatch(body, /wrong-node\.example\.invalid/, '节点正文必须保持转换地址的输出');
});

test('Clash hosts 表：改写节点入口并保留原域名作默认 SNI / Host（支持通配、链式与 IPv6）', () => {
  const yaml = `
hosts:
  'old.example.invalid': 203.0.113.10
  '*.cdn.example.invalid': [edge.pool.example.invalid, ignored.example.invalid]
  'edge.pool.example.invalid': 2001:db8::10
  '+.apex.example.invalid': 198.51.100.2
  '.subonly.example.invalid': 198.51.100.3
  'cycle-a.example.invalid': cycle-b.example.invalid
  'cycle-b.example.invalid': cycle-a.example.invalid
  'ignored.geosite.invalid': geosite:cn
proxies:
  - { name: Trojan-Exact, type: trojan, server: old.example.invalid, port: 443, password: pw }
  - { name: VMess-WS, type: vmess, server: edge1.cdn.example.invalid, port: 443, uuid: 11111111-1111-1111-1111-111111111111, tls: true, network: ws, ws-opts: { path: /ws } }
  - { name: VLESS-ExplicitSNI, type: vless, server: apex.example.invalid, port: 443, uuid: 22222222-2222-2222-2222-222222222222, tls: true, servername: keep.sni.invalid }
  - { name: SubOnly-Root, type: ss, server: subonly.example.invalid, port: 8388, cipher: aes-128-gcm, password: pw }
  - { name: SubOnly-Leaf, type: ss, server: a.subonly.example.invalid, port: 8388, cipher: aes-128-gcm, password: pw }
  - { name: SS-CDN-IPv6, type: ss, server: edge2.cdn.example.invalid, port: 8388, cipher: aes-128-gcm, password: pw }
  - { name: CycleNode, type: ss, server: cycle-a.example.invalid, port: 8388, cipher: aes-128-gcm, password: pw }
`;
  const { profile } = ingest(yaml);
  assert.equal(profile.nodes.length, 7);

  const trojan = profile.nodes.find((n) => n.name === 'Trojan-Exact');
  assert.equal(trojan?.server, '203.0.113.10');
  assert.equal(trojan?.options?.sni, 'old.example.invalid');

  const vmess = profile.nodes.find((n) => n.name === 'VMess-WS');
  assert.equal(vmess?.server, '2001:db8::10');
  assert.equal(vmess?.options?.sni, 'edge1.cdn.example.invalid');
  assert.equal(vmess?.options?.host, 'edge1.cdn.example.invalid');

  // IPv6 目标经 URI / QuanX 导出时：URI authority 与 QuanX 必须加方括号，vmess JSON 的 add 保持裸 IPv6；
  // Trojan 未显式写 tls: true 时，hosts 改写后导出分享链接与 QuanX 仍保留 TLS 与原始域名作 SNI。
  const uriList = emit(profile, plan(profile, 'v2box')).content;
  const vmessLine = uriList.split('\n').find((line) => line.startsWith('vmess://')) ?? '';
  const vmessJson = JSON.parse(
    Buffer.from(vmessLine.slice('vmess://'.length), 'base64url').toString('utf8'),
  ) as Record<string, string>;
  assert.equal(vmessJson['add'], '2001:db8::10');
  assert.match(uriList, /ss:\/\/[^@]+@\[2001:db8::10\]:8388#SS-CDN-IPv6/);
  assert.match(uriList, /trojan:\/\/pw@203\.0\.113\.10:443\?security=tls&sni=old\.example\.invalid#Trojan-Exact/);
  const quanx = emit(profile, plan(profile, 'quanx')).content;
  assert.match(quanx, /vmess=\[2001:db8::10\]:443/);
  assert.match(quanx, /trojan=203\.0\.113\.10:443, password=pw, over-tls=true, tls-host=old\.example\.invalid, tag=Trojan-Exact/);

  const vless = profile.nodes.find((n) => n.name === 'VLESS-ExplicitSNI');
  assert.equal(vless?.server, '198.51.100.2');
  assert.equal(vless?.options?.sni, 'keep.sni.invalid', '显式 sni/servername 不应被覆盖');

  const subRoot = profile.nodes.find((n) => n.name === 'SubOnly-Root');
  assert.equal(subRoot?.server, 'subonly.example.invalid', '.domain 只匹配子域名，不匹配裸域名');
  const subLeaf = profile.nodes.find((n) => n.name === 'SubOnly-Leaf');
  assert.equal(subLeaf?.server, '198.51.100.3');

  const cycle = profile.nodes.find((n) => n.name === 'CycleNode');
  assert.equal(cycle?.server, 'cycle-b.example.invalid', 'hosts 环路必须安全终止');
});

test('Surge / Loon / QuanX 导出转义 // 与 INI 特殊符号，节点与策略组成员名保持一致', () => {
  const profile = parseProfile({
    nodes: [
      { kind: 'shadowsocks', name: 'HK // Backup #1 [Beta]', server: 'hk.example.invalid', port: 443, method: 'aes-256-gcm', password: 'pw' },
      { kind: 'shadowsocks', name: 'JP ; Direct', server: 'jp.example.invalid', port: 443, method: 'aes-256-gcm', password: 'pw' },
      {
        kind: 'wireguard',
        name: 'WG // 01',
        server: 'wg.example.invalid',
        port: 51820,
        privateKey: 'priv',
        peerPublicKey: 'pub',
        addresses: ['10.0.0.2/32'],
      },
    ],
    ruleSources: [
      {
        kind: 'inline',
        rules: [{ condition: { type: 'domain', value: 'example.com' }, policy: 'Select // Main' }],
      },
      {
        kind: 'external',
        url: 'https://rules.example.invalid/custom.list',
        policy: 'Select // Main',
      },
    ],
    policyGroups: [
      {
        name: 'Select // Main',
        members: ['HK // Backup #1 [Beta]', 'JP ; Direct', 'WG // 01', 'DIRECT'],
      },
    ],
  });

  for (const target of ['surge', 'surge-mac', 'loon', 'quanx'] as const) {
    const content = emit(profile, plan(profile, target)).content;
    const nonHeader = content
      .split('\n')
      .filter((line) => !line.startsWith('# Generated') && !line.startsWith('# Field') && !line.startsWith('# [') && !line.startsWith('# external rule set'));
    const joined = nonHeader.join('\n');
    assert.doesNotMatch(joined.replace(/https?:\/\//g, ''), /\/\//, `${target} 正文不应保留未转义的 //`);
    assert.ok(!joined.includes('HK // Backup'), `${target} 不应保留原始 //`);
    assert.match(joined, /HK ／／ Backup ＃1 ［Beta］/, target);
    if (target !== 'loon') {
      assert.match(joined, /Select ／／ Main/, target);
    }
    if (target === 'surge' || target === 'surge-mac') {
      assert.match(joined, /WG ／／ 01 = wireguard, section-name = Startrails-WG-／／-01/);
      assert.match(joined, /\[WireGuard Startrails-WG-／／-01\]/);
      assert.match(joined, /DOMAIN,example\.com,Select ／／ Main/);
      assert.match(joined, /RULE-SET,https:\/\/rules\.example\.invalid\/custom\.list,Select ／／ Main/);
    }
    if (target === 'quanx') {
      assert.match(joined, /host, example\.com, Select ／／ Main/);
    }
  }
});

test('Snell 版本能力保护：Clash App (1.0.18+) 支持 Snell v6，Stash 限 v1-3，旧内核 mihomo 限 v1-5', () => {
  const profile = parseProfile({
    nodes: [
      { kind: 'snell', name: 'Snell-v3', server: 's3.example.invalid', port: 8388, psk: 'short', options: { version: 3 } },
      { kind: 'snell', name: 'Snell-v4', server: 's4.example.invalid', port: 8388, psk: 'short', options: { version: 4 } },
      { kind: 'snell', name: 'Snell-v6-OK', server: 's6.example.invalid', port: 8388, psk: 'valid-snell6-psk', options: { version: 6 } },
      {
        kind: 'snell',
        name: 'Snell-v6-Obfs',
        server: 's6o.example.invalid',
        port: 8388,
        psk: 'valid-snell6-psk',
        options: { version: 6, obfs: { type: 'tls', host: 'bing.com' } },
      },
      { kind: 'snell', name: 'Snell-v6-ShortPSK', server: 's6s.example.invalid', port: 8388, psk: 'too-short', options: { version: 6 } },
    ],
    ruleSources: [],
    policyGroups: [],
  });

  // Clash App (clash-apple): v3 / v4 / 合规 v6 放行并写出 version: 6；带 obfs 或短 PSK 的 v6 跳过。
  const clashApplePlan = plan(profile, 'clash-apple');
  const clashAppleByName = new Map(profile.nodes.map((n, i) => [n.name, clashApplePlan.items[i]]));
  assert.equal(clashAppleByName.get('Snell-v3')?.action, 'support');
  assert.equal(clashAppleByName.get('Snell-v4')?.action, 'support');
  assert.equal(clashAppleByName.get('Snell-v6-OK')?.action, 'support');
  assert.equal(clashAppleByName.get('Snell-v6-Obfs')?.reason, 'snell-v6-obfs-unsupported');
  assert.equal(clashAppleByName.get('Snell-v6-ShortPSK')?.reason, 'snell-v6-psk-length');
  const clashAppleYaml = emit(profile, clashApplePlan).content;
  assert.match(clashAppleYaml, /name: Snell-v6-OK[\s\S]*version: 6/);
  assert.doesNotMatch(clashAppleYaml, /Snell-v6-Obfs|Snell-v6-ShortPSK/);

  // 其余 mihomo 系仅接受 v1-v5，必须拒绝 v6 避免拖垮整份配置。
  for (const mihomoTarget of ['mihomo', 'clash-verge', 'clashmac', 'flclash', 'mihomo-party', 'clash-mi', 'karing'] as ClientTarget[]) {
    const p = plan(profile, mihomoTarget);
    const v6Item = p.items[2];
    assert.equal(v6Item?.action, 'reject', mihomoTarget);
    assert.equal(v6Item?.reason, 'snell-version-unsupported:6', mihomoTarget);
  }

  // Stash (clash): 仅接受 v1-v3。
  const stashPlan = plan(profile, 'clash');
  assert.equal(stashPlan.items[0]?.action, 'support');
  assert.equal(stashPlan.items[1]?.reason, 'snell-version-unsupported:4');
  assert.equal(stashPlan.items[2]?.reason, 'snell-version-unsupported:6');

  // Surge 仍支持 v1-v6。
  const surgeYaml = emit(profile, plan(profile, 'surge')).content;
  assert.match(surgeYaml, /Snell-v6-OK = snell, s6\.example\.invalid, 8388, psk=valid-snell6-psk, version=6/);
});

test('v2rayNG / v2rayN / V2Box 订阅投递：识别 UA 与 target 别名并输出无注释 Base64 分享链接', async (t) => {
  assert.equal(guessTargetByUa('v2rayNG/1.9.10'), 'v2box');
  assert.equal(guessTargetByUa('v2rayN/7.1.0'), 'v2box');
  assert.equal(guessTargetByUa('V2Box/5.0.2'), 'v2box');
  assert.deepEqual(resolveTargetSpec('v2rayng'), { target: 'v2box', base64Links: true });
  assert.deepEqual(resolveTargetSpec('v2rayN'), { target: 'v2box', base64Links: true });
  assert.deepEqual(resolveTargetSpec('v2ray'), { target: 'v2box', base64Links: true });

  const encoded = encodeUriSubscriptionBase64(
    '# Generated comment\n# Another comment\nss://abc@a.invalid:443#A\nvless://uuid@b.invalid:443#B\n',
  );
  assert.equal(
    Buffer.from(encoded, 'base64').toString('utf8'),
    'ss://abc@a.invalid:443#A\nvless://uuid@b.invalid:443#B',
  );

  const dir = mkdtempSync(join(tmpdir(), 'startrails-v2ray-'));
  const store = openStore(join(dir, 'state.db'), 'v2ray-secret');
  const app = createApp({
    store,
    adminToken: 'v2ray-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowStateless: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const auth = { authorization: 'Bearer v2ray-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await fetch(`${base}/api/sources`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      id: 's1',
      kind: 'inline',
      content: 'ss://YWVzLTI1Ni1nY206cHc=@node1.example.invalid:443#HK-1\nvless://11111111-1111-1111-1111-111111111111@node2.example.invalid:443?encryption=none&security=tls#US-2',
    }),
  });
  await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'default', entries: [{ kind: 'source', id: 's1' }] }),
  });
  const token = (await (
    await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profile: 'default', target: 'auto' }),
    })
  ).json()) as { token: string; url: string };

  for (const ua of ['v2rayNG/2.3.15', 'v2rayN/7.2', 'V2Box/5.0']) {
    const resp = await fetch(token.url, { headers: { 'user-agent': ua } });
    assert.equal(resp.status, 200, ua);
    const raw = await resp.text();
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    assert.doesNotMatch(decoded, /^#/m, `${ua} Base64 解码后不应含注释行`);
    assert.match(decoded, /^ss:\/\//m, ua);
    assert.match(decoded, /^vless:\/\//m, ua);
  }

  for (const alias of ['v2ray', 'v2rayng', 'v2rayn']) {
    const resp = await fetch(`${base}/s/${token.token}/default/${alias}`);
    assert.equal(resp.status, 200, alias);
    const decoded = Buffer.from(await resp.text(), 'base64').toString('utf8');
    assert.match(decoded, /^ss:\/\//m, alias);
    assert.match(decoded, /^vless:\/\//m, alias);
  }

  // ETag 按 plain / base64 编码区分，避免缓存错配。
  const plainResp = await fetch(`${base}/s/${token.token}/default/v2box`);
  assert.equal(plainResp.status, 200);
  const plainEtag = plainResp.headers.get('etag');
  assert.ok(plainEtag !== null);
  const plainText = await plainResp.text();
  assert.match(plainText, /^# Generated/m);

  const v2boxClientResp = await fetch(`${base}/s/${token.token}/default/v2box`, {
    headers: { 'user-agent': 'V2Box/5.0', 'if-none-match': plainEtag },
  });
  assert.equal(v2boxClientResp.status, 200, '明文 ETag 不应命中 V2Box 的 Base64 响应');
  assert.match(Buffer.from(await v2boxClientResp.text(), 'base64').toString('utf8'), /^ss:\/\//m);
});
