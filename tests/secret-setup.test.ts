import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app.ts';
import { resolveTokenSecret } from '../src/server/secret.ts';
import { openStore } from '../src/store/sqlite.ts';

interface Instance {
  readonly base: string;
  readonly store: ReturnType<typeof openStore>;
  readonly app: ReturnType<typeof createApp>;
  readonly secretFile: string;
}

async function start(options: {
  readonly dir: string;
  readonly dbPath: string;
  readonly secret: string;
  readonly secretConfigured: boolean;
  readonly adminToken?: string;
}): Promise<Instance> {
  const secretFile = join(options.dir, 'secret.key');
  const store = openStore(options.dbPath, options.secret);
  const app = createApp({
    store,
    ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
    secretConfigured: options.secretConfigured,
    secretFile,
    cacheDir: join(options.dir, 'cache'),
    dataDir: options.dir,
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  return {
    base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    store,
    app,
    secretFile,
  };
}

async function stop(instance: Instance): Promise<void> {
  await instance.app.close();
  instance.store.close();
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'startrails-secret-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁偶发残留，交给系统临时目录清理。
  }
}

const setupStatus = async (
  base: string,
): Promise<{ required: boolean; secretRequired: boolean }> =>
  (await (await fetch(`${base}/api/setup/status`)).json()) as {
    required: boolean;
    secretRequired: boolean;
  };

const stateStatus = (base: string, token: string): Promise<number> =>
  fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } }).then(
    (res) => res.status,
  );

const postSetup = (base: string, body: Record<string, string>, token?: string): Promise<Response> =>
  fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

test('首次启动：管理令牌与密钥都缺时，一次设置同时重加密已有正文并落盘', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'state.db');
  let instance: Instance | undefined = await start({
    dir,
    dbPath,
    secret: 'ephemeral-before-setup',
    secretConfigured: false,
  });
  t.after(async () => {
    if (instance !== undefined) await stop(instance);
    cleanup(dir);
  });
  const running = instance;

  // 模拟「用临时密钥已经写入过正文」：设置新密钥时必须在事务里重加密，不能丢。
  running.store.putSource({ id: 'seed', name: 'seed', kind: 'inline', enabled: true });
  running.store.writeSourcePayload('seed', 'seed-content');

  assert.deepEqual(await setupStatus(running.base), {
    required: true,
    secretRequired: true,
  });

  const short = await postSetup(running.base, {
    token: 'first-admin-token',
    secret: 'too-short',
  });
  assert.equal(short.status, 400);
  assert.equal(((await short.json()) as { error: string }).error, 'secret-too-short');

  const created = await postSetup(running.base, {
    token: 'first-admin-token',
    secret: 'first-encryption-secret',
  });
  assert.equal(created.status, 201);
  assert.equal(readFileSync(running.secretFile, 'utf8').trim(), 'first-encryption-secret');
  assert.equal(running.store.readSourcePayload('seed'), 'seed-content');

  assert.equal(await stateStatus(running.base, 'first-admin-token'), 200);
  assert.deepEqual(await setupStatus(running.base), {
    required: false,
    secretRequired: false,
  });

  // 重启后不再要求设置密钥；新密钥能解开，旧临时密钥不能。
  await stop(running);
  instance = undefined;
  const reopened = openStore(dbPath, 'first-encryption-secret');
  assert.equal(reopened.readSourcePayload('seed'), 'seed-content');
  reopened.close();

  const stale = openStore(dbPath, 'ephemeral-before-setup');
  assert.throws(() => stale.readSourcePayload('seed'));
  stale.close();
});

test('只缺密钥时：先鉴权再设置，未设置前管理面返回 503 而不是写坏数据', async (t) => {
  const dir = tempDir();
  const instance = await start({
    dir,
    dbPath: join(dir, 'state.db'),
    secret: 'ephemeral-before-setup',
    secretConfigured: false,
    adminToken: 'existing-admin-token',
  });
  t.after(async () => {
    await stop(instance);
    cleanup(dir);
  });

  assert.deepEqual(await setupStatus(instance.base), {
    required: false,
    secretRequired: true,
  });
  assert.equal(await stateStatus(instance.base, 'existing-admin-token'), 503);

  const anonymous = await postSetup(instance.base, { secret: 'another-encryption-secret' });
  assert.equal(anonymous.status, 401);

  const created = await postSetup(
    instance.base,
    { secret: 'another-encryption-secret' },
    'existing-admin-token',
  );
  assert.equal(created.status, 201);
  assert.equal(readFileSync(instance.secretFile, 'utf8').trim(), 'another-encryption-secret');
  assert.equal(await stateStatus(instance.base, 'existing-admin-token'), 200);
});

test('密钥文件写不进去时：数据库退回旧密钥，不留「库已换钥匙」的半成品', async (t) => {
  const dir = tempDir();
  const dbPath = join(dir, 'state.db');
  // 把密钥文件路径占成非空目录：暂存文件能写，最后那步原子 rename 会失败
  // （Windows EPERM / POSIX EISDIR），正好模拟「库已重加密、文件提交不出去」。
  mkdirSync(join(dir, 'secret.key'));
  writeFileSync(join(dir, 'secret.key', 'blocker'), 'x');

  let instance: Instance | undefined = await start({
    dir,
    dbPath,
    secret: 'ephemeral-before-setup',
    secretConfigured: false,
  });
  t.after(async () => {
    if (instance !== undefined) await stop(instance);
    cleanup(dir);
  });
  const running = instance;

  running.store.putSource({ id: 'seed', name: 'seed', kind: 'inline', enabled: true });
  running.store.writeSourcePayload('seed', 'seed-content');

  const failed = await postSetup(running.base, {
    token: 'first-admin-token',
    secret: 'first-encryption-secret',
  });
  assert.equal(failed.status, 500);
  const body = (await failed.json()) as { error: string };
  assert.equal(body.error, 'secret-persist-failed');

  // 关键断言：重加密必须被撤销，正文仍能用本次启动的旧密钥读出。
  assert.equal(running.store.readSourcePayload('seed'), 'seed-content');
  // 暂存文件不得残留（可能含明文密钥）。
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  );
  // 未设置成功就不该放行管理写入。
  assert.deepEqual(await setupStatus(running.base), {
    required: true,
    secretRequired: true,
  });

  await stop(running);
  instance = undefined;
  // 重开也只认旧密钥：库里若是新密钥，这里会抛解不开。
  const reopened = openStore(dbPath, 'ephemeral-before-setup');
  assert.equal(reopened.readSourcePayload('seed'), 'seed-content');
  reopened.close();
});

test('密钥来源优先级：环境变量 > 密钥文件 > 临时密钥', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'secret.key');
    writeFileSync(file, 'file-secret\n');

    const fromEnv = resolveTokenSecret({ envSecret: 'env-secret', file });
    assert.equal(fromEnv.secret, 'env-secret');
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.configured, true);

    const fromFile = resolveTokenSecret({ envSecret: '   ', file });
    assert.equal(fromFile.secret, 'file-secret');
    assert.equal(fromFile.source, 'file');
    assert.equal(fromFile.configured, true);

    const ephemeral = resolveTokenSecret({ file: join(dir, 'missing.key') });
    assert.equal(ephemeral.source, 'ephemeral');
    assert.equal(ephemeral.configured, false);
    assert.ok(ephemeral.secret.length >= 32);
  } finally {
    cleanup(dir);
  }
});
