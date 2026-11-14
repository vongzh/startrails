import assert from 'node:assert/strict';
import test from 'node:test';
import { initialOf } from '../web/src/format.ts';

test('initialOf 按完整码点取首字，不把 emoji 截成半个代理对', () => {
  assert.equal(initialOf('flyint'), 'f');
  assert.equal(initialOf('  魔戒  '), '魔');
  assert.equal(initialOf(''), '·');
  assert.equal(initialOf('   '), '·');

  // 源头像用这个名字首字做图标。slice(0, 1) 会得到孤立的高位代理 \uD83D，
  // 浏览器渲染成菱形替换字符 —— 看起来就是「图标坏了」。
  assert.equal(initialOf('🔶魔戒'), '🔶');
  assert.equal(initialOf('🚀机场'), '🚀');
});
