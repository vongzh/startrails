import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CAPABILITY_EVIDENCE,
  CLIENT_TARGETS,
  DIALECTS,
  TARGETS,
  NODE_FEATURES,
  PROTOCOL_KINDS,
  RULE_CONDITION_KINDS,
  descriptorOf,
  dialectOf,
  emit,
  ingest,
  plan,
  renderRule,
  targetsOfDialect,
  verifiedCapabilityTables,
} from '../src/core/index.ts';
import type { ClientTarget } from '../src/core/index.ts';

const fixture = readFileSync(new URL('../testdata/fixtures/minimal.json', import.meta.url), 'utf8');
const { profile } = ingest(fixture);

const ruleProfile = ingest(
  JSON.stringify({
    nodes: [],
    ruleSources: [
      {
        kind: 'inline',
        rules: [
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
        ],
      },
    ],
    policyGroups: [],
  }),
).profile;

test('能力表按 19 个 Target × 全维度完整覆盖，无缺键', () => {
  const caps = verifiedCapabilityTables;
  for (const target of CLIENT_TARGETS) {
    for (const kind of PROTOCOL_KINDS) {
      assert.ok(caps.node[target][kind], `${target}/${kind}`);
    }
    for (const feature of NODE_FEATURES) {
      assert.ok(caps.feature[target][feature], `${target}/${feature}`);
    }
    for (const kind of RULE_CONDITION_KINDS) {
      assert.ok(caps.rule[target][kind], `${target}/${kind}`);
    }
    assert.ok(caps.output[target].format, `${target}/output`);
  }
});

test('格式族划分与 19 个 ClientTarget 清单一致', () => {
  assert.equal(CLIENT_TARGETS.length, 19);
  assert.equal(DIALECTS.length, 7);
  assert.equal(targetsOfDialect('surge-ini').length, 2);
  assert.equal(targetsOfDialect('clash-yaml').length, 9);
  assert.equal(targetsOfDialect('sing-box-json').length, 2);
  assert.equal(targetsOfDialect('uri-list').length, 3);
  for (const item of TARGETS) {
    assert.equal(dialectOf(item.id), item.dialect);
  }
});

test('新增方言都有官方依据记录，且未核实项显式存在', () => {
  for (const target of ['loon', 'quanx', 'egern', 'clash', 'v2box'] as ClientTarget[]) {
    assert.ok(
      CAPABILITY_EVIDENCE.some((e) => e.target === target && e.source.startsWith('https://')),
      `${target} 缺依据`,
    );
  }
  assert.ok(CAPABILITY_EVIDENCE.some((e) => e.value === 'unverified'));
  assert.equal(descriptorOf('shadowrocket').independentEvidence, false);
  assert.equal(descriptorOf('shadowrocket').contentMode, 'nodes-only');
});

test('Loon 输出 [Proxy] 官方行格式，四协议齐全，且不编造未核实的 Group/Rule', () => {
  const result = emit(profile, plan(profile, 'loon'));
  assert.match(result.content, /\[Proxy\]/);
  assert.match(result.content, /= Shadowsocks,ss\.example\.invalid,8388,/);
  assert.match(result.content, /= VMess,vmess\.example\.invalid,443,/);
  assert.match(result.content, /= VLESS,vless\.example\.invalid,443,/);
  assert.match(result.content, /= Trojan,trojan\.example\.invalid,443,/);
  assert.match(result.content, /\[Proxy Group\] \/ \[Rule\] syntax not verified/);
  assert.ok(
    result.diagnostics.some((d) => d.reason.includes('partial-config')),
    '必须标注为片段级配置',
  );
});

test('QuanX 输出官方 sample.conf 方言：server_local / policy / filter_local', () => {
  const result = emit(ruleProfile, plan(ruleProfile, 'quanx'));
  assert.match(result.content, /\[server_local\]/);
  assert.match(result.content, /\[policy\]/);
  assert.match(result.content, /\[filter_local\]/);
  assert.match(result.content, /host, ad\.example\.invalid, reject/);
  assert.match(result.content, /host-suffix, google\.com, proxy/);
  assert.match(result.content, /ip-cidr, 10\.0\.0\.0\/8, direct/);
  assert.match(result.content, /final, proxy/);
  assert.doesNotMatch(result.content, /AND,\(\(/, '逻辑规则不可表达，不得写入');
});

test('QuanX 节点行使用官方参数名，且策略与规则不在 IR 上原地改写', () => {
  const before = JSON.stringify(profile);
  const result = emit(profile, plan(profile, 'quanx'));
  assert.match(result.content, /shadowsocks=ss\.example\.invalid:8388, method=/);
  assert.match(result.content, /vmess=vmess\.example\.invalid:443, method=/);
  assert.match(result.content, /vless=vless\.example\.invalid:443, method=none/);
  assert.match(result.content, /trojan=trojan\.example\.invalid:443, password=/);
  assert.equal(JSON.stringify(profile), before);
});

test('Egern 输出多文档 YAML 片段，并显式标注未核实的完整配置结构', () => {
  const result = emit(profile, plan(profile, 'egern'));
  assert.match(result.content, /^---$/m);
  assert.match(result.content, /shadowsocks:/);
  assert.match(result.content, /user_id:/);
  assert.match(result.content, /security: auto/);
  assert.match(result.content, /Partial config/);
  assert.equal(result.content.split('\n---\n').length, profile.nodes.length + 1);
  assert.ok(result.diagnostics.some((d) => d.reason.includes('partial-config')));
});

test('URI 列表按已核实规范写出传输层与 TLS，未核实参数不得出现', () => {
  for (const target of ['shadowrocket', 'v2box', 'anywhere'] as ClientTarget[]) {
    const result = emit(profile, plan(profile, target));
    assert.match(result.content, /^ss:\/\//m, target);
    assert.match(result.content, /^vmess:\/\//m, target);
    assert.match(result.content, /^vless:\/\//m, target);
    assert.match(result.content, /^trojan:\/\//m, target);
    // 依据 Xray 分享链接规范 §4.2–4.4：TLS / SNI / 传输层必须写出，否则导入后连不上。
    assert.match(result.content, /vless:\/\/[^#]+\?encryption=none&flow=xtls-rprx-vision&security=tls&sni=/);
    assert.match(result.content, /trojan:\/\/[^#]+\?security=tls&sni=/);
    const vmessLine = result.content.split('\n').find((line) => line.startsWith('vmess://')) ?? '';
    const vmessPayload = JSON.parse(
      Buffer.from(vmessLine.slice('vmess://'.length), 'base64url').toString('utf8'),
    ) as Record<string, string>;
    assert.equal(vmessPayload['net'], 'ws', 'vmess 必须保留 ws 传输层');
    assert.equal(vmessPayload['tls'], 'tls', 'vmess 必须保留 TLS');
    assert.equal(vmessPayload['path'], '/ws');
    // alterId / udp / plugin 无已核实参数，绝不能凭猜测写进 query。
    assert.doesNotMatch(result.content, /alterId=|&udp=|&plugin=/);
    assert.ok(result.diagnostics.some((d) => d.reason.includes('nodes-only-export')));
  }
});

test('Stash 与 mihomo 同方言但能力不同：逻辑规则单独判 unverified', () => {
  const mihomo = plan(ruleProfile, 'mihomo');
  const stash = plan(ruleProfile, 'clash');
  assert.equal(mihomo.ruleItems.filter((i) => i.decision.accepted).length, 4);
  assert.equal(stash.ruleItems.filter((i) => i.decision.accepted).length, 3);
  assert.ok(stash.diagnostics.some((d) => d.reason.includes('rule-capability:unverified:and')));
});

test('同方言 Target 节点集一致，身份体现在头注释与诊断', () => {
  const surge = emit(profile, plan(profile, 'surge'));
  const surgeMac = emit(profile, plan(profile, 'surge-mac'));
  assert.match(surge.content, /for Surge$/m);
  assert.match(surgeMac.content, /for Surge Mac$/m);
  assert.equal(
    (surge.content.match(/^.+= (ss|vmess),/gm) ?? []).length,
    (surgeMac.content.match(/^.+= (ss|vmess),/gm) ?? []).length,
  );
  assert.ok(surgeMac.diagnostics.every((d) => d.target === null || d.target === 'surge-mac'));
});

test('renderRule 按方言分派：QuanX 小写、Loon/Egern/sing-box/URI 返回 null', () => {
  const rule = ruleProfile.ruleSources[0];
  assert.ok(rule && rule.kind === 'inline');
  const first = rule.rules[0];
  assert.ok(first);
  assert.equal(renderRule('quanx', first), 'host, ad.example.invalid, reject');
  for (const target of ['loon', 'egern', 'sing-box', 'v2box'] as ClientTarget[]) {
    assert.equal(renderRule(target, first), null, target);
  }
});
