import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_TARGETS, clientImportHint, clientImportUrl } from '../src/core/index.ts';

const subUrl = 'https://sub.example.com/s/tok_123/default/surge?include=HK';

test('clientImportUrl：覆盖常见客户端并准确区分各家 URL Scheme 细节', () => {
  assert.equal(
    clientImportUrl('surge', subUrl),
    `surge:///install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('surge-mac', subUrl),
    `surgeconfig:///install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('clash', subUrl),
    `stash://install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('clash-verge', subUrl),
    `clash-verge://install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('clash-apple', subUrl),
    `clashmeta://install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('flclash', subUrl),
    `flclash://install-config?url=${encodeURIComponent(subUrl)}`,
  );
  assert.equal(
    clientImportUrl('mihomo-party', subUrl, { name: 'Daily' }),
    `mihomo://install-config?url=${encodeURIComponent(subUrl)}&name=Daily`,
  );
  assert.equal(
    clientImportUrl('clash-mi', subUrl, { name: 'Daily' }),
    `clashmi://install-config?url=${encodeURIComponent(subUrl)}&name=Daily`,
  );
  assert.equal(
    clientImportUrl('sing-box', subUrl, { name: 'My Profile' }),
    `sing-box://import-remote-profile?url=${encodeURIComponent(subUrl)}#My%20Profile`,
  );
  assert.equal(clientImportUrl('hiddify', subUrl), `hiddify://import/${subUrl}`);
  assert.equal(clientImportUrl('loon', subUrl), `loon://import?sub=${encodeURIComponent(subUrl)}`);
  assert.equal(
    clientImportUrl('egern', subUrl, { name: 'Daily' }),
    `egern:/profiles/new?url=${encodeURIComponent(subUrl)}&name=Daily`,
  );
  assert.equal(
    clientImportUrl('shadowrocket', subUrl, { name: 'Daily' }),
    `shadowrocket://add/${subUrl}#Daily`,
  );
  assert.equal(
    clientImportUrl('v2box', subUrl, { name: 'Daily' }),
    `v2box://install-sub?url=${encodeURIComponent(subUrl)}&name=Daily`,
  );
  assert.equal(
    clientImportUrl('anywhere', subUrl),
    `anywhere://add-proxy?link=${encodeURIComponent(subUrl)}`,
  );
});

test('clientImportUrl：Karing 默认稳定、带 revision 避免重复跳过；不支持目标诚实返回 null 与提示', () => {
  assert.equal(
    clientImportUrl('karing', subUrl, { name: 'Daily' }),
    clientImportUrl('karing', subUrl, { name: 'Daily' }),
    '省略 revision 时保持纯函数确定性',
  );
  const karing = clientImportUrl('karing', subUrl, { name: 'Daily', revision: 'rev-123456' });
  assert.ok(karing !== null && karing.startsWith('karing://install-config?url='));
  assert.match(karing, /st-import%3Drev-123456/);
  assert.match(karing, /Daily%20123456/);

  for (const unsupported of ['quanx', 'clashmac', 'mihomo', 'auto'] as const) {
    assert.equal(clientImportUrl(unsupported, subUrl), null, `${unsupported} 应返回 null`);
    assert.ok((clientImportHint(unsupported) ?? '').length > 0, `${unsupported} 应有明确说明`);
  }
  assert.equal(clientImportUrl('surge', '   '), null);

  for (const target of CLIENT_TARGETS) {
    const url = clientImportUrl(target, subUrl, { revision: '1' });
    const hint = clientImportHint(target);
    assert.ok((url !== null) !== (hint !== null), `${target} 要么能生成导入链，要么给出不可一键导入原因`);
  }
});
