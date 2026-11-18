<script setup lang="ts">
import { computed, onActivated, onMounted, onUnmounted, reactive, ref, watch, type Component } from 'vue';
import {
  NAlert,
  NButton,
  NInput,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
} from 'naive-ui';
import {
  Activity,
  Bell,
  Cloud,
  Database,
  DownloadCloud,
  Globe,
  HardDriveDownload,
  Info,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-vue-next';
import { formatTraffic } from '../format';
import { UI_CORE_VERSION } from '../version';
import CapabilitiesView from './CapabilitiesView.vue';
import DiagnosticsView from './DiagnosticsView.vue';
import {
  PALETTES,
  activeProfileName,
  backupDatabase,
  backupToRemote,
  busy,
  clearCache,
  disconnect,
  fetchDefaultsSettings,
  geoStatus,
  geoUpdating,
  notify,
  notifySettings,
  ops,
  palette,
  rotateAdminToken,
  saveFetchDefaults,
  saveNotifySettings,
  saveWebdavSettings,
  setPalette,
  setThemeMode,
  settingsSection,
  state,
  themeMode,
  updateGeoDatabase,
  webdavSettings,
  type Palette as PaletteId,
} from '../workspace';
import { api } from '../api';
import type { FetchDefaultsView, NotifyConfigView, NotifyTestResultView, WebDavProbeView } from '../api';

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

/**
 * 设置页分区：一次只渲染一个分区，而不是把所有卡片堆成一条长页。
 * 左侧导航是真正的切换器，滚动锚点在区块变多之后已经失去意义。
 */
type SectionId =
  | 'appearance'
  | 'backup'
  | 'notify'
  | 'fetch'
  | 'session'
  | 'info'
  | 'diagnostics'
  | 'capabilities';

interface SectionMeta {
  readonly id: SectionId;
  readonly label: string;
  readonly hint: string;
  readonly icon: Component;
}

/**
 * 分区按「改动落在哪里」分成三组，而不是一条平铺列表：
 * 个人偏好与凭据只跟这台设备有关，运行时几项会写库、改产物、发通知，
 * 环境三项是这只实例的规格与诊断（只读）。分组标题同时替代了原来那个自指的「分区」标题。
 */
const SETTING_GROUPS: readonly { readonly label: string; readonly items: readonly SectionMeta[] }[] = [
  {
    label: '个人',
    items: [
      { id: 'appearance', label: '外观', hint: '明暗与主题色，选择只保存在本机', icon: Palette },
      { id: 'session', label: '会话', hint: '管理令牌与当前设备的登录状态', icon: KeyRound },
    ],
  },
  {
    // 这一组不再叫「运行时」：DNS/TUN 已经跟着配置走（配置页第四段），
    // 剩下的是备份、缓存与通知——对实例做的事，不是对产物做的事。
    label: '运维',
    items: [
      { id: 'backup', label: '备份与缓存', hint: '本地快照、WebDAV 远端副本与上游缓存', icon: Database },
      { id: 'fetch', label: '采集默认', hint: '所有订阅拉取时的默认 UA / 代理 / 请求头', icon: DownloadCloud },
      { id: 'notify', label: '通知', hint: '刷新失败时推送到 Telegram 或 Bark', icon: Bell },
    ],
  },
  {
    label: '环境',
    items: [
      { id: 'info', label: '运行信息', hint: '版本、规模与自动刷新状态，只读', icon: Info },
      { id: 'capabilities', label: '能力矩阵', hint: '核对各客户端支持的能力范围与核实依据', icon: ShieldCheck },
      // 诊断与能力是只读参考，不需要频繁切换，所以并进设置而不占一级导航。
      { id: 'diagnostics', label: '诊断', hint: '追踪构建里的跳过、降级与逐步骤结果', icon: Activity },
    ],
  },
];

const SETTING_SECTIONS = SETTING_GROUPS.flatMap((group) => group.items);

const SECTION_KEY = 'startrails_settings_section';
const SECTION_IDS = SETTING_SECTIONS.map((item) => item.id);

/**
 * 诊断与能力是从独立页整页搬进来的只读视图：760px 的行长上限会把能力矩阵压到
 * 每列只剩三行、诊断双列挤成 300px。这两个分区放开到页面宽度，其余分区照旧守 760。
 */
const WIDE_SECTIONS: readonly SectionId[] = ['diagnostics', 'capabilities'];

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
const wideSection = computed(() => WIDE_SECTIONS.includes(activeSection.value));

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

/**
 * 别的页面（如订阅列表的「查看诊断」）会把目标分区写进 settingsSection。
 * 设置页被 KeepAlive 缓存，切回来不会重新挂载，所以只能靠 watch 接住，不能放 onMounted。
 * 值被消费后置回 null，否则下次正常进设置页会被上一次的跳转反复拉走。
 */
watch(
  settingsSection,
  (id) => {
    if (id === null) return;
    if ((SECTION_IDS as readonly string[]).includes(id)) switchSection(id as SectionId);
    settingsSection.value = null;
  },
  { immediate: true },
);

/* ---------------- 通知 / WebDAV（界面可覆盖环境变量默认值） ---------------- */

const notifyForm = reactive({
  /** 总开关：关掉只停推送，不删渠道配置。 */
  enabled: true,
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

/**
 * 设置页被 KeepAlive 缓存，切回来不会再走 onMounted。表单要不要跟随全局状态重读，
 * 取决于用户有没有动过它：动了就保留，没动就同步（否则会出现「徽标已启用、表单全空」，
 * 此时点保存反而把配置清掉）。基线在每次读库 / 保存后重设。
 */
const notifyBaseline = ref('');
const webdavBaseline = ref('');
const notifyDirty = computed(() => JSON.stringify(notifyForm) !== notifyBaseline.value);
const webdavDirty = computed(() => JSON.stringify(webdavForm) !== webdavBaseline.value);

function sectionDirty(id: SectionId): boolean {
  if (id === 'backup') return webdavDirty.value;
  if (id === 'notify') return notifyDirty.value;
  if (id === 'fetch') return fetchDirty.value;
  return false;
}

function loadNotifyForm(): void {
  const value = notifySettings.value?.value;
  notifyForm.enabled = value?.enabled !== false;
  notifyForm.botToken = value?.botToken ?? '';
  notifyForm.chatId = value?.chatId ?? '';
  notifyForm.barkUrl = value?.barkUrl ?? '';
  notifyBaseline.value = JSON.stringify(notifyForm);
}

function loadWebdavForm(): void {
  const value = webdavSettings.value?.value;
  webdavForm.url = value?.url ?? '';
  webdavForm.username = value?.username ?? '';
  // 密码不回传：已设过的密码这里留空，用户重填才覆盖。
  webdavForm.password = '';
  webdavBaseline.value = JSON.stringify(webdavForm);
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

/* ---------------- 采集默认（实例级拉取 UA / 代理 / 请求头） ---------------- */

/**
 * UA 快捷预设。值是实测过的机场端点行为：Clash/Stash UA 拿到含规则与策略组的 clash-yaml，
 * mihomo 拿到纯节点订阅，Surge 拿到 Managed Config。选一个即填入下方输入框，仍可手改。
 */
const UA_PRESETS: ReadonlyArray<{ label: string; value: string; hint: string }> = [
  { label: 'Clash', value: 'Clash', hint: '多数机场返回 clash-yaml：保住规则与策略组' },
  { label: 'Stash', value: 'Stash', hint: '返回 clash-yaml，含规则与策略组' },
  { label: 'mihomo', value: 'mihomo', hint: '返回纯节点订阅，规则与策略组会缺失' },
  { label: 'Surge', value: 'Surge', hint: '返回 Surge Managed Config' },
];

interface HeaderRow {
  /** 仅作 v-for 的稳定 key（删除中间项时避免 DOM 复用错位），不参与脏判断与提交。 */
  id: string;
  name: string;
  value: string;
}
/** 与后端 FETCH_HEADER_MASK 一致：已配置的 header 值回显成掩码，原样提交即「未改、继承旧值」。 */
const HEADER_MASK: string = '••••••';
let headerSeq = 0;
const nextHeaderId = (): string => `h${(headerSeq++).toString(36)}`;
const fetchForm = reactive({
  ua: '',
  proxy: '',
  headers: [] as HeaderRow[],
});
const fetchSaving = ref(false);
const fetchBaseline = ref('');
// 只比较 ua/proxy/headers 的 name+value：header 的 id 是纯前端 key，随 load 重新生成，
// 掺进比较会让「没改也判脏」。这里剥离 id 后再序列化。
const fetchFormFingerprint = (): string =>
  JSON.stringify({
    ua: fetchForm.ua,
    proxy: fetchForm.proxy,
    headers: fetchForm.headers.map((h) => ({ name: h.name, value: h.value })),
  });
const fetchDirty = computed(() => fetchFormFingerprint() !== fetchBaseline.value);

function loadFetchForm(): void {
  const value = fetchDefaultsSettings.value?.value;
  fetchForm.ua = value?.ua ?? '';
  fetchForm.proxy = value?.proxy ?? '';
  // header 值回显是掩码，是否「已配置」靠值本身判断，不额外存布尔。
  fetchForm.headers = (value?.headers ?? []).map((h) => ({ id: nextHeaderId(), name: h.name, value: h.value }));
  fetchBaseline.value = fetchFormFingerprint();
}

function addHeader(): void {
  fetchForm.headers.push({ id: nextHeaderId(), name: '', value: '' });
}

function removeHeader(row: HeaderRow): void {
  const index = fetchForm.headers.findIndex((h) => h.id === row.id);
  if (index >= 0) fetchForm.headers.splice(index, 1);
}

function applyUaPreset(value: string): void {
  fetchForm.ua = value;
}

/** 已配置的 header 值回显成掩码，据此决定 placeholder 提示「留空保持不变」。 */
function isMasked(value: string): boolean {
  return value === HEADER_MASK;
}

/** 有任意输入即存为覆盖；全空则清除回退到「源按自身配置拉取」。 */
function fetchHasInput(): boolean {
  return (
    fetchForm.ua.trim().length > 0 ||
    fetchForm.proxy.trim().length > 0 ||
    fetchForm.headers.some((h) => h.name.trim().length > 0 && h.value.trim().length > 0)
  );
}

async function saveFetch(): Promise<void> {
  fetchSaving.value = true;
  try {
    if (!fetchHasInput()) {
      await saveFetchDefaults(null);
      loadFetchForm();
      return;
    }
    const payload: FetchDefaultsView = {
      ua: fetchForm.ua.trim(),
      proxy: fetchForm.proxy.trim(),
      headers: fetchForm.headers
        .filter((h) => h.name.trim().length > 0 && h.value.trim().length > 0)
        .map((h) => ({ name: h.name.trim(), value: h.value.trim() })),
    };
    await saveFetchDefaults(payload);
    loadFetchForm();
  } finally {
    fetchSaving.value = false;
  }
}

/** 两个渠道各自的就绪判断，tab 标签与状态行共用。 */
const telegramReady = computed(() => notifyForm.botToken.trim().length > 0 && notifyForm.chatId.trim().length > 0);
const barkReady = computed(() => notifyForm.barkUrl.trim().length > 0);
const notifyTab = ref<'telegram' | 'bark'>('telegram');

/** 表单 → 通知配置。Telegram 两项必须成对；Bark 单独可存；全空返回 null。 */
function notifyPayload(): NotifyConfigView | null {
  if (!notifyHasInput()) return null;
  const botToken = notifyForm.botToken.trim();
  const chatId = notifyForm.chatId.trim();
  const barkUrl = notifyForm.barkUrl.trim();
  const payload: NotifyConfigView = { enabled: notifyForm.enabled };
  if (botToken.length > 0 || chatId.length > 0) {
    payload.botToken = botToken;
    payload.chatId = chatId;
  }
  if (barkUrl.length > 0) payload.barkUrl = barkUrl;
  return payload;
}

/** 只带一个渠道的配置，用来「只测这一页」。 */
function channelPayload(channel: 'telegram' | 'bark'): NotifyConfigView | null {
  if (channel === 'telegram') {
    return telegramReady.value
      ? { botToken: notifyForm.botToken.trim(), chatId: notifyForm.chatId.trim() }
      : null;
  }
  return barkReady.value ? { barkUrl: notifyForm.barkUrl.trim() } : null;
}

/** 状态行只描述「现在会发生什么」，不重复表单里已经写着的字段。 */
const notifyStatus = computed(() => {
  const ready: string[] = [];
  if (telegramReady.value) ready.push('Telegram');
  if (barkReady.value) ready.push('Bark');
  if (ready.length === 0) return '未配置任何渠道，填好下面一项并保存后生效';
  if (!notifyForm.enabled) return `已暂停 · ${ready.join(' / ')} 的配置保留，打开开关即恢复`;
  return `已启用：${ready.join(' / ')}`;
});

async function saveNotify(): Promise<void> {
  notifySaving.value = true;
  try {
    const payload = notifyPayload();
    if (payload === null) {
      await saveNotifySettings(null);
      loadNotifyForm();
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

async function testNotify(channel: 'telegram' | 'bark'): Promise<void> {
  if (notifyTesting.value) return;
  const payload = channelPayload(channel);
  if (payload === null) {
    notify('error', channel === 'telegram' ? '先把 Bot Token 与 Chat ID 填完' : '先填 Bark 推送地址');
    return;
  }
  notifyTesting.value = true;
  notifyTestResults.value = [];
  try {
    const outcome = await api.testNotify(payload);
    if (outcome.results === undefined) {
      notify('error', outcome.hint ?? outcome.error ?? '测试发送失败');
      return;
    }
    notifyTestResults.value = outcome.results;
    if (outcome.ok === true) notify('ok', '测试消息已发出，去手机上确认');
    else notify('error', '没发出去，原因见下方结果');
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
      loadWebdavForm();
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
  loadFetchForm();
  window.history.replaceState(null, '', `#sec-${activeSection.value}`);
  window.addEventListener('hashchange', syncFromHash);
});

// KeepAlive 下切回设置页不会重跑 onMounted：重新拉一次配置，未编辑的表单跟着同步。
onActivated(() => {
  void (async () => {
    try {
      const [notify, webdav, fetchDefs, geo] = await Promise.all([
        api.notifySettings(),
        api.webdavSettings(),
        api.fetchDefaults(),
        api.geoStatus(),
      ]);
      notifySettings.value = notify;
      webdavSettings.value = webdav;
      fetchDefaultsSettings.value = fetchDefs;
      geoStatus.value = geo;
      if (!notifyDirty.value) loadNotifyForm();
      if (!webdavDirty.value) loadWebdavForm();
      if (!fetchDirty.value) loadFetchForm();
    } catch {
      // 拉不到就保留现有表单，不拿空值覆盖用户正在编辑的内容。
    }
  })();
});

onUnmounted(() => {
  window.removeEventListener('hashchange', syncFromHash);
});
</script>

<template>
  <div class="page">
    <div class="settings-layout" :class="{ wide: wideSection }">
      <nav class="settings-nav" aria-label="设置分区">
        <div v-for="group in SETTING_GROUPS" :key="group.label" class="sn-group">
          <div class="sn-title">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="sn-item"
            :class="{ active: activeSection === item.id }"
            :title="item.hint"
            @click="switchSection(item.id)"
          >
            <component :is="item.icon" :size="14" />
            <span>{{ item.label }}</span>
            <span v-if="sectionDirty(item.id)" class="dot warn" style="margin-left: auto" title="有未保存修改"></span>
          </button>
        </div>
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

        <section v-if="activeSection === 'backup'" class="card">
          <div class="card-head">
            <h2>备份与缓存</h2>
            <n-tag v-if="webdavDirty" size="small" type="warning" :bordered="false">WebDAV 未保存</n-tag>
            <div class="spacer"></div>
            <n-tag size="small" :bordered="false" class="mono">SQLite WAL</n-tag>
          </div>
          <div class="card-body" style="padding-top: 4px; padding-bottom: 4px">
            <div class="setting-row">
              <HardDriveDownload :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">本地快照</div>
                <div class="da-sub">含订阅正文，一致性快照写入数据目录</div>
              </div>
              <!-- 备份本身不毁数据，但每次都会在数据目录里新写一份、不覆盖旧的，
                   所以先确认一次，免得手快点几下把磁盘写满。 -->
              <n-popconfirm
                placement="bottom-end"
                style="max-width: 268px"
                positive-text="备份"
                @positive-click="backupDatabase"
              >
                <template #trigger>
                  <n-button size="small" secondary :loading="busy > 0" :disabled="busy > 0">备份</n-button>
                </template>
                <div>
                  <div>在数据目录新写一份快照？</div>
                  <div class="pc-sub">data/backup/ 下按时间命名，旧快照保留不覆盖。</div>
                </div>
              </n-popconfirm>
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
              <!-- 上传会把整库（含订阅正文、令牌密文）推到第三方 WebDAV，属于数据出本机，
                   比本地备份更需要一次确认。 -->
              <n-popconfirm
                placement="bottom-end"
                style="max-width: 268px"
                positive-text="上传"
                @positive-click="backupToRemote"
              >
                <template #trigger>
                  <n-button size="small" secondary :disabled="!ops?.webdav.configured" :loading="busy > 0">
                    上传备份
                  </n-button>
                </template>
                <div>
                  <div>上传整库到 WebDAV？</div>
                  <div class="pc-sub">先在本地写一份快照，再上传（含订阅正文与令牌密文）。</div>
                </div>
              </n-popconfirm>
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
                <n-button v-if="webdavDirty" size="small" quaternary :disabled="webdavSaving" @click="loadWebdavForm">
                  放弃修改
                </n-button>
                <n-button size="small" secondary :loading="webdavTesting" :disabled="busy > 0" @click="testWebdav">
                  测试连接
                </n-button>
                <n-button size="small" type="primary" :loading="webdavSaving" :disabled="!webdavDirty" @click="saveWebdav">
                  {{ webdavDirty ? '保存 WebDAV' : '已保存' }}
                </n-button>
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
                  <n-button size="small" secondary :loading="busy > 0" :disabled="busy > 0">执行</n-button>
                </template>
                将清空全部上游缓存，确认执行？
              </n-popconfirm>
            </div>

            <div class="setting-row">
              <Globe :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">离线 IP 与 ASN 库</div>
                <div class="da-sub">
                  <template v-if="geoStatus?.available">
                    已就绪（{{ formatTraffic(geoStatus.bytes) }} · 国家
                    {{ (geoStatus.counts.countryV4 + geoStatus.counts.countryV6).toLocaleString() }}
                    条 · ASN
                    {{ (geoStatus.counts.asnV4 + geoStatus.counts.asnV6).toLocaleString() }} 条<template
                      v-if="geoStatus.updatedAt"
                    >
                      · 更新于 {{ geoStatus.updatedAt.slice(0, 10) }}</template
                    >）
                  </template>
                  <template v-else>
                    未下载 · 仅作节点名缺失时的兜底识别（手动覆盖与节点名始终优先，数据来自 {{ geoStatus?.source ?? 'sapics/ip-location-db' }}）
                  </template>
                </div>
              </div>
              <n-button
                size="small"
                secondary
                :loading="geoUpdating"
                :disabled="geoUpdating || busy > 0"
                @click="updateGeoDatabase"
              >
                {{ geoStatus?.available ? '更新库' : '下载离线库' }}
              </n-button>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'notify'" class="card">
          <div class="card-head">
            <h2>通知</h2>
            <n-tag v-if="notifyDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
            <div class="spacer"></div>
            <Bell :size="14" class="text-3" />
          </div>
          <div class="card-body">
            <!-- 一个总开关 + 每个渠道各占一个 tab：开关管「发不发」，tab 管「怎么发」，
                 两者分开才不用在三个输入框里猜哪个渠道现在是启用的。 -->
            <div class="setting-row" style="padding-top: 4px">
              <Bell :size="16" class="text-3" />
              <div class="da-text">
                <div class="da-title">运维通知</div>
                <div class="da-sub">{{ notifyStatus }}</div>
              </div>
              <n-switch v-model:value="notifyForm.enabled" size="small" />
            </div>

            <p class="text-3" style="font-size: 11.5px; margin: 10px 0 0">
              上游不可用、节点被目标拒收、定时刷新失败时推送；同类事件 30 分钟内只推一条。
            </p>

            <n-tabs v-model:value="notifyTab" type="line" size="small" animated class="notify-tabs">
              <n-tab-pane name="telegram">
                <template #tab>
                  <span class="notify-tab">
                    Telegram
                    <span class="dot" :class="telegramReady ? 'ok' : 'muted'"></span>
                  </span>
                </template>
                <div class="field">
                  <label>Bot Token</label>
                  <n-input
                    v-model:value="notifyForm.botToken"
                    type="password"
                    show-password-on="click"
                    size="small"
                    placeholder="123456:ABC-DEF…"
                  />
                </div>
                <div class="field">
                  <label>Chat ID</label>
                  <n-input v-model:value="notifyForm.chatId" size="small" placeholder="-1001234567890" />
                </div>
                <div class="form-actions">
                  <span class="text-3" style="font-size: 11px">
                    两项需成对填写；测试不受总开关暂停限制，也不会保存
                  </span>
                  <span class="spacer"></span>
                  <n-button
                    size="small"
                    secondary
                    :loading="notifyTesting"
                    :disabled="!telegramReady || busy > 0"
                    @click="testNotify('telegram')"
                  >
                    发一条测试
                  </n-button>
                </div>
              </n-tab-pane>

              <n-tab-pane name="bark">
                <template #tab>
                  <span class="notify-tab">
                    Bark
                    <span class="dot" :class="barkReady ? 'ok' : 'muted'"></span>
                  </span>
                </template>
                <div class="field">
                  <label>推送地址</label>
                  <n-input
                    v-model:value="notifyForm.barkUrl"
                    type="password"
                    show-password-on="click"
                    size="small"
                    placeholder="https://api.day.app/你的Key"
                  />
                </div>
                <div class="form-actions">
                  <span class="text-3" style="font-size: 11px">地址里含 Key，别贴到公开地方；测试不受总开关暂停限制</span>
                  <span class="spacer"></span>
                  <n-button
                    size="small"
                    secondary
                    :loading="notifyTesting"
                    :disabled="!barkReady || busy > 0"
                    @click="testNotify('bark')"
                  >
                    发一条测试
                  </n-button>
                </div>
              </n-tab-pane>
            </n-tabs>

            <div v-if="notifyTestResults.length > 0" class="probe-results">
              <div v-for="item in notifyTestResults" :key="item.channel" class="probe-row">
                <span class="dot" :class="item.ok ? 'ok' : 'danger'"></span>
                <span class="mono" style="font-size: 11.5px">{{ item.channel }}</span>
                <span class="text-2" style="font-size: 11.5px">{{ item.ok ? '已发送' : (item.error ?? '发送失败') }}</span>
              </div>
            </div>

            <div class="form-actions notify-save">
              <span class="text-3" style="font-size: 11px">全部留空并保存 = 清除界面配置，回退环境变量</span>
              <span class="spacer"></span>
              <n-button v-if="notifyDirty" size="small" quaternary :disabled="notifySaving" @click="loadNotifyForm">
                放弃修改
              </n-button>
              <n-button size="small" type="primary" :loading="notifySaving" :disabled="!notifyDirty" @click="saveNotify">
                {{ notifyDirty ? '保存通知' : '已保存' }}
              </n-button>
            </div>
          </div>
        </section>

        <section v-if="activeSection === 'fetch'" class="card">
          <div class="card-head">
            <h2>采集默认</h2>
            <n-tag v-if="fetchDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
            <div class="spacer"></div>
            <DownloadCloud :size="14" class="text-3" />
          </div>
          <div class="card-body">
            <n-alert type="info" :bordered="false" style="margin-bottom: 14px">
              <div style="font-size: 11.5px; line-height: 1.7">
                所有订阅拉取时共用这组默认值，改动只对<strong>下次拉取</strong>生效。
                某个订阅单独配了 UA 或代理，就以它自己的为准；这里的值只在它没配时兜底。
                请求头（如鉴权用的 <code>Authorization</code>）对所有订阅生效，值脱敏保存、不回传明文。
              </div>
            </n-alert>

            <div class="field">
              <label>默认 User-Agent</label>
              <div class="ua-presets" style="margin-bottom: 6px">
                <n-button
                  v-for="preset in UA_PRESETS"
                  :key="preset.label"
                  size="tiny"
                  secondary
                  :type="fetchForm.ua === preset.value ? 'primary' : 'default'"
                  :title="preset.hint"
                  @click="applyUaPreset(preset.value)"
                >
                  {{ preset.label }}
                </n-button>
              </div>
              <n-input v-model:value="fetchForm.ua" size="small" placeholder="留空 = 用运行时默认 UA（拿到的格式不可控）" />
              <span class="text-3" style="font-size: 11px; margin-top: 5px">
                Clash / Stash 通常拿到含规则与策略组的 clash-yaml；mihomo 拿到纯节点订阅；Surge 拿到 Managed Config。
              </span>
            </div>

            <div class="field" style="margin-top: 14px">
              <label>默认拉取代理</label>
              <n-input
                v-model:value="fetchForm.proxy"
                size="small"
                placeholder="socks5://127.0.0.1:1080 或 http://10.0.0.2:8080（留空 = 直连）"
              />
              <span class="text-3" style="font-size: 11px; margin-top: 5px">
                支持 http / https / socks5。用于机场按出口 IP 限区的场景。
              </span>
            </div>

            <div class="field" style="margin-top: 14px">
              <label>附加请求头</label>
              <div v-for="row in fetchForm.headers" :key="row.id" class="fetch-header-row">
                <n-input v-model:value="row.name" size="small" placeholder="头名，如 Authorization" />
                <n-input
                  v-model:value="row.value"
                  size="small"
                  :placeholder="isMasked(row.value) ? '保持原值不改；或直接替换新值' : '头值'"
                />
                <n-button size="small" quaternary type="error" title="删除" @click="removeHeader(row)">
                  <template #icon><Trash2 :size="14" /></template>
                </n-button>
              </div>
              <span v-if="fetchForm.headers.some((h: HeaderRow) => isMasked(h.value))" class="text-3" style="font-size: 11px; margin-top: 4px">
                显示为 <span class="mono">{{ HEADER_MASK }}</span> 的条目保持不变即沿用已保存的原值
              </span>
              <n-button size="small" secondary style="margin-top: 6px" @click="addHeader">
                <template #icon><Plus :size="14" /></template>
                添加请求头
              </n-button>
            </div>

            <div class="form-actions" style="margin-top: 16px">
              <span class="text-3" style="font-size: 11px">全部留空并保存 = 清除采集默认，订阅按自身配置拉取</span>
              <span class="spacer"></span>
              <n-button v-if="fetchDirty" size="small" quaternary :disabled="fetchSaving" @click="loadFetchForm">
                放弃修改
              </n-button>
              <n-button size="small" type="primary" :loading="fetchSaving" :disabled="!fetchDirty" @click="saveFetch">
                {{ fetchDirty ? '保存采集默认' : '已保存' }}
              </n-button>
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
                <span class="text-3" style="font-size: 11px" :style="tokenError !== '' ? { color: 'var(--danger)' } : undefined">
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
              <!-- 断开只影响这台浏览器；已签发的订阅地址照常交付，所以文案要把这点说清，
                   否则用户会以为断开等于让别人的订阅失效。 -->
              <n-popconfirm
                placement="bottom-end"
                style="max-width: 268px"
                positive-text="断开"
                negative-text="取消"
                @positive-click="disconnect"
              >
                <template #trigger>
                  <n-button size="small" secondary type="error">断开</n-button>
                </template>
                <div>
                  <div>断开这台设备？</div>
                  <div class="pc-sub">要重新输入管理令牌才能进入；已签发的订阅地址不受影响。</div>
                </div>
              </n-popconfirm>
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
              <dt>服务端版本</dt>
              <dd>{{ state?.coreVersion ?? '—' }}</dd>
              <dt>界面版本</dt>
              <dd>{{ UI_CORE_VERSION }}</dd>
              <dt>配置版本</dt>
              <dd>{{ state?.version ?? '—' }}</dd>
              <dt>当前配置</dt>
              <dd>{{ activeProfileName }}</dd>
              <dt>产物生成</dt>
              <dd>
                同一套编排 → {{ state?.clientTargets.length ?? 0 }} 份订阅（归成
                {{ dialectCount }} 种客户端语法）
              </dd>
              <dt>订阅</dt>
              <dd>{{ state?.sources.length ?? 0 }} 个订阅 · {{ state?.collections.length ?? 0 }} 个组合订阅</dd>
              <dt>自动刷新</dt>
              <dd>
                每 {{ Math.round((ops?.scheduler.intervalMs ?? 60000) / 1000) }}s 检查一次到期订阅
                <span class="text-3">·</span>
                {{ ops === null ? '读取中' : '运行中' }}
              </dd>
            </dl>
            <n-alert v-if="versionMismatch" type="warning" :bordered="false" style="margin-top: 14px">
              界面版本与服务端版本不一致，请重新构建前端。
            </n-alert>
          </div>
        </section>

        <!-- 诊断与能力原本是独立页面：整页都是卡片，所以这里不再套 .card（会变成卡中卡），
             只由 .settings-embed 中和它们根元素 .page 的内边距与宽度。 -->
        <DiagnosticsView v-else-if="activeSection === 'diagnostics'" class="settings-embed" />
        <CapabilitiesView v-else-if="activeSection === 'capabilities'" class="settings-embed" />

      </div>
    </div>
  </div>
</template>
