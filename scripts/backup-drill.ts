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
  live.putAnnotation({ nodeKey: 'k1', excluded: true, alias: 'Renamed', order: 2 });
  live.replaceRules([{ condition: { type: 'domain', value: 'ad.com' }, policy: 'REJECT' }]);
  live.replaceGroupOverrides([{ name: 'PROXY', members: ['A', 'B'], order: 0 }]);

  const backupPath = join(dir, 'backup', 'snapshot.db');
  await live.backup(backupPath);
  const restored = openStore(backupPath, 'drill-secret');

  assert.deepEqual(restored.listSources(), live.listSources(), '订阅源元数据');
  assert.deepEqual(restored.listCollections(), live.listCollections(), '组合订阅定义');
  assert.deepEqual(restored.listProfiles(), live.listProfiles(), 'Profile 构成');
  assert.equal(restored.readSourcePayload('a'), live.readSourcePayload('a'), '文件 / 粘贴源正文');
  assert.deepEqual(restored.listAnnotations(), live.listAnnotations(), 'Annotation');
  assert.deepEqual(restored.listRules(), live.listRules(), '内联规则');
  assert.deepEqual(restored.listGroupOverrides(), live.listGroupOverrides(), '策略组覆盖');

  restored.close();
  live.close();
  console.log(`BACKUP_DRILL_OK core=${CORE_VERSION} tables=8`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
