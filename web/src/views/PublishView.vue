<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCheckbox,
  NEmpty,
  NModal,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
} from 'naive-ui';
import { AlertTriangle, Copy, Download, KeyRound, Link2, Plus, QrCode, RefreshCw, Trash2 } from 'lucide-vue-next';
import { formatTime } from '../format';
import type { TokenView } from '../api';
import ClientIcon from '../components/ClientIcon.vue';
import { renderTargetLabel, targetSelectOptions } from '../client-select';
import {
  activeProfileName,
  busy,
  clientNameOf,
  configSection,
  copyText,
  createToken,
  createdUrls,
  groups,
  latestTokenId,
  profileDirty,
  profileEntries,
  publishTarget,
  publishTargetName,
  reissueToken,
  revokeToken,
  rules,
  state,
  tab,
  target,
} from '../workspace';

const sources = computed(() => state.value?.sources ?? []);
const tokens = computed(() => state.value?.tokens ?? []);
const latestUrl = computed(() =>
  createdUrls.value.find((item) => item.profile === activeProfileName.value && item.target === publishTarget.value),
);

function tokenTail(url: string): string {
  const clean = url.split('?')[0] ?? url;
  return clean.slice(-6);
}

/**
 * 台账只看「这份配置」的地址：`/api/state` 回的是全实例令牌，别的配置签过多少与本页无关，
 * 混进来只会让标题数字和行数对不上。换配置是侧栏那个下拉的事，这张表不承担导航。
 */
const profileTokens = computed(() =>
  tokens.value.filter((token) => token.profile === activeProfileName.value),
);

/** 唯一的一个开关：生效中 / 含已撤销。撤销只打标记不删数据，随时能翻出来。 */
const showRevoked = ref(false);

const visibleTokens = computed(() =>
  profileTokens.value.filter((token) => showRevoked.value || !token.revoked),
);

/** 被收起的历史条数：标题写「可见/全部」，一眼看出还有多少没列出来。 */
const hiddenCount = computed(() => profileTokens.value.length - visibleTokens.value.length);
const hiddenRevoked = computed(() => profileTokens.value.filter((token) => token.revoked).length);

/**
 * 二维码单独弹一层：台账行里塞 200px 的图会把表格撑高，
 * 而扫码这件事本身就是「停下来用手机扫一次」，弹窗刚好。
 */
const qrToken = ref<TokenView | null>(null);
const qrVisible = ref(false);

function openQr(token: TokenView): void {
  if (token.url === null) return;
  qrToken.value = token;
  qrVisible.value = true;
}

/**
 * 早期记录只存 hash，url 为 null：断言函数收口在这里，
 * 模板里就不必到处写 `token.url as string`。
 */
function copyTokenUrl(token: TokenView): void {
  if (token.url === null) return;
  void copyText(token.url);
}

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
        token.target === publishTarget.value,
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

/**
 * 台账里的客户端点一下就把人送到产物预览：那里只读，没有分段了，
 * 所以这里只要切页 + 选中客户端两件事。
 * auto 是「UA 自识别」链接，本身没有固定产物——/api/preview 只认具体客户端，
 * 点了会把 target 拨成 'auto' 然后吃 400，所以行内就不做成可点的。
 */
function previewClient(id: string): void {
  if (id === 'auto') return;
  target.value = id;
  tab.value = 'output';
}

async function generate(): Promise<void> {
  if (profileEmpty.value) return;
  // 请求在途时用户可能改下拉框：目标要在 await 前捕获，否则签发 A、预览拨到 B。
  const requested = publishTarget.value;
  const ok = await createToken(requested);
  if (!ok) return;
  // auto 是「一个链接喂所有客户端」，没有对应的固定预览目标。
  if (requested === 'auto') return;
  // 预览在另一页，这里只把目标记下来：用户点过去时看到的就该是刚签发的那个客户端。
  target.value = requested;
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
          构成改动还没保存，产物仍按已保存的构成生成
        </n-tooltip>
      </div>
      <div class="card-body">
        <div class="row" style="align-items: flex-start; gap: 24px">
          <div class="publish-picker">
            <div class="field">
              <label>签发给</label>
              <div class="row" style="margin-top: 4px">
                <n-select
                  v-model:value="publishTarget"
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
                  当前配置下该客户端已有 {{ duplicateCount }} 个生效中的地址；再签一条不会让旧地址失效，
                  确认要再生成一个？
                </n-popconfirm>
                <n-button v-else size="small" type="primary" :loading="busy > 0" :disabled="profileEmpty" @click="generate">
                  <template #icon><Plus :size="14" /></template>
                  生成地址
                </n-button>
              </div>
              <span v-if="profileEmpty" class="text-3" style="font-size: 11.5px; margin-top: 6px">
                <template v-if="sources.length === 0">
                  当前配置还没有任何订阅，签发出去的会是空配置。
                  <n-button text type="primary" size="tiny" @click="tab = 'sources'">去添加订阅</n-button>
                </template>
                <template v-else>
                  当前配置构成、规则与策略组均为空，签发出去的会是空配置。
                  <n-button text type="primary" size="tiny" @click="configSection = 'composition'; tab = 'config'">去配置构成</n-button>
                </template>
              </span>
            </div>
          </div>
        </div>

        <n-alert v-if="latestUrl" type="warning" :bordered="false" style="margin-top: 16px">
          <div class="row" style="align-items: flex-start; gap: 14px">
            <KeyRound :size="15" style="margin-top: 2px" />
            <div style="flex: 1; min-width: 0">
              <div style="font-weight: 600">{{ publishTargetName }} 订阅地址 · 刚刚签发</div>
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
      <div class="card-foot">
        <span class="text-3" style="font-size: 12px">
          签发后想确认它实际拿到什么，去「产物预览」页选同一个客户端。
        </span>
      </div>
    </section>

    <!-- 已签发排在预览之前：打开这页最常做的是「看我还签过哪些地址 / 撤销一条」，
         选客户端看产物是第二步，不该先滚过一整屏代码才能看到台账。
         撤销后这一行默认从列表消失——但记录还在，勾「含已撤销」能翻出来。 -->
    <section class="card">
      <div class="card-head">
        <h2>已签发</h2>
        <span class="count">
          {{ visibleTokens.length }}<template v-if="hiddenCount > 0">/{{ profileTokens.length }}</template>
        </span>
        <div class="spacer"></div>
        <!-- 只留一个开关：范围由侧栏那份配置决定，这里再给一个「全部配置」就是第二套导航。 -->
        <n-checkbox v-model:checked="showRevoked" size="small">含已撤销</n-checkbox>
      </div>
      <n-empty
        v-if="visibleTokens.length === 0"
        :description="hiddenRevoked > 0 ? '这份配置只有已撤销的地址' : '还没有生效中的订阅地址'"
        style="padding: 28px 0"
      >
        <template #icon><Link2 :size="28" /></template>
        <n-button v-if="hiddenRevoked > 0 && !showRevoked" size="small" @click="showRevoked = true">
          显示已撤销的 {{ hiddenRevoked }} 条
        </n-button>
        <n-button v-else size="small" type="primary" :loading="busy > 0" :disabled="profileEmpty" @click="generate">
          <template #icon><Plus :size="14" /></template>
          生成地址
        </n-button>
      </n-empty>
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th>客户端</th><th class="col-wide-only">订阅地址</th><th class="col-wide-only">创建时间</th><th style="width: 1%">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="token in visibleTokens" :key="token.id" :class="{ 'row-muted': token.revoked }">
              <td>
                <!-- auto 行不可点：它靠 UA 自识别，没有一份固定产物可以预览。 -->
                <span
                  v-if="token.target === 'auto'"
                  class="client-pill"
                  :title="'UA 自识别链接，请求方是谁就给谁对应格式的产物'"
                >
                  <ClientIcon id="auto" size="xs" />
                  <span>{{ clientNameOf(token.target) }}</span>
                </span>
                <button
                  v-else
                  class="client-pill pill-link"
                  type="button"
                  :title="`在下方预览 ${clientNameOf(token.target)} 的产物`"
                  @click="previewClient(token.target)"
                >
                  <ClientIcon :id="token.target" size="xs" />
                  <span>{{ clientNameOf(token.target) }}</span>
                </button>
                <span v-if="token.revoked" class="badge" style="margin-left: 6px">已撤销</span>
                <span v-else-if="token.id === latestTokenId" class="badge ok" style="margin-left: 6px">新签发</span>
                <span v-else-if="isDuplicate(token.target)" class="badge warn" style="margin-left: 6px">多条</span>
                <div class="addr-mobile">
                  {{ formatTime(token.createdAt) }}<template v-if="token.url !== null"> · <span class="mono">...{{ tokenTail(token.url) }}</span></template>
                </div>
              </td>
              <td class="col-wide-only">
                <span v-if="token.url !== null" class="addr-desktop mono" :title="token.url">{{ token.url }}</span>
                <n-tooltip v-else trigger="hover">
                  <template #trigger>
                    <span class="text-3" style="font-size: 11.5px; border-bottom: 1px dashed var(--border)">
                      旧记录 · 无法还原
                    </span>
                  </template>
                  这条地址是早期版本签发的，库里只留了令牌摘要，拼不回链接。点右侧「重新签发」换一条新地址。
                </n-tooltip>
              </td>
              <td class="text-3 col-wide-only" style="font-size: 12.5px; white-space: nowrap">{{ formatTime(token.createdAt) }}</td>
              <td class="actions">
                <template v-if="token.url !== null && !token.revoked">
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button aria-label="复制订阅链接" quaternary circle size="tiny" @click="copyTokenUrl(token)">
                        <template #icon><Copy :size="13" /></template>
                      </n-button>
                    </template>
                    复制订阅链接
                  </n-tooltip>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <n-button aria-label="查看订阅二维码" quaternary circle size="tiny" @click="openQr(token)">
                        <template #icon><QrCode :size="13" /></template>
                      </n-button>
                    </template>
                    查看订阅二维码
                  </n-tooltip>
                </template>
                <n-popconfirm v-if="token.url === null" @positive-click="reissueToken(token.id, token.target, token.profile)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="primary" :disabled="busy > 0">
                      <template #icon><RefreshCw :size="13" /></template>
                      重新签发
                    </n-button>
                  </template>
                  这条旧记录拼不回原链接；重新签发会生成一条新地址并撤销这条，已导入的客户端需要重新填一次。确认？
                </n-popconfirm>
                <n-popconfirm v-if="!token.revoked" @positive-click="revokeToken(token.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" :disabled="busy > 0">
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
      <div v-if="visibleTokens.length > 0" class="card-foot">
        <template v-if="duplicateTargets > 0">
          <AlertTriangle :size="14" class="text-3" />
          <span class="text-3" style="font-size: 12px">
            有 {{ duplicateTargets }} 个客户端存在多条生效地址；重新签发不会让旧地址失效，不用了就撤销。
          </span>
        </template>
        <span v-else class="text-3" style="font-size: 12px">
          填入客户端后即刻生效；撤销后立即失效，默认从列表里收起，勾「含已撤销」能翻出来。
        </span>
      </div>
    </section>

    <!-- 台账里点二维码按钮弹这一层：图大才扫得动，链接完整可读，顺手能复制。 -->
    <n-modal
      v-model:show="qrVisible"
      preset="card"
      style="width: 340px; max-width: calc(100vw - 32px)"
      :title="qrToken ? `${clientNameOf(qrToken.target)} 订阅二维码` : '订阅二维码'"
    >
      <div v-if="qrToken?.url" class="qr-panel">
        <img :src="`${qrToken.url}/qr.svg`" alt="订阅二维码" width="200" height="200" />
        <div class="mono text-3" style="font-size: 11px; word-break: break-all; text-align: center">{{ qrToken.url }}</div>
        <div class="row" style="gap: 8px">
          <n-button size="small" @click="copyText(qrToken.url)">
            <template #icon><Copy :size="13" /></template>
            复制链接
          </n-button>
          <n-button size="small" secondary tag="a" :href="`${qrToken.url}?download=1`">
            <template #icon><Download :size="13" /></template>
            导出文件
          </n-button>
        </div>
      </div>
      <p v-else class="text-3" style="font-size: 12.5px; line-height: 1.7">
        这条记录拼不回原始链接，请关闭后在台账里点「重新签发」。
      </p>
    </n-modal>
  </div>
</template>
