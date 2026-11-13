import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const extract = (source: string, name: string): string => {
  const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source);
  assert.ok(match !== null, `找不到 ${name}`);
  return match[1] ?? '';
};

const core = extract(read('src/core/version.ts'), 'CORE_VERSION');
const ui = extract(read('web/src/version.ts'), 'UI_CORE_VERSION');
const pkg = JSON.parse(read('package.json')) as { version: string };

assert.equal(core, pkg.version, 'src/core/version.ts 与 package.json 版本不一致');
assert.equal(ui, core, 'web/src/version.ts 与内核版本不一致；前端需同步升级');
console.log(`VERSION_CONSISTENCY_OK core=${core} ui=${ui} package=${pkg.version}`);
