import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { uploadToWebDav } from '../src/server/backup.ts';
import { createNotifier } from '../src/server/notify.ts';
import { probeAll, probeTcp } from '../src/server/probe.ts';
import { RuleSetCache, ruleSetKey } from '../src/server/ruleset.ts';

test('通知：未配置渠道时整体关闭，不会静默吞事件也不发请求', async () => {
  const notifier = createNotifier(undefined);
  assert.equal(notifier.describe().enabled, false);
  assert.deepEqual(notifier.describe().channels, []);
  assert.equal(await notifier.notify({ key: 'k', title: 't', body: 'b' }), false);
});

test('通知：同一 key 在窗口期内只发一次，不同 key 各自独立', async () => {
  const calls: string[] = [];
  const notifier = createNotifier(
    { bark: { url: 'https://bark.invalid/push' }, minIntervalMs: 60_000 },
    (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  );
  assert.equal(notifier.describe().enabled, true);
  assert.deepEqual(notifier.describe().channels, ['bark']);

  await notifier.notify({ key: 'refresh-failed:a', title: '拉取失败', body: '上游 500' });
  await notifier.notify({ key: 'refresh-failed:a', title: '拉取失败', body: '上游 500' });
  assert.equal(calls.length, 1, '同一 key 在 60s 内只推一次，避免调度器刷屏');

  await notifier.notify({ key: 'build-rejected:surge', title: '拒绝', body: 'reality' });
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? '', /^https:\/\/bark\.invalid\/push\//, 'Bark 走 path 形式推送');
});

test('通知：渠道报错只影响该渠道，不向上抛', async () => {
  const notifier = createNotifier(
    { telegram: { botToken: 'token', chatId: '1' } },
    (async () => {
      throw new Error('network-down');
    }) as unknown as typeof fetch,
  );
  await assert.doesNotReject(() => notifier.notify({ key: 'x', title: 't', body: 'b' }));
  assert.equal(await notifier.notify({ key: 'x2', title: 't', body: 'b' }), false);
});

test('延迟探测：TCP 握手可测通，端口关闭返回错误而非抛异常', async () => {
  const server = createTcpServer(() => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;

  const ok = await probeTcp('127.0.0.1', port, { timeoutMs: 500, attempts: 1 });
  assert.equal(ok.error, null);
  assert.ok((ok.latencyMs ?? -1) >= 0);

  const closed = await probeTcp('127.0.0.1', 9, { timeoutMs: 300, attempts: 1 });
  assert.equal(closed.latencyMs, null);
  assert.ok(closed.error !== null);

  const samples = await probeAll(
    [
      { nodeKey: 'k1', name: 'A', server: '127.0.0.1', port, kind: 'shadowsocks' },
      { nodeKey: 'k2', name: 'B', server: '127.0.0.1', port, kind: 'vmess' },
      { nodeKey: 'k3', name: 'Hy2', server: '127.0.0.1', port: 9, kind: 'hysteria2' },
      { nodeKey: 'k4', name: 'TUIC', server: '127.0.0.1', port: 9, kind: 'tuic' },
      { nodeKey: 'k5', name: 'WG', server: '127.0.0.1', port: 9, kind: 'wireguard' },
    ],
    { timeoutMs: 500, attempts: 1, concurrency: 2 },
  );
  assert.equal(samples.length, 5);
  const tcpSamples = samples.slice(0, 2);
  assert.ok(tcpSamples.every((sample) => sample.applicable && sample.latencyMs !== null), '并发探测结果顺序与输入一一对应');
  assert.ok(tcpSamples.every((sample) => sample.intercepted), '回环地址必须标成「非公网」，否则 2ms 会被当成好节点');
  const udpSamples = samples.slice(2);
  assert.ok(
    udpSamples.every((sample) => !sample.applicable && sample.latencyMs === null && sample.error === 'udp-only'),
    '纯 UDP 协议节点应跳过 TCP 探测并标为 udp-only',
  );

  await new Promise<void>((done) => server.close(() => done()));
});

test('WebDAV 备份：PUT 上传原始字节、带 Basic 认证、2xx 才算成功', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-dav-'));
  const file = join(dir, 'snapshot.db');
  const payload = Buffer.from('SQLite format 3\0fake-but-binary-safe');
  writeFileSync(file, payload);

  const seen: { method: string; url: string; auth: string; body: Buffer }[] = [];
  let respondWith = 201;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers['authorization'] ?? '',
        body: Buffer.concat(chunks),
      });
      res.writeHead(respondWith);
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;

  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const outcome = await uploadToWebDav(
    { url: `http://127.0.0.1:${port}/dav/startrails`, username: 'me', password: 'pw' },
    file,
    'startrails-1.db',
  );
  assert.match(outcome.remoteUrl, /\/dav\/startrails\/startrails-1\.db$/);
  assert.equal(outcome.bytes, payload.length);
  assert.equal(seen[0]?.method, 'PUT');
  assert.equal(seen[0]?.body.equals(payload), true, '必须原样上传，不能转成文本');
  assert.equal(seen[0]?.auth, `Basic ${Buffer.from('me:pw').toString('base64')}`);

  // 已存在的资源 WebDAV 回 204，也应视为成功。
  respondWith = 204;
  const again = await uploadToWebDav({ url: `http://127.0.0.1:${port}/dav/`, password: 'pw', username: 'me' }, file, 'x.db');
  assert.equal(again.remoteUrl, `http://127.0.0.1:${port}/dav/x.db`);

  respondWith = 401;
  await assert.rejects(
    () => uploadToWebDav({ url: `http://127.0.0.1:${port}/dav/`, username: 'me', password: 'pw' }, file, 'x.db'),
    /webdav-status:401/,
  );
});

test('规则集缓存：磁盘落盘、TTL 内不回源、上游失败回退旧内容', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-ruleset-'));
  let hits = 0;
  let latest = 'DOMAIN-SUFFIX,ads.example.invalid\nIP-CIDR,10.0.0.0/8,no-resolve\n';
  let failing = false;
  const server = createServer((_req, res) => {
    hits += 1;
    if (failing) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(latest);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/ads.list`;

  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  const cache = new RuleSetCache(join(dir, 'rulesets'), undefined, true);
  const key = cache.register(url);
  assert.equal(key, ruleSetKey(url));

  const first = await cache.resolve(url);
  assert.match(first?.body ?? '', /ads\.example\.invalid/);
  assert.equal(hits, 1);

  const second = await cache.resolve(url);
  assert.equal(second?.body, first?.body);
  assert.equal(hits, 1, 'TTL 内直接命中，不再打上游');

  // 新实例（模拟重启）应能直接读磁盘。
  const reopened = new RuleSetCache(join(dir, 'rulesets'), undefined, true);
  const fromDisk = await reopened.resolve(url);
  assert.match(fromDisk?.body ?? '', /ads\.example\.invalid/);

  // TTL 过期 + 上游失败 → 回退旧内容，绝不返回空。
  const shortLived = new RuleSetCache(join(dir, 'rulesets'), 1, true);
  failing = true;
  const stale = await shortLived.resolve(url);
  assert.match(stale?.body ?? '', /ads\.example\.invalid/, '规则集宁可旧也不能空');

  // 内容变化后能落新版本。
  failing = false;
  latest = 'DOMAIN,other.example.invalid\n';
  const changed = await new RuleSetCache(join(dir, 'rulesets'), 1, true).resolve(url);
  assert.match(changed?.body ?? '', /other\.example\.invalid/);

  const onDisk = readFileSync(join(dir, 'rulesets', `${key}.txt`), 'utf8');
  assert.match(onDisk, /other\.example\.invalid/);
});
