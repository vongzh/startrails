import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProfile } from '../src/core/ir/validate.ts';
import { mapConcurrent } from '../src/server/async.ts';
import { BuildCache } from '../src/server/build-cache.ts';
import { parseProcesses } from '../src/server/input.ts';

test('mapConcurrent：有界并发且严格按输入顺序返回结果', async () => {
  assert.deepEqual(await mapConcurrent([], 4, async (x: number) => x), []);

  let active = 0;
  let peak = 0;
  const delays = [40, 10, 30, 5, 25, 15];
  const output = await mapConcurrent(delays, 2, async (ms, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, ms));
    active -= 1;
    return `${index}:${ms}`;
  });

  assert.ok(peak <= 2, `并发峰值不应超过 limit=2，实际为 ${peak}`);
  assert.deepEqual(output, ['0:40', '1:10', '2:30', '3:5', '4:25', '5:15']);
});

test('BuildCache：L3 命中时刷新 LRU 顺序，淘汰最久未用的条目', () => {
  const cache = new BuildCache(2);
  const p1 = parseProfile({ nodes: [], ruleSources: [], policyGroups: [] });
  const p2 = parseProfile({ nodes: [], ruleSources: [], policyGroups: [] });
  const p3 = parseProfile({ nodes: [], ruleSources: [], policyGroups: [] });

  cache.setL3('k1', p1);
  cache.setL3('k2', p2);
  // 访问 k1 使其成为最近使用；随后写入 k3 应淘汰 k2 而保留 k1。
  assert.equal(cache.getL3('k1'), p1);
  cache.setL3('k3', p3);

  assert.equal(cache.getL3('k1'), p1);
  assert.equal(cache.getL3('k2'), undefined);
  assert.equal(cache.getL3('k3'), p3);
});

test('parseProcesses：保留 set-property（含清空 alpn 的空串）与 flag 算子', () => {
  const steps = parseProcesses([
    { type: 'set-property', key: 'udp', value: true },
    { type: 'set-property', key: 'skip-cert-verify', value: false },
    { type: 'set-property', key: 'alpn', value: 'h2,http/1.1' },
    { type: 'set-property', key: 'alpn', value: '' },
    { type: 'flag', value: '|VIP' },
    { type: 'flag', value: '   ' },
    { type: 'set-property', key: 'unknown', value: true },
  ]);
  assert.deepEqual(steps, [
    { type: 'set-property', key: 'udp', value: true },
    { type: 'set-property', key: 'skip-cert-verify', value: false },
    { type: 'set-property', key: 'alpn', value: 'h2,http/1.1' },
    { type: 'set-property', key: 'alpn', value: '' },
    { type: 'flag', value: '|VIP' },
  ]);
});
