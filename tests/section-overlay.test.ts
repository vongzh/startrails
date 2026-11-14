import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProfile, plan, emit } from '../src/core/index.ts';
import { alignInheritedMembers, applyDnsOverlay, applyGroupOverlay, applyRuleOverlay } from '../src/server/section-overlay.ts';
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
