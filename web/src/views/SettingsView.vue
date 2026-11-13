<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, type Component } from 'vue';
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
} from 'naive-ui';
import {
  Bell,
  Cloud,
  Database,
  Globe,
  HardDriveDownload,
  Info,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Sun,
} from 'lucide-vue-next';
import { UI_CORE_VERSION } from '../version';
import ClientIcon from '../components/ClientIcon.vue';
import {
  PALETTES,
  activeProfileName,
  backupDatabase,
  backupToRemote,
  busy,
  clearCache,
  disconnect,
  notify,
  notifySettings,
  ops,
  palette,
  rotateAdminToken,
  saveNotifySettings,
  saveWebdavSettings,
  setPalette,
  setThemeMode,
  state,
  themeMode,
  webdavSettings,
  type Palette as PaletteId,
} from '../workspace';
import { api } from '../api';
import type { NotifyConfigView, NotifyTestResultView, RuntimeCapabilityView, RuntimePolicyView, WebDavProbeView } from '../api';

const origin = window.location.origin;
const dialectCount = computed(
  () => new Set((state.value?.clientTargets ?? []).map((item) => item.dialect)).size,
);
const versionMismatch = computed(
  () => state.value !== null && state.value.coreVersion !== UI_CORE_VERSION,
);

/** 色板缩略：取各套浅色强调色，深色下也足够辨识。 */
const SWATCHES: Record<PaletteId, string> = {
  indigo: '#5A5AD2',
  clay: '#B05430',
  graphite: '#2A2A2E',
  celadon: '#2C6B59',
  ocean: '#1E5FD0',
};

/* ---------------- 运行时段（DNS / TUN） ---------------- */

/**
 * 这一块刻意做成「全量表单 + 保存」，而不是即时生效：
 * DNS 写错会让整台机器解析不到域名，误触的代价太高，必须有一次明确的提交动作。
 */
/**
 * 设置页分区：一次只渲染一个分区，而不是把八张卡片堆成一条长页。
 * 左侧导航是真正的切换器，滚动锚点在区块变多之后已经失去意义。
 */
type SectionId = 'appearance' | 'runtime' | 'backup' | 'notify' | 'session' | 'info';

const SETTING_SECTIONS: readonly {
  readonly id: SectionId;
  readonly label: string;
  readonly hint: string;
  readonly icon: Component;
}[] = [
  { id: 'appearance', label: '外观', hint: '明暗与主题色，选择只保存在本机', icon: Palette },
  { id: 'runtime', label: '运行时段', hint: 'DNS 与 TUN 入站，写进产物会影响整机解析', icon: Globe },
  { id: 'backup', label: '备份与缓存', hint: '本地快照、WebDAV 远端副本与上游缓存', icon: Database },
  { id: 'notify', label: '通知', hint: '刷新失败时推送到 Telegram 或 Bark', icon: Bell },
  { id: 'session', label: '会话', hint: '管理令牌与当前设备的登录状态', icon: KeyRound },
  { id: 'info', label: '运行信息', hint: '版本、规模与调度器状态，只读', icon: Info },
];

const SECTION_KEY = 'startrails_settings_section';
const SECTION_IDS = SETTING_SECTIONS.map((item) => item.id);

/** 深链优先（`#sec-session`），其次上次停留的分区，最后回到外观。 */
function initialSection(): SectionId {
  const raw = window.location.hash.replace(/^#/, '').replace(/^sec-/, '');
  const candidates = [raw, localStorage.getItem(SECTION_KEY) ?? ''];
  for (const item of candidates) {
    if ((SECTION_IDS as readonly string[]).includes(item)) return item as SectionId;
  }
  return 'appearance';
}

const activeSection = ref<SectionId>(initialSection());

function switchSection(id: SectionId): void {
  if (activeSection.value === id) return;
  activeSection.value = id;
  localStorage.setItem(SECTION_KEY, id);
  window.history.replaceState(null, '', `#sec-${id}`);
  // 分区高度差很大：不回收滚动位置的话，切到短分区会停在一片空白上。
  window.scrollTo({ top: 0 });
}

function syncFromHash(): void {
  const raw = window.location.hash.replace(/^#/, '').replace(/^sec-/, '');
  if ((SECTION_IDS as readonly string[]).includes(raw) && raw !== activeSection.value) {
    activeSection.value = raw as SectionId;
    localStorage.setItem(SECTION_KEY, raw);
  }
}

const runtimeCaps = ref<Record<string, RuntimeCapabilityView>>({});
const runtimeRaw = ref<string | null>(null);
const runtimeLoading = ref(false);
const runtimeSaving = ref(false);

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
  strictRoute: false,
});

const ipv6Options = [
  { label: '不写', value: 'unset' },
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
    const view = await api.runtime();
    runtimeCaps.value = view.targets;
    runtimeRaw.value = view.raw;
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
    tunForm.strictRoute = tun?.strictRoute === true;
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '读取运行时段失败');
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
              ...(tunForm.strictRoute ? { strictRoute: true } : {}),
            },
          }
        : {}),
    };
    const saved = await api.saveRuntime(Object.keys(runtime).length === 0 ? null : runtime);
    notify(
      'ok',
      saved.runtime === null
        ? '已清空运行时段：产物不再写 DNS / TUN 段'
        : '运行时段已保存；ETag 已变化，客户端下次拉取即生效',
    );
    await loadRuntime();
  } catch (error) {
    notify('error', error instanceof Error ? error.message : '保存运行时段失败');
  } finally {
    runtimeSaving.value = false;
  }
}

onMounted(() => {
  void loadRuntime();
});

/* ---------------- 通知 / WebDAV（界面可覆盖环境变量默认值） ---------------- */

const notifyForm = reactive({
  botToken: '',
  chatId: '',
  barkUrl: '',
});
const webdavForm = reactive({
  url: '',
  username: '',
  password: '',
});
const notifySaving = ref(false);
const webdavSaving = ref(false);

function loadNotifyForm(): void {
  const value = notifySettings.value?.value;
  notifyForm.botToken = value?.botToken ?? '';
  notifyForm.chatId = value?.chatId ?? '';
  notifyForm.barkUrl = value?.barkUrl ?? '';
}

function loadWebdavForm(): void {
  const value = webdavSettings.value?.value;
  webdavForm.url = value?.url ?? '';
  webdavForm.username = value?.username ?? '';
  // 密码不回传：已设过的密码这里留空，用户重填才覆盖。
  webdavForm.password = '';
}

/** 判断表单是否「有内容」：有则保存为界面覆盖，无则清除回退环境变量。 */
function notifyHasInput(): boolean {
  return (
    notifyForm.botToken.trim().length > 0 ||
    notifyForm.chatId.trim().length > 0 ||
    notifyForm.barkUrl.trim().length > 0
  );
}

function webdavHasInput(): boolean {
  return webdavForm.url.trim().length > 0;
}

/** 表单 → 通知配置。Telegram 两项必须成对；Bark 单独可存；全空返回 null。 */
function notifyPayload(): NotifyConfigView | null {
  if (!notifyHasInput()) return null;
  const botToken = notifyForm.botToken.trim();
  const chatId = notifyForm.chatId.trim();
  const barkUrl = notifyForm.barkUrl.trim();
  const payload: NotifyConfigView = {};
  if (botToken.length > 0 || chatId.length > 0) {
    payload.botToken = botToken;
    payload.chatId = chatId;
  }
  if (barkUrl.length > 0) payload.barkUrl = barkUrl;
  return payload;
}

async function saveNotify(): Promise<void> {
  notifySaving.value = true;
  try {
    const payload = notifyPayload();
    if (payload === null) {
      await saveNotifySettings(null);
      notifyForm.botToken = notifyForm.chatId = notifyForm.barkUrl = '';
      notifyTestResults.value = [];
      return;
    }
    await saveNotifySettings(payload);
    loadNotifyForm();
  } finally {
    notifySaving.value = false;
  }
}

/* 测试发送：用表单里的值先测，不必先保存——配错了当场知道，不用先污染库。 */
const notifyTesting = ref(false);
const notifyTestResults = ref<NotifyTestResultView[]>([]);

async function testNotify(): Promise<void> {
  if (notifyTesting.value) return;
  notifyTesting.value = true;
  notifyTestResults.value = [];
  try {
    const outcome = await api.testNotify(notifyPayload());
    if (outcome.results === undefined) {
      notify('error', outcome.hint ?? outcome.error ?? '测试发送失败');
      return;
    }
    notifyTestResults.value = outcome.results;
    if (outcome.ok === true) notify('ok', '测试消息已发出，去手机上确认');
    else notify('error', '有渠道没发出去，原因见下方结果');
  } catch (cause) {
    notify('error', cause instanceof Error ? cause.message : '测试发送失败');
  } finally {
    notifyTesting.value = false;
  }
}

async function saveWebdav(): Promise<void> {
  webdavSaving.value = true;
  try {
    if (!webdavHasInput()) {
      await saveWebdavSettings(null);
      webdavForm.url = webdavForm.username = webdavForm.password = '';
      webdavProbe.value = null;
      return;
    }
    const url = webdavForm.url.trim();
    const username = webdavForm.username.trim();
    const password = webdavForm.password;
    // 密码框留空 = 不传 password 字段，后端保留旧密码（或视为无密码）。
    await saveWebdavSettings({
      url,
      ...(username.length > 0 ? { username } : {}),
      ...(password.length > 0 ? { password } : {}),
    });
    loadWebdavForm();
  } finally {
    webdavSaving.value = false;
  }
}

const webdavTesting = ref(false);
const webdavProbe = ref<WebDavProbeView | null>(null);

/** 失败原因翻成人话：状态码留给 title，正文只说「谁的问题」。 */
function webdavReason(reason: string | null): string {
  if (reason === null) return '连接正常';
  if (reason === 'auth-rejected') return '用户名或密码被拒（401/403）';
  if (reason === 'path-not-found') return '目录不存在（404），先到远端把目录建好';
  if (reason === 'webdav-timeout') return '连接超时，检查地址与网络';
  if (reason.startsWith('webdav-status:')) return `服务器返回 ${reason.slice('webdav-status:'.length)}`;
  return reason;
}

async function testWebdav(): Promise<void> {
  if (webdavTesting.value) return;
  webdavTesting.value = true;
  webdavProbe.value = null;
  try {
    const url = webdavForm.url.trim();
    const outcome = await api.testWebdav(
      url.length === 0
        ? null
        : {
            url,
            ...(webdavForm.username.trim().length === 0 ? {} : { username: webdavForm.username.trim() }),
            ...(webdavForm.password.length === 0 ? {} : { password: webdavForm.password }),
          },
    );
    webdavProbe.value = outcome;
    if (outcome.ok) notify('ok', 'WebDAV 连接正常，可以上传备份了');
    else notify('error', outcome.hint ?? outcome.error ?? webdavReason(outcome.reason));
  } catch (cause) {
    notify('error', cause instanceof Error ? cause.message : 'WebDAV 测试失败');
  } finally {
    webdavTesting.value = false;
  }
}

/* ---------------- 管理令牌轮换 ---------------- */

const tokenOpen = ref(false);
const tokenSaving = ref(false);
const tokenError = ref('');
const tokenForm = reactive({ next: '', confirm: '' });

async function rotateToken(): Promise<void> {
  const next = tokenForm.next.trim();
  if (next.length < 8) {
    tokenError.value = '新令牌至少 8 位';
    return;
  }
  if (next !== tokenForm.confirm.trim()) {
    tokenError.value = '两次输入不一致';
    return;
  }
  tokenError.value = '';
  tokenSaving.value = true;
  const ok = await rotateAdminToken(next);
  tokenSaving.value = false;
  if (!ok) return;
  tokenForm.next = '';
  tokenForm.confirm = '';
  tokenOpen.value = false;
}

onMounted(() => {
  loadNotifyForm();
  loadWebdavForm();
  window.history.replaceState(null, '', `#sec-${activeSection.value}`);
  window.addEventListener('hashchange', syncFromHash);
});

onUnmounted(() => {
  window.removeEventListener('hashchange', syncFromHash);
});
</script>

<template>
  <div class="page settings-page">
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分区">
        <div class="sn-title">分区</div>
        <button
          v-for="item in SETTING_SECTIONS"
          :key="item.id"
          type="button"
          class="sn-item"
          :class="{ active: activeSection === item.id }"
          :title="item.hint"
          @click="switchSection(item.id)"
        >
          <component :is="item.icon" :size="14" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="settings-main">
        <section v-if="activeSection === 'appearance'" class="card">
          <div class="card-head">
            <h2>外观</h2>
            <div class="spacer"></div>
            <Palette :size="14" class="text-3" />
          </div>
          <div class="card-body">
            <div class="field">
              <label>明暗</label>
              <n-radio-group :value="themeMode" size="small" @update:value="setThemeMode">
                <n-radio-button value="system">
                  <span class="row tight" style="gap: 5px"><Monitor :size="13" />跟随系统</span>
                </n-radio-button>
                <n-radio-button value="light">
                  <span class="row tight" style="gap: 5px"><Sun :size="13" />浅色</span>
                </n-radio-button>
                <n-radio-button value="dark">
                  <span class="row tight" style="gap: 5px"><Moon :size="13" />深色</span>
                </n-radio-button>
              </n-radio-group>
            </div>

            <div class="field" style="margin-top: 14px">
              <label>主题色</label>
              <div class="palette-row">
                <button
                  v-for="item in PALETTES"
                  :key="item.id"
                  class="palette-item"
                  :class="{ active: palette === item.id }"
                  :title="item.hint"
                  @click="setPalette(item.id)"
                >
                  <span class="palette-swatch" :style="{ background: SWATCHES[item.id] }"></span>
                  {{ item.label }}
                </button>
              </div>
              <span class="text-3" style="font-size: 11.5px; margin-top: 6px">
                每套配色同时重写中性层与结论色，明暗各一份；选择保存在本机。
              </span>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'runtime'" class="card">
          <div class="card-head">
            <h2>运行时段</h2>
            <div class="spacer"></div>
            <n-tag size="small" :bordered="false" class="mono">
              {{ runtimeLoading ? '读取中' : hasRuntime ? '已配置' : '未配置' }}
            </n-tag>
          </div>
          <div class="card-body">
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
                保存运行时段
              </n-button>
              <n-popconfirm @positive-click="saveRuntime">
                <template #trigger>
                  <n-button size="small" secondary :disabled="!hasRuntime">清空</n-button>
                </template>
                清空后产物不再写 DNS / TUN 段，确认？
              </n-popconfirm>
              <span v-if="runtimeRaw !== null && !hasRuntime" class="text-3" style="font-size: 11.5px">
                库里存了无法解析的值，保存会用当前表单覆盖它。
              </span>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'backup'" class="card">
          <div class="card-head">
            <h2>备份与缓存</h2>
            <div class="spacer"></div>
            <n-tag size="small" :bordered="false" class="mono">SQLite WAL</n-tag>
          </div>
          <div class="card-body" style="padding-top: 4px; padding-bottom: 4px">
            <div class="setting-row">
              <HardDriveDownload :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">本地快照</div>
                <div class="da-sub">含订阅源正文，一致性快照写入数据目录</div>
              </div>
              <n-button size="small" secondary :loading="busy > 0" @click="backupDatabase">备份</n-button>
            </div>

            <div class="setting-row">
              <Cloud :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">远端副本（WebDAV）</div>
                <div class="da-sub">
                  {{
                    ops?.webdav.configured
                      ? '已配置；下载回来可直接替换 data/startrails.db'
                      : '未配置，填好下面的地址即可上传'
                  }}
                  <template v-if="webdavSettings?.envDefaults"> · 环境变量已设默认值</template>
                </div>
              </div>
              <n-button
                size="small"
                secondary
                :disabled="!ops?.webdav.configured"
                :loading="busy > 0"
                @click="backupToRemote"
              >
                上传备份
              </n-button>
            </div>
            <div class="settings-form">
              <div class="field">
                <label>WebDAV 地址</label>
                <n-input v-model:value="webdavForm.url" size="small" placeholder="https://dav.example.com/remote.php/dav/files/me/startrails" />
              </div>
              <div class="field-row">
                <div class="field">
                  <label>用户名（可选）</label>
                  <n-input v-model:value="webdavForm.username" size="small" placeholder="账号" />
                </div>
                <div class="field">
                  <label>密码（可选，与用户名成对）</label>
                  <n-input
                    v-model:value="webdavForm.password"
                    type="password"
                    show-password-on="click"
                    size="small"
                    :placeholder="webdavSettings?.value?.hasPassword ? '已设置，留空保持原密码' : '密码'"
                  />
                </div>
              </div>
              <div class="form-actions">
                <span class="text-3" style="font-size: 11px">账号密码需成对填写；留空地址保存 = 清除界面配置</span>
                <span class="spacer"></span>
                <n-button size="small" secondary :loading="webdavTesting" :disabled="busy > 0" @click="testWebdav">
                  测试连接
                </n-button>
                <n-button size="small" type="primary" :loading="webdavSaving" @click="saveWebdav">保存 WebDAV</n-button>
              </div>
              <div v-if="webdavProbe !== null" class="probe-results">
                <div class="probe-row">
                  <span class="dot" :class="webdavProbe.ok ? 'ok' : 'danger'"></span>
                  <span class="text-2" style="font-size: 11.5px">
                    {{ webdavProbe.ok ? 'PROPFIND 成功，目录可写入口就绪' : webdavReason(webdavProbe.reason) }}
                  </span>
                  <span class="mono text-3" style="font-size: 10.5px; margin-left: auto">
                    {{ webdavProbe.status === 0 ? 'no-response' : `HTTP ${webdavProbe.status}` }}
                  </span>
                </div>
                <div class="text-3" style="font-size: 11px; margin-top: 2px">
                  测试只做一次只读 PROPFIND，不会在远端写入任何文件。
                </div>
              </div>
            </div>

            <div class="setting-row">
              <Database :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">清空上游缓存</div>
                <div class="da-sub">下次订阅请求重新向上游拉取；不影响已保存的配置</div>
              </div>
              <n-popconfirm @positive-click="clearCache">
                <template #trigger>
                  <n-button size="small" secondary>执行</n-button>
                </template>
                将清空全部上游缓存，确认执行？
              </n-popconfirm>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'notify'" class="card">
          <div class="card-head">
            <h2>通知</h2>
            <div class="spacer"></div>
            <Bell :size="14" class="text-3" />
          </div>
          <div class="card-body" style="padding-top: 4px; padding-bottom: 4px">
            <p class="text-3" style="font-size: 11.5px; margin: 8px 0 0">
              上游不可用、节点被目标拒收、定时刷新失败时推送；同类事件 30 分钟内只推一条。
            </p>
            <div class="setting-row">
              <Bell :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">运维通知</div>
                <div class="da-sub">
                  {{
                    ops === null
                      ? '读取中'
                      : ops.notify.enabled
                        ? `已启用：${ops.notify.channels.join(' / ')}`
                        : '未配置'
                  }}
                  <template v-if="notifySettings?.envDefaults">
                    · 环境变量已设默认值
                  </template>
                </div>
              </div>
              <n-tag size="small" :bordered="false" :type="ops?.notify.enabled ? 'success' : 'default'">
                {{ ops?.notify.enabled ? '启用' : '关闭' }}
              </n-tag>
            </div>
            <div class="settings-form">
              <div class="field">
                <label>Telegram Bot Token</label>
                <n-input v-model:value="notifyForm.botToken" size="small" placeholder="123456:ABC-DEF…" />
              </div>
              <div class="field">
                <label>Telegram Chat ID</label>
                <n-input v-model:value="notifyForm.chatId" size="small" placeholder="-1001234567890" />
              </div>
              <div class="field">
                <label>Bark 推送地址</label>
                <n-input v-model:value="notifyForm.barkUrl" size="small" placeholder="https://api.day.app/你的Key" />
              </div>
              <div class="form-actions">
                <span class="text-3" style="font-size: 11px">Telegram 两项需成对填写；留空保存 = 清除界面配置</span>
                <span class="spacer"></span>
                <n-button size="small" secondary :loading="notifyTesting" :disabled="busy > 0" @click="testNotify">
                  发一条测试
                </n-button>
                <n-button size="small" type="primary" :loading="notifySaving" @click="saveNotify">保存通知</n-button>
              </div>
              <div v-if="notifyTestResults.length > 0" class="probe-results">
                <div v-for="item in notifyTestResults" :key="item.channel" class="probe-row">
                  <span class="dot" :class="item.ok ? 'ok' : 'danger'"></span>
                  <span class="mono" style="font-size: 11.5px">{{ item.channel }}</span>
                  <span class="text-2" style="font-size: 11.5px">{{ item.ok ? '已发送' : (item.error ?? '发送失败') }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'session'" class="card">
          <div class="card-head">
            <h2>会话</h2>
            <div class="spacer"></div>
            <KeyRound :size="14" class="text-3" />
          </div>
          <div class="card-body" style="padding-top: 4px; padding-bottom: 4px">
            <div class="setting-row">
              <KeyRound :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">管理令牌</div>
                <div class="da-sub">更换后本会话继续有效，其他设备需重新输入新令牌</div>
              </div>
              <n-button size="small" secondary @click="tokenOpen = !tokenOpen">
                {{ tokenOpen ? '收起' : '更换' }}
              </n-button>
            </div>
            <div v-if="tokenOpen" class="settings-form">
              <div class="field-row">
                <div class="field">
                  <label>新令牌（至少 8 位）</label>
                  <n-input v-model:value="tokenForm.next" type="password" show-password-on="click" size="small" />
                </div>
                <div class="field">
                  <label>再输一次</label>
                  <n-input
                    v-model:value="tokenForm.confirm"
                    type="password"
                    show-password-on="click"
                    size="small"
                    @keyup.enter="rotateToken"
                  />
                </div>
              </div>
              <div class="form-actions">
                <span class="text-3" style="font-size: 11px">
                  {{ tokenError === '' ? '服务端只存哈希；令牌来自环境变量时无法在此更换' : tokenError }}
                </span>
                <span class="spacer"></span>
                <n-button size="small" type="primary" :loading="tokenSaving" @click="rotateToken">更换令牌</n-button>
              </div>
            </div>
            <div class="setting-row">
              <LogOut :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">断开连接</div>
                <div class="da-sub">清除本会话保存的管理令牌</div>
              </div>
              <n-button size="small" secondary type="error" @click="disconnect">断开</n-button>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'info'" class="card">
          <div class="card-head">
            <h2>运行信息</h2>
          </div>
          <div class="card-body">
            <dl class="kv">
              <dt>服务地址</dt>
              <dd>{{ origin }}</dd>
              <dt>内核版本</dt>
              <dd>{{ state?.coreVersion ?? '—' }}</dd>
              <dt>前端契约</dt>
              <dd>{{ UI_CORE_VERSION }}</dd>
              <dt>配置版本</dt>
              <dd>{{ state?.version ?? '—' }}</dd>
              <dt>Profile</dt>
              <dd>{{ activeProfileName }}</dd>
              <dt>引擎</dt>
              <dd>IR 扇出 · {{ state?.clientTargets.length ?? 0 }} 个客户端 / {{ dialectCount }} 种方言</dd>
              <dt>订阅源</dt>
              <dd>{{ state?.sources.length ?? 0 }} 个 · {{ state?.collections.length ?? 0 }} 个组合订阅</dd>
              <dt>调度</dt>
              <dd>
                每 {{ Math.round((ops?.scheduler.intervalMs ?? 60000) / 1000) }}s 检查到期
                <span class="text-3">·</span>
                {{ ops === null ? '读取中' : '运行中' }}
              </dd>
            </dl>
            <n-alert v-if="versionMismatch" type="warning" :bordered="false" style="margin-top: 14px">
              前端契约与内核版本不一致，请重新执行前端构建。
            </n-alert>
          </div>
        </section>

      </div>
    </div>
  </div>
</template>
