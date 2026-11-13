<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSpin,
  NTag,
  NTooltip,
} from 'naive-ui';
import { Check, ChevronRight, Info, Search } from 'lucide-vue-next';
import { REASON_LABELS, STAGE_LABELS, formatTime, reasonLabel, severityOf } from '../format';
import ClientIcon from '../components/ClientIcon.vue';
import {
  allDiagnostics,
  buildReport,
  buildReportLoading,
  clientNameOf,
  closeBuildReport,
  history,
  loadBuildReport,
  loadTraceIfNeeded,
  preview,
  traceSteps,
} from '../workspace';

const stage = ref('');
const search = ref('');

const STAGES = ['ingest', 'process', 'plan', 'emit'] as const;

const counts = computed(() => {
  const map = new Map<string, number>();
  for (const item of allDiagnostics.value) map.set(item.stage, (map.get(item.stage) ?? 0) + 1);
  return map;
});

const list = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return allDiagnostics.value.filter((item) => {
    if (stage.value !== '' && item.stage !== stage.value) return false;
    if (needle.length === 0) return true;
    return (
      item.reason.toLowerCase().includes(needle) ||
      item.subject.toLowerCase().includes(needle) ||
      (item.target ?? '').toLowerCase().includes(needle)
    );
  });
});

const traceTotal = computed(() => traceSteps.value.reduce((sum, step) => sum + step.diff.length, 0));

/** 构建历史里点开的那一次：按需拉完整回执，不预先展开全部。 */
const detailOpen = ref(false);
const selectedId = ref('');

async function openReport(buildId: string): Promise<void> {
  selectedId.value = buildId;
  detailOpen.value = true;
  await loadBuildReport(buildId);
}

function onDrawerChange(show: boolean): void {
  if (show) return;
  detailOpen.value = false;
  closeBuildReport();
  selectedId.value = '';
}

const reportRows = computed(() => buildReport.value?.report.diagnostics ?? []);
const reportStages = computed(() => {
  const map = new Map<string, number>();
  for (const item of reportRows.value) map.set(item.stage, (map.get(item.stage) ?? 0) + 1);
  return [...map.entries()].map(([stage, count]) => ({
    stage,
    label: STAGE_LABELS[stage] ?? stage,
    count,
  }));
});

onMounted(() => {
  void loadTraceIfNeeded();
});
</script>

<template>
  <div class="page">
    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>构建诊断</h2>
          <span class="count">{{ list.length }}</span>
          <div class="spacer"></div>
          <n-tag size="small" :bordered="false" class="mono">{{ preview?.target ?? '—' }}</n-tag>
        </div>

        <div class="card-head filters">
          <n-radio-group v-model:value="stage" size="small">
            <n-radio-button value="">全部 {{ allDiagnostics.length }}</n-radio-button>
            <n-radio-button v-for="item in STAGES" :key="item" :value="item">
              {{ STAGE_LABELS[item] }} {{ counts.get(item) ?? 0 }}
            </n-radio-button>
          </n-radio-group>
          <n-input v-model:value="search" size="small" placeholder="搜索原因或对象" clearable class="grow" style="min-width: 160px">
            <template #prefix><Search :size="14" /></template>
          </n-input>
        </div>

        <n-empty v-if="allDiagnostics.length === 0" description="当前构建没有任何跳过或降级" style="padding: 40px 0">
          <template #icon><Check :size="30" /></template>
        </n-empty>
        <n-empty v-else-if="list.length === 0" description="没有匹配的诊断" style="padding: 40px 0">
          <template #icon><Search :size="30" /></template>
          <template #extra>
            <n-button size="small" quaternary @click="stage = ''; search = ''">清除筛选</n-button>
          </template>
        </n-empty>

        <div v-else class="list">
          <div v-for="(item, index) in list" :key="`${item.stage}-${index}`" class="list-item" style="align-items: flex-start">
            <span class="dot" :class="severityOf(item.reason)" style="margin-top: 6px"></span>
            <div class="list-main">
              <div class="list-title" style="font-weight: 500" :title="item.reason">{{ reasonLabel(item.reason) }}</div>
              <div class="list-meta" :title="item.subject">{{ item.subject }}</div>
            </div>
            <div class="row tight" style="flex: none">
              <n-tag size="small" :bordered="false">{{ STAGE_LABELS[item.stage] ?? item.stage }}</n-tag>
              <span v-if="item.target" class="client-pill">
                <ClientIcon :id="item.target" size="xs" />
                <span>{{ clientNameOf(item.target) }}</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h2>构建历史</h2>
            <span class="count">{{ history.length }}</span>
          </div>
          <n-empty v-if="history.length === 0" description="暂无构建记录" style="padding: 24px 0" />
          <div v-else class="list">
            <button
              v-for="entry in history"
              :key="entry.buildId"
              class="list-item tap"
              style="padding: 10px 18px; text-align: left; width: 100%"
              :class="{ active: selectedId === entry.buildId && detailOpen }"
              @click="openReport(entry.buildId)"
            >
              <div class="list-main">
                <div class="list-title">
                  <span class="client-pill">
                    <ClientIcon :id="entry.target" size="xs" />
                    <span>{{ clientNameOf(entry.target) }}</span>
                  </span>
                  <span class="mono text-3" style="font-size: 11.5px">{{ entry.buildId.slice(0, 8) }}</span>
                </div>
                <div class="list-meta">{{ formatTime(entry.createdAt) }}</div>
              </div>
              <div style="text-align: right">
                <div class="text-2" style="font-size: 12px">{{ entry.passed }} 通过</div>
                <div class="text-3" style="font-size: 11.5px">{{ entry.skipped }} 跳过</div>
              </div>
              <ChevronRight :size="14" class="text-3" />
            </button>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>加工轨迹</h2>
            <span class="count">{{ traceSteps.length }} 步</span>
            <div class="spacer"></div>
            <n-tooltip trigger="hover">
              <template #trigger>
                <Info :size="14" class="text-3" />
              </template>
              标注与规则变更后重新走加工链，此处为最近一次的结构化变更
            </n-tooltip>
            <span class="text-3" style="font-size: 12px">{{ traceTotal }} 处</span>
          </div>
          <n-empty v-if="traceSteps.length === 0" description="当前没有加工步骤" style="padding: 24px 0" />
          <div v-else class="card-body stack" style="gap: 8px">
            <div v-for="step in traceSteps" :key="step.index" class="trace-step">
              <div class="row" style="gap: 8px">
                <n-tag size="small" :bordered="false" class="mono">步骤 {{ step.index }}</n-tag>
                <span class="text-2" style="font-size: 12.5px">{{ step.nodesBefore }} → {{ step.nodesAfter }} 节点</span>
                <div class="spacer"></div>
                <span class="text-3" style="font-size: 11.5px">{{ step.diff.length }} 处变更</span>
              </div>
              <div v-for="(change, position) in step.diff" :key="position" class="mono text-3 trace-diff">
                {{ change.kind }} · {{ change.ref }}<template v-if="change.detail"> · {{ change.detail }}</template>
              </div>
              <div v-if="step.diff.length === 0" class="text-3" style="font-size: 11.5px; margin-top: 4px">无变更</div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 构建回执：历史里点某一次，看它当时的完整诊断，而不是只看最新一次。 -->
    <n-drawer :show="detailOpen" :width="540" placement="right" @update:show="onDrawerChange">
      <n-drawer-content :title="`构建回执 · ${buildReport ? clientNameOf(buildReport.target) : ''}`" closable>
        <n-spin :show="buildReportLoading">
          <div v-if="buildReport !== null" class="stack" style="gap: 12px">
            <dl class="kv">
              <dt>构建 ID</dt>
              <dd class="mono">{{ buildReport.buildId }}</dd>
              <dt>时间</dt>
              <dd>{{ formatTime(buildReport.createdAt) }}</dd>
              <dt>结果</dt>
              <dd>{{ buildReport.report.passed }} 通过 · {{ buildReport.report.skipped }} 跳过</dd>
            </dl>
            <div v-if="reportStages.length > 0" class="row" style="gap: 6px">
              <n-tag v-for="item in reportStages" :key="item.stage" size="small" :bordered="false" class="mono">
                {{ item.label }} {{ item.count }}
              </n-tag>
            </div>
            <n-empty v-if="reportRows.length === 0" description="这一次构建没有跳过或降级" style="padding: 28px 0">
              <template #icon><Check :size="26" /></template>
            </n-empty>
            <div v-else class="list">
              <div v-for="(item, index) in reportRows" :key="index" class="list-item" style="align-items: flex-start">
                <span class="dot" :class="severityOf(item.reason)" style="margin-top: 6px"></span>
                <div class="list-main">
                  <div class="list-title" style="font-weight: 500" :title="item.reason">{{ reasonLabel(item.reason) }}</div>
                  <div class="list-meta" :title="item.subject">{{ item.subject }}</div>
                </div>
                <n-tag size="small" :bordered="false">{{ STAGE_LABELS[item.stage] ?? item.stage }}</n-tag>
              </div>
            </div>
          </div>
          <n-empty v-else-if="!buildReportLoading" description="没有这条构建记录" style="padding: 40px 0" />
        </n-spin>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>
