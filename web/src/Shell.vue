<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTooltip,
  useMessage,
} from 'naive-ui';
import {
  Activity,
  ChevronRight,
  Filter,
  Inbox,
  LayoutDashboard,
  Menu,
  Moon,
  RefreshCw,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sun,
} from 'lucide-vue-next';
import ClientIcon from './components/ClientIcon.vue';
import BrandMark from './components/BrandMark.vue';
import PublishDialog from './components/PublishDialog.vue';
import LoginView from './components/LoginView.vue';
import OverviewView from './views/OverviewView.vue';
import SourcesView from './views/SourcesView.vue';
import NodesView from './views/NodesView.vue';
import RulesView from './views/RulesView.vue';
import PublishView from './views/PublishView.vue';
import DiagnosticsView from './views/DiagnosticsView.vue';
import CapabilitiesView from './views/CapabilitiesView.vue';
import SettingsView from './views/SettingsView.vue';
import {
  NAV,
  activeProfileName,
  allDiagnostics,
  busy,
  checkSetup,
  connect,
  connecting,
  connected,
  createProfile,
  evidence,
  groups,
  loadAll,
  nodes,
  preview,
  profileEntries,
  profiles,
  reload,
  rules,
  setMessenger,
  setupRequired,
  sources,
  state,
  switchProfile,
  tab,
  target,
  targetName,
  theme,
  toggleTheme,
  type Tab,
} from './workspace';

const message = useMessage();
setMessenger({
  success: (text) => message.success(text),
  error: (text) => message.error(text),
});

const moreOpen = ref(false);
/** 顶栏的「发布」是动作而不是导航：就地签发一条地址，省掉整页跳转。 */
const publishOpen = ref(false);

/* ---------------- Profile（多套独立构成与订阅地址） ---------------- */

const NEW_PROFILE = '__new__';
const newProfileOpen = ref(false);
const newProfileName = ref('');

const profileOptions = computed(() => [
  ...profiles.value.map((item) => ({
    label: item.name,
    value: item.name,
  })),
  { label: '＋ 新建 Profile…', value: NEW_PROFILE },
]);

async function onProfileChange(value: string): Promise<void> {
  if (value === NEW_PROFILE) {
    newProfileName.value = '';
    newProfileOpen.value = true;
    return;
  }
  await switchProfile(value);
}

async function submitProfile(): Promise<void> {
  const name = newProfileName.value.trim();
  if (name.length === 0) return;
  const ok = await createProfile(name);
  if (ok) newProfileOpen.value = false;
}

const VIEWS = {
  overview: OverviewView,
  sources: SourcesView,
  nodes: NodesView,
  rules: RulesView,
  publish: PublishView,
  diagnostics: DiagnosticsView,
  capabilities: CapabilitiesView,
  settings: SettingsView,
} as const;

const ICONS = {
  overview: LayoutDashboard,
  sources: Inbox,
  nodes: Server,
  rules: Filter,
  publish: Send,
  diagnostics: Activity,
  capabilities: ShieldCheck,
  settings: Settings,
} as const;

const currentView = computed(() => VIEWS[tab.value]);
const mobileNav = computed(() => NAV.filter((item) => item.mobile === true));
const moreNav = computed(() => NAV.filter((item) => item.mobile !== true));

const navGroups = computed(() => {
  const map = new Map<string, typeof NAV>();
  for (const item of NAV) {
    const list = [...(map.get(item.group) ?? [])];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
});

function navCount(key: Tab): number | null {
  // 0 不显示角标：空数据本身不是一条信息，满屏的 0 会把真正的数字淹掉。
  if (key === 'overview') return null;
  let count: number;
  if (key === 'sources') count = sources.value.length;
  else if (key === 'nodes') count = nodes.value.length;
  else if (key === 'rules') count = rules.value.length;
  else if (key === 'diagnostics') count = allDiagnostics.value.length;
  else if (key === 'capabilities') count = evidence.value.length;
  else if (key === 'publish') count = state.value?.tokens.filter((item) => !item.revoked).length ?? 0;
  else return null;
  return count > 0 ? count : null;
}

const title = computed(() => NAV.find((item) => item.key === tab.value)?.title ?? '概览');
const navGroup = computed(() => NAV.find((item) => item.key === tab.value)?.group ?? '编排');

/** 页面头只回答「这一页管什么」，不重复顶栏的实时计数；数字放在右侧状态行。 */
const PAGE_SUMMARY: Record<Tab, string> = {
  overview: '汇总当前配置的构建结果、签发地址与最近一次客户端拉取。',
  sources: '维护订阅来源、组合订阅与 Profile 的节点构成顺序。',
  nodes: '查看订阅源解析出的节点，按需调序、改名或排除。',
  rules: '维护内联规则与策略组，保存后参与下一次构建。',
  publish: '选择客户端目标，预览并签发对应的订阅地址。',
  diagnostics: '追踪一次构建里的跳过、降级与加工链逐步骤结果。',
  capabilities: '核对各客户端目标支持的能力范围与核实依据。',
  settings: '调整外观、运行时段、通知与备份，并查看本实例运行信息。',
};
const pageSummary = computed(() => PAGE_SUMMARY[tab.value]);

const subtitle = computed(() => {
  switch (tab.value) {
    case 'overview':
      return `${sources.value.length} 个源 · ${nodes.value.length} 个节点`;
    case 'sources':
      return `${sources.value.length} 个订阅源 · ${state.value?.collections.length ?? 0} 个组合 · ${profileEntries.value.length} 段构成`;
    case 'nodes':
      return `${nodes.value.length} 个节点参与构建`;
    case 'rules':
      return `${rules.value.length} 条规则 · ${groups.value.length} 个策略组`;
    case 'publish':
      return `当前预览 ${targetName.value}`;
    case 'diagnostics':
      return `${allDiagnostics.value.length} 条诊断 · ${preview.value?.report.passed ?? 0} 条通过`;
    case 'capabilities':
      return `${evidence.value.length} 条核实依据`;
    // 设置页不给右上角摘要：其余页面的摘要都是「实时数据」，这里只剩分区名，
    // 而分区名左边导航已经列全了，再放一枚 chip 就是第三次重复。
    default:
      return '';
  }
});

function goto(next: Tab): void {
  tab.value = next;
  moreOpen.value = false;
}

onMounted(async () => {
  await checkSetup();
  const stored = sessionStorage.getItem('startrails_admin');
  if (stored && !setupRequired.value) void connect(stored);
});
</script>

<template>
  <LoginView v-if="!connected" />

  <div v-else class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><BrandMark :size="22" /></div>
        <div class="brand-text">
          <div class="brand-name">Startrails</div>
          <div class="brand-sub">订阅配置控制台</div>
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

      <div class="side-foot">
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
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-select
                class="profile-switch"
                size="small"
                :value="activeProfileName"
                :options="profileOptions"
                :consistent-menu-width="false"
                @update:value="onProfileChange"
              />
            </template>
            当前编辑的 Profile：构成与订阅地址都按 Profile 独立
          </n-tooltip>
          <n-button size="small" type="primary" aria-haspopup="dialog" @click="publishOpen = true">
            <template #icon><Send :size="14" /></template>
            <span class="hide-sm">发布</span>
          </n-button>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button quaternary circle size="small" aria-label="重新加载数据" :loading="busy > 0" @click="reload()">
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
        </div>
      </header>

      <!-- 全站统一页面头：交代分组、职能与实时状态，8 个页面共用同一套节奏。 -->
      <div class="page-intro">
        <div class="pi-text">
          <div class="pi-eyebrow"><span class="pi-eyebrow-line"></span>{{ navGroup }}</div>
          <h1>{{ title }}</h1>
          <p>{{ pageSummary }}</p>
        </div>
        <div v-if="subtitle" class="pi-status" aria-label="当前状态">
          <ClientIcon v-if="tab === 'publish'" :id="target" size="xs" bare />
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
        v-for="item in mobileNav"
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
      <button
        class="tabbar-item"
        :class="{ active: moreNav.some((item) => item.key === tab) }"
        aria-label="更多页面"
        @click="moreOpen = true"
      >
        <Menu :size="19" :stroke-width="1.7" />
        <span>更多</span>
      </button>
    </nav>

    <n-drawer v-model:show="moreOpen" :height="260" placement="bottom">
      <n-drawer-content title="更多">
        <div class="list">
          <button v-for="item in moreNav" :key="item.key" class="list-item tap" @click="goto(item.key)">
            <component :is="ICONS[item.key]" :size="16" class="text-3" />
            <span>{{ item.label }}</span>
            <span class="spacer"></span>
            <span class="mono text-3" style="font-size: 11.5px">{{ navCount(item.key) ?? '' }}</span>
          </button>
        </div>
      </n-drawer-content>
    </n-drawer>

    <n-modal
      v-model:show="newProfileOpen"
      preset="card"
      title="新建 Profile"
      style="width: 380px; max-width: calc(100vw - 32px)"
    >
      <div class="field">
        <label>名称</label>
        <n-input
          v-model:value="newProfileName"
          size="small"
          placeholder="例如 work"
          @keyup.enter="submitProfile"
        />
        <span class="text-3" style="font-size: 11.5px">
          Profile 之间互不影响：各自有独立的构成、节点顺序与订阅地址。
        </span>
      </div>
      <template #footer>
        <div class="row end" style="width: 100%">
          <n-button size="small" quaternary @click="newProfileOpen = false">取消</n-button>
          <n-button size="small" type="primary" :loading="busy > 0" @click="submitProfile">创建</n-button>
        </div>
      </template>
    </n-modal>

    <PublishDialog v-model:show="publishOpen" />
  </div>
</template>
