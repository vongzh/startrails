import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CLIENT_TARGETS,
  DIALECTS,
  TARGETS,
  assertNever,
  deepFreeze,
  descriptorOf,
  dialectOf,
  emit,
  emitters,
  ingest,
  plan,
  unverifiedCapabilityTables,
} from '../src/core/index.ts';

const fixture = readFileSync(
  new URL('../testdata/fixtures/minimal.json', import.meta.url),
  'utf8',
);
const { profile } = ingest(fixture);

test('IR 经 zod 校验后深层冻结，运行时不可改写', () => {
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.nodes));
  assert.ok(Object.isFrozen(profile.nodes[0]));
  assert.ok(Object.isFrozen(profile.nodes[0]?.options));
  assert.throws(() => {
    (profile.nodes as unknown[]).push({ kind: 'vless' });
  }, TypeError);
  const nested = deepFreeze({ inner: { value: 1 } });
  assert.throws(() => {
    (nested.inner as { value: number }).value = 2;
  }, TypeError);
});

test('能力完全未核实时全部显式拒绝，不静默丢节点', () => {
  const emissionPlan = plan(profile, 'surge', unverifiedCapabilityTables);
  assert.equal(emissionPlan.items.length, profile.nodes.length);
  assert.ok(emissionPlan.items.every((item) => item.action === 'reject'));
  assert.ok(emissionPlan.diagnostics.every((d) => d.stage === 'plan'));
});

test('能力矩阵是数据：换表即换决策，代码不动', () => {
  const defaultPlan = plan(profile, 'mihomo');
  const unverifiedPlan = plan(profile, 'mihomo', unverifiedCapabilityTables);
  assert.equal(defaultPlan.items.filter((i) => i.action === 'reject').length, 0);
  assert.equal(unverifiedPlan.items.filter((i) => i.action === 'reject').length, profile.nodes.length);
});

test('Emit 是纯函数：不改写 IR，全部注册 Target 都能产出', () => {
  const before = JSON.stringify(profile);
  const contents = CLIENT_TARGETS.map((target) => {
    assert.equal(typeof emitters[dialectOf(target)], 'function');
    const result = emit(profile, plan(profile, target));
    assert.ok(result.content.length > 0, `${target} 输出为空`);
    // 诊断必须标注请求方身份，不能串成同方言的另一个客户端。
    assert.ok(
      result.diagnostics.every((d) => d.target === null || d.target === target),
      `${target} 的诊断标注了错误的 target`,
    );
    return result.content;
  });
  assert.equal(JSON.stringify(profile), before);
  assert.equal(contents.length, CLIENT_TARGETS.length);
  assert.ok(new Set(contents).size >= DIALECTS.length, '每种方言至少有一份不同输出');
});

test('注册表覆盖全部 Target：id 唯一、方言合法、依据非空', () => {
  assert.equal(new Set(TARGETS.map((item) => item.id)).size, CLIENT_TARGETS.length);
  for (const target of CLIENT_TARGETS) {
    const descriptor = descriptorOf(target);
    assert.ok(DIALECTS.includes(descriptor.dialect));
    assert.ok(descriptor.basis.startsWith('https://'), `${target} 缺官方依据`);
    assert.ok(descriptor.fileExtension.length > 0);
  }
});

test('加协议 / Target 时编译器列出遗漏处（assertNever 兜底）', () => {
  assert.throws(() => assertNever('unexpected' as never), /Unhandled variant/);
});

const coreRoot = fileURLToPath(new URL('../src/core/', import.meta.url));
const collect = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collect(path) : entry.name.endsWith('.ts') ? [path] : [];
  });

test('架构约束：src/core 零 IO、零 node: 内建依赖', () => {
  const files = collect(coreRoot);
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bfrom\s+['"]node:/, `${file} 引入了 node: 内建模块`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} 出现 fetch 调用`);
    assert.doesNotMatch(
      source,
      /\b(readFileSync|writeFileSync|createServer|execSync)\b/,
      `${file} 出现文件系统 / 进程 IO`,
    );
  }
});

test('架构约束：Plan 不硬编码任何目标客户端名', () => {
  const source = readFileSync(join(coreRoot, 'plan', 'index.ts'), 'utf8');
  for (const target of CLIENT_TARGETS) {
    assert.ok(!source.includes(`'${target}'`), `plan 中出现了 ${target} 字面量`);
  }
});
