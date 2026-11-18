<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import {
  NButton,
  NSelect,
  NSpin,
  NTooltip,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  Boxes,
  ChevronRight,
  Info,
  Layers,
  Inbox,
  LayoutDashboard,
  Moon,
  RefreshCw,
  Send,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-vue-next';
import ClientIcon from './components/ClientIcon.vue';
import BrandMark from './components/BrandMark.vue';
import LoginView from './components/LoginView.vue';
import OverviewView from './views/OverviewView.vue';
import SourcesView from './views/SourcesView.vue';
import ConfigView from './views/ConfigView.vue';
import OutputView from './views/OutputView.vue';
import PublishView from './views/PublishView.vue';
import SettingsView from './views/SettingsView.vue';
import {
  NAV,
  activeProfileName,
  busy,
  checkSetup,
  configSection,
  connect,
  connecting,
  connected,
  groupsDirty,
  nodes,
  onProfileChange,
  profileDirty,
  profileEntries,
  profileOptions,
  publishTarget,
  publishTargetName,
  reload,
  reloading,
  rules,
  rulesDirty,
  runtimeDirty,
  setDialoger,
  setMessenger,
  setupRequired,
  sources,
  sourceStats,
  state,
  tab,
  targetName,
  theme,
  toggleTheme,
  type Tab,
} from './workspace';

const message = useMessage();
const dialog = useDialog();
setMessenger({
  success: (text) => message.success(text),
  error: (text) => message.error(text),
});
setDialoger({
  confirmDiscard: (detail) =>
    new Promise((resolve) => {
      dialog.warning({
        title: '有未保存的修改',
        content: detail,
        positiveText: '放弃并继续',
        negativeText: '留下保存',
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onClose: () => resolve(false),
        onMaskClick: () => resolve(false),
      });
    }),
});

const VIEWS = {
  overview: OverviewView,
  sources: SourcesView,
  config: ConfigView,
  output: OutputView,
  publish: PublishView,
  settings: SettingsView,
} as const;

const ICONS = {
  overview: LayoutDashboard,
  sources: Inbox,
  config: SlidersHorizontal,
  output: Boxes,
  publish: Send,
  settings: Settings,
} as const;

const currentView = computed(() => VIEWS[tab.value]);

const navGroups = computed(() => {
  const map = new Map<string, typeof NAV>();
  for (const item of NAV) {
    const list = [...(map.get(item.group) ?? [])];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
});

/** 订阅页的数字分开算：订阅条数、自建节点总数——不能合并成一个「源」。 */
const subscriptionCount = computed(() => sources.value.filter((item) => item.kind !== 'inline').length);
const manualNodeCount = computed(() =>
  sources.value
    .filter((item) => item.kind === 'inline')
    .reduce((sum, item) => sum + (sourceStats.value[item.id]?.nodes ?? 0), 0),
);

function navCount(key: Tab): number | null {
  // 0 不显示角标：空数据本身不是一条信息，满屏的 0 会把真正的数字淹掉。
  if (key === 'overview' || key === 'settings') return null;
  let count: number;
  // 角标跟着导航名走：这一项叫「订阅」，就别把手填节点的条数也算进去。
  if (key === 'sources') count = subscriptionCount.value;
  else if (key === 'config') count = profileEntries.value.length;
  else if (key === 'output') count = nodes.value.length;
  // /api/state 回的是全实例令牌：角标只数当前配置的，不然和发布页台账对不上。
  else if (key === 'publish')
    count =
      state.value?.tokens.filter((item) => !item.revoked && item.profile === activeProfileName.value).length ?? 0;
  else return null;
  return count > 0 ? count : null;
}

/** 设置不在导航里（它属于这只实例，不属于某一页工作流），面包屑与标题只能单独给。 */
const SETTINGS_PAGE = { title: '设置', group: '系统' } as const;

const title = computed(() =>
  tab.value === 'settings' ? SETTINGS_PAGE.title : NAV.find((item) => item.key === tab.value)?.title ?? '概览',
);
const navGroup = computed(() =>
  tab.value === 'settings' ? SETTINGS_PAGE.group : '编排',
);

/** 页面头只回答「这一页管什么」，不重复顶栏的实时计数；数字放在右侧状态行。 */
const PAGE_SUMMARY: Record<Tab, string> = {
  overview: '汇总当前配置的构建结果、签发地址与最近一次客户端拉取。',
  sources: '添加订阅、维护自己的节点，再把它们组建成组合订阅。',
  config: '这份产物怎么组装：构成、节点取舍、规则与策略、DNS 与 TUN。',
  output: '客户端实际会拉到什么。只读——要改就去「配置」。',
  publish: '把这份配置签发出各客户端的订阅地址。',
  settings: '调整外观、通知与备份，并在同一页查看诊断、能力与运行信息。',
};
const pageSummary = computed(() => PAGE_SUMMARY[tab.value]);
const subtitle = computed(() => {
  switch (tab.value) {
    case 'overview':
      // 「源」是内部统称：订阅与我的节点已经拆开，摘要里就别再合成一个数。
      return `${subscriptionCount.value} 个订阅 · ${nodes.value.length} 个节点`;
    case 'sources':
      return `${subscriptionCount.value} 个订阅 · ${manualNodeCount.value} 个自建节点 · ${state.value?.collections.length ?? 0} 个组合订阅`;
    case 'config':
      return `${profileEntries.value.length} 段构成 · ${nodes.value.length} 个节点 · ${rules.value.length} 条规则`;
    case 'output':
      return `当前预览 ${targetName.value}`;
    case 'publish':
      return `签发目标 ${publishTargetName.value}`;
    // 设置页不给右上角摘要：其余页面的摘要都是「实时数据」，这里只剩分区名，
    // 而分区名左边导航已经列全了，再放一枚 chip 就是第三次重复。
    default:
      return '';
  }
});

/**
 * 切页回到顶部。
 * 页面被 KeepAlive 缓存、窗口滚动条是共用的：从滚到中段的规则页切到概览，
 * 新页会停在同样的位置，而那一页可能根本没这么长——手机上看就是「点了没反应」。
 * 这里必须瞬时归零（不传 behavior），滚动动画在切页这一下只会让它更像卡住。
 */
watch(tab, () => window.scrollTo(0, 0));

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!connected.value) return;
  if (!profileDirty.value && !rulesDirty.value && !groupsDirty.value && !runtimeDirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload);
  await checkSetup();
  const stored = sessionStorage.getItem('startrails_admin');
  if (stored && !setupRequired.value) void connect(stored);
});

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
});
const CONFIG_SCOPE_NOTES: Readonly<Record<string, string>> = {
  composition: '这份配置按顺序合并下列订阅；顺序即合并顺序，换一份配置可以引用完全不同的订阅。',
  nodes: '排除、别名、地区与排序只作用于这份配置；换一份配置，这些取舍各自独立。',
  rules: '规则和策略组各自选择继承订阅、整份替换，或和订阅组合。策略名要能在组或内置策略里找到。',
  runtime: '只作用于当前配置：手机要 fake-ip + TUN、路由器要 redir-host，各配各的。',
};

const configScopeNote = computed(() =>
  tab.value === 'config' ? (CONFIG_SCOPE_NOTES[configSection.value] ?? '') : '',
);
</script>

<template>
  <LoginView v-if="!connected" />

  <div v-else class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><BrandMark :size="22" /></div>
        <!-- 品牌锁版：上英文标、下中文名，与 brand/logo.svg 的中英双语排法一致。
             这里不写「订阅配置控制台」这类功能描述 —— 侧栏各分组已经说明了产品是干什么的。 -->
        <div class="brand-text">
          <div class="brand-name">Startrails</div>
          <div class="brand-sub">星迹</div>
        </div>
      </div>

      <nav class="nav">
        <template v-for="group in navGroups" :key="group.label">
          <div class="nav-group">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.key"
            class="nav-item"
            :class="{ active: tab === item.key }"
            :data-nav="item.key"
            :aria-current="tab === item.key ? 'page' : undefined"
            @click="tab = item.key"
          >
            <component :is="ICONS[item.key]" :size="16" :stroke-width="tab === item.key ? 2.1 : 1.75" />
            <span class="nav-label">{{ item.label }}</span>
            <span v-if="navCount(item.key) !== null" class="nav-count">{{ navCount(item.key) }}</span>
          </button>
        </template>
      </nav>

      <!-- 页脚区：一份配置 + 连接状态。配置切换既不属于「去哪一页」那条导航，
           也不该顶在品牌下面把第一眼的位置占掉，沉到底部这一栏才和它管的东西对得上。 -->
      <div class="side-foot">
        <!-- 不给 tooltip：图标 + 名字 + 箭头已经说清「这是当前配置、能换」，
             点开时再浮一个气泡只是挡视线。说明归「配置」页的分区作用域。 -->
        <div class="side-profile">
          <!-- 无边框 + 一个图标：这是「当前在为哪份配置干活」，不是要填的字段。
               带框会让侧栏底部读成一个孤零零的输入框；没有图标又只是一行漂着的字，
               看不出它能点。图标左缘与导航项对齐，读起来才像同一套东西。 -->
          <Layers :size="14" class="side-profile-icon" />
          <n-select
            class="profile-switch"
            size="small"
            :bordered="false"
            :consistent-menu-width="true"
            aria-label="切换配置"
            :value="activeProfileName"
            :options="profileOptions"
            @update:value="onProfileChange"
          />
        </div>
        <div class="side-conn">
          <span class="dot ok"></span>
          <span>已连接</span>
          <span class="spacer"></span>
          <span class="mono text-3" style="font-size: 10.5px">v{{ state?.coreVersion ?? '—' }}</span>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-crumb" aria-label="当前位置">
          <span>控制台</span>
          <ChevronRight :size="13" :stroke-width="1.8" />
          <span>{{ navGroup }}</span>
          <ChevronRight :size="13" :stroke-width="1.8" />
          <strong>{{ title }}</strong>
        </div>
        <div class="topbar-actions">
          <n-select
            v-if="profileOptions.length > 0"
            class="topbar-profile show-narrow"
            size="small"
            aria-label="当前配置"
            :value="activeProfileName"
            :options="profileOptions"
            :consistent-menu-width="false"
            @update:value="onProfileChange"
          />
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button quaternary circle size="small" aria-label="重新加载数据" :loading="reloading" @click="reload()">
                <template #icon><RefreshCw :size="15" /></template>
              </n-button>
            </template>
            重新加载
          </n-tooltip>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                quaternary circle size="small"
                :aria-label="theme === 'dark' ? '切换亮色' : '切换暗色'"
                @click="toggleTheme"
              >
                <template #icon>
                  <Sun v-if="theme === 'dark'" :size="15" />
                  <Moon v-else :size="15" />
                </template>
              </n-button>
            </template>
            {{ theme === 'dark' ? '切换亮色' : '切换暗色' }}
          </n-tooltip>
          <!-- 设置不占导航项：它属于这只实例，不属于任何一条工作流。
               桌面和手机共用这个入口，底栏因此能留出位置给「配置」。 -->
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                quaternary
                circle
                size="small"
                :type="tab === 'settings' ? 'primary' : 'default'"
                :aria-current="tab === 'settings' ? 'page' : undefined"
                aria-label="设置"
                data-nav="settings"
                @click="tab = 'settings'"
              >
                <template #icon><Settings :size="15" /></template>
              </n-button>
            </template>
            设置
          </n-tooltip>
        </div>
      </header>

      <!-- 全站统一页面头：交代分组、职能与实时状态，8 个页面共用同一套节奏。 -->
      <div class="page-intro">
        <div class="pi-text">
          <div class="pi-eyebrow"><span class="pi-eyebrow-line"></span>{{ navGroup }}</div>
          <div class="pi-title-row">
            <h1>{{ title }}</h1>
            <n-tooltip v-if="configScopeNote" trigger="hover">
              <template #trigger>
                <span class="pi-scope-info" tabindex="0" aria-label="配置作用域说明">
                  <Info :size="15" />
                </span>
              </template>
              {{ configScopeNote }}
            </n-tooltip>
          </div>
          <p>{{ pageSummary }}</p>
        </div>
        <div v-if="subtitle" class="pi-status" aria-label="当前状态">
          <ClientIcon v-if="tab === 'publish'" :id="publishTarget" size="xs" bare />
          <span>{{ subtitle }}</span>
        </div>
      </div>

      <n-spin :show="connecting" style="flex: 1">
        <Transition name="page" mode="out-in">
          <KeepAlive>
            <component :is="currentView" :key="tab" />
          </KeepAlive>
        </Transition>
      </n-spin>

      <!-- 内容页页脚：品牌 + 版权署名，居中显示，署名链接指向作者 GitHub。 -->
      <footer class="app-foot">
        <span class="brand-name">Startrails</span>
        <span>© 2026</span>
        <a href="https://github.com/vongzh" target="_blank" rel="noopener noreferrer">vongzh</a>
      </footer>
    </div>

    <nav class="tabbar">
      <button
        v-for="item in NAV"
        :key="item.key"
        class="tabbar-item"
        :class="{ active: tab === item.key }"
        :data-nav="item.key"
        :aria-current="tab === item.key ? 'page' : undefined"
        @click="tab = item.key"
      >
        <component :is="ICONS[item.key]" :size="19" :stroke-width="tab === item.key ? 2.1 : 1.7" />
        <span>{{ item.label }}</span>
      </button>
      <!-- 设置不占导航项：它属于这只实例，不属于任何一条工作流。
           五个页面全上了底栏，不再需要「更多」抽屉。 -->
    </nav>
  </div>
</template>
