<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NInput, NInputNumber, NPopconfirm, NRadioButton, NRadioGroup, NSelect, NSwitch, NTag } from 'naive-ui';
import { Globe, Info } from 'lucide-vue-next';
import { api } from '../api';
import type { RuntimeCapabilityView, RuntimePolicyView } from '../api';
import ClientIcon from './ClientIcon.vue';
import { activeProfileName, notify } from '../workspace';

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

type Tri = 'unset' | 'on' | 'off';
const dnsForm = reactive({
  mode: 'unset' as 'unset' | 'system' | 'redir-host' | 'fake-ip',
  nameserver: '',
  fallback: '',
  ecs: '',
  fakeIpRange: '',
  ipv6: 'unset' as Tri,
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
const strictRouteOptions = [
  { label: '不写（客户端默认）', value: 'unset' },
  { label: '启用', value: 'on' },
  { label: '关闭', value: 'off' },
];
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
    dnsForm.mode !== 'unset' ||
    splitLines(dnsForm.nameserver).length > 0 ||
    splitLines(dnsForm.fallback).length > 0 ||
    dnsForm.ecs.trim().length > 0 ||
    dnsForm.fakeIpRange.trim().length > 0 ||
    dnsForm.ipv6 !== 'unset' ||
    tunForm.enabled,
);

async function loadRuntime(): Promise<void> {
  runtimeLoading.value = true;
  try {
    const profile = activeProfileName.value;
    const view = await api.runtime(profile);
    runtimeCaps.value = view.targets;
    const dns = view.runtime?.dns;
    dnsForm.mode = dns === undefined ? 'unset' : dns.mode;
    dnsForm.nameserver = (dns?.nameserver ?? []).join('\n');
    dnsForm.fallback = (dns?.fallback ?? []).join('\n');
    dnsForm.ecs = dns?.ecs ?? '';
    dnsForm.fakeIpRange = dns?.fakeIpRange ?? '';
    dnsForm.ipv6 = dns?.ipv6 === undefined ? 'unset' : dns.ipv6 ? 'on' : 'off';
    const tun = view.runtime?.tun;
    tunForm.enabled = tun?.enabled === true;
    tunForm.stack = tun?.stack ?? 'gvisor';
    tunForm.mtu = tun?.mtu ?? null;
    tunForm.strictRoute = tun?.strictRoute === undefined ? 'unset' : tun.strictRoute ? 'on' : 'off';
    loadedFor.value = profile;
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '读取 DNS / TUN 设置失败');
  } finally {
    runtimeLoading.value = false;
  }
}

async function saveRuntime(): Promise<void> {
  runtimeSaving.value = true;
  try {
    const nameserver = splitLines(dnsForm.nameserver);
    const fallback = splitLines(dnsForm.fallback);
    const dns: RuntimePolicyView['dns'] =
      dnsForm.mode === 'unset' &&
      nameserver.length === 0 &&
      fallback.length === 0 &&
      dnsForm.ecs.trim().length === 0 &&
      dnsForm.fakeIpRange.trim().length === 0 &&
      dnsForm.ipv6 === 'unset'
        ? undefined
        : {
            // mode 是必填项：只填了服务器但没选模式时按 system 落库，语义是「按系统默认方式解析」。
            mode: dnsForm.mode === 'unset' ? 'system' : dnsForm.mode,
            ...(nameserver.length === 0 ? {} : { nameserver }),
            ...(fallback.length === 0 ? {} : { fallback }),
            ...(dnsForm.ecs.trim().length === 0 ? {} : { ecs: dnsForm.ecs.trim() }),
            ...(dnsForm.fakeIpRange.trim().length === 0 ? {} : { fakeIpRange: dnsForm.fakeIpRange.trim() }),
            ...(dnsForm.ipv6 === 'unset' ? {} : { ipv6: dnsForm.ipv6 === 'on' }),
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
    const saved = await api.saveRuntime(Object.keys(runtime).length === 0 ? null : runtime);
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
    await api.saveRuntime(null);
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
  <div class="scope-note">
    <Info :size="13" />
    只作用于「{{ activeProfileName }}」这一份配置：手机要 fake-ip + TUN、路由器要 redir-host，各配各的。
  </div>

  <section class="card">
    <div class="card-head">
      <h2>DNS 与 TUN</h2>
      <n-tag size="small" :bordered="false" class="mono">
        {{ runtimeLoading ? '读取中' : hasRuntime ? '已配置' : '未配置' }}
      </n-tag>
    </div>
    <div class="card-body">
      <p class="text-3" style="font-size: 12px; margin: 0 0 12px; max-width: 620px">
        这一区配的是「客户端拿到订阅后怎么上网」：DNS 决定域名怎么解析成 IP，TUN 决定要不要接管整机流量
        （不必再在系统里设代理）。两段会写进这份配置生成的产物，写错会让客户端一启动就上不了网；
        拿不准就留空，节点照常可用。
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
          <label>fallback</label>
          <n-input
            v-model:value="dnsForm.fallback"
            type="textarea"
            size="small"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="tls://8.8.4.4"
          />
        </div>
      </div>

      <div class="form-grid cols-3" style="margin-top: 10px">
        <div class="field">
          <label>fake-ip 网段</label>
          <n-input v-model:value="dnsForm.fakeIpRange" size="small" placeholder="198.18.0.1/16" />
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

      <div class="row" style="margin-top: 12px; gap: 8px">
        <n-button size="small" type="primary" :loading="runtimeSaving" @click="saveRuntime">
          保存 DNS 与 TUN
        </n-button>
        <n-popconfirm @positive-click="clearRuntime">
          <template #trigger>
            <n-button size="small" secondary :disabled="!hasRuntime">清空</n-button>
          </template>
          清空后这份配置的产物不再写 DNS / TUN 段，确认？
        </n-popconfirm>
      </div>
    </div>
  </section>
</template>
