<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NEmpty,
  NInput,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
} from 'naive-ui';
import { AlertTriangle, Check, Copy, Download, KeyRound, Link2, Plus, RefreshCw, Search, Trash2, WrapText } from 'lucide-vue-next';
import { formatBytes, formatTime } from '../format';
import ClientIcon from '../components/ClientIcon.vue';
import CodeView from '../components/CodeView.vue';
import { toneOfDialect } from '../client-icons';
import { renderTargetLabel, targetSelectOptions } from '../client-select';
import {
  activeProfileName,
  activeTokens,
  busy,
  clientNameOf,
  clientTargets,
  copyText,
  createToken,
  createdUrls,
  downloadPreview,
  groups,
  preview,
  previewLoading,
  previewMeta,
  collections,
  profileDirty,
  profileEntries,
  refreshPreview,
  revokeToken,
  rules,
  sourceLabel,
  state,
  tab,
  target,
  targetGroups,
  targetName,
} from '../workspace';

const tokenTarget = ref(target.value);
// 窄屏默认换行：手机上横向拖一份 JSON 才能看到 uuid，比折行更难读。
const wrap = ref(window.matchMedia('(max-width: 560px)').matches);
const targetQuery = ref('');

const currentTarget = computed(() => clientTargets.value.find((item) => item.id === target.value));
const nodesOnly = computed(() => currentTarget.value?.contentMode === 'nodes-only');
const sources = computed(() => state.value?.sources ?? []);
const tokens = computed(() => state.value?.tokens ?? []);
const latestUrl = computed(() => createdUrls.value.find((item) => item.target === tokenTarget.value));

/**
 * 构成、内联规则、策略组三样都空的时候，产物必然是空的（后端也会以 409 profile-empty 拒绝）。
 * 与其让用户点了按钮才失败，不如当场把「先去哪里补」说清楚。
 */
const profileEmpty = computed(
  () => profileEntries.value.length === 0 && rules.value.length === 0 && groups.value.length === 0,
);

/** 同一 Profile + 同一客户端已经生效的地址数：重复签发会让「哪条在用」变得不可知。 */
const duplicateCount = computed(
  () =>
    tokens.value.filter(
      (token) =>
        !token.revoked &&
        token.profile === activeProfileName.value &&
        token.target === tokenTarget.value,
    ).length,
);

const activeCountOf = (targetId: string): number =>
  tokens.value.filter(
    (token) => !token.revoked && token.profile === activeProfileName.value && token.target === targetId,
  ).length;

/** 已有重复签发的客户端个数：撤销旧地址前，这里如实报出来。 */
const duplicateTargets = computed(() => {
  const seen = new Map<string, number>();
  for (const token of tokens.value) {
    if (token.revoked || token.profile !== activeProfileName.value) continue;
    seen.set(token.target, (seen.get(token.target) ?? 0) + 1);
  }
  return [...seen.values()].filter((count) => count > 1).length;
});

/** 同一客户端有多条生效地址时，在行内标一下，避免用户以为「只剩一条」。 */
const isDuplicate = (targetId: string): boolean => activeCountOf(targetId) > 1;

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

async function selectTarget(id: string): Promise<void> {
  if (target.value === id) return;
  target.value = id;
  tokenTarget.value = id;
  await refreshPreview();
}

async function generate(): Promise<void> {
  if (profileEmpty.value) return;
  const ok = await createToken(tokenTarget.value);
  if (!ok) return;
  // auto 是「一个链接喂所有客户端」，没有对应的固定预览目标。
  if (tokenTarget.value === 'auto') return;
  target.value = tokenTarget.value;
  await refreshPreview();
}
</script>

<template>
  <div class="page">
    <section class="card">
      <div class="card-head">
        <h2>接入点</h2>
        <n-tag size="small" :bordered="false" class="mono">{{ activeProfileName }}</n-tag>
        <div class="spacer"></div>
        <n-tooltip v-if="profileDirty" trigger="hover">
          <template #trigger>
            <n-tag size="small" type="warning" :bordered="false">构成未保存</n-tag>
          </template>
          节点来源的改动还没保存，当前预览仍按已保存的构成生成
        </n-tooltip>
      </div>
      <div class="card-body">
        <div class="row" style="align-items: flex-start; gap: 24px">
          <div style="flex: 1; min-width: 220px">
            <div class="field">
              <label>节点来源（Profile 构成）</label>
              <div class="row" style="gap: 6px; margin-top: 4px">
                <template v-if="profileEntries.length > 0">
                  <n-tag v-for="entry in profileEntries" :key="`${entry.kind}:${entry.id}`" size="small" :bordered="false">
                    {{ entry.kind === 'collection' ? '组合' : '源' }} ·
                    {{ entry.kind === 'collection'
                      ? (collections.find((item) => item.id === entry.id)?.name ?? entry.id)
                      : sourceLabel(entry.id) }}
                  </n-tag>
                </template>
                <span v-else class="text-3" style="font-size: 12.5px">Profile 还没有任何来源</span>
                <n-button size="tiny" quaternary type="primary" @click="tab = 'sources'">编辑构成</n-button>
              </div>
            </div>
          </div>
          <div class="publish-picker">
            <div class="field">
              <label>签发给</label>
              <div class="row" style="margin-top: 4px">
                <n-select
                  v-model:value="tokenTarget"
                  :options="targetSelectOptions"
                  :render-label="renderTargetLabel"
                  size="small"
                  class="grow"
                />
                <n-popconfirm v-if="duplicateCount > 0" @positive-click="generate">
                  <template #trigger>
                    <n-button size="small" type="primary" :loading="busy > 0" :disabled="profileEmpty">
                      <template #icon><Plus :size="14" /></template>
                      生成地址
                    </n-button>
                  </template>
                  当前 Profile 下该客户端已有 {{ duplicateCount }} 个生效中的地址；再签一条不会让旧地址失效，
                  确认要再生成一个？
                </n-popconfirm>
                <n-button v-else size="small" type="primary" :loading="busy > 0" :disabled="profileEmpty" @click="generate">
                  <template #icon><Plus :size="14" /></template>
                  生成地址
                </n-button>
              </div>
              <span v-if="profileEmpty" class="text-3" style="font-size: 11.5px; margin-top: 6px">
                当前 Profile 还没有任何来源，签发出去的会是空配置。
                <n-button text type="primary" size="tiny" @click="tab = 'sources'">去添加来源</n-button>
              </span>
            </div>
          </div>
        </div>

        <n-alert v-if="latestUrl" type="warning" :bordered="false" style="margin-top: 16px">
          <div class="row" style="align-items: flex-start; gap: 14px">
            <KeyRound :size="15" style="margin-top: 2px" />
            <div style="flex: 1; min-width: 0">
              <div style="font-weight: 600">{{ targetName }} 订阅地址 · 明文只显示这一次</div>
              <div class="mono" style="word-break: break-all; margin-top: 2px; font-size: 11.5px">{{ latestUrl.url }}</div>
              <div class="row" style="gap: 6px; margin-top: 8px">
                <n-button size="tiny" @click="copyText(latestUrl.url)">
                  <template #icon><Copy :size="13" /></template>
                  复制
                </n-button>
                <n-button size="tiny" secondary tag="a" :href="`${latestUrl.url}?download=1`">
                  <template #icon><Download :size="13" /></template>
                  导出文件
                </n-button>
                <span class="text-3" style="font-size: 11.5px">导出即同一份产物换了个下发方式，不是另一条构建路径</span>
              </div>
            </div>
            <figure class="qr-figure">
              <img :src="`${latestUrl.url}/qr.svg`" alt="订阅二维码" width="120" height="120" />
              <figcaption>手机扫码导入</figcaption>
            </figure>
            <div class="qr-mobile-hint text-3" style="font-size: 11.5px; line-height: 1.6">
              二维码在窄屏下隐藏。请用上面的「复制」把订阅地址发到手机，或在电脑浏览器打开本页扫码。
            </div>
          </div>
        </n-alert>
      </div>
    </section>

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
                <n-button aria-label="切换自动换行" size="small" quaternary circle :type="wrap ? 'primary' : 'default'" @click="wrap = !wrap">
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
            <n-button size="small" secondary @click="copyText(preview?.content ?? '')">
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
        <CodeView
          v-else
          :content="preview?.content ?? ''"
          :dialect="currentTarget?.dialect ?? ''"
          :wrap="wrap"
        />

        <div v-if="nodesOnly" class="card-foot text-3" style="font-size: 12px">
          该客户端没有公开的完整配置格式，仅输出节点分享链接，策略组与规则在客户端内自行配置。
        </div>
        <div v-else-if="currentTarget && !currentTarget.independentEvidence" class="card-foot text-3" style="font-size: 12px">
          沿用 {{ currentTarget.dialect }} 方言输出，专属字段尚无官方依据，未做额外映射。
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>已签发</h2>
        <span class="count">{{ activeTokens.length }}</span>
        <div class="spacer"></div>
        <span class="text-3" style="font-size: 12px">填入客户端后即刻生效，撤销立即失效</span>
      </div>
      <n-empty v-if="tokens.length === 0" description="还没有签发订阅地址" style="padding: 28px 0">
        <template #icon><Link2 :size="28" /></template>
      </n-empty>
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th>客户端</th><th class="col-optional">Profile</th><th>状态</th><th class="col-wide-only">创建时间</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="token in tokens" :key="token.id">
              <td>
                <span class="client-pill">
                  <ClientIcon :id="token.target" size="xs" />
                  <span>{{ clientNameOf(token.target) }}</span>
                </span>
                <span v-if="!token.revoked && isDuplicate(token.target)" class="badge warn" style="margin-left: 6px">多条</span>
                <div class="addr-mobile">{{ formatTime(token.createdAt) }}</div>
              </td>
              <td class="text-2 col-optional">{{ token.profile }}</td>
              <td>
                <span class="row tight" style="gap: 7px">
                  <span class="dot" :class="token.revoked ? 'danger' : 'ok'"></span>
                  <span :class="token.revoked ? 'text-3' : 'text-2'" style="font-size: 12.5px">{{ token.revoked ? '已撤销' : '生效中' }}</span>
                </span>
              </td>
              <td class="text-3 col-wide-only" style="font-size: 12.5px; white-space: nowrap">{{ formatTime(token.createdAt) }}</td>
              <td class="actions">
                <n-popconfirm v-if="!token.revoked" @positive-click="revokeToken(token.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">
                      <template #icon><Trash2 :size="13" /></template>
                      撤销
                    </n-button>
                  </template>
                  撤销后该地址立即失效，已导入的客户端会拉不到配置。确认撤销「{{ clientNameOf(token.target) }}」这条？
                </n-popconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="duplicateTargets > 0" class="card-foot">
        <AlertTriangle :size="14" class="text-3" />
        <span class="text-3" style="font-size: 12px">
          有 {{ duplicateTargets }} 个客户端存在多条生效地址；重新签发不会让旧地址失效，不用了就撤销。
        </span>
      </div>
    </section>
  </div>
</template>
