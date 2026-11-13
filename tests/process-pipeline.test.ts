import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMemberFilter,
  compileLegacyFilter,
  isUselessNode,
  regionOf,
  regionOfNode,
} from '../src/core/collections/index.ts';
import { ingest } from '../src/core/index.ts';
import { applyAnnotations } from '../src/core/process/index.ts';
import { nodeKey } from '../src/core/ir/index.ts';

const nodesOf = (...uris: string[]) => ingest(uris.join('\n')).profile.nodes;

const names = (nodes: readonly { name: string }[]): string[] => nodes.map((node) => node.name);

/** 同一台服务器、同一凭据 → nodeKey 相同；名字可不同，用来验证「按名字去重」与「按 nodeKey 去重」的差异。 */
const twin = (name: string) =>
  `ss://YWVzLTEyOC1nY206cHc@hk.example.invalid:8388#${encodeURIComponent(name)}`;
const other = (name: string, port: number) =>
  `ss://YWVzLTEyOC1nY206cHc@jp.example.invalid:${port}#${encodeURIComponent(name)}`;

test('算子链顺序即语义：先去重再改名 ≠ 先改名再去重', () => {
  const nodes = nodesOf(twin('HK 01'), twin('HK 01'), other('JP 01', 9001));
  assert.equal(nodes.length, 3);

  const dedupeFirst = applyMemberFilter(
    nodes,
    {
      process: [
        { type: 'dedupe', strategy: 'name' },
        { type: 'rename', template: '{index}-{name}' },
      ],
    },
    's1',
  );
  const renameFirst = applyMemberFilter(
    nodes,
    {
      process: [
        { type: 'rename', template: '{index}-{name}' },
        { type: 'dedupe', strategy: 'name' },
      ],
    },
    's1',
  );

  assert.deepEqual(names(dedupeFirst.nodes), ['1-HK 01', '2-JP 01']);
  assert.deepEqual(
    names(renameFirst.nodes),
    ['1-HK 01', '2-HK 01', '3-JP 01'],
    '改名之后名字不再重复，去重就拦不住——这正是旧「固定顺序」表达不了的需求',
  );
});

test('机场信息节点默认剔除，并报出剔除了几个', () => {
  const nodes = nodesOf(twin('香港 01'), twin('剩余流量：12GB'), other('到期时间：2027-01-01', 9002));
  assert.equal(nodes.length, 3);

  const outcome = applyMemberFilter(nodes, { process: [{ type: 'prefix', value: 'X-' }] }, 's1');
  assert.deepEqual(names(outcome.nodes), ['X-香港 01']);
  assert.ok(
    outcome.diagnostics.some((item) => item.reason === 'useless-dropped:2'),
    `应当报出剔除了 2 个，实际：${JSON.stringify(outcome.diagnostics.map((item) => item.reason))}`,
  );

  // 想保留就显式关掉。
  const kept = applyMemberFilter(
    nodes,
    { process: [{ type: 'filter', by: 'useless', keep: true }] },
    's1',
  );
  assert.equal(kept.nodes.length, 3);
});

test('凭据含非 ASCII 的节点也算无效（必然握手失败）', () => {
  const node = nodesOf(`ss://YWVzLTEyOC1nY2065a+G56CB@hk.example.invalid:8388#Normal`)[0];
  assert.ok(node !== undefined);
  assert.equal(isUselessNode(node), true);
});

test('地区识别：中文 / IATA / 国家码都能认，认不出就不猜', () => {
  assert.equal(regionOf('香港 01'), 'HK');
  assert.equal(regionOf('HKG-01'), 'HK');
  assert.equal(regionOf('HK-01'), 'HK');
  assert.equal(regionOf('中国台湾 01'), 'TW');
  assert.equal(regionOf('日本 东京'), 'JP');
  assert.equal(regionOf('US Los Angeles'), 'US');
  assert.equal(regionOf('Australia Sydney'), undefined, 'Australia 里的 us 不能被当成美国');
  assert.equal(regionOf('节点 A'), undefined);
});

test('手动改地区：Annotation.region 覆盖名字推断，并参与筛选与排序', () => {
  // 名字含独立词 US，会被按名字判成美国；但实际是新加坡节点，手动覆盖为 SG。
  const node = nodesOf(`ss://YWVzLTEyOC1nY206cHc@sg.example.invalid:8388#${encodeURIComponent('US Relay 01')}`)[0];
  assert.ok(node !== undefined);
  assert.equal(regionOfNode(node), 'US', '覆盖前按名字判成美国');

  const applied = applyAnnotations([{ nodeKey: nodeKey(node), region: 'SG' }])({ ...ingest('').profile, nodes: [node] }, { configVersion: 't' });
  const overridden = applied.profile.nodes[0];
  assert.ok(overridden !== undefined);
  assert.equal(regionOfNode(overridden), 'SG', '覆盖后应读手动值');

  // 覆盖值要能进地区筛选：filter by region keep:true 只留 SG。
  const filtered = applyMemberFilter(
    [overridden],
    { process: [{ type: 'filter', by: 'region', keep: true, value: ['SG'] }] },
    's1',
  );
  assert.equal(filtered.nodes.length, 1, '覆盖为 SG 后应能被 SG 筛选命中');

  // 清除覆盖（region=''）后回退名字推断。
  const cleared = applyAnnotations([{ nodeKey: nodeKey(node), region: '' }])({ ...ingest('').profile, nodes: [node] }, { configVersion: 't' });
  assert.equal(regionOfNode(cleared.profile.nodes[0]!), 'US', '清除覆盖后回退名字推断');
});

test('按地区 / 协议筛选，并给出可读计数', () => {
  const nodes = nodesOf(twin('香港 01'), other('日本 01', 9003), other('美国 01', 9004));

  const onlyHk = applyMemberFilter(
    nodes,
    { process: [{ type: 'filter', by: 'region', keep: true, value: ['HK'] }] },
    's1',
  );
  assert.deepEqual(names(onlyHk.nodes), ['香港 01']);
  assert.ok(onlyHk.diagnostics.some((item) => item.reason === 'region-filter:1/3'));

  const dropJp = applyMemberFilter(
    nodes,
    { process: [{ type: 'filter', by: 'region', keep: false, value: ['JP'] }] },
    's1',
  );
  assert.deepEqual(names(dropJp.nodes), ['香港 01', '美国 01']);

  const ssOnly = applyMemberFilter(
    nodes,
    { process: [{ type: 'filter', by: 'type', keep: true, value: ['shadowsocks'] }] },
    's1',
  );
  assert.equal(ssOnly.nodes.length, 3);
});

test('排序按地区把可识别地区的节点提前', () => {
  const nodes = nodesOf(other('未知 01', 9005), twin('香港 01'), other('日本 01', 9006));
  const sorted = applyMemberFilter(
    nodes,
    { process: [{ type: 'sort', by: 'region', order: 'asc' }] },
    's1',
  );
  assert.deepEqual(names(sorted.nodes), ['香港 01', '日本 01', '未知 01']);
});

test('旧字段被编译成等价链，行为与旧实现一致（无需迁移脚本）', () => {
  const nodes = nodesOf(twin('香港 01'), twin('日本 01'), other('香港 02', 9007));
  const legacy = { exclude: ['日本'], include: ['香港'], rename: '[{index}]{name}', limit: 1 };
  assert.deepEqual(compileLegacyFilter(legacy), [
    { type: 'filter', by: 'regex', keep: false, value: ['日本'] },
    { type: 'filter', by: 'regex', keep: true, value: ['香港'] },
    { type: 'rename', template: '[{index}]{name}' },
    { type: 'limit', count: 1 },
  ]);

  const viaLegacy = applyMemberFilter(nodes, legacy, 's1');
  const viaChain = applyMemberFilter(
    nodes,
    {
      process: [
        { type: 'filter', by: 'regex', keep: false, value: ['日本'] },
        { type: 'filter', by: 'regex', keep: true, value: ['香港'] },
        { type: 'rename', template: '[{index}]{name}' },
        { type: 'limit', count: 1 },
      ],
    },
    's1',
  );
  assert.deepEqual(names(viaLegacy.nodes), ['[1]香港 01']);
  assert.deepEqual(names(viaChain.nodes), names(viaLegacy.nodes));
});

test('成员停用优先于整条链：一个节点都不留', () => {
  const nodes = nodesOf(twin('香港 01'), other('日本 01', 9008));
  const outcome = applyMemberFilter(
    nodes,
    { enabled: false, process: [{ type: 'sort', by: 'name', order: 'asc' }] },
    's1',
  );
  assert.equal(outcome.nodes.length, 0);
  assert.equal(outcome.diagnostics[0]?.reason, 'member-disabled');
});

test('坏正则只记诊断，不中断整条链', () => {
  const nodes = nodesOf(twin('香港 01'));
  const outcome = applyMemberFilter(
    nodes,
    {
      process: [
        { type: 'filter', by: 'regex', keep: true, value: ['/(unclosed/'] },
        { type: 'prefix', value: 'A-' },
      ],
    },
    's1',
  );
  // 正则编译失败 → 匹配不到任何节点 → 全部被筛掉；但链继续跑完，诊断里有据可查。
  assert.equal(outcome.nodes.length, 0);
  assert.ok(outcome.diagnostics.some((item) => item.reason.startsWith('invalid-regex-pattern:')));
});

test('set-property / flag 声明式算子：改属性进 options，标记 toggle 进名字', () => {
  const node = nodesOf(`ss://YWVzLTEyOC1nY206cHc@hk.example.invalid:8388#HK-01`)[0];
  assert.ok(node !== undefined);

  // set-property udp / skip-cert-verify / alpn 映射到 options。
  const setProps = applyMemberFilter(
    [node],
    {
      process: [
        { type: 'set-property', key: 'udp', value: true },
        { type: 'set-property', key: 'skip-cert-verify', value: true },
        { type: 'set-property', key: 'alpn', value: 'h2,http/1.1' },
      ],
    },
    's1',
  );
  const changed = setProps.nodes[0];
  assert.ok(changed !== undefined);
  assert.equal(changed.options?.udp, true);
  assert.equal(changed.options?.insecure, true);
  assert.deepEqual(changed.options?.alpn, ['h2', 'http/1.1']);

  // flag：追加标记，再次执行则移除（toggle）。
  const flagged = applyMemberFilter([node], { process: [{ type: 'flag', value: '|机场A' }] }, 's1');
  assert.equal(flagged.nodes[0]?.name, 'HK-01 |机场A');
  const unflagged = applyMemberFilter(flagged.nodes, { process: [{ type: 'flag', value: '|机场A' }] }, 's1');
  assert.equal(unflagged.nodes[0]?.name, 'HK-01', 'flag 应可 toggle 移除');
});
