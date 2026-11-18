<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NInput, NInputNumber, NPopconfirm, NRadioButton, NRadioGroup, NSelect, NSwitch, NTag } from 'naive-ui';
import { Globe } from 'lucide-vue-next';
import { api } from '../api';
import type { FallbackFilterView, OverlayMode, RuntimeCapabilityView, RuntimePolicyView } from '../api';
import ClientIcon from './ClientIcon.vue';
import { activeProfileName, notify, runtimeDirty } from '../workspace';

/**
 * DNS 与 TUN 是这份配置的产物内容：客户端拿到订阅后按它解析域名、按它决定要不要接管整机流量。
 * 所以它属于「配置」而不是「设置」——设置页那一组管的是这只实例怎么跑（备份、通知、会话）。
 *
 * 刻意做成「全量表单 + 保存」而不是即时生效：DNS 写错会让整台机器解析不到域名，
 * 误触的代价太高，必须有一次明确的提交动作。
 */
const runtimeCaps = ref<Record<string, RuntimeCapabilityView>>({});
const runtimeLoading = ref(false);
const runtimeSaving = ref(false);
const loadedFor = ref<string | null>(null);
const baselineSnapshot = ref('');

type Tri = 'unset' | 'on' | 'off';
const dnsForm = reactive({
  overlay: 'inherit' as OverlayMode,
  mode: 'unset' as 'unset' | 'system' | 'redir-host' | 'fake-ip',
  nameserver: '',
  proxyNameserver: '',
  proxyNameserverEmpty: false,
  directNameserver: '',
  fallback: '',
  nameserverPolicy: '',
  ecs: '',
  fakeIpRange: '',
  ipv6: 'unset' as Tri,
  defaultNameserver: '',
  fakeIpFilter: '',
  fallbackFilterGeoip: 'unset' as Tri,
  fallbackFilterGeoipCode: '',
  fallbackFilterIpCidr: '',
  fallbackFilterDomain: '',
  useHosts: 'unset' as Tri,
  useSystemHosts: 'unset' as Tri,
  respectRules: 'unset' as Tri,
});
const tunForm = reactive({
  enabled: false,
  stack: 'gvisor' as 'gvisor' | 'system' | 'mixed',
  mtu: null as number | null,
  strictRoute: 'unset' as Tri,
});

const ipv6Options = [
  { label: '不写', value: 'unset' },
  { label: '启用', value: 'on' },
  { label: '关闭', value: 'off' },
];
const boolOptions = [
  { label: '不写（客户端默认）', value: 'unset' },
  { label: '开启', value: 'on' },
  { label: '关闭', value: 'off' },
];
const strictRouteOptions = boolOptions;
const stackOptions = [
  { label: 'gvisor（用户态，最稳）', value: 'gvisor' },
  { label: 'system（走内核栈）', value: 'system' },
  { label: 'mixed（混合）', value: 'mixed' },
];

const splitLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const currentSnapshot = (): string =>
  JSON.stringify({ dns: { ...dnsForm }, tun: { ...tunForm } });

const dirty = computed(
  () => loadedFor.value !== null && currentSnapshot() !== baselineSnapshot.value,
);

watch(
  dirty,
  (value) => {
    runtimeDirty.value = value;
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  runtimeDirty.value = false;
});

const invalidPolicyLines = computed(() =>
  splitLines(dnsForm.nameserverPolicy).filter((line) => !/^\S+\s+\S+/.test(line)),
);

/** 能力分组：把「谁会写 DNS 段、谁不会」直接说出来，比让用户逐个试要省事。 */
const capabilitySplit = computed(() => {
  const entries = Object.entries(runtimeCaps.value);
  return {
    dnsYes: entries.filter(([, cap]) => cap.dns === 'support').map(([target]) => target),
    dnsNo: entries.filter(([, cap]) => cap.dns !== 'support').map(([target]) => target),
    fakeIpYes: entries.filter(([, cap]) => cap.fakeIp === 'support').map(([target]) => target),
    tunYes: entries.filter(([, cap]) => cap.tun === 'support').map(([target]) => target),
  };
});

const hasRuntime = computed(
  () =>
    dnsForm.overlay !== 'inherit' ||
    dnsForm.mode !== 'unset' ||
    splitLines(dnsForm.nameserver).length > 0 ||
    splitLines(dnsForm.proxyNameserver).length > 0 ||
    dnsForm.proxyNameserverEmpty ||
    splitLines(dnsForm.directNameserver).length > 0 ||
    splitLines(dnsForm.fallback).length > 0 ||
    splitLines(dnsForm.nameserverPolicy).length > 0 ||
    dnsForm.ecs.trim().length > 0 ||
    dnsForm.fakeIpRange.trim().length > 0 ||
    dnsForm.ipv6 !== 'unset' ||
    splitLines(dnsForm.defaultNameserver).length > 0 ||
    splitLines(dnsForm.fakeIpFilter).length > 0 ||
    dnsForm.fallbackFilterGeoip !== 'unset' ||
    dnsForm.fallbackFilterGeoipCode.trim().length > 0 ||
    splitLines(dnsForm.fallbackFilterIpCidr).length > 0 ||
    splitLines(dnsForm.fallbackFilterDomain).length > 0 ||
    dnsForm.useHosts !== 'unset' ||
    dnsForm.useSystemHosts !== 'unset' ||
    dnsForm.respectRules !== 'unset' ||
    tunForm.enabled,
);

async function loadRuntime(): Promise<void> {
  runtimeLoading.value = true;
  try {
    const profile = activeProfileName.value;
    const view = await api.runtime(profile);
    runtimeCaps.value = view.targets;
    const dns = view.runtime?.dns;
    dnsForm.overlay = view.dnsMode ?? 'inherit';
    dnsForm.mode = dns === undefined ? 'unset' : dns.mode;
    dnsForm.nameserver = (dns?.nameserver ?? []).join('\n');
    dnsForm.proxyNameserver = (dns?.proxyNameserver ?? []).join('\n');
    dnsForm.proxyNameserverEmpty = Array.isArray(dns?.proxyNameserver) && dns.proxyNameserver.length === 0;
    dnsForm.directNameserver = (dns?.directNameserver ?? []).join('\n');
    dnsForm.fallback = (dns?.fallback ?? []).join('\n');
    dnsForm.nameserverPolicy = Object.entries(dns?.nameserverPolicy ?? {})
      .map(([domain, server]) => `${domain} ${server}`)
      .join('\n');
    dnsForm.ecs = dns?.ecs ?? '';
    dnsForm.fakeIpRange = dns?.fakeIpRange ?? '';
    dnsForm.ipv6 = dns?.ipv6 === undefined ? 'unset' : dns.ipv6 ? 'on' : 'off';
    dnsForm.defaultNameserver = (dns?.defaultNameserver ?? []).join('\n');
    dnsForm.fakeIpFilter = (dns?.fakeIpFilter ?? []).join('\n');
    dnsForm.fallbackFilterGeoip =
      dns?.fallbackFilter?.geoip === undefined ? 'unset' : dns.fallbackFilter.geoip ? 'on' : 'off';
    dnsForm.fallbackFilterGeoipCode = dns?.fallbackFilter?.geoipCode ?? '';
    dnsForm.fallbackFilterIpCidr = (dns?.fallbackFilter?.ipCidr ?? []).join('\n');
    dnsForm.fallbackFilterDomain = (dns?.fallbackFilter?.domain ?? []).join('\n');
    dnsForm.useHosts = dns?.useHosts === undefined ? 'unset' : dns.useHosts ? 'on' : 'off';
    dnsForm.useSystemHosts = dns?.useSystemHosts === undefined ? 'unset' : dns.useSystemHosts ? 'on' : 'off';
    dnsForm.respectRules = dns?.respectRules === undefined ? 'unset' : dns.respectRules ? 'on' : 'off';
    const tun = view.runtime?.tun;
    tunForm.enabled = tun?.enabled === true;
    tunForm.stack = tun?.stack ?? 'gvisor';
    tunForm.mtu = tun?.mtu ?? null;
    tunForm.strictRoute = tun?.strictRoute === undefined ? 'unset' : tun.strictRoute ? 'on' : 'off';
    loadedFor.value = profile;
    baselineSnapshot.value = currentSnapshot();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '读取 DNS / TUN 设置失败');
  } finally {
    runtimeLoading.value = false;
  }
}

function discardRuntime(): void {
  if (baselineSnapshot.value === '') return;
  try {
    const parsed = JSON.parse(baselineSnapshot.value) as {
      dns: typeof dnsForm;
      tun: typeof tunForm;
    };
    Object.assign(dnsForm, parsed.dns);
    Object.assign(tunForm, parsed.tun);
  } catch {
    void loadRuntime();
  }
}

async function saveRuntime(): Promise<void> {
  if (invalidPolicyLines.value.length > 0) {
    notify('error', `按域名指定解析器有 ${invalidPolicyLines.value.length} 行格式不正确，需为「域名 空格 地址」`);
    return;
  }
  runtimeSaving.value = true;
  try {
    const nameserver = splitLines(dnsForm.nameserver);
    const proxyNameserver = splitLines(dnsForm.proxyNameserver);
    const directNameserver = splitLines(dnsForm.directNameserver);
    const fallback = splitLines(dnsForm.fallback);
    const nameserverPolicy: Record<string, string> = {};
    for (const line of splitLines(dnsForm.nameserverPolicy)) {
      const splitAt = line.indexOf(' ');
      if (splitAt <= 0) continue;
      const domain = line.slice(0, splitAt).trim();
      const server = line.slice(splitAt + 1).trim();
      if (domain.length > 0 && server.length > 0) nameserverPolicy[domain] = server;
    }
    const defaultNameserver = splitLines(dnsForm.defaultNameserver);
    const fakeIpFilter = splitLines(dnsForm.fakeIpFilter);
    const fallbackIpCidr = splitLines(dnsForm.fallbackFilterIpCidr);
    const fallbackDomain = splitLines(dnsForm.fallbackFilterDomain);
    const fallbackFilter: FallbackFilterView = {
      ...(dnsForm.fallbackFilterGeoip === 'unset' ? {} : { geoip: dnsForm.fallbackFilterGeoip === 'on' }),
      ...(dnsForm.fallbackFilterGeoipCode.trim() === ''
        ? {}
        : { geoipCode: dnsForm.fallbackFilterGeoipCode.trim() }),
      ...(fallbackIpCidr.length === 0 ? {} : { ipCidr: fallbackIpCidr }),
      ...(fallbackDomain.length === 0 ? {} : { domain: fallbackDomain }),
    };
    const tri = (value: Tri): boolean | undefined => (value === 'unset' ? undefined : value === 'on');
    const hasFallbackFilter = Object.keys(fallbackFilter).length > 0;
    const dnsEmpty =
      dnsForm.mode === 'unset' &&
      nameserver.length === 0 &&
      proxyNameserver.length === 0 &&
      !dnsForm.proxyNameserverEmpty &&
      directNameserver.length === 0 &&
      fallback.length === 0 &&
      Object.keys(nameserverPolicy).length === 0 &&
      dnsForm.ecs.trim().length === 0 &&
      dnsForm.fakeIpRange.trim().length === 0 &&
      dnsForm.ipv6 === 'unset' &&
      defaultNameserver.length === 0 &&
      fakeIpFilter.length === 0 &&
      !hasFallbackFilter &&
      dnsForm.useHosts === 'unset' &&
      dnsForm.useSystemHosts === 'unset' &&
      dnsForm.respectRules === 'unset';
    const dns: RuntimePolicyView['dns'] = dnsEmpty
      ? undefined
      : {
          mode: dnsForm.mode === 'unset' ? 'system' : dnsForm.mode,
          ...(nameserver.length === 0 ? {} : { nameserver }),
          // 显式留空是刻意写法：写 [] 而不是省略，让节点域名走 nameserver-policy。
          ...(dnsForm.proxyNameserverEmpty
            ? { proxyNameserver: [] }
            : proxyNameserver.length === 0
              ? {}
              : { proxyNameserver }),
          ...(directNameserver.length === 0 ? {} : { directNameserver }),
          ...(fallback.length === 0 ? {} : { fallback }),
          ...(Object.keys(nameserverPolicy).length === 0 ? {} : { nameserverPolicy }),
          ...(dnsForm.ecs.trim().length === 0 ? {} : { ecs: dnsForm.ecs.trim() }),
          ...(dnsForm.fakeIpRange.trim().length === 0 ? {} : { fakeIpRange: dnsForm.fakeIpRange.trim() }),
          ...(dnsForm.ipv6 === 'unset' ? {} : { ipv6: dnsForm.ipv6 === 'on' }),
          ...(defaultNameserver.length === 0 ? {} : { defaultNameserver }),
          ...(fakeIpFilter.length === 0 ? {} : { fakeIpFilter }),
          ...(hasFallbackFilter ? { fallbackFilter } : {}),
          ...(dnsForm.useHosts === 'unset' ? {} : { useHosts: tri(dnsForm.useHosts) }),
          ...(dnsForm.useSystemHosts === 'unset' ? {} : { useSystemHosts: tri(dnsForm.useSystemHosts) }),
          ...(dnsForm.respectRules === 'unset' ? {} : { respectRules: tri(dnsForm.respectRules) }),
        };
    const runtime: RuntimePolicyView = {
      ...(dns === undefined ? {} : { dns }),
      ...(tunForm.enabled
        ? {
            tun: {
              enabled: true,
              stack: tunForm.stack,
              ...(tunForm.mtu === null || tunForm.mtu <= 0 ? {} : { mtu: tunForm.mtu }),
              ...(tunForm.strictRoute === 'unset' ? {} : { strictRoute: tunForm.strictRoute === 'on' }),
            },
          }
        : {}),
    };
    const saved = await api.saveRuntime(
      Object.keys(runtime).length === 0 ? null : runtime,
      activeProfileName.value,
      dnsForm.overlay,
    );
    notify(
      'ok',
      saved.runtime === null
        ? '已清空：这份配置的产物不再写 DNS / TUN 段'
        : '已保存；客户端下次拉取产物时生效',
    );
    await loadRuntime();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '保存 DNS / TUN 设置失败');
  } finally {
    runtimeSaving.value = false;
  }
}

async function clearRuntime(): Promise<void> {
  runtimeSaving.value = true;
  try {
    await api.saveRuntime(null, activeProfileName.value, 'inherit');
    notify('ok', '已清空：这份配置的产物不再写 DNS / TUN 段');
    await loadRuntime();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '保存 DNS / TUN 设置失败');
  } finally {
    runtimeSaving.value = false;
  }
}

onMounted(() => {
  void loadRuntime();
});

/**
 * 配置页在 KeepAlive 里，切配置不会重新挂载。
 * 不跟着当前配置重读，表单会保留上一份配置的 DNS，用户一保存就把它写到了另一份配置上。
 */
watch(activeProfileName, (name) => {
  if (name === loadedFor.value) return;
  void loadRuntime();
});
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>DNS 与 TUN</h2>
      <n-tag size="small" :bordered="false" class="mono">
        {{ runtimeLoading ? '读取中' : hasRuntime ? '已配置' : '未配置' }}
      </n-tag>
      <n-tag v-if="dirty" size="small" type="warning" :bordered="false">未保存</n-tag>
    </div>
    <div class="card-body">
      <p class="text-3" style="font-size: 12px; margin: 0 0 12px; max-width: 620px">
        这一区配的是「客户端拿到订阅后怎么上网」：DNS 决定域名怎么解析成 IP，TUN 决定要不要接管整机流量
        （不必再在系统里设代理）。两段会写进这份配置生成的产物，写错会让客户端一启动就上不了网；
        拿不准就留空，节点照常可用。
      </p>
      <div class="field">
        <label>和订阅的关系</label>
        <n-radio-group v-model:value="dnsForm.overlay" size="small">
          <n-radio-button value="inherit">继承</n-radio-button>
          <n-radio-button value="replace">替换</n-radio-button>
          <n-radio-button value="merge">组合</n-radio-button>
        </n-radio-group>
        <span class="text-3" style="font-size: 11.5px; margin-top: 6px">
          继承沿用订阅 DNS；替换用下面的整份覆盖；组合时填了的字段覆盖订阅、没填的留给订阅（按域名解析器也会合并，同名域名以这里为准；建议同时明确选好 DNS 模式，避免未选时回落成 system）。
        </span>
      </div>

      <div :class="{ 'scope-disabled': dnsForm.overlay === 'inherit' }">
        <p v-if="dnsForm.overlay === 'inherit'" class="text-3" style="font-size: 11.5px; margin: 8px 0 6px; color: var(--warn)">
          当前为「继承」模式，生成产物时将沿用订阅自带的 DNS，下方 DNS 字段仅保留草稿不会写入产物；切换到「替换」或「组合」后生效。
        </p>
        <div class="field">
          <label>DNS 模式</label>
          <n-radio-group v-model:value="dnsForm.mode" size="small">
            <n-radio-button value="unset">不写</n-radio-button>
            <n-radio-button value="system">system</n-radio-button>
            <n-radio-button value="redir-host">redir-host</n-radio-button>
            <n-radio-button value="fake-ip">fake-ip</n-radio-button>
          </n-radio-group>
          <span class="text-3" style="font-size: 11.5px; margin-top: 6px">
            缺 DNS 段不影响节点可用，写错反而可能让整机解析不到域名；不支持的客户端会自动跳过这一段并留诊断。
          </span>
        </div>

        <div class="form-grid cols-2" style="margin-top: 12px">
          <div class="field">
            <label>nameserver（每行一条）</label>
            <n-input
              v-model:value="dnsForm.nameserver"
              type="textarea"
              size="small"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="https://dns.alidns.com/dns-query"
            />
          </div>
          <div class="field">
            <label>按域名指定解析器</label>
            <n-input
              v-model:value="dnsForm.nameserverPolicy"
              type="textarea"
              size="small"
              :status="invalidPolicyLines.length > 0 ? 'error' : undefined"
              :autosize="{ minRows: 2, maxRows: 6 }"
              placeholder="*.example.com https://dns.example/dns-query"
            />
            <span v-if="invalidPolicyLines.length > 0" class="text-3" style="font-size: 11.5px; color: var(--danger); margin-top: 4px">
              以下格式无效（需「域名 空格 解析器地址」）：{{ invalidPolicyLines[0] }}<template v-if="invalidPolicyLines.length > 1">（共 {{ invalidPolicyLines.length }} 行）</template>
            </span>
          </div>
          <div class="field">
            <label>fallback</label>
            <n-input
              v-model:value="dnsForm.fallback"
              type="textarea"
              size="small"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="tls://8.8.4.4"
            />
          </div>
          <div class="field">
            <label>节点域名解析器（proxy-server）</label>
            <n-input
              v-model:value="dnsForm.proxyNameserver"
              type="textarea"
              size="small"
              :disabled="dnsForm.proxyNameserverEmpty"
              :autosize="{ minRows: 2, maxRows: 3 }"
              :placeholder="dnsForm.proxyNameserverEmpty ? '已设为显式留空 []' : '解析节点域名用；留空走默认'"
            />
            <label style="margin-top: 6px; display: flex; align-items: center; gap: 6px">
              <n-switch v-model:value="dnsForm.proxyNameserverEmpty" size="small" />
              <span class="text-3">显式留空（写 []，让节点域名走上面的按域名策略）</span>
            </label>
          </div>
          <div class="field">
            <label>直连域名解析器（direct-nameserver）</label>
            <n-input
              v-model:value="dnsForm.directNameserver"
              type="textarea"
              size="small"
              :autosize="{ minRows: 2, maxRows: 3 }"
              placeholder="https://doh.pub/dns-query"
            />
          </div>
        </div>

        <div class="form-grid cols-3" style="margin-top: 10px">
          <div class="field">
            <label>fake-ip 网段</label>
            <n-input v-model:value="dnsForm.fakeIpRange" size="small" placeholder="198.18.0.1/16" />
            <span v-if="dnsForm.fakeIpRange.trim() !== '' && dnsForm.mode !== 'fake-ip'" class="text-3" style="font-size: 11px; margin-top: 3px">
              仅在 fake-ip 模式下生效
            </span>
          </div>
          <div class="field">
            <label>ECS</label>
            <n-input v-model:value="dnsForm.ecs" size="small" placeholder="1.2.3.0/24" />
          </div>
          <div class="field">
            <label>IPv6</label>
            <n-select v-model:value="dnsForm.ipv6" size="small" :options="ipv6Options" />
          </div>
        </div>

        <n-collapse style="margin-top: 10px">
          <n-collapse-item title="mihomo 高级 DNS 字段" name="advanced">
            <p class="text-3" style="font-size: 11.5px; margin: 0 0 12px; max-width: 640px">
              这一组只有 mihomo / clash-yaml 系客户端能表达；导出到 Surge、sing-box 等目标时会自动剥掉并留一条诊断。
              拿不准就全部留空。
            </p>
            <div class="form-grid cols-2">
              <div class="field">
                <label>default-nameserver（每行一条，引导 DNS）</label>
                <n-input
                  v-model:value="dnsForm.defaultNameserver"
                  type="textarea" size="small" :autosize="{ minRows: 2, maxRows: 3 }"
                  placeholder="223.5.5.5&#10;119.29.29.29"
                />
              </div>
              <div class="field">
                <label>fake-ip-filter（每行一条）</label>
                <n-input
                  v-model:value="dnsForm.fakeIpFilter"
                  type="textarea" size="small" :autosize="{ minRows: 4, maxRows: 7 }"
                  placeholder="*.lan&#10;+.msftconnecttest.com"
                />
                <span v-if="dnsForm.fakeIpFilter.trim() !== '' && dnsForm.mode !== 'fake-ip'" class="text-3" style="font-size: 11px; margin-top: 3px">
                  仅在 fake-ip 模式下生效
                </span>
              </div>
            </div>
            <div class="form-grid cols-2" style="margin-top: 10px">
              <div class="field">
                <label>fallback-filter · ipcidr（每行一条）</label>
                <n-input
                  v-model:value="dnsForm.fallbackFilterIpCidr"
                  type="textarea" size="small" :autosize="{ minRows: 3, maxRows: 5 }"
                  placeholder="0.0.0.0/8&#10;10.0.0.0/8"
                />
              </div>
              <div class="field">
                <label>fallback-filter · domain（每行一条）</label>
                <n-input
                  v-model:value="dnsForm.fallbackFilterDomain"
                  type="textarea" size="small" :autosize="{ minRows: 3, maxRows: 5 }"
                  placeholder="+.google.com&#10;+.youtube.com"
                />
              </div>
            </div>
            <div class="form-grid cols-2" style="margin-top: 10px">
              <div class="field">
                <label>fallback-filter · geoip</label>
                <n-select v-model:value="dnsForm.fallbackFilterGeoip" size="small" :options="boolOptions" />
              </div>
              <div class="field">
                <label>fallback-filter · geoip-code</label>
                <n-input v-model:value="dnsForm.fallbackFilterGeoipCode" size="small" placeholder="CN" />
              </div>
            </div>
            <div class="form-grid cols-3" style="margin-top: 10px">
              <div class="field">
                <label>use-hosts</label>
                <n-select v-model:value="dnsForm.useHosts" size="small" :options="boolOptions" />
              </div>
              <div class="field">
                <label>use-system-hosts</label>
                <n-select v-model:value="dnsForm.useSystemHosts" size="small" :options="boolOptions" />
              </div>
              <div class="field">
                <label>respect-rules</label>
                <n-select v-model:value="dnsForm.respectRules" size="small" :options="boolOptions" />
              </div>
            </div>
          </n-collapse-item>
        </n-collapse>
      </div>

      <div class="setting-row" style="margin-top: 6px">
        <Globe :size="16" class="text-3" />
        <div class="da-text">
          <div class="da-title">TUN 入站</div>
          <div class="da-sub">
            只对支持的客户端写出 tun 段；{{ capabilitySplit.tunYes.length }} 个目标可表达
          </div>
        </div>
        <n-switch v-model:value="tunForm.enabled" size="small" />
      </div>

      <div v-if="tunForm.enabled" class="form-grid cols-2-1" style="margin-top: 6px">
        <div class="field">
          <label>栈</label>
          <n-select v-model:value="tunForm.stack" size="small" :options="stackOptions" />
        </div>
        <div class="field">
          <label>MTU</label>
          <n-input-number
            v-model:value="tunForm.mtu"
            size="small"
            :min="1280"
            :max="9000"
            placeholder="默认"
            style="width: 100%"
          />
        </div>
        <div class="field">
          <label>strict-route</label>
          <n-select v-model:value="tunForm.strictRoute" size="small" :options="strictRouteOptions" />
        </div>
      </div>

      <n-alert type="info" :bordered="false" style="margin-top: 12px">
        <div class="cap-split">
          <span class="cap-split-label">写 DNS 段 · {{ capabilitySplit.dnsYes.length }} 个</span>
          <span v-for="id in capabilitySplit.dnsYes" :key="id" class="client-pill">
            <ClientIcon :id="id" size="xs" bare />
            <span class="mono">{{ id }}</span>
          </span>
        </div>
        <div class="cap-split">
          <span class="cap-split-label">不写 · {{ capabilitySplit.dnsNo.length }} 个</span>
          <span v-for="id in capabilitySplit.dnsNo" :key="id" class="client-pill">
            <ClientIcon :id="id" size="xs" bare />
            <span class="mono">{{ id }}</span>
          </span>
          <span v-if="capabilitySplit.dnsNo.length === 0" class="text-3">无</span>
        </div>
      </n-alert>

    </div>
    <div class="card-foot">
      <n-button size="small" type="primary" :loading="runtimeSaving" :disabled="!dirty || runtimeLoading" @click="saveRuntime">
        {{ dirty ? '保存 DNS 与 TUN' : '已保存' }}
      </n-button>
      <n-button v-if="dirty" size="small" quaternary :disabled="runtimeSaving || runtimeLoading" @click="discardRuntime">
        放弃修改
      </n-button>
      <n-popconfirm @positive-click="clearRuntime">
        <template #trigger>
          <n-button size="small" secondary :disabled="!hasRuntime || runtimeSaving || runtimeLoading">清空</n-button>
        </template>
        清空后这份配置的产物不再写 DNS / TUN 段，确认？
      </n-popconfirm>
    </div>
  </section>
</template>
