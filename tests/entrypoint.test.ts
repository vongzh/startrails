import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CORE_VERSION } from '../src/core/version.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fileURLToPath(new URL('../src/server/index.ts', import.meta.url));

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
}

async function spawnServer(env: NodeJS.ProcessEnv): Promise<Running> {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 10s')), 10_000);
    const check = (): void => {
      if (!output.includes('listening')) return;
      clearTimeout(timer);
      child.stdout?.off('data', check);
      child.stderr?.off('data', check);
      resolve();
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code ?? 'null'}): ${output.slice(0, 400)}`));
    });
    check(); // 覆盖监听注册前已写入的输出
  });
  return { child, output: () => output };
}

async function stopServer(child: ChildProcess): Promise<void> {
  child.kill();
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 文件锁偶发残留，交给系统临时目录清理，不影响验收结论。
  }
}

function baseEnv(dir: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    STARTRAILS_PORT: String(port),
    STARTRAILS_HOST: '127.0.0.1',
    STARTRAILS_TOKEN_SECRET: 'entry-secret',
    STARTRAILS_DATA_DIR: dir,
    STARTRAILS_DB_PATH: join(dir, 'state.db'),
    // 隔离宿主机上的 STARTRAILS_SECRET_FILE，避免测试读写真实部署的密钥文件。
    STARTRAILS_SECRET_FILE: join(dir, 'secret.key'),
  };
}

test('真实进程入口：按环境变量启动，健康检查与 Web UI 都可访问', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-entry-'));
  const port = 18899;
  const { child } = await spawnServer({
    ...baseEnv(dir, port),
    STARTRAILS_ADMIN_TOKEN: 'entry-admin',
  });
  t.after(async () => {
    await stopServer(child);
    removeDir(dir);
  });

  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { coreVersion: string }).coreVersion, CORE_VERSION);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Startrails/);

  const unauthorized = await fetch(`${base}/api/state`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${base}/api/state`, {
    headers: { authorization: 'Bearer entry-admin' },
  });
  assert.equal(authorized.status, 200);
});

test('真实进程入口：未配置管理令牌时进入首次设置，且日志不打印令牌明文', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-entry-'));
  const port = 18900;
  // 显式空值占住这个键，使入口的 loadEnvFile 不会回退项目根 .env，模拟「未配置」。
  const running = await spawnServer({
    ...baseEnv(dir, port),
    STARTRAILS_ADMIN_TOKEN: '',
  });
  t.after(async () => {
    await stopServer(running.child);
    removeDir(dir);
  });

  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/api/setup/status`)).json(), { required: true, secretRequired: false });
  assert.equal((await fetch(`${base}/api/state`)).status, 401);

  const created = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'entry-first-token' }),
  });
  assert.equal(created.status, 201);
  const authorized = await fetch(`${base}/api/state`, {
    headers: { authorization: 'Bearer entry-first-token' },
  });
  assert.equal(authorized.status, 200);

  assert.match(running.output(), /admin setup/);
  assert.doesNotMatch(running.output(), /entry-first-token/);
});

test('真实进程入口：密钥未配置时首次设置落盘，重启后无需再设置', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-entry-'));
  const port = 18901;
  const env = {
    ...baseEnv(dir, port),
    // 显式空值占住两个键：模拟完全没有环境变量与项目 .env 回退的首次启动。
    STARTRAILS_TOKEN_SECRET: '',
    STARTRAILS_ADMIN_TOKEN: '',
  };
  let running = await spawnServer(env);
  t.after(async () => {
    await stopServer(running.child);
    removeDir(dir);
  });

  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await (await fetch(`${base}/api/setup/status`)).json(), {
    required: true,
    secretRequired: true,
  });
  assert.equal((await fetch(`${base}/api/state`)).status, 401);

  const created = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'entry-first-token', secret: 'entry-encryption-secret' }),
  });
  assert.equal(created.status, 201);
  assert.equal(
    readFileSync(join(dir, 'secret.key'), 'utf8').trim(),
    'entry-encryption-secret',
  );
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: 'Bearer entry-first-token' },
      })
    ).status,
    200,
  );
  assert.match(running.output(), /secret setup/);
  assert.doesNotMatch(running.output(), /entry-encryption-secret/);

  // 重启：密钥文件被复用，不再要求设置，管理令牌也仍来自数据库。
  await stopServer(running.child);
  running = await spawnServer(env);
  assert.deepEqual(await (await fetch(`${base}/api/setup/status`)).json(), {
    required: false,
    secretRequired: false,
  });
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { authorization: 'Bearer entry-first-token' },
      })
    ).status,
    200,
  );
});
