import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CAPABILITY_EVIDENCE, emit, plan } from '../src/core/index.ts';
import { ingest } from '../src/core/index.ts';

const fixture = readFileSync(new URL('../testdata/fixtures/minimal.json', import.meta.url), 'utf8');
const { profile } = ingest(fixture);

test('Surge 不支持 VLESS（官方手册未列），按显式拒绝 + 诊断', () => {
  const emissionPlan = plan(profile, 'surge');
  const vless = emissionPlan.items.find((item) => item.ref.startsWith('vless:'));
  assert.equal(vless?.action, 'reject');
  assert.equal(vless?.reason, 'protocol-unsupported');
  assert.ok(
    emissionPlan.diagnostics.some((d) => d.reason.includes('vless protocol-unsupported')),
  );
});

test('Surge Trojan 参数依据未核实，保持 unverified 并拒绝，不编造字段', () => {
  const emissionPlan = plan(profile, 'surge');
  const trojan = emissionPlan.items.find((item) => item.ref.startsWith('trojan:'));
  assert.equal(trojan?.reason, 'capability-unverified');
  assert.ok(CAPABILITY_EVIDENCE.some((e) => e.target === 'surge' && e.subject === 'trojan' && e.value === 'unverified'));
});

test('非认证级特性不足时降级：Plan 决策、Emit 表达，且每条降级可查', () => {
  // Egern 官方页未给出 alpn 字段，能力表标 unverified —— 典型「可降级」特性。
  const { profile: withAlpn } = ingest(
    JSON.stringify({
      nodes: [
        {
          kind: 'vless',
          name: 'Alpn Node',
          server: 'vless.example.invalid',
          port: 443,
          uuid: '00000000-0000-0000-0000-000000000000',
          options: { tls: true, sni: 'vless.example.invalid', alpn: ['h2', 'http/1.1'] },
        },
      ],
      ruleSources: [],
      policyGroups: [],
    }),
  );
  const emissionPlan = plan(withAlpn, 'egern');
  const downgraded = emissionPlan.items.filter((item) => item.action === 'downgrade');
  assert.equal(downgraded.length, 1);
  assert.deepEqual(downgraded[0]?.droppedFeatures, ['alpn']);
  assert.ok(
    emissionPlan.diagnostics.some((d) => d.reason.includes('feature-not-expressible:alpn')),
  );
  const content = emit(withAlpn, emissionPlan).content;
  assert.ok(!content.includes('alpn'));
  assert.ok(content.includes('user_id'));
});

test('认证级特性无法降级：reality 不被支持时拒绝节点而不是丢掉字段', () => {
  const { profile: withReality } = ingest(
    JSON.stringify({
      nodes: [
        {
          kind: 'vless',
          name: 'Reality Node',
          server: 'vless.example.invalid',
          port: 443,
          uuid: '00000000-0000-0000-0000-000000000000',
          options: {
            tls: true,
            sni: 'www.microsoft.com',
            reality: { publicKey: 'pubkey', shortId: 'abcd' },
          },
        },
      ],
      ruleSources: [],
      policyGroups: [],
    }),
  );
  // Quantumult X 的 sample.conf 未出现 reality 参数 → 必须拒绝，不能生成一个连不上的节点。
  const emissionPlan = plan(withReality, 'quanx');
  assert.equal(emissionPlan.items[0]?.action, 'reject');
  assert.equal(emissionPlan.items[0]?.reason, 'feature-required:reality');
  assert.ok(!emit(withReality, emissionPlan).content.includes('reality'));

  // mihomo 支持 reality-opts，同一节点应保留并写入对应字段。
  const mihomo = emit(withReality, plan(withReality, 'mihomo'));
  assert.match(mihomo.content, /reality-opts/);
  assert.match(mihomo.content, /public-key: pubkey/);
});

test('降级不改写 IR：所有节点对象与 options 保持冻结', () => {
  const before = JSON.stringify(profile);
  for (const target of ['surge', 'mihomo', 'sing-box'] as const) {
    const emissionPlan = plan(profile, target);
    emit(profile, emissionPlan);
    assert.equal(JSON.stringify(profile), before, target);
  }
  assert.ok(profile.nodes.every((node) => Object.isFrozen(node)));
});

test('外链规则集：能表达的方言不报警，表达不了的方言如实标注', () => {
  // Surge / mihomo 都有官方写法把远程规则集交给客户端（RULE-SET / rule-providers），
  // 这时候再说「不可判定」就是假警报——会让人以为规则集被丢了。
  assert.ok(
    !plan(profile, 'mihomo').diagnostics.some((d) => d.reason === 'external-ruleset-not-evaluable'),
  );
  assert.ok(
    !plan(profile, 'surge').diagnostics.some((d) => d.reason === 'external-ruleset-not-evaluable'),
  );
  // 其余方言没有取得官方依据，必须如实标注，而不是静默丢。
  for (const target of ['sing-box', 'loon', 'quanx', 'egern'] as const) {
    assert.ok(
      plan(profile, target).diagnostics.some((d) => d.reason === 'external-ruleset-not-evaluable'),
      target,
    );
  }
});
