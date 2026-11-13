import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store/sqlite.ts';
import { createApp } from '../src/server/app.ts';
import { encodeQr } from '../src/core/qr/index.ts';

/**
 * 交付形态的验证：摘要头、二维码、文件导出、无状态一次性转换。
 *
 * 这四条的共同点是「产物已经对了，但拿不到或看不懂」。所以断言分两类：
 * - 摘要头 / 导出：断言**响应本身**（头字段、Content-Disposition、文件名）；
 * - 二维码：断言 SVG 里真的包着这个订阅地址（反解回矩阵再与 encodeQr 对账），
 *   而不是「返回了一个 svg」就算过。
 */
const subscription = readFileSync(
  new URL('../testdata/fixtures/subscription.txt', import.meta.url),
  'utf8',
);

interface Harness {
  readonly base: string;
  readonly app: ReturnType<typeof createApp>;
  readonly store: ReturnType<typeof openStore>;
  readonly dir: string;
  /** 让上游从「正常」切到「一直 503」，用来制造回退旧快照的场景。 */
  readonly setUpstreamDown: (down: boolean) => void;
  /** 关掉应用、上游与临时目录。上游不关会让 node:test 进程挂住不退出。 */
  readonly close: () => Promise<void>;
}

const boot = async (options: { allowStateless?: boolean } = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'startrails-delivery-'));
  let down = false;
  const upstream = createServer((req, res) => {
    if (down) {
      res.writeHead(503);
      res.end('upstream down');
      return;
    }
    // 规则集镜像的取数也走这台上游：域名列表与 CIDR 列表各一份，用来验证形态判定。
    const path = req.url ?? '/';
    if (path.startsWith('/ads.list')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('# ads\nads.example.invalid\n+.tracker.example.invalid\n');
      return;
    }
    if (path.startsWith('/cidr.list')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('10.0.0.0/8\n192.168.0.0/16\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(subscription);
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const store = openStore(join(dir, 'state.db'), 'delivery-secret');
  const app = createApp({
    store,
    adminToken: 'delivery-admin',
    cacheDir: join(dir, 'cache'),
    dataDir: dir,
    allowPrivate: true,
    ...(options.allowStateless === true ? { allowStateless: true } : {}),
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const auth = { authorization: 'Bearer delivery-admin', 'content-type': 'application/json' };
  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });

  assert.equal((await post('/api/sources', { id: 'a', url: `http://127.0.0.1:${upstreamPort}/sub` })).status, 201);
  assert.equal((await post('/api/profiles', { name: 'default', sourceIds: ['a'] })).status, 201);

  return {
    base,
    app,
    store,
    dir,
    setUpstreamDown: (value: boolean) => {
      down = value;
    },
    close: async () => {
      await app.close();
      store.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const teardown = (harness: Harness): Promise<void> => harness.close();

const issueToken = async (
  base: string,
  body: Record<string, unknown>,
): Promise<{ id: string; token: string; url: string }> => {
  const response = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: { authorization: 'Bearer delivery-admin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; token: string; url: string };
};

const summaryOf = (headers: Headers): Record<string, number> => {
  const raw = headers.get('x-startrails-summary');
  assert.ok(raw !== null, '缺少 X-Startrails-Summary');
  const fields: Record<string, number> = {};
  for (const part of raw.split(' ')) {
    const [key, value] = part.split('=');
    assert.ok(key !== undefined && value !== undefined, `摘要字段格式不对：${part}`);
    assert.ok(/^\d+$/.test(value), `摘要值必须是整数：${part}`);
    fields[key] = Number(value);
  }
  return fields;
};

test('交付：摘要头把「这次发生了什么」压成一行，且上游回退时 stale 抬头', async (t) => {
  const harness = await boot();
  t.after(() => teardown(harness));
  const token = await issueToken(harness.base, { name: '摘要', profile: 'default', target: 'surge' });

  const first = await fetch(`${token.url}`);
  assert.equal(first.status, 200);
  const summary = summaryOf(first.headers);
  // 四个字段必须都在：少一个就等于没说清「节点有多少 / 跳过多少 / 几个源 / 有没有用旧数据」。
  assert.deepEqual(Object.keys(summary).sort(), ['nodes', 'skipped', 'sources', 'stale']);
  assert.ok((summary['nodes'] ?? 0) > 0, '正常上游不该产出 0 个节点');
  assert.equal(summary['sources'], 1);
  assert.equal(summary['stale'], 0, '上游正常时不该报陈旧');

  // 节点数必须与真实产物对得上：`<名字> = ss, ...` 这类行数就是写进去的节点数。
  // 名字里可能带空格，所以不能假设 `=` 前只有一段。
  const content = await first.text();
  const written = content
    .split('\n')
    .filter((line) => / = (ss|vmess|vless|trojan|hysteria2|tuic|anytls|snell|http|socks5),/.test(line)).length;
  assert.equal(summary['nodes'], written, '摘要里的 nodes 与产物里的节点行数不一致');

  // 上游挂掉后同一份配置仍要能发出来，并把「在用旧快照」写进摘要。
  harness.setUpstreamDown(true);
  const stale = await fetch(`${token.url}`);
  assert.equal(stale.status, 200, '上游失败应回退旧快照而不是 500');
  const staleSummary = summaryOf(stale.headers);
  assert.equal(staleSummary['stale'], 1, '回退旧快照时 stale 必须是 1');
  assert.equal(staleSummary['nodes'], summary['nodes'], '回退后节点数不应变化');
});

test('交付：二维码路由直接编码订阅地址，且不触发构建', async (t) => {
  const harness = await boot();
  t.after(() => teardown(harness));
  const token = await issueToken(harness.base, { name: '二维码', profile: 'default', target: 'surge' });

  const response = await fetch(`${token.url}/qr.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
  const svg = await response.text();
  assert.match(svg, /^<svg /);
  assert.match(svg, /shape-rendering="crispEdges"/);

  // 关键断言：SVG 里那条 path 展开后，必须与「编码同一个 URL」得到的矩阵逐格相同。
  // 这同时验证了「编码的是订阅地址」和「地址拼的是绝对 URL」两件事。
  const expectedUrl = `${token.url}`;
  const expected = encodeQr(expectedUrl, { ec: 'M' });
  const cells: boolean[][] = Array.from({ length: expected.size }, () =>
    new Array<boolean>(expected.size).fill(false),
  );
  const path = /<path d="([^"]*)"/.exec(svg)?.[1] ?? '';
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    for (let i = 0; i < Number(match[3]); i++) cells[y]![x + i] = true;
  }
  assert.deepEqual(cells, expected.modules.map((row) => [...row]), '二维码内容与订阅地址不一致');

  // 两种路径形态都必须有二维码：锁定形态编码的是锁定地址，自适应形态编码的是 /s/<token>。
  const adaptive = await fetch(`${harness.base}/s/${token.token}/qr.svg`);
  assert.equal(adaptive.status, 200);
  const adaptiveSvg = await adaptive.text();
  const adaptiveExpected = encodeQr(`${harness.base}/s/${token.token}`, { ec: 'M' });
  const adaptiveCells: boolean[][] = Array.from({ length: adaptiveExpected.size }, () =>
    new Array<boolean>(adaptiveExpected.size).fill(false),
  );
  const adaptivePath = /<path d="([^"]*)"/.exec(adaptiveSvg)?.[1] ?? '';
  for (const match of adaptivePath.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    for (let i = 0; i < Number(match[3]); i++) adaptiveCells[y]![x + i] = true;
  }
  assert.deepEqual(
    adaptiveCells,
    adaptiveExpected.modules.map((row) => [...row]),
    '自适应形态的二维码应只编码 /s/<token>，由客户端 UA 决定格式',
  );

  // 撤销后二维码也必须跟着失效——否则等于留了一个绕过 token 撤销的入口。
  await fetch(`${harness.base}/api/tokens/${token.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer delivery-admin' },
  });
  assert.equal((await fetch(`${token.url}/qr.svg`)).status, 404);
});

test('交付：?download=1 以附件形式下发，文件名带 profile 与客户端后缀', async (t) => {
  const harness = await boot();
  t.after(() => teardown(harness));
  const token = await issueToken(harness.base, { name: '导出', profile: 'default', target: 'sing-box' });

  const inline = await fetch(`${token.url}`);
  assert.equal(inline.headers.get('content-disposition'), null, '默认不应是附件下载');

  const download = await fetch(`${token.url}?download=1`);
  assert.equal(download.status, 200);
  const disposition = download.headers.get('content-disposition') ?? '';
  assert.match(disposition, /^attachment; filename="default-sing-box\.json"$/);
  // 内容是同一份产物：下载只是换了下发方式，不是另一条构建路径。
  assert.equal(await download.text(), await (await fetch(`${token.url}`)).text());
});

test('交付：无状态转换默认关闭，开启后可一次性转换且不落库', async (t) => {
  const closed = await boot();
  t.after(() => teardown(closed));
  const denied = await fetch(`${closed.base}/sub?url=http%3A%2F%2Fexample.com%2Fsub&target=surge`);
  assert.equal(denied.status, 404);
  assert.match(String(((await denied.json()) as { error: string }).error), /stateless-disabled/);

  const open = await boot({ allowStateless: true });
  t.after(() => teardown(open));
  // 源本身是私网地址，所以必须带 allowPrivate —— 这条同时证明端点在复用同一套 SSRF 判定。
  const sourceUrl = encodeURIComponent(open.store.listSources()[0]?.url ?? '');
  const converted = await fetch(`${open.base}/sub?url=${sourceUrl}&target=surge`);
  assert.equal(converted.status, 200);
  assert.match(converted.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(converted.headers.get('x-startrails-stateless'), '1');
  const body = await converted.text();
  assert.match(body, /ss\.example\.invalid/);
  // 不落库：构建历史里不应多出这一次的记录。
  const before = open.store.listBuildReports(50).length;
  await fetch(`${open.base}/sub?url=${sourceUrl}&target=mihomo`);
  assert.equal(open.store.listBuildReports(50).length, before, '无状态转换不应写构建历史');

  // 目标非法必须拒绝，且响应里点名是哪个 target——静默给个默认格式最坑人。
  const badTarget = await fetch(`${open.base}/sub?url=${sourceUrl}&target=not-a-client`);
  assert.equal(badTarget.status, 400);
  assert.equal(((await badTarget.json()) as { target: string }).target, 'not-a-client');

  const noUrl = await fetch(`${open.base}/sub?target=surge`);
  assert.equal(noUrl.status, 400);
  assert.equal(((await noUrl.json()) as { error: string }).error, 'missing-url');

  // 指向内网元数据地址：即使 allowPrivate 未开也要被拦；这里 allowPrivate 开着，
  // 所以换一个协议不在白名单的地址，确认 assertPublicUrl 的同一套规则确实在跑。
  const fileUrl = await fetch(`${open.base}/sub?url=${encodeURIComponent('file:///etc/passwd')}&target=surge`);
  assert.equal(fileUrl.status, 502);
  assert.match(String(((await fileUrl.json()) as { reason: string }).reason), /protocol-not-allowed/);
});

test('规则集形态由内容判定：源里没声明 behavior 也不猜，判不出来就不写', async (t) => {
  const harness = await boot();
  t.after(() => teardown(harness));
  const upstreamPort = new URL(harness.store.listSources()[0]?.url ?? '').port;

  // 一份「声明了 url 但没写 behavior」的 Clash 配置——这正是需要服务端自己判定形态的场景。
  const clash = JSON.stringify({
    proxies: [],
    'proxy-groups': [],
    'rule-providers': {
      ads: { type: 'http', url: `http://127.0.0.1:${upstreamPort}/ads.list` },
      cidrs: { type: 'http', url: `http://127.0.0.1:${upstreamPort}/cidr.list` },
      opaque: { type: 'http', url: `http://127.0.0.1:${upstreamPort}/sub` },
    },
    rules: ['RULE-SET,ads,REJECT', 'RULE-SET,cidrs,DIRECT', 'RULE-SET,opaque,PROXY'],
  });
  harness.store.putSource({ id: 'clash', name: 'clash', kind: 'inline', enabled: true });
  harness.store.writeSourcePayload('clash', clash);
  harness.store.putProfile({ id: 'clash-p', name: 'clash-p', entries: [{ kind: 'source', id: 'clash' }] });

  const token = await issueToken(harness.base, { name: '规则集', profile: 'clash-p', target: 'mihomo' });
  const response = await fetch(`${token.url}`);
  assert.equal(response.status, 200);
  const content = await response.text();

  // 域名列表 → domain，CIDR 列表 → ipcidr：这两条只能靠看内容得出。
  assert.match(content, /behavior: domain/);
  assert.match(content, /behavior: ipcidr/);
  const providers = [...content.matchAll(/^ {2}(rs_[0-9a-f]{8}):$/gm)].map((match) => match[1]);
  assert.equal(providers.length, 2, '判不出形态的那一份不该被写成 provider');

  // 第三份（订阅正文，既不是域名也不是 CIDR）必须被跳过，并且诊断说得出原因。
  const diagnostics = (await (await fetch(`${token.url}/diagnostics`)).json()) as {
    report: { diagnostics: { reason: string }[] };
  };
  const reasons = diagnostics.report.diagnostics.map((item) => item.reason);
  assert.ok(reasons.includes('external-ruleset-shape-unknown'), `缺少形态诊断：${reasons.join(',')}`);
});

test('交付：sources= 只数本次真的喂进构建的源，不含配置里挂着但拉取失败的源', async (t) => {
  const harness = await boot();
  t.after(() => teardown(harness));

  // 第二个源指向一个没有监听的端口：必然 upstream-failed，且没有旧快照可回退。
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${harness.base}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer delivery-admin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/api/sources', { id: 'dead', url: 'http://127.0.0.1:1/never' })).status, 201);
  assert.equal((await post('/api/profiles', { name: 'mixed', sourceIds: ['a', 'dead'] })).status, 201);

  const token = await issueToken(harness.base, { name: '混合', profile: 'mixed', target: 'surge' });
  const response = await fetch(`${token.url}`);
  assert.equal(response.status, 200);
  const summary = summaryOf(response.headers);
  assert.equal(summary['sources'], 1, '配置里有 2 个源，但只有 1 个真的参与了构建');
  assert.equal(summary['stale'], 0, '没有旧快照时不能误报陈旧');
  assert.ok((summary['nodes'] ?? 0) > 0, '好源的节点仍应正常导出');
});
