/**
 * 前端绑定完整性闸门。
 *
 * 背景：`tsconfig.json` 的 include 只覆盖 src/scripts/tests，`web/**` 从来没过过类型检查，
 * 于是「模板里用了没导入的名字」这类错误一路绿灯进到构建产物，只能在浏览器控制台暴露
 * （历史上踩过两次：SourcesView 的 formatDuration、PublishView 的 saveProfile）。
 *
 * 这里跑完整的 vue-tsc，但只对「名字解析不出来」这一类信号失败：
 *   - TS2304 / TS2552：脚本作用域里引用了不存在的名字
 *   - TS2339 + ComponentPublicInstance：模板里引用了 setup 未暴露的绑定
 * 其余类型噪音（Naive UI 的 v-model:value 位置映射等）不计入失败，避免闸门被噪音淹没。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_TARGETS } from '../src/core/targets.ts';
import { CLIENT_ICON_IDS } from '../web/src/client-icons.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const vueTsc = fileURLToPath(new URL('../node_modules/vue-tsc/bin/vue-tsc.js', import.meta.url));

/** 注册表与图标表必须同步：新增客户端漏配图标时，先在这里失败，别让灰色占位徽标混进界面。 */
const iconIds = new Set<string>(CLIENT_ICON_IDS);
const targetIds: readonly string[] = CLIENT_TARGETS;
const targetSet = new Set<string>(targetIds);
assert.deepEqual(
  targetIds.filter((id) => !iconIds.has(id)),
  [],
  '客户端缺少图标：请同步 web/src/client-icons.ts',
);
assert.deepEqual(
  CLIENT_ICON_IDS.filter((id) => !targetSet.has(id)),
  [],
  '图标表存在已下线的客户端：请同步 web/src/client-icons.ts',
);

const result = spawnSync(process.execPath, [vueTsc, '--noEmit', '-p', 'web/tsconfig.json', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
});

if (result.error !== undefined) {
  console.error(`无法运行 vue-tsc：${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const lines = output.split('\n').filter((line) => line.includes('error TS'));

const MISSING_NAME = /error (?:TS2304|TS2552)\b|error TS2339: Property '\S+' does not exist on type 'ComponentPublicInstance/;
const failures = lines.filter((line) => MISSING_NAME.test(line));

if (failures.length > 0) {
  console.error('前端存在未解析的绑定：');
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`UI_BINDINGS_OK checked=${lines.length} unresolved=0`);
