import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildReport, ingest } from '../src/core/index.ts';
import { CORE_VERSION } from '../src/core/version.ts';
import { BuildCache } from '../src/server/build-cache.ts';
import { openStore } from '../src/store/sqlite.ts';

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

test('版本一致性脚本：内核 / 前端 / package.json 三处对齐', () => {
  const output = execFileSync(process.execPath, [script('check-version.ts')], { encoding: 'utf8' });
  assert.match(output, /VERSION_CONSISTENCY_OK/);
  assert.match(output, new RegExp(CORE_VERSION.replace(/\./g, '\\.')));
});

test('备份恢复演练脚本可独立执行', () => {
  const output = execFileSync(process.execPath, [script('backup-drill.ts')], { encoding: 'utf8' });
  assert.match(output, /BACKUP_DRILL_OK/);
});

test('L2/L3 缓存命中与 LRU 上限', () => {
  const profile = ingest('{"nodes":[],"ruleSources":[],"policyGroups":[]}').profile;
  const report = buildReport('surge', [], 0, 0, 'build-1');
  const cache = new BuildCache(2);

  cache.setL2('etag-1', 'surge', { content: 'A', report, diagnostics: [] });
  assert.equal(cache.getL2('etag-1', 'surge')?.content, 'A');
  cache.setL2('etag-2', 'mihomo', { content: 'B', report, diagnostics: [] });
  cache.setL2('etag-3', 'sing-box', { content: 'C', report, diagnostics: [] });
  assert.equal(cache.getL2('etag-1', 'surge'), undefined, '超出上限应淘汰最久未用条目');

  cache.setL3('ir-1', profile);
  assert.equal(cache.getL3('ir-1'), profile);
  cache.clear();
  assert.equal(cache.getL3('ir-1'), undefined);
  assert.equal(cache.getL2('etag-2', 'mihomo'), undefined);
});

test('历史诊断保留策略：只保留最近 N 次构建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-prune-'));
  try {
    const store = openStore(join(dir, 'state.db'), 'prune-secret');
    for (let index = 0; index < 5; index += 1) {
      store.saveBuildReport({
        buildId: `build-${index}`,
        target: 'surge',
        report: buildReport('surge', [], 0, 0, `build-${index}`),
        createdAt: new Date(Date.now() + index * 1000).toISOString(),
      });
    }
    assert.equal(store.listBuildReports(10).length, 5);
    store.pruneBuildReports(2);
    assert.equal(store.listBuildReports(10).length, 2);
    assert.equal(store.getBuildReport('build-4')?.buildId, 'build-4');
    assert.equal(store.getBuildReport('build-0'), undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
