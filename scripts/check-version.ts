import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_VERSION } from '../src/core/version.ts';
import { UI_CORE_VERSION } from '../web/src/version.ts';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };

assert.ok(pkg.version.length > 0, 'package.json version 不能为空');
assert.equal(CORE_VERSION, pkg.version, 'src/core/version.ts 与 package.json 版本不一致');
assert.equal(UI_CORE_VERSION, CORE_VERSION, 'web/src/version.ts 与内核版本不一致');
console.log(`VERSION_CONSISTENCY_OK core=${CORE_VERSION} ui=${UI_CORE_VERSION} package=${pkg.version}`);
