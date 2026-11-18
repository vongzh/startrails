import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProfile, plan, emit } from '../src/core/index.ts';
import { BuildCache } from '../src/server/build-cache.ts';
import { createBuilder } from '../src/server/builder.ts';
import { SnapshotCache } from '../src/server/cache.ts';
import { createNotifier } from '../src/server/notify.ts';
import { RuleSetCache } from '../src/server/ruleset.ts';
import { alignInheritedMembers, applyDnsOverlay, applyGroupOverlay, applyRuleOverlay } from '../src/server/section-overlay.ts';
import { openStore } from '../src/store/sqlite.ts';
import type { PersistedGroupOverride, StoredRule } from '../src/store/port.ts';

test('匹配成员按当前节点展开，引用保留组名和内置策略', () => {
  const nodes = parseProfile({
    nodes: [
      {
        kind: 'trojan',
        name: 'USA 1',
        server: 'a.example',
        port: 443,
        password: 'secret',
      },
      {
        kind: 'trojan',
        name: 'Japan 1',
        server: 'b.example',
        port: 443,
        password: 'secret',
      },
    ],
    ruleSources: [],
    policyGroups: [],
  }).nodes;
  const groups: PersistedGroupOverride[] = [
    {
      name: '美国',
      order: 0,
      strategy: 'url-test',
      testUrl: 'https://www.gstatic.com/generate_204',
      interval: 300,
      members: [{ kind: 'match', pattern: '/USA/i' }, 'DIRECT'],
    },
    {
      name: '日常',
      order: 1,
      members: [{ kind: 'ref', name: '美国' }, 'REJECT'],
    },
  ];
  const applied = applyGroupOverlay([], groups, nodes, 'replace');
  assert.deepEqual(applied[0]?.members, ['USA 1', 'DIRECT']);
  assert.equal(applied[0]?.strategy, 'url-test');
  assert.deepEqual(applied[1]?.members, ['美国', 'REJECT']);
});

test('其余节点只收没被其他组点名的节点，改名后继承成员跟着新名字', () => {
  const nodes = parseProfile({
    nodes: [
      { kind: 'trojan', name: 'USA 1', server: 'a.example', port: 443, password: 'secret' },
      { kind: 'trojan', name: 'France 1', server: 'b.example', port: 443, password: 'secret' },
    ],
    ruleSources: [],
    policyGroups: [{ name: '订阅组', members: ['USA 1', 'France 1'] }],
  }).nodes;
  const applied = applyGroupOverlay(
    [],
    [
      {
        name: '美国',
        order: 0,
        members: [{ kind: 'match', pattern: '/USA/' }],
      },
      {
        name: '其他',
        order: 1,
        members: [{ kind: 'rest' }],
      },
    ],
    nodes,
    'replace',
  );
  assert.deepEqual(applied[0]?.members, ['USA 1']);
  assert.deepEqual(applied[1]?.members, ['France 1']);

  const renamed = nodes.map((node) => (node.name === 'USA 1' ? { ...node, name: '美国 1' } : node));
  const aligned = alignInheritedMembers([{ name: '订阅组', members: ['USA 1', 'France 1'] }], nodes, renamed);
  assert.deepEqual(aligned[0]?.members, ['美国 1', 'France 1']);
});

test('规则替换丢掉订阅规则，兜底留在最后；组合时用户兜底换掉底稿', () => {
  const base = [
    {
      kind: 'inline' as const,
      rules: [
        { condition: { type: 'domain' as const, value: 'from-sub.example' }, policy: 'SUB' },
        { condition: { type: 'match' as const }, policy: 'SUB' },
      ],
    },
  ];
  const stored: StoredRule[] = [
    { condition: { type: 'geosite', value: 'cn' }, policy: 'DIRECT' },
    { kind: 'final', policy: 'Daily' },
  ];
  const replaced = applyRuleOverlay(base, stored, 'replace', 'after');
  const replacedPolicies = replaced.flatMap((source) =>
    source.kind === 'inline' ? source.rules.map((rule) => rule.policy) : [],
  );
  assert.deepEqual(replacedPolicies, ['DIRECT', 'Daily']);
  const merged = applyRuleOverlay(base, stored, 'merge', 'before');
  const policies = merged.flatMap((source) => (source.kind === 'inline' ? source.rules.map((rule) => rule.policy) : []));
  assert.deepEqual(policies, ['DIRECT', 'SUB', 'Daily']);
});

test('DNS 继承用订阅底稿，组合时同名解析器以用户为准，替换丢掉底稿', () => {
  const source = {
    dns: {
      mode: 'fake-ip' as const,
      nameserver: ['https://dns.alidns.com/dns-query'],
      nameserverPolicy: { '*.example.com': 'https://airport.example/dns-query', '*.mine.example': 'https://airport.example/dns-query' },
    },
  };
  const saved = {
    dns: {
      mode: 'fake-ip' as const,
      nameserverPolicy: { '*.mine.example': 'https://user.example/dns-query' },
    },
    tun: { enabled: true },
  };
  const inherited = applyDnsOverlay(source, { tun: { enabled: true } }, 'inherit');
  assert.equal(inherited?.dns?.nameserverPolicy?.['*.example.com'], 'https://airport.example/dns-query');
  assert.equal(inherited?.tun?.enabled, true);
  const merged = applyDnsOverlay(source, saved, 'merge');
  assert.equal(merged?.dns?.nameserver?.[0], 'https://dns.alidns.com/dns-query');
  assert.equal(merged?.dns?.nameserverPolicy?.['*.mine.example'], 'https://user.example/dns-query');
  assert.equal(merged?.dns?.nameserverPolicy?.['*.example.com'], 'https://airport.example/dns-query');
  const replaced = applyDnsOverlay(source, saved, 'replace');
  assert.equal(replaced?.dns?.nameserver, undefined);
  assert.equal(replaced?.dns?.nameserverPolicy?.['*.example.com'], undefined);
});

test('mihomo 写出测速组、GEOSITE 和按域名的解析器', () => {
  const profile = parseProfile({
    nodes: [
      { kind: 'trojan', name: 'USA 1', server: 'a.example', port: 443, password: 'secret' },
    ],
    ruleSources: [{ kind: 'inline', rules: [{ condition: { type: 'geosite', value: 'cn' }, policy: 'DIRECT' }] }],
    policyGroups: [
      {
        name: '美国',
        strategy: 'url-test',
        testUrl: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        lazy: true,
        hidden: true,
        members: ['USA 1'],
      },
    ],
    runtime: {
      dns: {
        mode: 'fake-ip',
        nameserver: ['https://dns.alidns.com/dns-query'],
        nameserverPolicy: { '*.example.com': 'https://dns.example/dns-query' },
      },
    },
  });
  const output = emit(profile, plan(profile, 'mihomo')).content;
  assert.match(output, /type: url-test/);
  assert.match(output, /hidden: true/);
  assert.match(output, /GEOSITE,cn,DIRECT/);
  assert.match(output, /nameserver-policy:/);
  assert.match(output, /"\*\.example\.com": https:\/\/dns\.example\/dns-query/);
  const surge = emit(profile, plan(profile, 'surge'));
  assert.ok(surge.diagnostics.some((item) => item.reason === 'group-strategy-not-expressible:url-test'));
  assert.match(surge.content, /= select,/);
});

test('组合模式保留订阅的 mihomo 高级 DNS 字段并合并 fallbackFilter', () => {
  const source = {
    dns: {
      mode: 'fake-ip' as const,
      nameserver: ['https://dns.alidns.com/dns-query'],
      defaultNameserver: ['223.5.5.5'],
      fakeIpFilter: ['*.lan', '*.local'],
      fallbackFilter: {
        geoip: true,
        geoipCode: 'CN',
        ipCidr: ['10.0.0.0/8'],
        domain: ['+.google.com'],
      },
      useHosts: false,
      useSystemHosts: true,
      respectRules: false,
    },
  };
  const saved = {
    dns: {
      mode: 'fake-ip' as const,
      nameserverPolicy: { '*.mine.example': 'https://user.example/dns-query' },
      fallbackFilter: {
        domain: ['+.youtube.com'],
      },
      respectRules: true,
    },
  };
  const merged = applyDnsOverlay(source, saved, 'merge');
  assert.deepEqual(merged?.dns?.defaultNameserver, ['223.5.5.5']);
  assert.deepEqual(merged?.dns?.fakeIpFilter, ['*.lan', '*.local']);
  assert.equal(merged?.dns?.useHosts, false);
  assert.equal(merged?.dns?.useSystemHosts, true);
  assert.equal(merged?.dns?.respectRules, true);
  assert.equal(merged?.dns?.fallbackFilter?.geoip, true);
  assert.equal(merged?.dns?.fallbackFilter?.geoipCode, 'CN');
  assert.deepEqual(merged?.dns?.fallbackFilter?.ipCidr, ['10.0.0.0/8']);
  assert.deepEqual(merged?.dns?.fallbackFilter?.domain, ['+.youtube.com']);
});

test('多订阅来源合成时合并各源的 nameserver-policy，同域名以先入源为准', () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-dns-merge-'));
  const store = openStore(join(dir, 'state.db'), 'dns-merge-secret');
  try {
    const subA = [
      'proxies:',
      '  - { name: A1, type: ss, server: a.example, port: 443, cipher: aes-128-gcm, password: p }',
      'dns:',
      '  enable: true',
      '  enhanced-mode: fake-ip',
      '  nameserver:',
      '    - https://dns.alidns.com/dns-query',
      '  nameserver-policy:',
      '    "*.shared.example": https://sub-a.example/dns-query',
      '    "*.only-a.example": https://sub-a.example/dns-query',
    ].join('\n');
    const subB = [
      'proxies:',
      '  - { name: B1, type: ss, server: b.example, port: 443, cipher: aes-128-gcm, password: p }',
      'dns:',
      '  enable: true',
      '  enhanced-mode: fake-ip',
      '  nameserver:',
      '    - https://doh.pub/dns-query',
      '  nameserver-policy:',
      '    "*.shared.example": https://sub-b.example/dns-query',
      '    "*.only-b.example": https://sub-b.example/dns-query',
    ].join('\n');
    store.putSource({ id: 'sub-a', name: 'A', kind: 'inline', enabled: true });
    store.writeSourcePayload('sub-a', subA);
    store.putSource({ id: 'sub-b', name: 'B', kind: 'inline', enabled: true });
    store.writeSourcePayload('sub-b', subB);
    store.putProfile({
      id: 'default',
      name: 'default',
      entries: [
        { kind: 'source', id: 'sub-a' },
        { kind: 'source', id: 'sub-b' },
      ],
    });
    const builder = createBuilder({
      store,
      cache: new SnapshotCache(join(dir, 'cache')),
      buildCache: new BuildCache(),
      ruleSets: new RuleSetCache(join(dir, 'rulesets'), undefined, true),
      notifier: createNotifier(() => undefined),
      allowPrivate: true,
    });
    const profile = builder.findProfile('default');
    assert.ok(profile !== undefined);
    const composed = builder.composeProfile(profile, [
      { id: 'sub-a', body: subA },
      { id: 'sub-b', body: subB },
    ]);
    assert.deepEqual(composed.profile.runtime?.dns?.nameserver, ['https://dns.alidns.com/dns-query']);
    assert.equal(composed.profile.runtime?.dns?.nameserverPolicy?.['*.shared.example'], 'https://sub-a.example/dns-query');
    assert.equal(composed.profile.runtime?.dns?.nameserverPolicy?.['*.only-a.example'], 'https://sub-a.example/dns-query');
    assert.equal(composed.profile.runtime?.dns?.nameserverPolicy?.['*.only-b.example'], 'https://sub-b.example/dns-query');
    assert.ok(composed.diagnostics.some((d) => d.subject === 'sub-b' && d.reason === 'dns-ignored'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
