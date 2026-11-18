import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAutoGroupIcons,
  countryCodeOfFlag,
  emit,
  flagEmojiOf,
  iconUrlForEmoji,
  leadingEmoji,
  parseProfile,
  plan,
  quanxIconForEmoji,
  recognizeGroupEmoji,
  resolveGroupEmoji,
  resolveGroupIcon,
} from '../src/core/index.ts';
import { createApp } from '../src/server/app.ts';
import { openStore } from '../src/store/sqlite.ts';

test('leadingEmoji 提取国旗双码点与变体符 Emoji，跳过 ASCII 符号', () => {
  assert.equal(leadingEmoji('🇭🇰 香港节点'), '🇭🇰');
  assert.equal(leadingEmoji('🛡️ 隐私拦截'), '🛡️');
  assert.equal(leadingEmoji('🚀 Proxy'), '🚀');
  assert.equal(leadingEmoji('1. 香港'), undefined);
  assert.equal(leadingEmoji('#Auto'), undefined);
  assert.equal(countryCodeOfFlag('🇬🇧'), 'GB');
  assert.equal(flagEmojiOf('UK'), '🇬🇧');
});

test('分层图标识别优先级：首部 Emoji > 服务名 > 地区 > 策略角色 > 规则列表 > 成员特性 > 策略兜底', () => {
  // 1. 首部 Emoji 永远优先
  assert.equal(
    resolveGroupEmoji({ name: '🍎 Google Search', strategy: 'select', members: ['HK-1'] }),
    '🍎',
  );
  // 2. 服务名（CamelCase 切词不误伤 AkamaiCloud -> iCloud）
  assert.equal(recognizeGroupEmoji({ name: 'AkamaiCloud', strategy: 'select', members: ['a'] }), undefined);
  assert.equal(recognizeGroupEmoji({ name: 'Netflix 专享', strategy: 'select', members: ['a'] }), '🎥');
  assert.equal(recognizeGroupEmoji({ name: 'OpenAI GPT', strategy: 'select', members: ['a'] }), '🤖');
  // 3. 地区 / 别名
  assert.equal(recognizeGroupEmoji({ name: '新加坡节点', strategy: 'select', members: ['a'] }), '🇸🇬');
  assert.equal(recognizeGroupEmoji({ name: '欧洲优选', strategy: 'url-test', members: ['a'] }), '🌍'.replace('🌍', '🇪🇺'));
  // 4. 规则特征（包括全流媒体投票合并与 MATCH/GEOIP）
  assert.equal(
    recognizeGroupEmoji(
      { name: 'Custom Group', strategy: 'select', members: ['n1'] },
      [
        {
          kind: 'external',
          url: 'https://example.com/ruleset/Netflix.list',
          policy: 'Custom Group',
        },
        {
          kind: 'external',
          url: 'https://example.com/ruleset/YouTube.list',
          policy: 'Custom Group',
        },
      ],
    ),
    '🎬',
  );
  assert.equal(
    recognizeGroupEmoji(
      { name: 'CatchAll', strategy: 'select', members: ['n1'] },
      [{ kind: 'inline', rules: [{ condition: { type: 'match' }, policy: 'CatchAll' }] }],
    ),
    '🐟',
  );
  // 5. 成员特征与策略兜底
  assert.equal(recognizeGroupEmoji({ name: 'GroupA', strategy: 'select', members: ['DIRECT'] }), '🎯');
  assert.equal(
    recognizeGroupEmoji({ name: 'GroupB', strategy: 'select', members: ['🇭🇰 HK 01', '🇭🇰 HK 02'] }),
    '🇭🇰',
  );
  assert.equal(resolveGroupEmoji({ name: 'GroupC', strategy: 'url-test', members: ['Custom-1'] }), '⚡');
  assert.equal(resolveGroupEmoji({ name: 'GroupD', strategy: 'fallback', members: ['Custom-1'] }), '🔁');
  assert.equal(resolveGroupEmoji({ name: 'GroupE', strategy: 'select', members: ['Custom-1'] }), '🌐');
});

test('Fluent Emoji 3D / Twemoji Flag / QuanX SF Symbol 地址映射与显式 icon 保留', () => {
  const aiUrl = iconUrlForEmoji('🤖');
  assert.ok(aiUrl !== undefined && aiUrl.includes('microsoft/fluentui-emoji'));
  const hkUrl = iconUrlForEmoji('🇭🇰');
  assert.equal(hkUrl, 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f1ed-1f1f0.png');
  assert.equal(quanxIconForEmoji('🤖'), 'brain.head.profile.system');

  const resolved = resolveGroupIcon({
    name: 'OpenAI',
    strategy: 'select',
    members: ['DIRECT'],
  });
  assert.equal(resolved.emoji, '🤖');
  assert.equal(resolved.url, aiUrl);
  assert.equal(resolved.quanx, 'brain.head.profile.system');

  const populated = applyAutoGroupIcons([
    { name: 'AI', members: ['DIRECT'], strategy: 'select' },
    { name: 'Custom', members: ['DIRECT'], strategy: 'select', icon: 'https://example.com/custom.png' },
  ]);
  assert.equal(populated[0]?.icon, aiUrl);
  assert.equal(populated[1]?.icon, 'https://example.com/custom.png');
});

test('多端 Emitter：mihomo 输出 icon、Surge 输出 icon-url 且首部已有国旗时去重、QuanX 输出 .system', () => {
  const baseProfile = parseProfile({
    nodes: [
      { kind: 'shadowsocks', name: '🇭🇰 HK-1', server: 'hk.example.invalid', port: 443, method: 'aes-128-gcm', password: 'pw' },
    ],
    ruleSources: [],
    policyGroups: [
      { name: 'AI', members: ['🇭🇰 HK-1'], strategy: 'select' },
      { name: '🇭🇰 香港', members: ['🇭🇰 HK-1'], strategy: 'select' },
      { name: 'Custom', members: ['DIRECT'], strategy: 'select', icon: 'https://example.com/custom.png' },
    ],
  });
  const withIcons = parseProfile({
    nodes: baseProfile.nodes,
    ruleSources: [],
    policyGroups: applyAutoGroupIcons(baseProfile.policyGroups),
  });

  const clashYaml = emit(withIcons, plan(withIcons, 'mihomo')).content;
  assert.match(clashYaml, /name: AI[\s\S]*?icon: https:\/\/cdn\.jsdelivr\.net\/gh\/microsoft\/fluentui-emoji/);
  assert.match(clashYaml, /name: 🇭🇰 香港[\s\S]*?icon: https:\/\/cdn\.jsdelivr\.net\/gh\/jdecked\/twemoji/);
  assert.match(clashYaml, /name: Custom[\s\S]*?icon: https:\/\/example\.com\/custom\.png/);

  const surgeIni = emit(withIcons, plan(withIcons, 'surge')).content;
  assert.match(surgeIni, /AI = select, 🇭🇰 HK-1, icon-url=https:\/\/cdn\.jsdelivr\.net\/gh\/microsoft\/fluentui-emoji/);
  // Surge 组名首部已有国旗且图标同为 Twemoji 国旗时不重复写 icon-url
  assert.match(surgeIni, /🇭🇰 香港 = select, 🇭🇰 HK-1\r?\n/);
  assert.match(surgeIni, /Custom = select, DIRECT, icon-url=https:\/\/example\.com\/custom\.png/);

  const quanxIni = emit(withIcons, plan(withIcons, 'quanx')).content;
  assert.match(quanxIni, /static = AI, 🇭🇰 HK-1, img-url=brain\.head\.profile\.system/);
  assert.match(quanxIni, /static = Custom, direct, img-url=https:\/\/example\.com\/custom\.png/);
});

test('服务端持久化：/api/policy-groups 保存 groupIcons=auto 与单组自定义 icon 并影响产物预览', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-group-icons-'));
  const store = openStore(join(dir, 'state.db'), 'icons-secret');
  const app = createApp({
    store,
    adminToken: 'icons-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: false,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (path: string, method: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: 'Bearer icons-admin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  await call('/api/sources', 'POST', {
    id: 'src1',
    name: 'Local',
    kind: 'inline',
    profile: 'default',
    content: 'vless://33333333-3333-3333-3333-333333333333@hk.example.invalid:443?security=tls#HK-1',
  });

  // 默认关闭 groupIcons
  const before = (await (await call('/api/policy-groups', 'GET')).json()) as {
    groupIcons: string;
  };
  assert.equal(before.groupIcons, 'off');

  const saveRes = await call('/api/policy-groups', 'POST', {
    mode: 'replace',
    groupIcons: 'auto',
    groups: [
      { name: 'OpenAI', strategy: 'select', members: [{ kind: 'rest' }] },
      { name: 'Manual', strategy: 'select', icon: 'https://example.com/my.png', members: ['DIRECT'] },
    ],
  });
  assert.equal(saveRes.status, 200);

  const after = (await (await call('/api/policy-groups', 'GET')).json()) as {
    groupIcons: string;
    groups: { name: string; icon?: string }[];
  };
  assert.equal(after.groupIcons, 'auto');
  assert.equal(after.groups.find((g) => g.name === 'Manual')?.icon, 'https://example.com/my.png');

  const preview = (await (await call('/api/preview?target=mihomo', 'GET')).json()) as {
    content: string;
  };
  assert.match(preview.content, /name: OpenAI[\s\S]*?icon: https:\/\/cdn\.jsdelivr\.net\/gh\/microsoft\/fluentui-emoji/);
  assert.match(preview.content, /name: Manual[\s\S]*?icon: https:\/\/example\.com\/my\.png/);
});
