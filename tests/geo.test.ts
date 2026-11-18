import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.ts';
import {
  compileAsnCsvs,
  compileCountryV4Csv,
  compileCountryV6Csv,
  compileGeoFromCsv,
  createGeoService,
  normalizeCountryRegion,
  parseIPv4Num,
} from '../src/server/geo.ts';
import { openStore } from '../src/store/sqlite.ts';

const IP4_1_1_1 = parseIPv4Num('1.1.1.0')!;
const IP4_1_1_1_END = parseIPv4Num('1.1.1.255')!;
const IP4_1_1_2 = parseIPv4Num('1.1.2.0')!;
const IP4_1_1_2_END = parseIPv4Num('1.1.2.255')!;
const IP4_8_8_8 = parseIPv4Num('8.8.8.0')!;
const IP4_8_8_8_END = parseIPv4Num('8.8.8.255')!;
const IP4_GB = parseIPv4Num('185.86.0.0')!;
const IP4_GB_END = parseIPv4Num('185.86.0.255')!;
const IP4_198 = parseIPv4Num('198.51.100.0')!;
const IP4_198_END = parseIPv4Num('198.51.100.255')!;

const FIXTURE_COUNTRY_V4 = [
  // 相邻两段同为 AU 应自动合并成 1 条记录
  `${IP4_1_1_1},${IP4_1_1_1_END},AU`,
  `${IP4_1_1_2},${IP4_1_1_2_END},AU`,
  `${IP4_8_8_8},${IP4_8_8_8_END},US`,
  `${IP4_GB},${IP4_GB_END},GB`,
  `${IP4_198},${IP4_198_END},JP`,
].join('\n');

const FIXTURE_COUNTRY_V6 = [
  '2001:4860:4860::,2001:4860:4860::ffff,US',
  '2406:da00::,2406:da00::ffff,JP',
].join('\n');

const FIXTURE_ASN_V4 = [
  `${IP4_1_1_1},${IP4_1_1_1_END},13335,"Cloudflare, Inc."`,
  `${IP4_8_8_8},${IP4_8_8_8_END},15169,Google LLC`,
  `${IP4_198},${IP4_198_END},2516,KDDI CORPORATION`,
].join('\n');

const FIXTURE_ASN_V6 = [
  '2001:4860:4860::,2001:4860:4860::ffff,15169,Google LLC',
].join('\n');

test('Geo 二进制编译与相邻区间合并 + IPv4/IPv6/mapped 查询', () => {
  const c4 = compileCountryV4Csv(FIXTURE_COUNTRY_V4);
  // 1.1.1.0/24 + 1.1.2.0/24 已合并为 1 条，总共 4 条
  assert.equal(c4.count, 4);
  const c6 = compileCountryV6Csv(FIXTURE_COUNTRY_V6);
  assert.equal(c6.count, 2);
  const asn = compileAsnCsvs(FIXTURE_ASN_V4, FIXTURE_ASN_V6);
  assert.equal(asn.v4Count, 3);
  assert.equal(asn.v6Count, 1);

  const dir = mkdtempSync(join(tmpdir(), 'startrails-geo-bin-'));
  try {
    const status = compileGeoFromCsv(dir, {
      countryV4: FIXTURE_COUNTRY_V4,
      countryV6: FIXTURE_COUNTRY_V6,
      asnV4: FIXTURE_ASN_V4,
      asnV6: FIXTURE_ASN_V6,
    });
    assert.equal(status.available, true);
    assert.equal(status.counts.countryV4, 4);

    const geo = createGeoService(dir);
    assert.equal(geo.lookupCountryIp('1.1.1.1'), 'AU');
    assert.equal(geo.lookupCountryIp('1.1.2.42'), 'AU');
    assert.equal(geo.lookupCountryIp('185.86.0.10'), 'UK'); // GB -> UK 对齐 Startrails 口径
    assert.equal(normalizeCountryRegion('gb'), 'UK');
    assert.equal(geo.lookupCountryIp('[2406:da00::1]'), 'JP');
    assert.equal(geo.lookupCountryIp('::ffff:198.51.100.8'), 'JP');
    assert.deepEqual(geo.lookupAsnIp('1.1.1.1'), { asn: 13335, org: 'Cloudflare, Inc.' });
    assert.deepEqual(geo.lookupAsnIp('2001:4860:4860::8888'), { asn: 15169, org: 'Google LLC' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缺失库目录优雅降级：available=false 且不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-geo-empty-'));
  try {
    const geo = createGeoService(join(dir, 'nonexistent'));
    assert.equal(geo.status().available, false);
    assert.equal(geo.peekHost('1.1.1.1'), undefined);
    const info = await geo.lookupHost('example.com');
    assert.deepEqual(info, { addresses: [], conflict: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DNS 并发合并、私网地址过滤与多 IP 地区冲突规则', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-geo-dns-'));
  try {
    compileGeoFromCsv(dir, {
      countryV4: FIXTURE_COUNTRY_V4,
      countryV6: FIXTURE_COUNTRY_V6,
      asnV4: FIXTURE_ASN_V4,
      asnV6: FIXTURE_ASN_V6,
    });

    let calls = 0;
    const table: Record<string, readonly string[]> = {
      'jp-edge.example.com': ['198.51.100.12', '2406:da00::22'],
      'anycast-conflict.example.com': ['8.8.8.8', '198.51.100.12'],
      'private-only.example.com': ['127.0.0.1', '192.168.1.10', '::1'],
    };
    const geo = createGeoService(dir, {
      resolver: async (host) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return table[host] ?? [];
      },
    });

    // 同名域名并发只触发 1 次 DNS 查询
    const [a, b] = await Promise.all([
      geo.lookupHost('jp-edge.example.com'),
      geo.lookupHost('jp-edge.example.com'),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.country, 'JP');
    assert.equal(b.country, 'JP');
    assert.equal(a.asn, 2516);
    assert.equal(a.org, 'KDDI CORPORATION');
    assert.equal(a.conflict, false);

    // 多个不同国家 IP -> country 置空且 conflict=true
    const conflict = await geo.lookupHost('anycast-conflict.example.com');
    assert.equal(conflict.country, undefined);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.asn, 2516); // 取最小 ASN

    // 私网 / 回环 IP 过滤跳过，不误判国家
    const priv = await geo.lookupHost('private-only.example.com');
    assert.equal(priv.country, undefined);
    assert.equal(priv.addresses.length, 0);
    assert.equal((await geo.lookupHost('10.0.0.1')).addresses.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/geo/status、/api/nodes 地区优先级（manual > name > ip）与按 IP 地区入组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-geo-app-'));
  const geoDir = join(dir, 'geo');
  compileGeoFromCsv(geoDir, {
    countryV4: FIXTURE_COUNTRY_V4,
    countryV6: FIXTURE_COUNTRY_V6,
    asnV4: FIXTURE_ASN_V4,
    asnV6: FIXTURE_ASN_V6,
  });

  const geo = createGeoService(geoDir, {
    resolver: async (host) => {
      if (host === 'unnamed-jp.example.com') return ['198.51.100.88'];
      if (host === 'conflict.example.com') return ['8.8.8.8', '198.51.100.88'];
      return [];
    },
  });

  const store = openStore(':memory:', 'unit-test-secret-0123456789abcdef');
  const app = createApp({
    store,
    adminToken: 'test-admin-token',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    geoService: geo,
  });

  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
    };

    const statusRes = await fetch(`${base}/api/geo/status`, { headers });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { available: boolean; counts: { countryV4: number } };
    assert.equal(statusJson.available, true);
    assert.equal(statusJson.counts.countryV4, 4);

    // 写入 4 个节点：无地区名的域名节点、无地区名的 UK IPv4 节点、有名字的域名节点（应走 name 覆盖 IP）、多 IP 冲突节点
    const payload = [
      'ss://YWVzLTI1Ni1nY206cGFzcw==@unnamed-jp.example.com:8388#Edge-Alpha',
      'ss://YWVzLTI1Ni1nY206cGFzcw==@185.86.0.10:8388#Node-Beta-1',
      'ss://YWVzLTI1Ni1nY206cGFzcw==@unnamed-jp.example.com:8389#%E6%96%B0%E5%8A%A0%E5%9D%A1%2001',
      'ss://YWVzLTI1Ni1nY206cGFzcw==@conflict.example.com:8388#Multi-Exit',
    ].join('\n');

    await fetch(`${base}/api/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'src-geo', kind: 'inline', content: payload, profile: 'default' }),
    });

    // 手动把 Node-Beta-1 覆盖为 DE（测试 manual > ip）
    const firstNodesRes = await fetch(`${base}/api/nodes?profile=default`, { headers });
    assert.equal(firstNodesRes.status, 200);
    const firstBody = (await firstNodesRes.json()) as {
      nodes: { nodeKey: string; name: string; geo?: { country?: string; asn?: number; org?: string; source?: string; conflict?: boolean } }[];
    };

    const ukRelay = firstBody.nodes.find((n) => n.name === 'Node-Beta-1')!;
    assert.equal(ukRelay.geo?.country, 'UK');
    assert.equal(ukRelay.geo?.source, 'ip');

    await fetch(`${base}/api/annotations?profile=default`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ nodeKey: ukRelay.nodeKey, region: 'DE' }),
    });

    const nodesRes = await fetch(`${base}/api/nodes?profile=default`, { headers });
    const body = (await nodesRes.json()) as typeof firstBody;

    const byName = new Map(body.nodes.map((n) => [n.name, n]));
    // 1) 无地名域名节点：由 IP 识别成 JP + ASN
    assert.deepEqual(byName.get('Edge-Alpha')?.geo, {
      country: 'JP',
      asn: 2516,
      org: 'KDDI CORPORATION',
      source: 'ip',
    });
    // 2) 手动覆盖：DE 胜过 IP 的 UK
    assert.equal(byName.get('Node-Beta-1')?.geo?.country, 'DE');
    assert.equal(byName.get('Node-Beta-1')?.geo?.source, 'manual');
    // 3) 节点名优先级高于 IP：节点名带「新加坡」且 IP 在 JP -> SG (name)，仍附带 ASN
    assert.deepEqual(byName.get('新加坡 01')?.geo, {
      country: 'SG',
      asn: 2516,
      org: 'KDDI CORPORATION',
      source: 'name',
    });
    // 4) 多 IP 冲突节点：country 置空且 conflict=true
    assert.equal(byName.get('Multi-Exit')?.geo?.country, undefined);
    assert.equal(byName.get('Multi-Exit')?.geo?.conflict, true);

    // 5) 缓存预热后，策略组按 region=JP 筛选能命中无地名的 Edge-Alpha
    const pgRes = await fetch(`${base}/api/policy-groups?profile=default`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'replace',
        groups: [{ name: 'JP-Auto', strategy: 'select', members: [{ kind: 'region', code: 'JP' }] }],
      }),
    });
    assert.equal(pgRes.status, 200);
    const previewRes = await fetch(`${base}/api/preview?target=surge&profile=default`, { headers });
    const previewText = await previewRes.text();
    assert.equal(previewRes.status, 200, previewText);
    const previewJson = JSON.parse(previewText) as { content: string };
    assert.match(previewJson.content, /JP-Auto = select, Edge-Alpha/);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
