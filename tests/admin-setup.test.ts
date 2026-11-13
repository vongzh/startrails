import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ADMIN_TOKEN_SETTING_KEY, createApp } from '../src/server/app.ts';
import { hashToken } from '../src/store/crypto.ts';
import { openStore } from '../src/store/sqlite.ts';

interface Instance {
  readonly base: string;
  readonly store: ReturnType<typeof openStore>;
  readonly app: ReturnType<typeof createApp>;
}

async function start(dir: string, dbPath: string, adminToken?: string): Promise<Instance> {
  const store = openStore(dbPath, 'setup-secret');
  const app = createApp({
    store,
    ...(adminToken === undefined ? {} : { adminToken }),
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  return {
    base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    store,
    app,
  };
}

async function stop(instance: Instance): Promise<void> {
  await instance.app.close();
  instance.store.close();
}

const postSetup = (base: string, token: string): Promise<Response> =>
  fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

const setupStatus = async (base: string): Promise<{ required: boolean }> =>
  (await (await fetch(`${base}/api/setup/status`)).json()) as { required: boolean };

const stateStatus = (base: string, token: string): Promise<number> =>
  fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } }).then(
    (res) => res.status,
  );

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'startrails-setup-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁偶发残留，交给系统临时目录清理，不影响验收结论。
  }
}

test('未配置环境变量：首次设置落库、只存 hash，重启后仍有效', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'state.db');
  let instance = await start(dir, dbPath);
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  assert.deepEqual(await setupStatus(instance.base), { required: true, secretRequired: false });
  assert.equal(await stateStatus(instance.base, 'anything'), 401);

  const badBody = await fetch(`${instance.base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(badBody.status, 400, '坏 body 不能落到外层 500');
  assert.equal((await postSetup(instance.base, 'abc')).status, 400, '过短令牌必须拒绝');
  assert.equal((await postSetup(instance.base, 'first-admin-token')).status, 201);
  assert.equal(instance.store.getSetting(ADMIN_TOKEN_SETTING_KEY), hashToken('first-admin-token'));
  assert.notEqual(instance.store.getSetting(ADMIN_TOKEN_SETTING_KEY), 'first-admin-token');

  assert.equal((await postSetup(instance.base, 'other-token')).status, 409, '重复设置不能覆盖');
  assert.equal(await stateStatus(instance.base, 'first-admin-token'), 200);
  assert.equal(await stateStatus(instance.base, 'other-token'), 401);
  assert.deepEqual(await setupStatus(instance.base), { required: false, secretRequired: false });

  // 关库重开，模拟进程重启：令牌来自数据库而不是启动期内存。
  await stop(instance);
  instance = await start(dir, dbPath);
  assert.equal(await stateStatus(instance.base, 'first-admin-token'), 200);
  assert.deepEqual(await setupStatus(instance.base), { required: false, secretRequired: false });
});

test('环境变量优先于数据库，且存在时禁用首次设置', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'state.db');
  const seeded = openStore(dbPath, 'setup-secret');
  seeded.putSetting(ADMIN_TOKEN_SETTING_KEY, hashToken('db-token'));
  seeded.close();

  const instance = await start(dir, dbPath, 'env-token');
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  assert.deepEqual(await setupStatus(instance.base), { required: false, secretRequired: false });
  assert.equal(await stateStatus(instance.base, 'env-token'), 200);
  assert.equal(await stateStatus(instance.base, 'db-token'), 401, '数据库令牌不得覆盖环境变量');
  assert.equal((await postSetup(instance.base, 'new-token')).status, 409);
});

test('环境变量为空白字符串时按未配置处理，不把管理面锁死', async (t) => {
  const dir = tempDir();
  const instance = await start(dir, join(dir, 'state.db'), '   ');
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  assert.deepEqual(await setupStatus(instance.base), { required: true, secretRequired: false });
  assert.equal((await postSetup(instance.base, 'blank-env-token')).status, 201);
  assert.equal(await stateStatus(instance.base, 'blank-env-token'), 200);
});

test('并发首次提交只有一个赢家，且只有赢家的令牌生效', async (t) => {
  const dir = tempDir();
  const instance = await start(dir, join(dir, 'state.db'));
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  const [first, second] = await Promise.all([
    postSetup(instance.base, 'racer-a-token'),
    postSetup(instance.base, 'racer-b-token'),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const winner = first.status === 201 ? 'racer-a-token' : 'racer-b-token';
  const loser = first.status === 201 ? 'racer-b-token' : 'racer-a-token';
  assert.equal(await stateStatus(instance.base, winner), 200);
  assert.equal(await stateStatus(instance.base, loser), 401);
});

test('库里残留空哈希时可重新初始化，不会永久锁死', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'state.db');
  const seeded = openStore(dbPath, 'setup-secret');
  seeded.putSetting(ADMIN_TOKEN_SETTING_KEY, '');
  seeded.close();

  const instance = await start(dir, dbPath);
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  assert.deepEqual(await setupStatus(instance.base), { required: true, secretRequired: false });
  assert.equal((await postSetup(instance.base, 'recovered-token')).status, 201);
  assert.equal(await stateStatus(instance.base, 'recovered-token'), 200);
});
