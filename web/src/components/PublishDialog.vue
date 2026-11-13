<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NModal, NSelect, NTag } from 'naive-ui';
import { Copy, Download, KeyRound, Plus } from 'lucide-vue-next';
import { renderTargetLabel, targetSelectOptions } from '../client-select';
import {
  activeProfileName,
  busy,
  clientNameOf,
  copyText,
  createToken,
  groups,
  profileDirty,
  profileEntries,
  rules,
  state,
  tab,
  target,
} from '../workspace';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();

const showModel = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
});

/** 默认就按顶栏当前选中的客户端签发，少一次选择。 */
const pick = ref(target.value);
/** 明文地址只在本次生成后保留在内存里，关掉弹窗即丢弃。 */
const issued = ref<{ target: string; url: string } | null>(null);

/** 与发布页同一口径：三样都空时产物必然是空的，后端也会以 409 拒绝。 */
const empty = computed(
  () => profileEntries.value.length === 0 && rules.value.length === 0 && groups.value.length === 0,
);

const existing = computed(
  () =>
    (state.value?.tokens ?? []).filter(
      (item) => !item.revoked && item.profile === activeProfileName.value && item.target === pick.value,
    ).length,
);

watch(
  () => props.show,
  (open) => {
    if (!open) {
      issued.value = null;
      return;
    }
    pick.value = target.value;
  },
);

async function publish(): Promise<void> {
  if (empty.value) return;
  const url = await createToken(pick.value);
  if (url === null) return;
  issued.value = { target: pick.value, url };
}

function goTo(next: 'publish' | 'sources'): void {
  tab.value = next;
  showModel.value = false;
}
</script>

<template>
  <n-modal
    v-model:show="showModel"
    preset="card"
    title="发布订阅地址"
    class="pub-modal"
    style="width: 480px; max-width: calc(100vw - 32px)"
  >
    <div class="pub-body">
      <div class="row pub-who">
        <span class="text-3">当前 Profile</span>
        <n-tag size="small" :bordered="false" class="mono">{{ activeProfileName }}</n-tag>
        <n-tag v-if="profileDirty" size="small" type="warning" :bordered="false">构成未保存</n-tag>
      </div>

      <div class="field">
        <label>签发给</label>
        <div class="pub-pick">
          <n-select
            v-model:value="pick"
            :options="targetSelectOptions"
            :render-label="renderTargetLabel"
            size="small"
          />
          <n-button size="small" type="primary" :loading="busy > 0" :disabled="empty" @click="publish">
            <template #icon><Plus :size="14" /></template>
            生成地址
          </n-button>
        </div>
        <span class="text-3" style="font-size: 11.5px">
          地址里的令牌只显示这一次，复制后直接填进客户端。
        </span>
      </div>

      <n-alert v-if="empty" type="warning" :bordered="false">
        当前 Profile 还没有任何来源，签发出去的会是空配置。
        <n-button text type="primary" size="tiny" @click="goTo('sources')">去添加来源</n-button>
      </n-alert>

      <div v-if="issued" class="pub-issued">
        <div class="pub-issued-main">
          <div class="row tight">
            <KeyRound :size="14" class="text-3" />
            <strong>{{ clientNameOf(issued.target) }} 订阅地址</strong>
          </div>
          <div class="pub-url mono">{{ issued.url }}</div>
          <div class="row">
            <n-button size="tiny" @click="copyText(issued.url)">
              <template #icon><Copy :size="13" /></template>
              复制
            </n-button>
            <n-button size="tiny" secondary tag="a" :href="`${issued.url}?download=1`">
              <template #icon><Download :size="13" /></template>
              导出文件
            </n-button>
            <n-button size="tiny" text tag="a" :href="issued.url" target="_blank" rel="noopener noreferrer">
              打开产物
            </n-button>
          </div>
        </div>
        <figure v-if="issued.target !== 'auto'" class="pub-qr">
          <img :src="`${issued.url}/qr.svg`" alt="订阅二维码" width="96" height="96" />
          <figcaption class="text-3">手机扫码导入</figcaption>
        </figure>
      </div>

      <p v-else-if="existing > 0" class="pub-note text-3">
        该客户端在当前 Profile 下已有 {{ existing }} 条生效地址；再生成不会让旧地址失效，不用了要去撤销。
      </p>
    </div>

    <template #footer>
      <div class="row pub-foot">
        <n-button text type="primary" size="small" @click="goTo('publish')">打开发布页管理全部地址</n-button>
        <div class="spacer"></div>
        <n-button size="small" @click="showModel = false">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>
