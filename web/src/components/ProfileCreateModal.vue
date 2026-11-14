<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput, NModal } from 'naive-ui';
import { busy, createProfile } from '../workspace';

/**
 * 新建配置的弹窗。原先长在顶栏切换器里，而「新建配置」这个动作和「切换配置」并不是一回事：
 * 现在它跟着配置页页头走，顶栏下拉只负责切换。
 */
const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const name = ref('');

async function submit(): Promise<void> {
  const value = name.value.trim();
  if (value.length === 0) return;
  const ok = await createProfile(value);
  if (ok) {
    name.value = '';
    emit('update:show', false);
  }
}

function close(): void {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    title="新建配置"
    style="width: 380px; max-width: calc(100vw - 32px)"
    @update:show="emit('update:show', $event)"
  >
    <div class="field">
      <label>名称</label>
      <n-input
        v-model:value="name"
        size="small"
        placeholder="例如 work"
        @keyup.enter="submit"
      />
      <span class="text-3" style="font-size: 11.5px">
        配置之间互不影响：各自有独立的构成、节点取舍、规则、DNS 与订阅地址。
      </span>
    </div>
    <template #footer>
      <div class="row end" style="width: 100%">
        <n-button size="small" quaternary @click="close">取消</n-button>
        <n-button size="small" type="primary" :loading="busy > 0" @click="submit">创建</n-button>
      </div>
    </template>
  </n-modal>
</template>
