<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NEmpty, NInput, NTag, NTooltip } from 'naive-ui';
import { Check, Copy, Download, RefreshCw, Search, WrapText } from 'lucide-vue-next';
import { formatBytes } from '../format';
import ClientIcon from './ClientIcon.vue';
import CodeView from './CodeView.vue';
import { toneOfDialect } from '../client-icons';
import {
  clientTargets,
  copyText,
  downloadPreview,
  preview,
  previewLoading,
  previewMeta,
  refreshPreview,
  target,
  targetGroups,
  targetName,
} from '../workspace';

/**
 * 客户端列表 + 产物预览。原先贴在发布页下方，但它是「这份配置会生成什么」，
 * 和节点、规则是同一个问题的三种视角，所以挪进产物预览页。
 *
 * 产物跟着 target 走：发布页「点客户端去看产物」「签发后拨指针」都只改 workspace
 * 的 target 而不经过本组件。页面在 KeepAlive 里只挂载一次，onMounted 接不住后续变化，
 * 所以刷新以 watch(target) 为准——组件内选客户端（selectTarget）只是改同一个值，
 * 也由这条 watch 统一触发，不再各自为政。
 */
const wrap = ref(window.matchMedia('(max-width: 560px)').matches);
const targetQuery = ref('');

const currentTarget = computed(() => clientTargets.value.find((item) => item.id === target.value));
const nodesOnly = computed(() => currentTarget.value?.contentMode === 'nodes-only');

/** 19 个客户端靠滚动找太慢：按名称 / id / 方言 / 扩展名即时筛选。 */
const filteredGroups = computed(() => {
  const needle = targetQuery.value.trim().toLowerCase();
  if (needle === '') return targetGroups.value;
  return targetGroups.value
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.name} ${item.id} ${group.label} ${group.dialect} ${item.ext}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.items.length > 0);
});
const matchCount = computed(() => filteredGroups.value.reduce((sum, group) => sum + group.items.length, 0));

function selectTarget(id: string): void {
  target.value = id;
}

watch(target, () => {
  void refreshPreview();
});

onMounted(() => {
  void refreshPreview();
});
</script>

<template>
  <div class="publish">
    <aside class="card target-list">
      <div class="card-head">
        <h2>客户端</h2>
        <span class="count">{{ matchCount }}</span>
      </div>
      <div class="target-search">
        <n-input v-model:value="targetQuery" size="small" placeholder="筛选客户端…" clearable>
          <template #prefix><Search :size="13" /></template>
        </n-input>
      </div>
      <div class="target-scroll">
        <template v-for="group in filteredGroups" :key="group.dialect">
          <div class="target-group" :class="`tone-${toneOfDialect(group.dialect)}`">
            <span class="dialect-dot"></span>{{ group.label }}
          </div>
          <button
            v-for="item in group.items"
            :key="item.id"
            class="target-item"
            :class="{ active: target === item.id }"
            :title="item.nodesOnly ? `${item.name}（仅节点）` : item.name"
            :aria-pressed="target === item.id"
            @click="selectTarget(item.id)"
          >
            <ClientIcon :id="item.id" size="sm" />
            <span class="target-name">{{ item.name }}</span>
            <span class="ext">{{ item.nodesOnly ? '仅节点' : item.ext }}</span>
          </button>
        </template>
        <n-empty
          v-if="matchCount === 0"
          description="没有匹配的客户端"
          size="small"
          style="padding: 28px 0; grid-column: 1 / -1"
        >
          <template #icon><Search :size="24" /></template>
          <n-button size="tiny" @click="targetQuery = ''">清除筛选</n-button>
        </n-empty>
      </div>
    </aside>

    <section class="card" style="overflow: hidden">
      <div class="card-head">
        <ClientIcon :id="target" size="md" />
        <h2>{{ currentTarget?.name ?? targetName }}</h2>
        <span class="badge outline mono">{{ previewMeta.filename }}</span>
        <n-tag v-if="nodesOnly" size="small" type="warning" :bordered="false">仅节点列表</n-tag>
        <div class="spacer"></div>
        <div class="head-actions">
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                aria-label="切换自动换行"
                size="small"
                quaternary
                circle
                :type="wrap ? 'primary' : 'default'"
                @click="wrap = !wrap"
              >
                <template #icon><WrapText :size="14" /></template>
              </n-button>
            </template>
            自动换行
          </n-tooltip>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button aria-label="刷新预览" size="small" quaternary circle :loading="previewLoading" @click="refreshPreview()">
                <template #icon><RefreshCw :size="14" /></template>
              </n-button>
            </template>
            重新构建
          </n-tooltip>
          <n-button size="small" secondary :disabled="!preview?.content" @click="copyText(preview?.content ?? '')">
            <template #icon><Copy :size="13" /></template>
            复制
          </n-button>
          <n-button size="small" type="primary" @click="downloadPreview">
            <template #icon><Download :size="13" /></template>
            下载
          </n-button>
        </div>
      </div>

      <div class="code-bar">
        <Check :size="12" style="color: var(--ok)" />
        <span>{{ preview?.report.passed ?? 0 }} 通过</span>
        <span class="text-3">·</span>
        <span>{{ preview?.report.skipped ?? 0 }} 跳过</span>
        <span class="text-3">·</span>
        <span>{{ previewMeta.lines }} 行</span>
        <span class="text-3">·</span>
        <span>{{ formatBytes(previewMeta.bytes) }}</span>
        <div class="spacer"></div>
        <span class="client-pill" :class="`tone-${toneOfDialect(currentTarget?.dialect ?? '')}`">
          <span class="dialect-dot"></span>{{ currentTarget?.dialect }}
        </span>
      </div>

      <div v-if="previewLoading" class="code-view">
        <div class="cv-empty">构建中…</div>
      </div>
      <CodeView v-else :content="preview?.content ?? ''" :dialect="currentTarget?.dialect ?? ''" :wrap="wrap" />

      <div v-if="nodesOnly" class="card-foot text-3" style="font-size: 12px">
        该客户端没有公开的完整配置格式，仅输出节点分享链接，策略组与规则在客户端内自行配置。
      </div>
      <div v-else-if="currentTarget && !currentTarget.independentEvidence" class="card-foot text-3" style="font-size: 12px">
        沿用 {{ currentTarget.dialect }} 方言输出，专属字段尚无官方依据，未做额外映射。
      </div>
    </section>
  </div>
</template>
