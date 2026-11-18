<script setup lang="ts">
import { computed, watch } from 'vue';
import { highlight } from '../code-highlight';

const props = withDefaults(
  defineProps<{
    content: string;
    dialect: string;
    wrap?: boolean;
    filter?: string;
  }>(),
  { wrap: false, filter: '' },
);

const emit = defineEmits<{ matchCount: [count: number] }>();

const rendered = computed(() => highlight(props.content, props.dialect, props.filter));
watch(
  () => rendered.value.matches,
  (count) => emit('matchCount', count),
  { immediate: true },
);
</script>

<template>
  <div class="code-view" :class="{ wrap: props.wrap }" role="region" aria-label="产物预览">
    <div v-if="rendered.lines === 0" class="cv-empty">（无内容）</div>
    <div v-else-if="rendered.matches === 0" class="cv-empty">（没有匹配「{{ props.filter.trim() }}」的行）</div>
    <div v-else v-html="rendered.html"></div>
  </div>
</template>
