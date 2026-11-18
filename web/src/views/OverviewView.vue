<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NEmpty, NTag } from 'naive-ui';
import { AlertTriangle, ArrowRight, Check, ChevronRight, Layers, Send, Server, Inbox } from 'lucide-vue-next';
import { formatDuration, reasonLabel, STAGE_LABELS, severityOf, timeAgo } from '../format';
import ClientIcon from '../components/ClientIcon.vue';
import {
  activeProfileName,
  allDiagnostics,
  clientNameOf,
  collections,
  evidence,
  history,
  nodes,
  openBuildDiagnostic,
  preview,
  profileEntries,
  groups,
  openSettingsSection,
  configSection,
  rules,
  sourceNameMap,
  sources,
  state,
  tab,
  target,
} from '../workspace';
import type { Tab } from '../workspace';

// 概览只汇报当前配置：/api/state 回的是全实例令牌，别的配置签了多少不该出现在这里。
const tokens = computed(() =>
  (state.value?.tokens ?? []).filter((item) => item.profile === activeProfileName.value),
);
const activeTokens = computed(() => tokens.value.filter((item) => !item.revoked));
/**
 * 同一客户端可以签出多条地址（发布弹窗会提示「已有 N 条，再生成不会让旧的失效」），
 * 所以这里按客户端聚合：6 条 Surge 显示成「Surge ×6」，而不是 6 个一模一样的标签。
 * 标签本身不可点击，合并不会丢操作。
 */
const tokenGroups = computed(() => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const item of activeTokens.value) {
    if (!counts.has(item.target)) {
      counts.set(item.target, 0);
      order.push(item.target);
    }
    counts.set(item.target, (counts.get(item.target) ?? 0) + 1);
  }
  return order.map((target) => ({ target, count: counts.get(target) ?? 0 }));
});
const kinds = computed(() => new Set(nodes.value.map((node) => node.kind)).size);
const sourceErrors = computed(() => sources.value.filter((item) => item.enabled === false).length);
const build = computed(() => {
  const passed = preview.value?.report.passed ?? 0;
  const skipped = preview.value?.report.skipped ?? 0;
  const total = passed + skipped;
  return {
    passed,
    skipped,
    total,
    ratio: total === 0 ? 0 : Math.round((passed / total) * 100),
    diagnostics: preview.value?.report.diagnostics.length ?? 0,
  };
});

/** 概览只回答「哪里会出问题」，所以按严重度取前 4 条，完整列表去诊断页。 */
const QUIET_REASONS = ['exclude', 'duplicate', 'filtered-out', 'include-kept', 'truncated-to', 'excluded-by'];

/** 诊断的 subject 常是 nodeKey 或源 id，能对上名字就别把裸 id 丢给用户。 */
const nodeNameByKey = computed(() => new Map(nodes.value.map((node) => [node.nodeKey, node.name])));

const sourceIssues = computed(() =>
  sources.value.filter((item) => item.enabled && (item.snapshotStale || item.lastError !== null)).length,
);

/** 订阅页把「订阅」与「我的节点」拆成了两张表，概览的计数必须跟着拆，否则点过去数字会变。 */
const subscriptionCount = computed(() => sources.value.filter((item) => item.kind !== 'inline').length);
const nodeGroupCount = computed(() => sources.value.filter((item) => item.kind === 'inline').length);

interface AttentionRow {
  subject: string;
  reason: string;
  stage: string;
  rank: number;
}

/**
 * /api/nodes 与 /api/preview 各自带一份 ingest 诊断，直接拼会在总览里出现两条一模一样的
 * 「bad / upstream-failed」；`source-unavailable` 又是 `upstream-failed` 的派生结论，同样只该留根因。
 * 另外「回退旧快照」是缓存状态，不在诊断流里，必须从源视图补进来——否则总览会全绿。
 */
const rows = computed<AttentionRow[]>(() => {
  const seen = new Set<string>();
  const list: AttentionRow[] = [];
  const push = (id: string, reason: string, stage: string, rank: number): void => {
    const key = `${id}\u0000${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    const subject = nodeNameByKey.value.get(id) ?? sourceNameMap.value.get(id) ?? id;
    list.push({ subject, reason, stage, rank });
  };
  const rankOf = (reason: string): number => {
    if (reason.startsWith('upstream-failed:')) return 4;
    if (reason.includes('unsupported') || reason.includes('reject')) return 3;
    if (reason.includes('not-expressible') || reason.includes('unverified')) return 2;
    return 1;
  };

  const ingested = new Set<string>();
  for (const item of allDiagnostics.value) {
    if (QUIET_REASONS.some((prefix) => item.reason.startsWith(prefix))) continue;
    if (item.reason === 'source-unavailable') continue;
    if (item.stage === 'ingest') ingested.add(item.subject);
    // 陈旧态统一由下面源视图生成，文案带「多久没更新」，比 upstream-stale:ms 更可读。
    if (item.reason.startsWith('upstream-stale:')) continue;
    push(item.subject, item.reason, item.stage, rankOf(item.reason));
  }

  for (const source of sources.value) {
    if (!source.enabled) continue;
    if (source.snapshotStale) {
      // 静默用旧数据比直接失败更难被发现，所以优先级最高，绝不能被前 4 条截断掉。
      // 措辞跟订阅页的状态列保持一致：有上游错误是「旧快照」，只是超时是「已过期」。
      const label = source.lastError !== null ? '旧快照' : '已过期';
      push(source.id, `${label} · ${formatDuration(source.snapshotAgeMs ?? 0)}`, 'ingest', 5);
    } else if (source.lastError !== null && !ingested.has(source.id)) {
      push(source.id, `拉取失败 · ${source.lastError}`, 'ingest', 4);
    }
  }

  return list.sort((a, b) => b.rank - a.rank);
});

const attention = computed(() => rows.value.slice(0, 4));

/** 节点与规则现在都在「配置」页，点卡片要连分段一起切，否则落到默认的「构成」段。 */
function openStep(step: { goto: Tab; section?: 'composition' | 'nodes' | 'rules' | 'runtime' }): void {
  if (step.section !== undefined) configSection.value = step.section;
  tab.value = step.goto;
}

function openOutputTarget(targetId: string): void {
  if (targetId === 'auto') {
    tab.value = 'publish';
    return;
  }
  target.value = targetId;
  tab.value = 'output';
}

const pipeline = computed(() => [
  {
    key: 'sources' as const,
    label: '订阅',
    goto: 'sources' as const,
    icon: Inbox,
    value: subscriptionCount.value,
    unit: '个',
    foot: [
      ...(nodeGroupCount.value > 0 ? [`${nodeGroupCount.value} 组我的节点`] : []),
      `${collections.value.length} 个组合订阅`,
      ...(sourceIssues.value > 0 ? [`${sourceIssues.value} 个异常`] : []),
      ...(sourceErrors.value > 0 ? [`${sourceErrors.value} 个停用`] : []),
    ].join(' · '),
    state: sources.value.length === 0 || sourceIssues.value > 0 ? 'warn' : 'ok',
  },
  {
    key: 'nodes' as const,
    label: '节点',
    goto: 'config' as const,
    section: 'nodes' as const,
    icon: Server,
    value: nodes.value.length,
    unit: '个',
    foot: `${kinds.value} 种协议 · ${profileEntries.value.length} 段构成`,
    state: nodes.value.length === 0 ? 'warn' : 'ok',
  },
  {
    key: 'rules' as const,
    label: '规则',
    goto: 'config' as const,
    section: 'rules' as const,
    icon: Layers,
    value: rules.value.length,
    unit: '条',
    foot: `${groups.value.length} 个策略组 · ${evidence.value.length} 条能力依据`,
    state: 'ok',
  },
  {
    key: 'publish' as const,
    label: '发布',
    goto: 'publish' as const,
    icon: Send,
    value: activeTokens.value.length,
    unit: '个地址',
    foot: `${build.value.passed}/${build.value.total} 通过 · ${build.value.skipped} 跳过`,
    state: build.value.skipped > 0 ? 'warn' : 'ok',
  },
]);
</script>

<template>
  <div class="page">
    <!-- 空库 / 零节点时，概览是第一屏：这里必须给出下一步，而不是一排 0。 -->
    <section v-if="sources.length === 0 || nodes.length === 0" class="card start-card">
      <div class="card-head">
        <h2>{{ sources.length === 0 ? '开始使用' : '还没有可用的节点' }}</h2>
        <div class="spacer"></div>
        <n-tag size="small" :bordered="false" class="mono">
          {{ sources.length === 0 ? '第 1 / 3 步' : '差一步' }}
        </n-tag>
      </div>
      <div class="card-body">
        <p class="start-lede">
          {{
            sources.length === 0
              ? '先接入一个订阅（远端链接或上传文件），或者直接填几条自己的节点。'
              : '订阅已经接入，但配置构成里没有解析出节点 —— 把它加入构成并保存即可。'
          }}
        </p>
        <div class="start-steps">
          <button type="button" class="start-step" :class="{ done: sources.length > 0 }" @click="tab = 'sources'">
            <span class="start-num">1</span>
            <div>
              <b>接入订阅或节点</b>
              <p>订阅链接、上传文件会自动识别 Clash、sing-box、Surge、base64；自己常用的几条也可以直接填。</p>
            </div>
          </button>
          <button
            type="button"
            class="start-step"
            :class="{ done: profileEntries.length > 0 }"
            @click="openStep({ goto: 'config', section: 'composition' })"
          >
            <span class="start-num">2</span>
            <div>
              <b>加入构成</b>
              <p>在「配置 › 构成」划清这份配置包含哪些订阅与节点，顺序即合并顺序；可先按源过滤、加前缀、去重。</p>
            </div>
          </button>
          <button type="button" class="start-step" :class="{ done: activeTokens.length > 0 }" @click="tab = 'publish'">
            <span class="start-num">3</span>
            <div>
              <b>签发地址</b>
              <p>按客户端生成订阅地址，导入即用；之后改配置，客户端下次拉取就生效。</p>
            </div>
          </button>
        </div>
        <div class="row" style="margin-top: 14px">
          <n-button
            size="small"
            type="primary"
            @click="sources.length === 0 ? (tab = 'sources') : openStep({ goto: 'config', section: 'composition' })"
          >
            {{ sources.length === 0 ? '添加订阅' : '去配置构成' }}
            <template #icon><ArrowRight :size="14" /></template>
          </n-button>
          <span class="text-3" style="font-size: 12px">
            支持 {{ state?.clientTargets.length ?? 0 }} 个客户端目标
          </span>
        </div>
      </div>
    </section>

    <div class="stat-grid">
      <button
        v-for="step in pipeline"
        :key="step.key"
        type="button"
        class="stat pipeline-step"
        @click="openStep(step)"
      >
        <div class="stat-label">
          <span class="dot" :class="step.state"></span>
          {{ step.label }}
          <ChevronRight :size="13" class="stat-icon" />
        </div>
        <div class="stat-value">{{ step.value }}<small>{{ step.unit }}</small></div>
        <div class="stat-foot">{{ step.foot }}</div>
      </button>
    </div>

    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>需要关注</h2>
          <span class="count">{{ attention.length }}/{{ rows.length }}</span>
          <div class="spacer"></div>
          <n-button size="tiny" quaternary @click="openSettingsSection('diagnostics')">
            全部诊断
            <template #icon><ArrowRight :size="13" /></template>
          </n-button>
        </div>
        <n-empty
          v-if="attention.length === 0"
          description="没有需要处理的跳过或降级"
          style="padding: 32px 0"
        >
          <template #icon><Check :size="26" /></template>
        </n-empty>
        <div v-else class="list">
          <div v-for="(item, index) in attention" :key="`${item.subject}-${index}`" class="list-item">
            <span class="severity-icon" :class="severityOf(item.reason)"><AlertTriangle :size="13" /></span>
            <div class="list-main">
              <div class="list-title">{{ item.subject }}</div>
              <div class="list-meta wrap" :title="item.reason">{{ reasonLabel(item.reason) }}</div>
            </div>
            <n-tag size="small" :bordered="false">{{ STAGE_LABELS[item.stage] ?? item.stage }}</n-tag>
          </div>
        </div>
      </section>

      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h2>最近构建</h2>
            <div class="spacer"></div>
            <n-button size="tiny" quaternary @click="openSettingsSection('diagnostics')">
              记录
              <template #icon><ArrowRight :size="13" /></template>
            </n-button>
          </div>
          <n-empty v-if="history.length === 0" description="还没有客户端拉取过配置" style="padding: 24px 0" />
          <div v-else class="list">
            <button
              v-for="entry in history.slice(0, 4)"
              :key="entry.buildId"
              type="button"
              class="list-item list-btn"
              @click="openBuildDiagnostic(entry.buildId)"
            >
              <span class="client-pill">
                <ClientIcon :id="entry.target" size="xs" />
                <span>{{ clientNameOf(entry.target) }}</span>
              </span>
              <span class="mono text-3" style="font-size: 10.5px">{{ entry.buildId.slice(0, 8) }}</span>
              <div class="spacer"></div>
              <span class="text-2" style="font-size: 11.5px; white-space: nowrap">
                {{ entry.passed }} 通过 / {{ entry.skipped }} 跳过
              </span>
              <span class="text-3 nowrap-time" style="font-size: 10.5px; min-width: 52px; text-align: right">
                {{ timeAgo(entry.createdAt) }}
              </span>
            </button>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>订阅地址</h2>
            <span class="count">{{ activeTokens.length }}/{{ tokens.length }}</span>
            <div class="spacer"></div>
            <n-button size="tiny" quaternary @click="tab = 'publish'">
              发布
              <template #icon><ArrowRight :size="13" /></template>
            </n-button>
          </div>
          <div class="card-body" style="padding-top: 0; padding-bottom: 0">
            <n-empty v-if="activeTokens.length === 0" description="还没有签发的地址" style="padding: 24px 0">
              <template #extra>
                <n-button size="small" quaternary @click="tab = 'publish'">去发布页选择客户端</n-button>
              </template>
            </n-empty>
            <div v-else class="row" style="gap: 8px; flex-wrap: wrap; padding: 14px 0">
              <button
                v-for="group in tokenGroups.slice(0, 6)"
                :key="group.target"
                type="button"
                class="client-pill pill-btn"
                :title="group.target === 'auto' ? '去发布页查看自适配地址' : `去产物页预览 ${clientNameOf(group.target)}`"
                @click="openOutputTarget(group.target)"
              >
                <ClientIcon :id="group.target" size="xs" />
                <span>{{ clientNameOf(group.target) }}</span>
                <span v-if="group.count > 1" class="text-3 mono" style="font-size: 11px">×{{ group.count }}</span>
              </button>
              <span v-if="tokenGroups.length > 6" class="text-3" style="font-size: 11.5px">
                +{{ tokenGroups.length - 6 }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
