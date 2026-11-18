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

test('parseRuleText 支持逻辑规则 AND/OR/NOT、别名、subconverter 前缀、FINAL 与引号安全注释', () => {
  const input = [
    '; Surge 注释行',
    'HOST,app.example.com,PROXY # 行尾注释',
    'HOST-SUFFIX,cdn.example.com,DIRECT ; 分号注释',
    'IP6-CIDR,fe80::/10,DIRECT,no-resolve',
    'RULE-SET,clash-ipcidr:https://rules.example.invalid/cncidr.txt,DIRECT',
    'RULE-SET,clash-classic:https://rules.example.invalid/custom.list,PROXY',
    'AND,((DOMAIN,x.com),(OR,((DOMAIN-SUFFIX,y.com),(IP-CIDR,10.0.0.0/8,no-resolve)))),PROXY',
    'NOT,((DOMAIN,blocked.example.com)),DIRECT',
    'FINAL,🌈 Daily,dns-failed',
  ].join('\n');

  const parsed = parseRuleText(input);
  assert.equal(parsed.skipped.length, 0);
  assert.equal(parsed.rules.length, 8);

  assert.deepEqual(parsed.rules[0], {
    kind: 'inline',
    condition: { type: 'domain', value: 'app.example.com' },
    policy: 'PROXY',
  });
  assert.deepEqual(parsed.rules[1], {
    kind: 'inline',
    condition: { type: 'domainSuffix', value: 'cdn.example.com' },
    policy: 'DIRECT',
  });
  assert.deepEqual(parsed.rules[2], {
    kind: 'inline',
    condition: { type: 'ipCidr6', value: 'fe80::/10', noResolve: true },
    policy: 'DIRECT',
  });
  assert.deepEqual(parsed.rules[3], {
    kind: 'external',
    url: 'https://rules.example.invalid/cncidr.txt',
    policy: 'DIRECT',
    shape: 'ipcidr',
    format: 'text',
  });
  assert.deepEqual(parsed.rules[4], {
    kind: 'external',
    url: 'https://rules.example.invalid/custom.list',
    policy: 'PROXY',
    shape: 'rules',
    format: 'text',
  });
  assert.deepEqual(parsed.rules[5], {
    kind: 'inline',
    condition: {
      type: 'and',
      children: [
        { type: 'domain', value: 'x.com' },
        {
          type: 'or',
          children: [
            { type: 'domainSuffix', value: 'y.com' },
            { type: 'ipCidr', value: '10.0.0.0/8', noResolve: true },
          ],
        },
      ],
    },
    policy: 'PROXY',
  });
  assert.deepEqual(parsed.rules[6], {
    kind: 'inline',
    condition: { type: 'not', child: { type: 'domain', value: 'blocked.example.com' } },
    policy: 'DIRECT',
  });
  assert.deepEqual(parsed.rules[7], { kind: 'final', policy: '🌈 Daily' });

  // 复合条件 + 所有规则往返一致
  const formatted = formatRuleText(parsed.rules);
  const roundTrip = parseRuleText(formatted);
  assert.equal(roundTrip.skipped.length, 0);
  assert.deepEqual(roundTrip.rules, parsed.rules);
});

test('parseRuleText 对不闭合的括号或引号报错并跳过', () => {
  const broken = parseRuleText([
    'AND,((DOMAIN,a.com),(DOMAIN,b.com),PROXY',
    'DOMAIN,ok.com,DIRECT',
  ].join('\n'));
  assert.equal(broken.rules.length, 1);
  assert.equal(broken.skipped.length, 1);
  assert.equal(broken.skipped[0]?.line, 1);
});
