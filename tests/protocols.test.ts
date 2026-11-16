import assert from 'node:assert/strict';
import test from 'node:test';
import { emit, ingest, plan } from '../src/core/index.ts';

const profileOf = (nodes: readonly unknown[]) =>
  ingest(JSON.stringify({ nodes, ruleSources: [], policyGroups: [] })).profile;

const emittersOf = (nodes: readonly unknown[]) => {
  const profile = profileOf(nodes);
  const pick = (target: Parameters<typeof plan>[1]) => emit(profile, plan(profile, target)).content;
  return { profile, pick };
};

test('Hysteria2 URI：官方 scheme 的 auth / obfs / sni / insecure / 端口跳跃都进 IR', () => {
  const { profile } = ingest(
    [
      'hysteria2://letmein@hy.example.invalid:443/?sni=real.example.invalid&insecure=1&obfs=salamander&obfs-password=gawr&pinSHA256=dead#香港 HY2',
      'hy2://pw2@hy2.example.invalid:8443/?obfs=gecko#日本 HY2',
    ].join('\n'),
  );
  assert.equal(profile.nodes.length, 2);
  const first = profile.nodes[0];
  assert.equal(first?.kind, 'hysteria2');
  assert.equal(first?.name, '香港 HY2');
  if (first?.kind !== 'hysteria2') return;
  assert.equal(first.password, 'letmein');
  assert.equal(first.options?.sni, 'real.example.invalid');
  assert.equal(first.options?.insecure, true);
  assert.deepEqual(first.options?.obfs, { type: 'salamander', password: 'gawr' });

  // 端口跳跃写法：首个数字为主端口，其余原样留在 ports。
  const hopping = ingest('hysteria2://pw@hy.example.invalid:443,5000-6000/?sni=a.example.invalid');
  assert.equal(hopping.profile.nodes[0]?.port, 443);
  assert.equal(hopping.profile.nodes[0]?.options?.ports, '443,5000-6000');
});

test('TUIC / AnyTLS URI：v5 的 uuid+password 与 password 各自落到正确字段', () => {
  const { profile } = ingest(
    [
      'tuic://11111111-2222-3333-4444-555555555555:pw@tuic.example.invalid:443/?sni=t.example.invalid&congestion_control=bbr&udp_relay_mode=quic&alpn=h3#TUIC',
      'anytls://secret@any.example.invalid:8443/?sni=a.example.invalid&insecure=1#AnyTLS',
    ].join('\n'),
  );
  const tuic = profile.nodes.find((node) => node.kind === 'tuic');
  const anytls = profile.nodes.find((node) => node.kind === 'anytls');
  assert.ok(tuic !== undefined && anytls !== undefined);
  if (tuic?.kind !== 'tuic' || anytls?.kind !== 'anytls') return;
  assert.equal(tuic.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(tuic.password, 'pw');
  assert.equal(tuic.options?.congestionControl, 'bbr');
  assert.equal(tuic.options?.udpRelayMode, 'quic');
  assert.deepEqual(tuic.options?.alpn, ['h3']);
  assert.equal(anytls.password, 'secret');
  assert.equal(anytls.options?.insecure, true);

  // v4 只有 token，本 IR 不建模，必须明确拒绝而不是猜成 uuid。
  const legacy = ingest('tuic://tokenonly@tuic.example.invalid:443#v4');
  assert.equal(legacy.profile.nodes.length, 0);
  assert.ok(legacy.diagnostics.some((d) => d.reason === 'tuic-requires-uuid-password'));
});

test('VLESS Reality：pbk / sid / fp / spx 进 IR，普通 TLS 与之互斥', () => {
  const { profile } = ingest(
    'vless://uuid@r.example.invalid:443?security=reality&sni=www.microsoft.com&pbk=PUBKEY&sid=abcd&fp=chrome&spx=%2F&flow=xtls-rprx-vision#Reality',
  );
  const node = profile.nodes[0];
  assert.equal(node?.kind, 'vless');
  assert.deepEqual(node?.options?.reality, {
    publicKey: 'PUBKEY',
    shortId: 'abcd',
    fingerprint: 'chrome',
    spiderX: '/',
  });
  assert.equal(node?.options?.tls, true);
});

test('SS SIP002 插件参数解析为 plugin + pluginOpts，而不是丢掉', () => {
  const credential = Buffer.from('aes-256-gcm:pw').toString('base64');
  const { profile } = ingest(
    `ss://${credential}@ss.example.invalid:443?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dbing.com#Obfs`,
  );
  const node = profile.nodes[0];
  assert.equal(node?.kind, 'shadowsocks');
  assert.equal(node?.options?.plugin, 'obfs-local');
  assert.equal(node?.options?.pluginOpts?.mode, 'http');
  assert.equal(node?.options?.pluginOpts?.host, 'bing.com');
});

test('Clash YAML：hysteria2 / tuic / anytls / snell 与 reality-opts / plugin-opts 都能读', () => {
  const yaml = `
proxies:
  - { name: HY2, type: hysteria2, server: hy.example.invalid, port: 443, password: pw, sni: a.example.invalid, obfs: salamander, obfs-password: ob, up: 30, down: 200, ports: 443-8443 }
  - { name: TUIC, type: tuic, server: t.example.invalid, port: 443, uuid: uuid, password: pw, congestion-controller: bbr, udp-relay-mode: native, alpn: [h3], skip-cert-verify: true }
  - { name: AT, type: anytls, server: at.example.invalid, port: 443, password: pw, idle-session-timeout: 30 }
  - { name: SN, type: snell, server: sn.example.invalid, port: 8388, psk: pskv, version: 4, obfs-opts: { mode: http, host: bing.com } }
  - type: vless
    name: R
    server: r.example.invalid
    port: 443
    uuid: uuid
    tls: true
    servername: www.microsoft.com
    client-fingerprint: chrome
    network: ws
    ws-opts: { path: /ws, headers: { Host: cdn.example.invalid } }
    reality-opts: { public-key: PUBKEY, short-id: abcd }
  - { name: SSO, type: ss, server: ss.example.invalid, port: 443, cipher: aes-256-gcm, password: pw, plugin: obfs, plugin-opts: { mode: tls, host: bing.com } }
`;
  const { profile } = ingest(yaml);
  assert.equal(profile.nodes.length, 6);
  const hy2 = profile.nodes.find((node) => node.kind === 'hysteria2');
  if (hy2?.kind === 'hysteria2') {
    assert.deepEqual(hy2.options?.bandwidth, { up: 30, down: 200 });
    assert.equal(hy2.options?.ports, '443-8443');
    assert.deepEqual(hy2.options?.obfs, { type: 'salamander', password: 'ob' });
  }
  const snell = profile.nodes.find((node) => node.kind === 'snell');
  if (snell?.kind === 'snell') {
    assert.equal(snell.psk, 'pskv');
    assert.equal(snell.options?.version, 4);
    assert.deepEqual(snell.options?.obfs, { type: 'http', host: 'bing.com' });
  }
  const reality = profile.nodes.find((node) => node.kind === 'vless');
  if (reality?.kind === 'vless') {
    assert.equal(reality.options?.reality?.publicKey, 'PUBKEY');
    assert.equal(reality.options?.transport, 'ws');
    assert.equal(reality.options?.path, '/ws');
    assert.equal(reality.options?.host, 'cdn.example.invalid');
    assert.equal(reality.options?.fingerprint, 'chrome');
  }
  const ss = profile.nodes.find((node) => node.kind === 'shadowsocks');
  assert.equal(ss?.options?.plugin, 'obfs');
  assert.equal(ss?.options?.pluginOpts?.mode, 'tls');
});

test('sing-box JSON：tls 子对象与 transport 子对象完整还原', () => {
  const json = JSON.stringify({
    outbounds: [
      {
        type: 'vless',
        tag: 'R',
        server: 'r.example.invalid',
        server_port: 443,
        uuid: 'uuid',
        flow: 'xtls-rprx-vision',
        tls: {
          enabled: true,
          server_name: 'www.microsoft.com',
          insecure: true,
          alpn: ['h2'],
          utls: { enabled: true, fingerprint: 'chrome' },
          reality: { enabled: true, public_key: 'PUBKEY', short_id: 'abcd' },
        },
        transport: { type: 'grpc', service_name: 'svc' },
      },
      {
        type: 'hysteria2',
        tag: 'HY',
        server: 'hy.example.invalid',
        server_port: 443,
        password: 'pw',
        up_mbps: 30,
        down_mbps: 200,
        obfs: { type: 'salamander', password: 'ob' },
        tls: { enabled: true, server_name: 'hy.example.invalid' },
      },
      {
        type: 'shadowsocks',
        tag: 'SS',
        server: 'ss.example.invalid',
        server_port: 443,
        method: 'aes-256-gcm',
        password: 'pw',
        plugin: 'obfs-local',
        plugin_opts: 'obfs=http;obfs-host=bing.com',
      },
    ],
  });
  const { profile } = ingest(json);
  assert.equal(profile.nodes.length, 3);
  const vless = profile.nodes.find((node) => node.kind === 'vless');
  if (vless?.kind === 'vless') {
    assert.equal(vless.options?.reality?.publicKey, 'PUBKEY');
    assert.equal(vless.options?.fingerprint, 'chrome');
    assert.equal(vless.options?.insecure, true);
    assert.deepEqual(vless.options?.alpn, ['h2']);
    assert.equal(vless.options?.transport, 'grpc');
    assert.equal(vless.options?.path, 'svc');
  }
  const hy2 = profile.nodes.find((node) => node.kind === 'hysteria2');
  if (hy2?.kind === 'hysteria2') {
    assert.deepEqual(hy2.options?.bandwidth, { up: 30, down: 200 });
    assert.equal(hy2.options?.obfs?.type, 'salamander');
  }
  const ss = profile.nodes.find((node) => node.kind === 'shadowsocks');
  assert.equal(ss?.options?.plugin, 'obfs-local');
  assert.equal(ss?.options?.pluginOpts?.mode, 'http');
});

test('Surge / Loon 配置行：Hysteria2 / tuic-v5 / snell / AnyTLS 都能解析', () => {
  const conf = `
[Proxy]
HY = Hysteria2,hy.example.invalid,443,"pw",sni=hy.example.invalid,salamander-password=ob,download-bandwidth=200,server-ports="20000:20100"
TU = tuic-v5,t.example.invalid,443,uuid=uuid,password=pw,alpn=h3
SN = snell,sn.example.invalid,8388,psk=pskv,version=4,obfs=http,obfs-host=bing.com
AT = AnyTLS,at.example.invalid,443,"pw",sni=at.example.invalid,idle-session-timeout=30
VL = VLESS,v.example.invalid,443,"uuid",transport=ws,path=/ws,host=cdn.example.invalid,public-key="PUBKEY",short-id=abcd,sni=www.microsoft.com,tls-profile=chrome
`;
  const { profile } = ingest(conf);
  assert.equal(profile.nodes.length, 5);
  const hy2 = profile.nodes.find((node) => node.kind === 'hysteria2');
  if (hy2?.kind === 'hysteria2') {
    assert.equal(hy2.options?.obfs?.password, 'ob');
    assert.equal(hy2.options?.bandwidth?.down, 200);
    assert.equal(hy2.options?.ports, '20000:20100');
  }
  const tuic = profile.nodes.find((node) => node.kind === 'tuic');
  assert.equal(tuic?.kind === 'tuic' ? tuic.uuid : undefined, 'uuid');
  const snell = profile.nodes.find((node) => node.kind === 'snell');
  if (snell?.kind === 'snell') assert.equal(snell.options?.version, 4);
  const anytls = profile.nodes.find((node) => node.kind === 'anytls');
  assert.equal(anytls?.options?.idleSessionTimeout, 30);
  const vless = profile.nodes.find((node) => node.kind === 'vless');
  if (vless?.kind === 'vless') {
    assert.equal(vless.options?.reality?.shortId, 'abcd');
    assert.equal(vless.options?.host, 'cdn.example.invalid');
    assert.equal(vless.options?.fingerprint, 'chrome');
  }
});

test('Surge 输出：hysteria2 / tuic-v5 / snell 行格式与官方手册一致', () => {
  const { pick } = emittersOf([
    {
      kind: 'hysteria2',
      name: 'HY',
      server: 'hy.example.invalid',
      port: 443,
      password: 'pw',
      options: {
        sni: 'hy.example.invalid',
        obfs: { type: 'salamander', password: 'ob' },
        bandwidth: { down: 200 },
        ports: '20000-30000',
      },
    },
    { kind: 'tuic', name: 'TU', server: 't.example.invalid', port: 443, uuid: 'uuid', password: 'pw' },
    {
      kind: 'snell',
      name: 'SN',
      server: 'sn.example.invalid',
      port: 8388,
      psk: 'pskv',
      options: { version: 4, obfs: { type: 'http', host: 'bing.com' } },
    },
  ]);
  const surge = pick('surge');
  assert.match(surge, /= hysteria2, hy\.example\.invalid, 443, password=pw, sni=hy\.example\.invalid/);
  assert.match(surge, /salamander-password=ob/);
  assert.match(surge, /download-bandwidth=200/);
  assert.match(surge, /port-hopping=20000-30000/);
  // TUIC v5 的关键字是 tuic-v5，不是 tuic（后者在 Surge 里是 v4 token 模式）。
  assert.match(surge, /= tuic-v5, t\.example\.invalid, 443, uuid=uuid, password=pw/);
  assert.match(surge, /= snell, sn\.example\.invalid, 8388, psk=pskv, version=4, obfs=http, obfs-host=bing\.com/);
});

test('mihomo 输出：新协议字段与 reality / plugin-opts / 传输层子对象', () => {
  const { pick } = emittersOf([
    {
      kind: 'hysteria2',
      name: 'HY',
      server: 'hy.example.invalid',
      port: 443,
      password: 'pw',
      options: {
        sni: 'a.example.invalid',
        obfs: { type: 'salamander', password: 'ob' },
        bandwidth: { up: 30, down: 200 },
        ports: '443-8443',
        alpn: ['h3'],
      },
    },
    {
      kind: 'tuic',
      name: 'TU',
      server: 't.example.invalid',
      port: 443,
      uuid: 'uuid',
      password: 'pw',
      options: { congestionControl: 'bbr', udpRelayMode: 'native' },
    },
    {
      kind: 'anytls',
      name: 'AT',
      server: 'at.example.invalid',
      port: 443,
      password: 'pw',
      options: { idleSessionTimeout: 30 },
    },
    {
      kind: 'snell',
      name: 'SN',
      server: 'sn.example.invalid',
      port: 8388,
      psk: 'pskv',
      options: { version: 4, obfs: { type: 'http', host: 'bing.com' } },
    },
    {
      kind: 'vless',
      name: 'R',
      server: 'r.example.invalid',
      port: 443,
      uuid: 'uuid',
      options: {
        tls: true,
        sni: 'www.microsoft.com',
        transport: 'ws',
        path: '/ws',
        host: 'cdn.example.invalid',
        reality: { publicKey: 'PUBKEY', shortId: 'abcd', fingerprint: 'chrome' },
      },
    },
    {
      kind: 'shadowsocks',
      name: 'SSO',
      server: 'ss.example.invalid',
      port: 443,
      method: 'aes-256-gcm',
      password: 'pw',
      options: { plugin: 'obfs', pluginOpts: { mode: 'tls', host: 'bing.com' } },
    },
  ]);
  const yaml = pick('mihomo');
  assert.match(yaml, /type: hysteria2/);
  assert.match(yaml, /obfs: salamander/);
  assert.match(yaml, /up: 30 Mbps/);
  assert.match(yaml, /ports: 443-8443/);
  assert.match(yaml, /type: tuic/);
  assert.match(yaml, /congestion-controller: bbr/);
  assert.match(yaml, /type: anytls/);
  assert.match(yaml, /idle-session-timeout: 30/);
  assert.match(yaml, /type: snell/);
  assert.match(yaml, /obfs-opts:/);
  assert.match(yaml, /reality-opts:/);
  assert.match(yaml, /public-key: PUBKEY/);
  assert.match(yaml, /client-fingerprint: chrome/);
  assert.match(yaml, /ws-opts:/);
  assert.match(yaml, /Host: cdn\.example\.invalid/);
  assert.match(yaml, /plugin: obfs/);
  assert.match(yaml, /plugin-opts:/);
});

test('sing-box 输出：tls / transport / plugin_opts 结构与官方文档一致', () => {
  const { pick } = emittersOf([
    {
      kind: 'vless',
      name: 'R',
      server: 'r.example.invalid',
      port: 443,
      uuid: 'uuid',
      options: {
        tls: true,
        sni: 'www.microsoft.com',
        transport: 'ws',
        path: '/ws',
        host: 'cdn.example.invalid',
        alpn: ['h2'],
        reality: { publicKey: 'PUBKEY', shortId: 'abcd' },
      },
    },
    {
      kind: 'shadowsocks',
      name: 'SSO',
      server: 'ss.example.invalid',
      port: 443,
      method: 'aes-256-gcm',
      password: 'pw',
      options: { plugin: 'obfs', pluginOpts: { mode: 'http', host: 'bing.com' } },
    },
  ]);
  const doc = JSON.parse(pick('sing-box')) as {
    outbounds: { type: string; tls?: Record<string, unknown>; transport?: Record<string, unknown>; plugin?: string; plugin_opts?: string }[];
  };
  const vless = doc.outbounds.find((item) => item.type === 'vless');
  assert.equal(vless?.tls?.['server_name'], 'www.microsoft.com');
  assert.deepEqual(vless?.tls?.['reality'], {
    enabled: true,
    public_key: 'PUBKEY',
    short_id: 'abcd',
  });
  assert.deepEqual(vless?.tls?.['utls'], { enabled: true, fingerprint: 'chrome' });
  assert.deepEqual(vless?.transport, { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.invalid' } });
  const ss = doc.outbounds.find((item) => item.type === 'shadowsocks');
  assert.equal(ss?.['plugin'], 'obfs-local');
  assert.equal(ss?.plugin_opts, 'obfs=http;obfs-host=bing.com');
});

test('节点分享 URI 输出：hysteria2 / tuic / anytls / reality 都按各自 scheme 生成', () => {
  const { pick } = emittersOf([
    {
      kind: 'hysteria2',
      name: 'HY',
      server: 'hy.example.invalid',
      port: 443,
      password: 'pw',
      options: { sni: 'a.example.invalid', obfs: { type: 'salamander', password: 'ob' }, insecure: true },
    },
    {
      kind: 'tuic',
      name: 'TU',
      server: 't.example.invalid',
      port: 443,
      uuid: 'uuid',
      password: 'pw',
      options: { congestionControl: 'bbr', udpRelayMode: 'quic' },
    },
    { kind: 'anytls', name: 'AT', server: 'at.example.invalid', port: 443, password: 'pw' },
    {
      kind: 'vless',
      name: 'R',
      server: 'r.example.invalid',
      port: 443,
      uuid: 'uuid',
      options: {
        tls: true,
        sni: 'www.microsoft.com',
        reality: { publicKey: 'PUBKEY', shortId: 'abcd', fingerprint: 'chrome' },
      },
    },
  ]);
  const list = pick('shadowrocket');
  assert.match(list, /hysteria2:\/\/pw@hy\.example\.invalid:443\/\?sni=a\.example\.invalid&insecure=1&obfs=salamander&obfs-password=ob/);
  assert.match(list, /tuic:\/\/uuid:pw@t\.example\.invalid:443\/\?congestion_control=bbr&udp_relay_mode=quic/);
  assert.match(list, /anytls:\/\/pw@at\.example\.invalid:443/);
  assert.match(list, /vless:\/\/uuid@r\.example\.invalid:443\?encryption=none&security=reality&sni=www\.microsoft\.com&pbk=PUBKEY&sid=abcd&fp=chrome/);
});

test('能力边界：Stash 不写 mihomo 专属字段，QuanX 直接拒绝新协议', () => {
  const nodes = [
    {
      kind: 'hysteria2',
      name: 'HY',
      server: 'hy.example.invalid',
      port: 443,
      password: 'pw',
    },
    {
      kind: 'vless',
      name: 'R',
      server: 'r.example.invalid',
      port: 443,
      uuid: 'uuid',
      options: { tls: true, reality: { publicKey: 'PUBKEY' } },
    },
  ];
  const profile = profileOf(nodes);

  // Stash 的 hysteria2 认证字段是 auth，与 mihomo 不同构 → 拒绝而不是写错。
  const stashPlan = plan(profile, 'clash');
  const hy2Plan = stashPlan.items.find((item) => item.ref.startsWith('hysteria2:'));
  assert.equal(hy2Plan?.action, 'reject');
  assert.doesNotMatch(emit(profile, stashPlan).content, /type: hysteria2/);

  // QuanX 的 sample.conf 无 hysteria2 / tuic / anytls / snell。
  const quanxPlan = plan(profile, 'quanx');
  assert.ok(quanxPlan.items.every((item) => item.action === 'reject'));
  // Clash Premium 缺 reality，vless 带 reality 时按认证级特性拒绝。
  const premiumPlan = plan(profile, 'clash-apple');
  const vlessPlan = premiumPlan.items.find((item) => item.ref.startsWith('vless:'));
  assert.equal(vlessPlan?.reason, 'feature-required:reality');
});

test('ShadowTLS：作为 SS 的 SIP003 插件解析，只有核实过的内核写出，其余目标整条拒绝', () => {
  // ss://base64(aes-128-gcm:pw)@host:port?plugin=shadow-tls;host=…;password=…;version=3#name
  const uri =
    'ss://YWVzLTEyOC1nY206cHc@st.example.invalid:443?plugin=' +
    encodeURIComponent('shadow-tls;host=cloud.tencent.com;password=tls-pw;version=3') +
    '#%E9%A6%99%E6%B8%AF%20ST';
  const { profile } = ingest(uri);
  const node = profile.nodes[0];
  assert.ok(node !== undefined, '应当解析出一个节点');
  assert.equal(node.kind, 'shadowsocks');
  if (node.kind !== 'shadowsocks') return;
  assert.equal(node.options?.plugin, 'shadow-tls');
  assert.deepEqual(node.options?.pluginOpts, {
    host: 'cloud.tencent.com',
    password: 'tls-pw',
    version: 3,
  });

  const mihomo = emit(profile, plan(profile, 'mihomo')).content;
  assert.match(mihomo, /plugin: shadow-tls/);
  assert.match(mihomo, /password: tls-pw/);
  assert.match(mihomo, /version: 3/);

  // 没核实过该插件的目标必须整条拒绝：写成普通 SS 会「语法合法、握手必失败」。
  for (const target of ['surge', 'sing-box', 'clash', 'egern'] as const) {
    const emissionPlan = plan(profile, target);
    const rejected = emissionPlan.items.filter((item) => item.action === 'reject');
    assert.equal(rejected.length, 1, `${target} 应当拒绝该节点`);
    assert.equal(rejected[0]?.reason, 'feature-required:shadowTls');
  }
});

test('WireGuard URI：私钥/公钥/隧道地址/可选字段进 IR，mihomo 写出、URI 还原', () => {
  const { profile } = ingest(
    'wireguard://cHJpdmF0ZUtleQ==@wg.example.invalid:51820?publickey=cGVlclB1YmxpY0tleQ==&address=10.0.0.2/32&address=fd00::2/128&mtu=1408&reserved=209,98,59&allowedips=0.0.0.0/0,::/0&psk=cHNrS2V5#香港 WG',
  );
  assert.equal(profile.nodes.length, 1);
  const node = profile.nodes[0];
  assert.equal(node?.kind, 'wireguard');
  if (node?.kind !== 'wireguard') return;
  assert.equal(node.privateKey, 'cHJpdmF0ZUtleQ==');
  assert.equal(node.peerPublicKey, 'cGVlclB1YmxpY0tleQ==');
  assert.deepEqual(node.addresses, ['10.0.0.2/32', 'fd00::2/128']);
  assert.equal(node.mtu, 1408);
  assert.deepEqual(node.reserved, [209, 98, 59]);
  assert.deepEqual(node.allowedIps, ['0.0.0.0/0', '::/0']);
  assert.equal(node.preSharedKey, 'cHNrS2V5');
  assert.equal(node.server, 'wg.example.invalid');
  assert.equal(node.port, 51820);

  // mihomo（能力表 support）应写出 wireguard 块与连字符字段。
  const mihomo = emit(profile, plan(profile, 'mihomo')).content;
  assert.match(mihomo, /type: wireguard/);
  assert.match(mihomo, /private-key: cHJpdmF0ZUtleQ==/);
  assert.match(mihomo, /public-key: cGVlclB1YmxpY0tleQ==/);
  assert.match(mihomo, /ip: 10\.0\.0\.2\/32/);
  assert.match(mihomo, /pre-shared-key: cHNrS2V5/);
  assert.ok(mihomo.includes('reserved:'), '应写出 reserved 字段');

  // URI 列表（能力表 support）应能还原 wireguard:// URI（base64 里的 = 和地址里的 / 会被百分号编码）。
  const uri = emit(profile, plan(profile, 'shadowrocket')).content;
  assert.ok(
    uri.includes('wireguard://cHJpdmF0ZUtleQ%3D%3D@wg.example.invalid:51820?publickey=cGVlclB1YmxpY0tleQ%3D%3D'),
    'URI 列表应还原 wireguard:// 链接',
  );
  assert.ok(uri.includes('address=10.0.0.2%2F32'), '隧道地址应进入 query');

  // 缺公钥或缺地址必须整条拒绝，不产出残缺节点。
  const noPubKey = ingest('wireguard://key@wg.example.invalid:51820?address=10.0.0.2/32#bad');
  assert.equal(noPubKey.profile.nodes.length, 0);
  assert.ok(noPubKey.diagnostics.some((d) => d.reason === 'missing-wireguard-required-fields'));
  const noAddr = ingest('wireguard://key@wg.example.invalid:51820?publickey=pk#bad');
  assert.equal(noAddr.profile.nodes.length, 0);
  assert.ok(noAddr.diagnostics.some((d) => d.reason === 'missing-wireguard-address'));

  // surge（能力表 support）应写出 [Proxy] 引用行 + 独立 [WireGuard] 段。
  const surge = emit(profile, plan(profile, 'surge')).content;
  assert.match(surge, /香港 WG = wireguard, section-name = /);
  assert.match(surge, /\[WireGuard Startrails-香港-WG\]/);
  assert.match(surge, /private-key = cHJpdmF0ZUtleQ==/);
  assert.match(surge, /self-ip = 10\.0\.0\.2\/32/);
  assert.match(surge, /self-ip-v6 = fd00::2\/128/);
  assert.match(surge, /mtu = 1408/);
  assert.match(surge, /public-key = cGVlclB1YmxpY0tleQ==/);
  assert.match(surge, /preshared-key = cHNrS2V5/);
  assert.match(surge, /allowed-ips = "0\.0\.0\.0\/0, ::\/0"/);
  assert.match(surge, /endpoint = wg\.example\.invalid:51820/);

  // 未核实的方言（sing-box / loon / quanx / egern）必须拒绝，而不是写出错误配置。
  for (const target of ['sing-box', 'loon', 'quanx', 'egern'] as const) {
    const emissionPlan = plan(profile, target);
    const rejected = emissionPlan.items.filter((item) => item.action === 'reject');
    assert.equal(rejected.length, 1, `${target} 应当拒绝 wireguard 节点（未核实）`);
  }
});

test('SOCKS5 / HTTP 直连节点：URI 进 IR，mihomo / sing-box / surge / URI 各按能力写出', () => {
  const { profile } = ingest(
    [
      'socks5://user1:pass1@proxy.example.invalid:1080#SOCKS 中转',
      'http://user2:pass2@proxy2.example.invalid:8080#HTTP 中转',
    ].join('\n'),
  );
  assert.equal(profile.nodes.length, 2);
  const socks = profile.nodes.find((n) => n.kind === 'socks5');
  const http = profile.nodes.find((n) => n.kind === 'http');
  assert.ok(socks !== undefined && http !== undefined);
  if (socks?.kind !== 'socks5' || http?.kind !== 'http') return;
  assert.equal(socks.username, 'user1');
  assert.equal(socks.password, 'pass1');
  assert.equal(http.username, 'user2');
  assert.equal(http.password, 'pass2');

  // mihomo（support）写出 socks5 / http 类型。
  const mihomo = emit(profile, plan(profile, 'mihomo')).content;
  assert.match(mihomo, /type: socks5/);
  assert.match(mihomo, /type: http/);
  assert.match(mihomo, /username: user1/);
  assert.match(mihomo, /password: pass1/);

  // sing-box（support）用 type: socks（非 socks5）。
  const singbox = emit(profile, plan(profile, 'sing-box')).content;
  assert.ok(singbox.includes('"type": "socks"'));
  assert.ok(singbox.includes('"type": "http"'));

  // URI 列表还原。
  const uri = emit(profile, plan(profile, 'shadowrocket')).content;
  assert.ok(uri.includes('socks5://user1:pass1@proxy.example.invalid:1080'));
  assert.ok(uri.includes('http://user2:pass2@proxy2.example.invalid:8080'));

  // 未核实的方言拒绝，而不是写出错误配置。
  for (const target of ['loon', 'quanx', 'egern'] as const) {
    const emissionPlan = plan(profile, target);
    const rejected = emissionPlan.items.filter((item) => item.action === 'reject');
    assert.equal(rejected.length, 2, `${target} 应拒绝 socks5/http（未核实）`);
  }
});

test('Hysteria2 分享链接：query 的 up / down 带宽进入 options.bandwidth', () => {
  const result = ingest('hysteria2://pw@hy.example.invalid:443/?sni=a.example.invalid&up=30&down=200#HY2');
  const node = result.profile.nodes[0];
  assert.ok(node !== undefined);
  assert.equal(node.kind, 'hysteria2');
  assert.deepEqual(node.options?.bandwidth, { up: 30, down: 200 });

  // 只给了其中一个也要收下；给小数同样合法（Mbps）。
  const one = ingest('hysteria2://pw@hy.example.invalid:443/?down=100.5').profile.nodes[0];
  assert.deepEqual(one?.options?.bandwidth, { down: 100.5 });

  // 没有带宽参数时不应凭空造出一个空对象。
  const none = ingest('hysteria2://pw@hy.example.invalid:443/?sni=a.example.invalid').profile.nodes[0];
  assert.equal(none?.options?.bandwidth, undefined);
});
