import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_VERSION } from '../src/core/version.ts';
import { openStore } from '../src/store/sqlite.ts';

/** 备份恢复演练：写满配置态五类数据 → VACUUM INTO 快照 → 从快照重开并逐项比对。 */
const dir = mkdtempSync(join(tmpdir(), 'startrails-drill-'));
try {
  const live = openStore(join(dir, 'live.db'), 'drill-secret');
  live.putSource({ id: 'a', name: '机场 A', kind: 'file', enabled: true });
  live.writeSourcePayload('a', 'ss://YWVzLTI1Ni1nY206c2VjcmV0@ss.example.invalid:443#A');
  live.putProfile({ id: 'default', name: 'default', entries: [{ kind: 'source', id: 'a' }] });
  live.putCollection({
    id: 'c1',
    name: '合并',
    members: [{ sourceId: 'a', filter: { prefix: 'A-', exclude: ['过期'] } }],
    dedupe: 'nodeKey',
    order: 0,
  });
  live.putAnnotation('default', { nodeKey: 'k1', excluded: true, alias: 'Renamed', order: 2 });
  live.replaceRules('default', [{ condition: { type: 'domain', value: 'ad.com' }, policy: 'REJECT' }]);
  live.replaceGroupOverrides('default', [{ name: 'PROXY', members: ['A', 'B'], order: 0 }]);
  // 台账令牌连明文一起加密落库：恢复后必须还能还原出链接，这是台账存在的意义。
  live.createToken({
    id: 't1',
    tokenHash: 'hash-t1',
    token: 'plain-t1-token',
    profile: 'default',
    target: 'surge',
    revoked: false,
    createdAt: '2026-11-14T00:00:00.000Z',
  });

  const backupPath = join(dir, 'backup', 'snapshot.db');
  await live.backup(backupPath);
  const restored = openStore(backupPath, 'drill-secret');

  assert.deepEqual(restored.listSources(), live.listSources(), '订阅源元数据');
  assert.deepEqual(restored.listCollections(), live.listCollections(), '组合订阅定义');
  assert.deepEqual(restored.listProfiles(), live.listProfiles(), 'Profile 构成');
  assert.equal(restored.readSourcePayload('a'), live.readSourcePayload('a'), '文件 / 粘贴源正文');
  assert.deepEqual(restored.listAnnotations('default'), live.listAnnotations('default'), 'Annotation');
  assert.deepEqual(restored.listRules('default'), live.listRules('default'), '内联规则');
  assert.deepEqual(restored.listGroupOverrides('default'), live.listGroupOverrides('default'), '策略组覆盖');
  assert.deepEqual(restored.listTokens(), live.listTokens(), '订阅地址台账（token_secret 重加密后可还原）');

  // 改名级联是新接口，顺手在恢复出来的库上验一遍行为。
  assert.equal(restored.renameTokenProfile('default', 'renamed'), 1, '改名级联改写 1 条');
  assert.equal(restored.findTokenByHash('hash-t1')?.profile, 'renamed', '令牌归属跟着新配置名');

  restored.close();
  live.close();
  // tables 数的是参与比对的表：上面 8 组断言各对应一张配置态表。
  console.log(`BACKUP_DRILL_OK core=${CORE_VERSION} tables=8`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
