import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SOURCE_FORMATS, detectFormat, ingest } from '../src/core/index.ts';

const read = (name: string): string =>
  readFileSync(new URL(`../testdata/fixtures/${name}`, import.meta.url), 'utf8');

test('五种来源格式都能识别', () => {
  assert.equal(detectFormat(read('minimal.json')), 'startrails-json');
  assert.equal(detectFormat(read('subscription.txt')), 'subscription-uri');
  assert.equal(detectFormat(read('clash.yaml')), 'clash-yaml');
  assert.equal(detectFormat(read('surge.conf')), 'surge-ini');
  assert.equal(detectFormat(read('singbox.json')), 'sing-box-json');
  assert.equal(SOURCE_FORMATS.length, 5);
});

test('订阅 URI：四种协议解析入 IR，不支持的行结构化跳过', () => {
  const result = ingest(read('subscription.txt'));
  assert.equal(result.format, 'subscription-uri');
  assert.equal(result.profile.nodes.length, 4);
  assert.equal(result.skipped, 1);
  assert.deepEqual(
    new Set(result.profile.nodes.map((node) => node.kind)),
    new Set(['vless', 'trojan', 'vmess', 'shadowsocks']),
  );
  assert.ok(result.diagnostics.some((d) => d.reason === 'invalid-proxy-uri'));
  const vless = result.profile.nodes.find((node) => node.kind === 'vless');
  assert.equal(vless?.options?.sni, 'vless.example.invalid');
  assert.equal(vless?.options?.flow, 'xtls-rprx-vision');
});

test('Clash YAML：测速组、有序规则和 DNS 进入底稿', () => {
  const raw = [
    'proxies:',
    '  - {name: USA 1, type: ss, server: a.example.invalid, port: 443, cipher: aes-256-gcm, password: pw}',
    'proxy-groups:',
    '  - {name: 自动选择, type: url-test, url: https://www.gstatic.com/generate_204, interval: 300, tolerance: 50, lazy: true, hidden: true, proxies: [USA 1]}',
    '  - {name: 负载, type: load-balance, proxies: [USA 1]}',
    'rule-providers:',
    '  ads: {type: http, behavior: domain, format: yaml, url: https://rules.example.invalid/ads.txt}',
    'rules:',
    '  - DOMAIN-SUFFIX,cn,DIRECT',
    '  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    '  - IP-CIDR6,fe80::/10,DIRECT,no-resolve',
    '  - GEOSITE,google,PROXY',
    '  - GEOIP,CN,DIRECT,no-resolve',
    '  - RULE-SET,ads,REJECT',
    '  - PROCESS-NAME,LINE.exe,PROXY',
    '  - MATCH,PROXY',
    'dns:',
    '  enable: true',
    '  ipv6: false',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    '  nameserver: ["https://dns.alidns.com/dns-query"]',
    "  nameserver-policy: {'*.example.com': https://dns.example/dns-query, 'a.com,b.com': https://dns.example/dns-query}",
  ].join('\n');
  const result = ingest(raw);
  const auto = result.profile.policyGroups[0];
  assert.equal(auto?.strategy, 'url-test');
  assert.equal(auto?.testUrl, 'https://www.gstatic.com/generate_204');
  assert.equal(auto?.interval, 300);
  assert.equal(auto?.tolerance, 50);
  assert.equal(auto?.lazy, true);
  assert.equal(auto?.hidden, true);
  assert.equal(result.profile.policyGroups[1]?.strategy, undefined);
  assert.ok(result.diagnostics.some((item) => item.reason === 'group-strategy-not-modelled:load-balance'));
  const inline = result.profile.ruleSources.filter((source) => source.kind === 'inline');
  const rules = inline.flatMap((source) => (source.kind === 'inline' ? source.rules : []));
  assert.deepEqual(
    rules.map((rule) => rule.condition.type),
    ['domainSuffix', 'ipCidr', 'ipCidr6', 'geosite', 'geoip', 'match'],
  );
  assert.equal(rules[1]?.condition.type === 'ipCidr' ? rules[1].condition.noResolve : false, true);
  assert.equal(rules.at(-1)?.policy, 'PROXY');
  const external = result.profile.ruleSources.find((source) => source.kind === 'external');
  assert.equal(external?.kind === 'external' ? external.encoding : undefined, 'yaml');
  assert.equal(external?.kind === 'external' ? external.policy : undefined, 'REJECT');
  assert.equal(result.profile.runtime?.dns?.mode, 'fake-ip');
  assert.equal(result.profile.runtime?.dns?.nameserverPolicy?.['*.example.com'], 'https://dns.example/dns-query');
  assert.equal(result.profile.runtime?.dns?.nameserverPolicy?.['a.com'], 'https://dns.example/dns-query');
  assert.equal(result.profile.runtime?.dns?.nameserverPolicy?.['b.com'], 'https://dns.example/dns-query');
  assert.ok(result.diagnostics.some((item) => item.reason === 'nameserver-policy-comma-key'));
  assert.ok(result.diagnostics.some((item) => item.reason === 'rule-not-modelled:PROCESS-NAME'));
});

test('Clash YAML：代理 / 策略组 / 外链规则集都进入 IR', () => {
  const result = ingest(read('clash.yaml'));
  assert.equal(result.format, 'clash-yaml');
  assert.equal(result.profile.nodes.length, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.profile.policyGroups[0]?.name, 'PROXY');
  assert.equal(result.profile.ruleSources[0]?.kind, 'external');
  assert.ok(result.diagnostics.some((d) => d.reason.startsWith('unsupported-or-incomplete')));
});

test('Surge / Loon INI：ss / vmess / trojan 都进 IR，是否可导出由能力表决定', () => {
  const result = ingest(read('surge.conf'));
  assert.equal(result.format, 'surge-ini');
  // 解析层只负责把行读进 IR；Trojan 在 Surge 侧仍因字段依据未核实被 Plan 拒绝。
  assert.equal(result.profile.nodes.length, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.profile.policyGroups[0]?.name, 'PROXY');
  assert.ok(result.profile.nodes.some((node) => node.kind === 'trojan'));
});

test('sing-box JSON：outbounds 与 selector 还原为节点与策略组', () => {
  const result = ingest(read('singbox.json'));
  assert.equal(result.format, 'sing-box-json');
  assert.equal(result.profile.nodes.length, 2);
  assert.equal(result.profile.policyGroups[0]?.name, 'PROXY');
  assert.equal(result.skipped, 0);
});

test('脏输入不会抛异常：给出空 Profile 与结构化诊断', () => {
  const broken = ingest('{ this is not json');
  assert.equal(broken.profile.nodes.length, 0);
  assert.ok(broken.diagnostics.length > 0);
  const unknown = ingest('this is not a subscription');
  assert.equal(unknown.profile.nodes.length, 0);
  assert.ok(unknown.diagnostics.length > 0);
});

test('每个解析出的 Profile 都被冻结', () => {
  for (const name of ['minimal.json', 'subscription.txt', 'clash.yaml', 'surge.conf', 'singbox.json']) {
    const result = ingest(read(name));
    assert.ok(Object.isFrozen(result.profile), name);
    assert.ok(Object.isFrozen(result.profile.nodes), name);
  }
});
