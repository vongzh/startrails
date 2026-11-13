import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HIGHLIGHT_LINES, highlight } from '../web/src/code-highlight.ts';

const htmlOf = (text: string, dialect: string): string => highlight(text, dialect).html;

test('Surge：分节与注释各自成档，代理行的协议名高亮', () => {
  const html = htmlOf('[Proxy]\n# 香港\n香港 01 直连 = ss, hk01.demo.example, 8443, password=demo-a1', 'surge-ini');

  assert.ok(html.includes('<span class="tk-e">[Proxy]</span>'));
  assert.ok(html.includes('<span class="tk-c"># 香港</span>'));
  // 节点名整段一个 token：按空格分词会把它拆碎，这里必须保持完整
  assert.ok(html.includes('<span class="tk-n">香港 01 直连</span>'));
  assert.ok(html.includes('<span class="tk-e"> ss</span>'));
  // 端口与参数不上色，避免满行彩色
  assert.ok(html.includes('8443'));
  assert.ok(!html.includes('tk-e">8443'));
});

test('Surge：规则行只有首段（规则类型）与末段（策略）上色', () => {
  const html = htmlOf('[Rule]\nDOMAIN-SUFFIX,example.com,PROXY\nFINAL,DIRECT', 'surge-ini');

  assert.ok(html.includes('<span class="tk-e">DOMAIN-SUFFIX</span>,example.com,<span class="tk-n">PROXY</span>'));
  assert.ok(html.includes('<span class="tk-e">FINAL</span>,<span class="tk-n">DIRECT</span>'));
});

test('Quantumult X：等号左侧是类型，规则节同构', () => {
  const serverLocal = htmlOf('[server_local]\nshadowsocks=1.1.1.1:8388, method=aes-256-gcm, tag=香港01', 'quanx-ini');
  assert.ok(serverLocal.includes('<span class="tk-e">shadowsocks</span>='));
  assert.ok(!serverLocal.includes('tk-k'));

  const filter = htmlOf('[filter_local]\nhost-suffix, example.com, direct', 'quanx-ini');
  assert.ok(filter.includes('<span class="tk-e">host-suffix</span>'));
  assert.ok(filter.includes('<span class="tk-n"> direct</span>'));
});

test('YAML：键上色，type 的值命中协议表才强调', () => {
  const html = htmlOf('  type: ss\n  name: 香港 01\n  skip-cert-verify: true', 'clash-yaml');

  assert.ok(html.includes('<span class="tk-k">type</span>: <span class="tk-e">ss</span>'));
  assert.ok(html.includes('<span class="tk-k">name</span>: <span class="tk-n">香港 01</span>'));
  // 非协议值不强调
  assert.ok(html.includes('<span class="tk-k">skip-cert-verify</span>: true'));
  assert.ok(!html.includes('tk-e"> true'));
});

test('YAML：列表前缀保留，注释整行变注释', () => {
  const html = htmlOf('proxies:\n  - name: 香港 01\n# 段注释', 'clash-yaml');
  assert.ok(html.includes('proxies'));
  assert.ok(html.includes('- <span class="tk-k">name</span>: <span class="tk-n">香港 01</span>'));
  assert.ok(html.includes('<span class="tk-c"># 段注释</span>'));
});

test('JSON：键上色，type 的字符串值命中协议表才强调', () => {
  const html = htmlOf('    "type": "shadowsocks",\n    "tag": "香港 01"', 'sing-box-json');

  // 引号在渲染前已转义成 &quot;，浏览器里仍然是正常的双引号
  assert.ok(html.includes('<span class="tk-k">&quot;type&quot;</span>: <span class="tk-e">&quot;shadowsocks&quot;</span>'));
  assert.ok(html.includes('<span class="tk-k">&quot;tag&quot;</span>: <span class="tk-n">&quot;香港 01&quot;</span>'));
});

test('分享链接：协议前缀上色，井号后的备注按名字处理', () => {
  const html = htmlOf('ss://YWVzLTI1Ni1nY206ZGVtbw==@hk01.demo.example:8443#香港 01', 'uri-list');
  assert.ok(html.includes('<span class="tk-e">ss</span>://'));
  assert.ok(html.includes('#<span class="tk-n">香港 01</span>'));
});

test('产物里的尖括号与 & 必须转义，避免破坏结构或注入', () => {
  const html = htmlOf('  password: a&b<c>d', 'clash-yaml');
  assert.ok(html.includes('a&amp;b&lt;c&gt;d'));
  assert.ok(!html.includes('<c>'));
});

test('未知方言回退为纯文本，仍保留行号', () => {
  const result = highlight('[Proxy]\nss, hk01, 8443', 'whatever-ini');
  assert.equal(result.plain, true);
  assert.equal(result.lines, 2);
  assert.ok(result.html.includes('cv-n">1<'));
  assert.ok(!result.html.includes('tk-e'));
});

test('超大产物不再着色，避免几万个节点拖慢滚动', () => {
  const text = Array.from({ length: MAX_HIGHLIGHT_LINES + 5 }, (_, index) => `line-${index}`).join('\n');
  const result = highlight(text, 'surge-ini');
  assert.equal(result.plain, true);
  assert.equal(result.lines, MAX_HIGHLIGHT_LINES + 5);
});

test('末行换行不多算一行，行号与「N 行」一致', () => {
  const result = highlight('a\nb\n', 'uri-list');
  assert.equal(result.lines, 2);
  assert.ok(result.html.endsWith('</div>'));
  assert.equal(result.html.match(/cv-line/g)?.length, 2);
});
