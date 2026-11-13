import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMemberFilter,
  compileMatcher,
  composeCollection,
  dedupeNodes,
  inspectPatterns,
} from '../src/core/index.ts';
import type { CollectionSpec, ProxyNode } from '../src/core/index.ts';

const node = (name: string, server = 'a.example.invalid', port = 443): ProxyNode => ({
  kind: 'trojan',
  name,
  server,
  port,
  password: 'pw',
});

const nodes: readonly ProxyNode[] = [
  node('香港 01', 'hk1.example.invalid'),
  node('香港 02', 'hk2.example.invalid'),
  node('日本 01', 'jp1.example.invalid'),
  node('过期 试用', 'b.example.invalid'),
  node('香港 01', 'hk1.example.invalid'), // 完全重复
];

test('匹配语法三档：正则 / glob / 子串', () => {
  const regex = compileMatcher('/^香港/');
  assert.ok(regex?.test('香港 01'));
  assert.ok(!regex?.test('日本 01'));

  const glob = compileMatcher('*香港*');
  assert.ok(glob?.test('香港 01'));
  assert.ok(!glob?.test('日本 01'));

  const substring = compileMatcher('日本');
  assert.ok(substring?.test('日本 01'));
  assert.ok(!substring?.test('香港 01'));

  assert.equal(compileMatcher('/(unclosed/'), null, '坏正则返回 null 而不是抛错');
  assert.equal(compileMatcher('   '), null);
});

test('inspectPatterns 给出每条规则的命中数，坏规则单独标出', () => {
  const report = inspectPatterns(['香港', '/(bad/', '日本'], nodes);
  assert.deepEqual(
    report.map((item) => [item.pattern, item.valid, item.hits]),
    [
      ['香港', true, 3],
      ['/(bad/', false, 0],
      ['日本', true, 1],
    ],
  );
});

test('applyMemberFilter：exclude 优先于 include，前缀改名，limit 截断', () => {
  const outcome = applyMemberFilter(
    nodes,
    { include: ['香港'], exclude: ['过期'], prefix: 'HK-', limit: 2 },
    'src-1',
  );
  assert.deepEqual(
    outcome.nodes.map((item) => item.name),
    ['HK-香港 01', 'HK-香港 02'],
  );
  assert.ok(outcome.diagnostics.some((item) => item.reason.startsWith('filtered-out')));

  const disabled = applyMemberFilter(nodes, { enabled: false }, 'src-1');
  assert.equal(disabled.nodes.length, 0);
  assert.equal(disabled.diagnostics[0]?.reason, 'member-disabled');

  const noFilter = applyMemberFilter(nodes, undefined, 'src-1');
  assert.equal(noFilter.nodes, nodes, '未配置过滤时原样返回，不复制数组');
});

test('dedupeNodes 三策略', () => {
  assert.equal(dedupeNodes(nodes, 'nodeKey').nodes.length, 4, '完全相同的节点被合并');
  assert.equal(dedupeNodes(nodes, 'name').nodes.length, 4, '同名节点被合并');
  assert.equal(dedupeNodes(nodes, 'none').nodes.length, 5, 'none 完全不去重');
});

test('composeCollection：缺源只记诊断，成员顺序决定输出顺序', () => {
  const spec: CollectionSpec = {
    id: 'c1',
    name: '合并',
    dedupe: 'nodeKey',
    members: [
      { sourceId: 'a', filter: { prefix: 'A-' } },
      { sourceId: 'missing' },
      { sourceId: 'b', filter: { include: ['日本'] } },
    ],
  };
  const library = new Map<string, readonly ProxyNode[]>([
    ['a', [node('香港 01', 'a1.example.invalid'), node('香港 02', 'a2.example.invalid')]],
    ['b', [node('日本 01', 'b.example.invalid'), node('香港 09', 'b.example.invalid')]],
  ]);
  const outcome = composeCollection(spec, (id) => library.get(id));
  assert.deepEqual(
    outcome.nodes.map((item) => item.name),
    ['A-香港 01', 'A-香港 02', '日本 01'],
  );
  assert.ok(outcome.diagnostics.some((item) => item.reason === 'collection-member-missing'));
});

test('composeCollection：同一节点被两个成员带入时按 nodeKey 去重并留痕', () => {
  const spec: CollectionSpec = {
    id: 'c2',
    name: '重叠',
    members: [{ sourceId: 'a' }, { sourceId: 'b' }],
  };
  const shared = node('共用');
  const outcome = composeCollection(spec, (id) => (id === 'a' ? [shared] : [shared]));
  assert.equal(outcome.nodes.length, 1);
  assert.ok(outcome.diagnostics.some((item) => item.reason === 'duplicate-dropped:1'));
});
