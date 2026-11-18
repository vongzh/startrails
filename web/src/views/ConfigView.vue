<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NDropdown, NEmpty, NPopconfirm, NTabPane, NTabs, NTag, NTooltip } from 'naive-ui';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-vue-next';
import type { ProfileEntryView } from '../api';
import NodesView from './NodesView.vue';
import RulesView from './RulesView.vue';
import RuntimePane from '../components/RuntimePane.vue';
import NodeTransformsPane from '../components/NodeTransformsPane.vue';
import ProfileCreateModal from '../components/ProfileCreateModal.vue';
import {
  activeProfileName,
  addProfileEntry,
  attachSources,
  busy,
  collections,
  configSection,
  discardProfileDraft,
  moveProfileEntry,
  notify,
  profileDirty,
  profileEntries,
  profiles,
  removeProfile,
  removeProfileEntry,
  saveProfile,
  sourceLabel,
  sourceStats,
  state,
  tab,
  unattachedSources,
} from '../workspace';

/**
 * 「配置」是这份产物怎么组装：构成决定拿哪些订阅，节点决定留哪些、叫什么，
 * 规则与策略决定怎么分流，DNS 与 TUN 决定客户端怎么解析和接管流量。
 * 四段都是配置级的——换一份配置，四处都该能不一样。
 */
const sources = computed(() => state.value?.sources ?? []);
const createOpen = ref(false);

/* ---------------- 配置构成 ---------------- */

const entryOptions = computed(() =>
  [
    {
      type: 'group' as const,
      label: '组合订阅',
      key: 'collections',
      // n-dropdown 的 @select 回传的是选项的 key，不是 value——用 value 会让回调收到 undefined，
      // addEntry 拆不出 id 就静默丢弃，表现就是「点了没反应」。
      children: collections.value.map((item) => ({ label: item.name, key: `collection:${item.id}` })),
    },
    {
      type: 'group' as const,
      label: '订阅',
      key: 'subscriptions',
      children: sources.value
        .filter((item) => item.kind !== 'inline')
        .map((item) => ({ label: item.name, key: `source:${item.id}` })),
    },
    {
      type: 'group' as const,
      label: '我的节点',
      key: 'nodes',
      children: sources.value
        .filter((item) => item.kind === 'inline')
        .map((item) => ({ label: item.name, key: `source:${item.id}` })),
    },
  ].filter((group) => group.children.length > 0),
);

function addEntry(value: string): void {
  const [kind, id] = value.split(':');
  if (id === undefined) return;
  const entry: ProfileEntryView = { kind: kind === 'collection' ? 'collection' : 'source', id };
  if (profileEntries.value.some((item) => item.kind === entry.kind && item.id === entry.id)) {
    notify('error', '已经在构成里了');
    return;
  }
  addProfileEntry(entry);
}

function entryName(entry: ProfileEntryView): string {
  if (entry.kind === 'source') return sourceLabel(entry.id);
  return collections.value.find((item) => item.id === entry.id)?.name ?? `缺失：${entry.id}`;
}

function entryCount(entry: ProfileEntryView): string {
  if (entry.kind === 'source') {
    const stat = sourceStats.value[entry.id];
    return stat === undefined ? '—' : String(stat.nodes);
  }
  const found = collections.value.find((item) => item.id === entry.id);
  return found?.previewCount === undefined ? '—' : String(found.previewCount);
}

/** 直接相加是去重前的量，不能和旁边「按节点指纹全局去重」说成同一个数。 */
const derivedNodes = computed(() =>
  profileEntries.value.reduce((sum, entry) => {
    const value = Number.parseInt(entryCount(entry), 10);
    return Number.isNaN(value) ? sum : sum + value;
  }, 0),
);
</script>

<template>
  <div class="page config-page">
    <n-tabs v-model:value="configSection" type="line" size="small" animated class="pane-tabs">
      <template #suffix>
        <div class="head-actions" style="padding-bottom: 4px">
          <n-button size="small" quaternary @click="createOpen = true">
            <template #icon><Plus :size="14" /></template>
            新建配置
          </n-button>
          <n-popconfirm v-if="profiles.length > 1" @positive-click="removeProfile(activeProfileName)">
            <template #trigger>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <n-button aria-label="删除当前配置" quaternary circle size="small" type="error">
                    <template #icon><Trash2 :size="14" /></template>
                  </n-button>
                </template>
                删除当前配置
              </n-tooltip>
            </template>
            删除配置「{{ activeProfileName }}」？绑定它的订阅地址会一并撤销，其余配置不受影响。
          </n-popconfirm>
        </div>
      </template>

      <n-tab-pane name="composition" tab="构成">

        <section class="card">
          <div class="card-head">
            <h2>配置构成</h2>
            <span class="count">{{ profileEntries.length }}</span>
            <!-- 只在有改动时出现：没有待保存的改动就不写「已保存」，安静本身就是状态。 -->
            <n-tag v-if="profileDirty" size="small" :bordered="false" type="warning">未保存</n-tag>
            <div class="spacer"></div>
            <div class="head-actions">
              <!-- 下拉按钮而非 select：它是一次「往列表里追加」的动作，不是常驻字段。
                   主按钮权重跟着本卡此刻的主操作走：有未保存改动时让位给右侧「保存」，
                   这里退成同色系浅底（tonal），不用灰底——灰底会被读成禁用。 -->
              <n-dropdown
                trigger="click"
                placement="bottom-end"
                :options="entryOptions"
                :disabled="entryOptions.length === 0"
                @select="addEntry"
              >
                <n-button size="small" type="primary" :secondary="profileDirty" :disabled="entryOptions.length === 0">
                  <template #icon><Plus :size="14" /></template>
                  加入订阅
                </n-button>
              </n-dropdown>
              <n-button v-if="profileDirty" size="small" quaternary @click="discardProfileDraft">撤销</n-button>
              <n-button v-if="profileDirty" size="small" type="primary" :loading="busy > 0" @click="saveProfile()">
                保存
              </n-button>
            </div>
          </div>

          <!-- 加完源却没进构成，是「节点一直是 0」最常见的成因；在构成卡片上当场补挂。 -->
          <div v-if="unattachedSources.length > 0" class="card-foot attach-hint">
            <AlertTriangle :size="14" class="text-3" />
            <span class="text-2" style="font-size: 12px">
              {{ unattachedSources.length }} 个已启用的订阅或我的节点还没加入构成，构建不会用到它们
            </span>
            <span class="text-3" style="font-size: 11.5px" :title="unattachedSources.map((item) => item.name).join('、')">
              {{ unattachedSources.slice(0, 3).map((item) => item.name).join('、') }}{{ unattachedSources.length > 3 ? ' 等' : '' }}
            </span>
            <div class="spacer"></div>
            <n-button size="tiny" secondary :loading="busy > 0" @click="attachSources(unattachedSources.map((item) => item.id))">
              全部加入构成
            </n-button>
          </div>

          <n-empty
            v-if="profileEntries.length === 0"
            description="这份配置还没有任何订阅，发布出去会是空配置"
            style="padding: 28px 0"
          >
            <template #extra>
              <n-button v-if="sources.length === 0" size="small" type="primary" @click="tab = 'sources'">
                <template #icon><Plus :size="14" /></template>
                先去添加订阅
              </n-button>
              <span v-else class="text-3" style="font-size: 12px">点右上角「加入订阅」，把已有的订阅放进这份构成</span>
            </template>
          </n-empty>

          <div v-else>
            <div v-for="(entry, index) in profileEntries" :key="`${entry.kind}:${entry.id}`" class="entry-row">
              <span class="entry-index mono">{{ index + 1 }}</span>
              <n-tag size="small" :bordered="false" :type="entry.kind === 'collection' ? 'primary' : 'default'">
                {{ entry.kind === 'collection' ? '组合' : '源' }}
              </n-tag>
              <span class="strong" style="font-size: 13px">{{ entryName(entry) }}</span>
              <span class="text-3 mono" style="font-size: 11.5px">{{ entryCount(entry) }} 节点</span>
              <div class="spacer"></div>
              <div class="row-actions">
                <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveProfileEntry(index, -1)">
                  <template #icon><ArrowUp :size="13" /></template>
                </n-button>
                <n-button
                  aria-label="下移"
                  quaternary
                  circle
                  size="tiny"
                  :disabled="index === profileEntries.length - 1"
                  @click="moveProfileEntry(index, 1)"
                >
                  <template #icon><ArrowDown :size="13" /></template>
                </n-button>
                <n-button aria-label="从构成里移除" quaternary circle size="tiny" type="error" @click="removeProfileEntry(index)">
                  <template #icon><X :size="13" /></template>
                </n-button>
              </div>
            </div>
            <div class="card-foot">
              <span class="text-3" style="font-size: 12px">
                顺序即合并顺序；按节点指纹全局去重，同一订阅被多个组合订阅引用只出现一次。
              </span>
              <div class="spacer"></div>
              <span class="mono text-2" style="font-size: 12px">合计 {{ derivedNodes }} 节点（去重前）</span>
            </div>
          </div>
        </section>
      </n-tab-pane>

      <n-tab-pane name="nodes" tab="节点">
        <NodeTransformsPane />
        <NodesView class="embed" />
      </n-tab-pane>

      <n-tab-pane name="rules" tab="规则与策略">
        <RulesView class="embed" />
      </n-tab-pane>

      <n-tab-pane name="runtime" tab="DNS/TUN">
        <RuntimePane />
      </n-tab-pane>
    </n-tabs>

    <ProfileCreateModal v-model:show="createOpen" />
  </div>
</template>
