import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createApp } from '../src/server/app.ts';
import { openStore } from '../src/store/sqlite.ts';

const inlinePayload = (host: string, tag: string): string =>
  `ss://YWVzLTEyOC1nY206cHc@${host}:8388#${tag}`;

/**
 * 排除 / 规则 / 策略组 / DNS 曾经都是全局一份，改一份会连带改掉所有配置的产物。
 * 这条用例守住「改 A 不影响 B」——它是这四张表加 profile 维度的唯一理由。
 */
test('两份配置各自维护排除 / 规则 / 策略组 / DNS，互不影响', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-scope-'));
  const store = openStore(join(dir, 'state.db'), 'scope-secret');
  store.putSource({ id: 'sa', name: '源 A', kind: 'inline', enabled: true });
  store.writeSourcePayload('sa', inlinePayload('a.example.invalid', 'A-01'));
  store.putSource({ id: 'sb', name: '源 B', kind: 'inline', enabled: true });
  store.writeSourcePayload('sb', inlinePayload('b.example.invalid', 'B-01'));
  store.putProfile({ id: 'pa', name: 'pa', entries: [{ kind: 'source', id: 'sa' }] });
  store.putProfile({ id: 'pb', name: 'pb', entries: [{ kind: 'source', id: 'sb' }] });

  const app = createApp({
    store,
    adminToken: 'scope-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const auth = { authorization: 'Bearer scope-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const nodeKeyOf = async (profile: string): Promise<string> => {
    const response = await fetch(`${base}/api/nodes?profile=${profile}`, { headers: auth });
    const body = (await response.json()) as { nodes: { nodeKey: string }[] };
    const key = body.nodes[0]?.nodeKey;
    assert.ok(key !== undefined, `${profile} 应该有一个节点`);
    return key;
  };
  const artifactOf = async (profile: string): Promise<string> => {
    const response = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ profile, target: 'mihomo' }),
    });
    const { url } = (await response.json()) as { url: string };
    return (await fetch(url)).text();
  };

  // A：排除自己的节点、加规则、建组、配 DNS
  await fetch(`${base}/api/annotations?profile=pa`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ nodeKey: await nodeKeyOf('pa'), excluded: true, alias: 'A 独有别名' }),
  });
  await fetch(`${base}/api/rules?profile=pa`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ rules: [{ condition: { type: 'domain', value: 'only-a.example' }, policy: 'REJECT' }] }),
  });
  await fetch(`${base}/api/policy-groups?profile=pa`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ groups: [{ name: 'A 独有组', members: ['DIRECT'] }] }),
  });
  await fetch(`${base}/api/runtime?profile=pa`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ runtime: { dns: { mode: 'fake-ip', nameserver: ['223.5.5.5'] } } }),
  });

  // B 的读接口全部保持干净
  const rulesB = (await (await fetch(`${base}/api/rules?profile=pb`, { headers: auth })).json()) as {
    rules: unknown[];
  };
  assert.deepEqual(rulesB.rules, [], 'A 的规则不该出现在 B');

  const groupsB = (await (await fetch(`${base}/api/policy-groups?profile=pb`, { headers: auth })).json()) as {
    groups: { name: string }[];
  };
  assert.deepEqual(
    groupsB.groups.map((group) => group.name),
    [],
    'A 的策略组不该顶掉 B 的组',
  );

  const runtimeB = (await (await fetch(`${base}/api/runtime?profile=pb`, { headers: auth })).json()) as {
    runtime: unknown;
  };
  assert.equal(runtimeB.runtime, null, 'DNS 是配置级的，B 不该继承 A');

  const stateB = (await (await fetch(`${base}/api/state?profile=pb`, { headers: auth })).json()) as {
    annotations: { alias?: string }[];
  };
  assert.deepEqual(stateB.annotations, [], 'B 不该看到 A 的标注');

  // 产物层面：A 的节点被排除、规则与 DNS 生效；B 原样
  const artifactA = await artifactOf('pa');
  // 只认节点定义那一行：名字也可能作为「策略组成员」出现在别处，那不是节点。
  assert.doesNotMatch(artifactA, /name: A-01/, 'A 应该排除自己的节点');
  assert.match(artifactA, /only-a\.example/);
  assert.match(artifactA, /A 独有组/);
  assert.match(artifactA, /enhanced-mode: fake-ip/);

  const artifactB = await artifactOf('pb');
  assert.match(artifactB, /B-01/, 'B 的节点必须还在');
  assert.doesNotMatch(artifactB, /only-a\.example/, 'A 的规则不该写进 B 的产物');
  assert.doesNotMatch(artifactB, /A 独有组/);
  assert.doesNotMatch(artifactB, /^dns:/m, 'A 的 DNS 不该写进 B 的产物');
});

/**
 * 升级路径：老库四样东西都是全局一份，重开之后要在每份配置里各留一份。
 * 平铺而不是只给 default——否则多配置用户升级后会发现其它配置的排除项凭空消失。
 */
test('旧库升级：全局标注 / 规则 / 策略组 / 运行时平铺到每份配置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-legacy-'));
  const dbPath = join(dir, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE profile_definition (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, source_ids TEXT NOT NULL DEFAULT '[]', items TEXT);
    CREATE TABLE annotation (node_key TEXT PRIMARY KEY, excluded INTEGER NOT NULL DEFAULT 0, alias TEXT, tag TEXT, region TEXT, sort_order INTEGER);
    CREATE TABLE inline_rule (position INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE policy_group_override (name TEXT PRIMARY KEY, members TEXT NOT NULL, sort_order INTEGER NOT NULL);
    CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insertProfile = legacy.prepare(
    'INSERT INTO profile_definition (id, name, source_ids, items) VALUES (?, ?, ?, ?)',
  );
  insertProfile.run('p1', 'p1', '[]', '[]');
  insertProfile.run('p2', 'p2', '[]', '[]');
  legacy
    .prepare('INSERT INTO annotation (node_key, excluded, alias, sort_order) VALUES (?, ?, ?, ?)')
    .run('k1', 1, '旧别名', 3);
  legacy
    .prepare('INSERT INTO inline_rule (position, payload) VALUES (?, ?)')
    .run(0, JSON.stringify({ condition: { type: 'domain', value: 'old.example' }, policy: 'DIRECT' }));
  legacy
    .prepare('INSERT INTO policy_group_override (name, members, sort_order) VALUES (?, ?, ?)')
    .run('PROXY', JSON.stringify(['N1']), 0);
  legacy
    .prepare('INSERT INTO app_setting (key, value) VALUES (?, ?)')
    .run('runtime', JSON.stringify({ dns: { mode: 'system', nameserver: ['1.1.1.1'] } }));
  legacy.close();

  const store = openStore(dbPath, 'legacy-secret');
  try {
    for (const id of ['p1', 'p2']) {
      assert.equal(store.listAnnotations(id)[0]?.alias, '旧别名', `${id} 应继承旧标注`);
      assert.equal(store.listRules(id).length, 1, `${id} 应继承旧规则`);
      assert.equal(store.listGroupOverrides(id).length, 1, `${id} 应继承旧策略组`);
    }
    for (const profile of store.listProfiles()) {
      assert.equal(profile.runtime?.dns?.mode, 'system', `${profile.id} 应继承旧运行时段`);
    }
    assert.equal(store.getSetting('runtime'), undefined, '旧键必须删掉，避免被后来的配置误读');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 配置名是令牌的归属键：改名不级联，已签发地址的 /s/ 链路就对不上号；
 * 删除不回收，标注 / 规则 / 策略组会留给下一个同名配置继承旧意图。
 */
test('配置改名级联到令牌；删除回收配置级数据并撤销地址', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-cascade-'));
  const store = openStore(join(dir, 'state.db'), 'cascade-secret');
  store.putSource({ id: 'sc', name: '源 C', kind: 'inline', enabled: true });
  store.writeSourcePayload('sc', inlinePayload('c.example.invalid', 'C-01'));
  store.putProfile({ id: 'pc', name: '旧名', entries: [{ kind: 'source', id: 'sc' }] });
  // detached.annotations 的计数要有东西可数：标注是即时保存，直接走 store。
  store.putAnnotation('pc', { nodeKey: 'c-01', excluded: true });

  const app = createApp({
    store,
    adminToken: 'cascade-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const auth = { authorization: 'Bearer cascade-admin', 'content-type': 'application/json' };

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ profile: '旧名', target: 'surge' }),
  });
  await fetch(`${base}/api/rules?profile=${encodeURIComponent('旧名')}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ rules: [{ condition: { type: 'domain', value: 'c.example' }, policy: 'DIRECT' }] }),
  });
  await fetch(`${base}/api/policy-groups?profile=${encodeURIComponent('旧名')}`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ groups: [{ name: 'C 组', members: ['DIRECT'] }] }),
  });

  // 改名撞已有配置名：必须是稳定 409，而不是 SQLite UNIQUE 约束炸成 500。
  store.putProfile({ id: 'other', name: '别的配置', entries: [] });
  const clashing = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: 'pc', name: '别的配置', entries: [{ kind: 'source', id: 'sc' }] }),
  });
  assert.equal(clashing.status, 409);
  assert.equal(((await clashing.json()) as { error: string }).error, 'profile-name-taken');
  assert.equal(
    store.listProfiles().find((profile) => profile.id === 'pc')?.name,
    '旧名',
    '撞名请求不得改库',
  );

  // 改名：同一个 id、新名字。响应必须说清这是改名，而不是「新建了一个」。
  const renamed = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ id: 'pc', name: '新名', entries: [{ kind: 'source', id: 'sc' }] }),
  });
  assert.equal(renamed.status, 201);
  assert.equal(((await renamed.json()) as { renamed: boolean }).renamed, true);

  // 令牌归属跟着走，已签发地址不能失效。
  const tokens = (await (await fetch(`${base}/api/state?profile=${encodeURIComponent('新名')}`, { headers: auth })).json()) as {
    tokens: { profile: string; url: string | null }[];
  };
  assert.equal(tokens.tokens[0]?.profile, '新名', '改名后令牌必须归属新名');
  assert.ok(tokens.tokens[0]?.url !== null, '台账要能还原链接');
  assert.equal(await fetch(tokens.tokens[0]!.url!).then((r) => r.status), 200, '改名不该弄断已签发地址');

  // 删除：配置级数据随删除回收，地址当场撤销。
  const removed = await fetch(`${base}/api/profiles/${encodeURIComponent('新名')}`, { method: 'DELETE', headers: auth });
  assert.equal(removed.status, 200);
  const result = (await removed.json()) as {
    detached: { rules: number; annotations: number; groupOverrides: number };
    revoked: number;
  };
  assert.equal(result.revoked, 1, '地址要随删除撤销');
  assert.equal(result.detached.rules, 1, '内联规则要随删除回收');
  assert.equal(result.detached.annotations, 1, '标注要随删除回收');
  assert.equal(result.detached.groupOverrides, 1, '策略组要随删除回收');
  assert.equal(
    await fetch(tokens.tokens[0]!.url!).then((r) => r.status),
    404,
    '删除后地址必须失效',
  );
  // store 层：同名配置重建时不该继承旧数据。
  assert.deepEqual(store.listRules('pc'), [], '规则已回收');
  assert.deepEqual(store.listAnnotations('pc'), [], '标注已回收');
  assert.deepEqual(store.listGroupOverrides('pc'), [], '策略组已回收');
});
