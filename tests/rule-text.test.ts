import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRuleText, parseRuleText } from '../web/src/rule-text.ts';

test('parseRuleText 支持脚本数组引号逗号、YAML 列表前缀、注释与 HTTP 规则集', () => {
  const input = [
    '// 私有网段直连',
    '  "IP-CIDR,192.168.31.0/24,🏡 Home-CG,no-resolve", // 家庭网段',
    '  - DOMAIN-SUFFIX,qq.com,DIRECT # 腾讯',
    '  RULE-SET,https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt,REJECT,domain,text',
    '  RULE-SET,ai,🤖 AI',
    '  "MATCH,🌈 Daily",',
  ].join('\n');

  const parsed = parseRuleText(input);
  assert.equal(parsed.rules.length, 4);
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.skipped[0]?.line, 5);
  assert.match(parsed.skipped[0]?.reason ?? '', /http\(s\)/i);

  assert.deepEqual(parsed.rules[0], {
    kind: 'inline',
    condition: { type: 'ipCidr', value: '192.168.31.0/24', noResolve: true },
    policy: '🏡 Home-CG',
  });
  assert.deepEqual(parsed.rules[1], {
    kind: 'inline',
    condition: { type: 'domainSuffix', value: 'qq.com' },
    policy: 'DIRECT',
  });
  assert.deepEqual(parsed.rules[2], {
    kind: 'external',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt',
    policy: 'REJECT',
    shape: 'domain',
    format: 'text',
  });
  assert.deepEqual(parsed.rules[3], {
    kind: 'final',
    policy: '🌈 Daily',
  });
});

test('formatRuleText 与 parseRuleText 可往返序列化规则', () => {
  const original = parseRuleText([
    'DOMAIN,api.example.com,PROXY',
    'DOMAIN-KEYWORD,openai,🤖 AI',
    'GEOSITE,cn,DIRECT',
    'GEOIP,CN,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'RULE-SET,https://example.com/list.yaml,PROXY,rules,yaml',
    'MATCH,DIRECT',
  ].join('\n')).rules;

  const text = formatRuleText(original);
  const roundTrip = parseRuleText(text);
  assert.equal(roundTrip.skipped.length, 0);
  assert.deepEqual(roundTrip.rules, original);
});
