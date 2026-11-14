import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.ts';
import { openStore } from '../src/store/sqlite.ts';

/**
 * 管理面的「闭环」验证：能进去、能继续、删掉之后不留悬空引用。
 *
 * 这一组测试的共同点不是「接口返回 200」，而是**用户下一步还有没有路**：
 * 加完源能不能直接出节点、删了源组合订阅和构成会不会指向不存在的 id、
 * 换掉令牌后旧令牌是否立刻失效、测试发送失败时能不能看出是哪个渠道不通。
 */
const subscription = readFileSync(
  new URL('../testdata/fixtures/subscription.txt', import.meta.url),
  'utf8',
);

const singleNode = 'vless://33333333-3333-3333-3333-333333333333@one.example.invalid:443?security=tls#Only';

interface Harness {
  readonly base: string;
  readonly store: ReturnType<typeof openStore>;
  readonly app: ReturnType<typeof createApp>;
  readonly dir: string;
  readonly call: (path: string, method: string, body?: unknown) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const boot = async (
  options: { adminToken?: string | undefined; allowPrivate?: boolean } = { adminToken: 'flows-admin' },
): Promise<Harness> => {
  const adminToken = options.adminToken;
  const dir = mkdtempSync(join(tmpdir(), 'startrails-flows-'));
  const store = openStore(join(dir, 'state.db'), 'flows-secret');
  const app = createApp({
    store,
    ...(adminToken === undefined ? {} : { adminToken }),
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: options.allowPrivate ?? false,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = (path: string, method: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(adminToken === undefined ? {} : { authorization: `Bearer ${adminToken}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const close = async (): Promise<void> => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { base, store, app, dir, call, close };
};

interface StateShape {
  sources: { id: string; kind: string }[];
  collections: { id: string; name: string; members: { sourceId: string }[]; order: number }[];
  profiles: { name: string; entries: { kind: string; id: string }[] }[];
  tokens: { id: string; profile: string; target: string; revoked: boolean }[];
}

const stateOf = async (harness: Harness): Promise<StateShape> =>
  (await (await harness.call('/api/state', 'GET')).json()) as StateShape;

test('首次使用：空 Profile 下加源自动挂进构成，非空时不动构成', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  // 空库时 default profile 已存在但没有构成：这时新加的源就是用户唯一的意图。
  const first = await harness.call('/api/sources', 'POST', {
    id: 'first',
    kind: 'inline',
    content: subscription,
    profile: 'default',
  });
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { attached: boolean }).attached, true);
  let state = await stateOf(harness);
  assert.deepEqual(state.profiles[0]?.entries, [{ kind: 'source', id: 'first' }]);

  // 第二个源不再自动追加：静默改动已发布的构成比多点一次更糟。
  const second = await harness.call('/api/sources', 'POST', {
    id: 'second',
    kind: 'inline',
    content: singleNode,
    profile: 'default',
  });
  assert.equal(second.status, 201);
  assert.equal(((await second.json()) as { attached: boolean }).attached, false);
  state = await stateOf(harness);
  assert.equal(state.profiles[0]?.entries.length, 1, '已有构成不得被自动改写');
});

test('本地源正文可读可改：PUT 正文后重新解析生效', async (t) => {
  // 远端源那条断言要落库一个本机地址，因此这一组放开私网地址限制。
  const harness = await boot({ adminToken: 'flows-admin', allowPrivate: true });
  t.after(() => harness.close());

  assert.equal(
    (
      await harness.call('/api/sources', 'POST', {
        id: 'local',
        kind: 'inline',
        content: subscription,
      })
    ).status,
    201,
  );

  // 正文必须能读出来，否则界面上的「编辑」只能改名字，等于没得改。
  const detail = (await (await harness.call('/api/sources/local', 'GET')).json()) as {
    content: string | null;
  };
  assert.equal(detail.content, subscription);

  assert.equal(
    (await harness.call('/api/sources/local', 'PUT', { content: singleNode })).status,
    200,
  );
  const updated = (await (await harness.call('/api/sources/local', 'GET')).json()) as {
    content: string | null;
  };
  assert.equal(updated.content, singleNode);

  const preview = (await (
    await harness.call('/api/sources/local/preview', 'GET')
  ).json()) as { nodes: number };
  assert.equal(preview.nodes, 1, '改正文后应当按新正文解析');

  // 远端源没有本地正文，接口回 null 而不是空串（空串会被当成「内容被清空」）。
  assert.equal(
    (
      await harness.call('/api/sources', 'POST', {
        id: 'remote',
        url: 'http://127.0.0.1:1/sub',
      })
    ).status,
    201,
  );
  const remote = (await (await harness.call('/api/sources/remote', 'GET')).json()) as {
    content: string | null;
  };
  assert.equal(remote.content, null);
});

test('删源：组合成员与 Profile 构成一并清理，成员清空的组合自动删除', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  for (const id of ['a', 'b']) {
    assert.equal(
      (
        await harness.call('/api/sources', 'POST', {
          id,
          kind: 'inline',
          content: subscription,
        })
      ).status,
      201,
    );
  }
  // 只含 a 的组合：删 a 之后应该整体消失，而不是留一个 0 成员的壳。
  assert.equal(
    (await harness.call('/api/collections', 'POST', { id: 'solo', name: 'solo', members: [{ sourceId: 'a' }] }))
      .status,
    201,
  );
  assert.equal(
    (
      await harness.call('/api/collections', 'POST', {
        id: 'pair',
        name: 'pair',
        members: [{ sourceId: 'a' }, { sourceId: 'b' }],
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await harness.call('/api/profiles', 'POST', {
        name: 'default',
        entries: [
          { kind: 'source', id: 'a' },
          { kind: 'collection', id: 'solo' },
          { kind: 'collection', id: 'pair' },
        ],
      })
    ).status,
    201,
  );

  const removed = await harness.call('/api/sources/a', 'DELETE');
  assert.equal(removed.status, 200);
  const detached = ((await removed.json()) as {
    detached: { collections: number; profiles: number; removedCollections: string[] };
  }).detached;
  assert.equal(detached.collections, 2, '两个组合各被清理一处');
  assert.equal(detached.profiles, 1);
  assert.deepEqual(detached.removedCollections, ['solo']);

  const state = await stateOf(harness);
  assert.deepEqual(
    state.collections.map((item) => item.id),
    ['pair'],
    '成员清空的组合应被删除',
  );
  assert.deepEqual(state.collections[0]?.members, [{ sourceId: 'b' }]);
  assert.deepEqual(
    state.profiles[0]?.entries,
    [{ kind: 'collection', id: 'pair' }],
    '构成里指向已删源 / 已删组合的引用必须一并移除',
  );

  // 清理后的构成不应再产出「引用不存在」类诊断（方言降级属于另一类，不在此列）。
  const preview = (await (await harness.call('/api/preview?target=surge', 'GET')).json()) as {
    report: { diagnostics: { reason: string }[] };
  };
  const dangling = preview.report.diagnostics
    .map((item) => item.reason)
    .filter((reason) =>
      ['source-not-found', 'source-unavailable', 'collection-not-found', 'collection-member-missing'].includes(
        reason,
      ),
    );
  assert.deepEqual(dangling, [], `清理后不该还有悬空引用：${dangling.join(',')}`);
});

test('删组合：Profile 构成里的引用同步移除', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  assert.equal(
    (await harness.call('/api/sources', 'POST', { id: 'a', kind: 'inline', content: subscription })).status,
    201,
  );
  assert.equal(
    (await harness.call('/api/collections', 'POST', { id: 'col', name: 'col', members: [{ sourceId: 'a' }] }))
      .status,
    201,
  );
  assert.equal(
    (
      await harness.call('/api/profiles', 'POST', {
        name: 'default',
        entries: [{ kind: 'collection', id: 'col' }],
      })
    ).status,
    201,
  );

  const removed = await harness.call('/api/collections/col', 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { detached: { profiles: number } }).detached.profiles, 1);
  const state = await stateOf(harness);
  assert.deepEqual(state.profiles[0]?.entries, []);
  assert.deepEqual(state.collections, []);
});

test('组合订阅编辑不改变顺序：order 只在创建时确定', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  assert.equal(
    (await harness.call('/api/sources', 'POST', { id: 'a', kind: 'inline', content: subscription })).status,
    201,
  );
  for (const [id, name] of [
    ['one', 'one'],
    ['two', 'two'],
  ] as const) {
    assert.equal(
      (await harness.call('/api/collections', 'POST', { id, name, members: [{ sourceId: 'a' }] })).status,
      201,
    );
  }
  let state = await stateOf(harness);
  assert.deepEqual(
    state.collections.map((item) => [item.id, item.order]),
    [
      ['one', 0],
      ['two', 1],
    ],
  );

  // 改名字 / 成员属于编辑：顺序必须原地不动，否则每次改过滤条件都会改变合并顺序。
  assert.equal(
    (
      await harness.call('/api/collections', 'POST', {
        id: 'one',
        name: 'one-renamed',
        members: [{ sourceId: 'a' }],
      })
    ).status,
    201,
  );
  state = await stateOf(harness);
  assert.deepEqual(
    state.collections.map((item) => [item.id, item.order]),
    [
      ['one', 0],
      ['two', 1],
    ],
  );
});

test('空 Profile 拒绝签发；Profile 可新建可删除，删除会撤销绑定地址', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  assert.equal(
    (await harness.call('/api/profiles', 'POST', { name: 'work' })).status,
    201,
  );
  const blocked = await harness.call('/api/tokens', 'POST', { profile: 'work', target: 'surge' });
  assert.equal(blocked.status, 409, '构成全空的 Profile 不该签发空壳地址');
  assert.equal(((await blocked.json()) as { error: string }).error, 'profile-empty');

  assert.equal(
    (await harness.call('/api/sources', 'POST', { id: 'a', kind: 'inline', content: subscription })).status,
    201,
  );
  assert.equal(
    (
      await harness.call('/api/profiles', 'POST', {
        name: 'default',
        entries: [{ kind: 'source', id: 'a' }],
      })
    ).status,
    201,
  );
  const issued = await harness.call('/api/tokens', 'POST', { profile: 'default', target: 'surge' });
  assert.equal(issued.status, 201);
  const token = (await issued.json()) as { id: string; url: string };
  assert.equal((await fetch(`${token.url}`)).status, 200);

  const deleted = await harness.call('/api/profiles/default', 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(((await deleted.json()) as { revoked: number }).revoked, 1);
  assert.equal(
    (await fetch(`${token.url}`)).status,
    404,
    'Profile 被删后绑定的地址必须失效，而不是留一个 404 给客户端自己猜',
  );

  const last = await harness.call('/api/profiles/work', 'DELETE');
  assert.equal(last.status, 409, '不能把最后一个 Profile 删掉');
  assert.equal(((await last.json()) as { error: string }).error, 'last-profile');
});

test('管理令牌轮换：短令牌与相同令牌被拒，换后旧令牌立刻失效', async (t) => {
  // 轮换只对「首次设置写进库」的令牌有意义；环境变量令牌的路径另有一条测试。
  const harness = await boot({ adminToken: undefined });
  t.after(() => harness.close());

  // 先走一次首次设置，把令牌落到库里。
  assert.equal(
    (
      await fetch(`${harness.base}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'setup-admin-token' }),
      })
    ).status,
    201,
  );

  const rotate = (token: string): Promise<Response> =>
    fetch(`${harness.base}/api/admin/token`, {
      method: 'POST',
      headers: { authorization: 'Bearer setup-admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

  assert.equal((await rotate('short')).status, 400);
  assert.equal((await rotate('setup-admin-token')).status, 400, '与当前相同时应明确拒绝，避免误以为已更换');
  assert.equal((await rotate('rotated-admin-token')).status, 200);

  const statusOf = (token: string): Promise<number> =>
    fetch(`${harness.base}/api/state`, { headers: { authorization: `Bearer ${token}` } }).then(
      (res) => res.status,
    );
  assert.equal(await statusOf('setup-admin-token'), 401, '旧令牌必须立刻失效');
  assert.equal(await statusOf('rotated-admin-token'), 200);
});

test('管理令牌来自环境变量时不允许在界面轮换', async (t) => {
  const harness = await boot({ adminToken: 'env-admin' });
  t.after(() => harness.close());

  const response = await harness.call('/api/admin/token', 'POST', { token: 'another-admin' });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, 'admin-token-from-env');
});

test('通知测试：未配置回 400，配置不通时按渠道回报原因', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  assert.equal((await harness.call('/api/settings/notify/test', 'POST', {})).status, 400);

  // 指向没有监听的本机端口：必定失败，但失败原因是「数据」而不是传输错误。
  const failed = await harness.call('/api/settings/notify/test', 'POST', {
    notify: { barkUrl: 'http://127.0.0.1:1/probe' },
  });
  assert.equal(failed.status, 502);
  const body = (await failed.json()) as {
    ok: boolean;
    results: { channel: string; ok: boolean; error: string | null }[];
  };
  assert.equal(body.ok, false);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.channel, 'bark');
  assert.equal(body.results[0]?.ok, false);
  assert.ok((body.results[0]?.error ?? '').length > 0, '要说清是哪一步不通');
});

test('WebDAV 测试：不可达时报原因，未配置时回 400', async (t) => {
  const harness = await boot();
  t.after(() => harness.close());

  assert.equal((await harness.call('/api/settings/webdav/test', 'POST', {})).status, 400);

  const unreachable = await harness.call('/api/settings/webdav/test', 'POST', {
    webdav: { url: 'http://127.0.0.1:1/dav' },
  });
  assert.equal(unreachable.status, 502);
  const body = (await unreachable.json()) as { ok: boolean; status: number; reason: string | null };
  assert.equal(body.ok, false);
  assert.equal(body.status, 0, '连不上时没有 HTTP 状态码');
  assert.ok((body.reason ?? '').length > 0);

  // 非法地址在解析阶段就该被拒，不用等发请求。
  assert.equal(
    (
      await harness.call('/api/settings/webdav/test', 'POST', {
        webdav: { url: 'ftp://example.invalid/dav' },
      })
    ).status,
    400,
  );
});

/**
 * 编辑远端源的回归：管理面返回明文供抽屉回填，保存时不能把脱敏值或空值写回库。
 * 这一组覆盖的是「只改个名字就把机场订阅废掉」这个真实事故，以及同源的
 * 空链接静默回退、格式偏好清不掉（只能删源重建）。
 */
test('编辑源：明文回填、只改名不破坏链接、空值与格式清除语义明确', async (t) => {
  const harness = await boot({ adminToken: 'edit-admin', allowPrivate: true });
  t.after(() => harness.close());

  const url = 'http://127.0.0.1:1/api/v1/client/subscribe?token=abcdef0123456789abcdef0123456789';
  const proxy = 'socks5://alice:secret@127.0.0.1:1080';
  const created = await harness.call('/api/sources', 'POST', {
    id: 'editable',
    kind: 'remote',
    url,
    proxy,
    format: 'clash-yaml',
  });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { url: string }).url, url, 'POST 响应也不能给脱敏值');

  const state = (await (await harness.call('/api/state', 'GET')).json()) as {
    sources: { id: string; url: string | null; proxy: string | null; format: string | null }[];
  };
  const view = state.sources.find((item) => item.id === 'editable');
  assert.equal(view?.url, url, '管理面必须返回明文，编辑抽屉才能原样回填');
  assert.equal(view?.proxy, proxy, '带凭据的代理同样不能被脱敏后写回');
  assert.equal(view?.format, 'clash-yaml');

  const detail = (await (await harness.call('/api/sources/editable', 'GET')).json()) as {
    source: { url: string | null };
  };
  assert.equal(detail.source.url, url);

  // 模拟编辑抽屉「只改个名字」：把回填的字段原样 PUT 回去。
  assert.equal(
    (
      await harness.call('/api/sources/editable', 'PUT', {
        name: '改名后',
        url,
        ua: '',
        format: 'clash-yaml',
        refreshPolicy: 'off',
        proxy,
      })
    ).status,
    200,
  );
  assert.equal(harness.store.getSource('editable')?.url, url);
  assert.equal(harness.store.getSource('editable')?.name, '改名后');
  assert.equal(harness.store.getSource('editable')?.proxy, proxy);

  // 清空链接必须报错且不动库，不能回 200 让界面假报「保存成功」。
  const empty = await harness.call('/api/sources/editable', 'PUT', { url: '' });
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as { error: string }).error, 'url-required');
  assert.equal(harness.store.getSource('editable')?.url, url);

  // 用户开着缓存的旧页面时，脱敏值直接拒掉，而不是写坏库再说。
  const stale = await harness.call('/api/sources/editable', 'PUT', {
    url: url.replace(/token=.*/, 'token=***'),
  });
  assert.equal(stale.status, 400);
  assert.equal(((await stale.json()) as { error: string }).error, 'redacted-url-rejected');
  assert.equal(harness.store.getSource('editable')?.url, url);

  // 省略 format = 本次不改（开关只带 enabled 不能顺手清掉偏好）。
  assert.equal((await harness.call('/api/sources/editable', 'PUT', { enabled: false })).status, 200);
  assert.equal(harness.store.getSource('editable')?.format, 'clash-yaml');
  // 显式空串 = 选回「自动识别」，必须能清掉。
  assert.equal((await harness.call('/api/sources/editable', 'PUT', { format: '' })).status, 200);
  assert.equal(harness.store.getSource('editable')?.format, undefined);

  // 本地源没有上游：编辑抽屉不再显示自动刷新，服务端也不写一条永不执行的策略。
  assert.equal(
    (await harness.call('/api/sources', 'POST', { id: 'local-edit', kind: 'inline', content: singleNode })).status,
    201,
  );
  assert.equal((await harness.call('/api/sources/local-edit', 'PUT', { refreshPolicy: '2h' })).status, 200);
  assert.equal(harness.store.getSource('local-edit')?.refreshPolicy, undefined);
});
