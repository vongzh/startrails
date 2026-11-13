import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRule,
  ingest,
  emit,
  inferRuleSetShape,
  parseProfile,
  plan,
  renderRule,
  verifiedCapabilityTables,
} from '../src/core/index.ts';
import type { InlineRule } from '../src/core/index.ts';

const rules: InlineRule[] = [
  { condition: { type: 'domain', value: 'ad.example.invalid' }, policy: 'REJECT' },
  { condition: { type: 'domainSuffix', value: 'google.com' }, policy: 'PROXY' },
  { condition: { type: 'ipCidr', value: '10.0.0.0/8' }, policy: 'DIRECT' },
  {
    condition: {
      type: 'and',
      children: [
        { type: 'domain', value: 'x.example.invalid' },
        { type: 'ipCidr', value: '1.2.3.0/24' },
      ],
    },
    policy: 'PROXY',
  },
  {
    condition: { type: 'not', child: { type: 'domain', value: 'blocked.com' } },
    policy: 'DIRECT',
  },
];

const { profile } = ingest(
  JSON.stringify({ nodes: [], ruleSources: [{ kind: 'inline', rules }], policyGroups: [] }),
);

test('三维规则能力表：Surge 只收基本条件，mihomo 收逻辑树，sing-box 全不可判定', () => {
  const surge = plan(profile, 'surge');
  const mihomo = plan(profile, 'mihomo');
  const singBox = plan(profile, 'sing-box');
  assert.equal(surge.ruleItems.filter((item) => item.decision.accepted).length, 3);
  assert.equal(mihomo.ruleItems.filter((item) => item.decision.accepted).length, 5);
  assert.equal(singBox.ruleItems.filter((item) => item.decision.accepted).length, 0);
  assert.ok(
    surge.diagnostics.some((diagnostic) => diagnostic.reason.includes('rule-capability:unverified:and')),
  );
});

test('逻辑条件树递归判定：任一子节点不可表达即整条拒绝', () => {
  const table = verifiedCapabilityTables.rule;
  assert.equal(evaluateRule(rules[3]!.condition, 'mihomo', table).accepted, true);
  assert.equal(evaluateRule(rules[3]!.condition, 'surge', table).accepted, false);
});

test('规则渲染严格按官方写法，不编造 sing-box route 字段', () => {
  assert.equal(renderRule('surge', rules[0]!), 'DOMAIN,ad.example.invalid,REJECT');
  assert.equal(renderRule('mihomo', rules[2]!), 'IP-CIDR,10.0.0.0/8,DIRECT');
  assert.equal(
    renderRule('mihomo', rules[3]!),
    'AND,((DOMAIN,x.example.invalid),(IP-CIDR,1.2.3.0/24)),PROXY',
  );
  assert.equal(renderRule('mihomo', rules[4]!), 'NOT,((DOMAIN,blocked.com)),DIRECT');
  assert.equal(renderRule('sing-box', rules[0]!), null);
});

test('Emitter 输出 accepted 规则，且拒绝项带可查诊断', () => {
  const surge = plan(profile, 'surge');
  const surgeContent = emit(profile, surge).content;
  assert.match(surgeContent, /DOMAIN,ad\.example\.invalid,REJECT/);
  assert.match(surgeContent, /FINAL,DIRECT/);
  assert.doesNotMatch(surgeContent, /AND,\(\(/);

  const mihomo = plan(profile, 'mihomo');
  const mihomoContent = emit(profile, mihomo).content;
  assert.match(mihomoContent, /AND,\(\(DOMAIN,x\.example\.invalid\),\(IP-CIDR,1\.2\.3\.0\/24\)\),PROXY/);
  assert.match(mihomoContent, /MATCH,DIRECT/);
});

test('规则判定不改写 IR', () => {
  const before = JSON.stringify(profile);
  for (const target of ['surge', 'mihomo', 'sing-box'] as const) {
    emit(profile, plan(profile, target));
  }
  assert.equal(JSON.stringify(profile), before);
  assert.ok(Object.isFrozen(profile.ruleSources[0]));
});

/**
 * 规则集形态判定 + Clash `rule-providers` 输出。
 *
 * 这一组的关键不是「键写出来了」，而是**判不出来时不写**：
 * `behavior` 写错会让 mihomo 拒绝加载整份配置，那比少一条规则集严重得多。
 */
test('规则集形态判定：只有三种文件形状算「判得出来」，其余一律返回 undefined', () => {
  const domainList = ['# ACL4SSR', 'example.com', '+.google.com', '*.x.io', ''].join('\n');
  assert.equal(inferRuleSetShape(domainList), 'domain');

  const cidrList = ['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32'].join('\n');
  assert.equal(inferRuleSetShape(cidrList), 'ipcidr');

  const fullRules = ['IP-CIDR,1.2.3.0/24,no-resolve', 'DOMAIN-SUFFIX,x.com,PROXY'].join('\n');
  assert.equal(inferRuleSetShape(fullRules), 'rules');

  // Clash 的 YAML 包装没法用 format: text 表达，原样喂进去会被当成域名 `payload:`。
  assert.equal(inferRuleSetShape('payload:/n  - example.com'), undefined);
  // 一半域名一半 CIDR：单一 behavior 表达不了。
  assert.equal(inferRuleSetShape('example.com\n10.0.0.0/8'), undefined);
  // 二进制（.mrs / .srs）不是文本。
  assert.equal(inferRuleSetShape('mrs\u0000binary'), undefined);
  // 全是注释 = 没有内容。
  assert.equal(inferRuleSetShape('# only a comment'), undefined);
});

test('Clash 源声明的 behavior 直接映射成 shape，不需要再猜', () => {
  const clash = JSON.stringify({
    proxies: [],
    'proxy-groups': [],
    'rule-providers': {
      ads: { type: 'http', behavior: 'domain', url: 'https://rules.example.invalid/ads.list' },
      cidrs: { type: 'http', behavior: 'ipcidr', url: 'https://rules.example.invalid/cidr.list' },
      whole: { type: 'http', behavior: 'classical', url: 'https://rules.example.invalid/full.list' },
    },
    rules: ['RULE-SET,ads,REJECT', 'RULE-SET,cidrs,DIRECT', 'RULE-SET,whole,PROXY'],
  });
  const parsed = ingest(clash).profile;
  const shapes = parsed.ruleSources
    .filter((source) => source.kind === 'external')
    .map((source) => (source.kind === 'external' ? [source.policy, source.shape] : []));
  assert.deepEqual(shapes, [
    ['REJECT', 'domain'],
    ['DIRECT', 'ipcidr'],
    ['PROXY', 'rules'],
  ]);
});

test('mihomo 输出 rule-providers 与 RULE-SET 行，且 RULE-SET 排在 MATCH 之前', () => {
  const withProviders = parseProfile({
    nodes: [
      {
        kind: 'shadowsocks',
        name: 'HK',
        server: 'hk.example.invalid',
        port: 8388,
        method: 'aes-128-gcm',
        password: 'pw',
      },
    ],
    ruleSources: [
      { kind: 'inline', rules: [{ condition: { type: 'domain', value: 'a.com' }, policy: 'REJECT' }] },
      { kind: 'external', url: 'https://rules.example.invalid/ads.list', policy: 'REJECT', shape: 'domain' },
      { kind: 'external', url: 'https://rules.example.invalid/cidr.list', policy: 'DIRECT', shape: 'ipcidr' },
    ],
    policyGroups: [{ name: 'PROXY', members: ['HK'] }],
  });
  const result = emit(withProviders, plan(withProviders, 'mihomo'));
  const content = result.content;

  assert.match(content, /rule-providers:/);
  assert.match(content, /behavior: domain/);
  assert.match(content, /behavior: ipcidr/);
  assert.match(content, /format: text/);
  assert.match(content, /path: \.\/ruleset\/rs_[0-9a-f]{8}\.list/);
  // provider 名与 RULE-SET 行必须成对出现，否则规则集要么没被引用、要么指向不存在的 provider。
  const providerNames = [...content.matchAll(/^ {2}(rs_[0-9a-f]{8}):$/gm)].map((match) => match[1]);
  assert.equal(providerNames.length, 2);
  for (const name of providerNames) {
    assert.match(content, new RegExp(`RULE-SET,${name},`));
  }

  const lines = content.split('\n');
  const lastRuleSet = lines.reduce((acc, line, index) => (line.includes('RULE-SET,') ? index : acc), -1);
  const matchLine = lines.findIndex((line) => line.trim() === '- MATCH,DIRECT');
  assert.ok(lastRuleSet > 0 && matchLine > lastRuleSet, 'RULE-SET 必须在 MATCH 之前，否则永远查不到');
  assert.ok(result.diagnostics.every((item) => !item.reason.startsWith('external-ruleset-')));
});

test('形态未知或缺策略时不写 rule-providers，但留下能看懂的诊断', () => {
  const incomplete = parseProfile({
    nodes: [
      {
        kind: 'shadowsocks',
        name: 'HK',
        server: 'hk.example.invalid',
        port: 8388,
        method: 'aes-128-gcm',
        password: 'pw',
      },
    ],
    ruleSources: [
      // 有策略、不知道装什么 → behavior 猜不出来，不能写
      { kind: 'external', url: 'https://rules.example.invalid/unknown.list', policy: 'REJECT' },
      // 知道形态、没有策略 → RULE-SET 行写不出来
      { kind: 'external', url: 'https://rules.example.invalid/ads.list', shape: 'domain' },
    ],
    policyGroups: [{ name: 'PROXY', members: ['HK'] }],
  });
  const result = emit(incomplete, plan(incomplete, 'mihomo'));
  assert.doesNotMatch(result.content, /rule-providers:/);
  assert.doesNotMatch(result.content, /RULE-SET,/);
  const reasons = result.diagnostics.map((item) => item.reason);
  assert.ok(reasons.includes('external-ruleset-shape-unknown'));
  assert.ok(reasons.includes('external-ruleset-policy-missing'));
});
