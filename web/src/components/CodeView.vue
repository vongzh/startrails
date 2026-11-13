<script setup lang="ts">
import { computed } from 'vue';
import { highlight } from '../code-highlight';

const props = withDefaults(
  defineProps<{
    content: string;
    dialect: string;
    wrap?: boolean;
  }>(),
  { wrap: false },
);

const rendered = computed(() => highlight(props.content, props.dialect));
</script>

<template>
  <div class="code-view" :class="{ wrap: props.wrap }" role="region" aria-label="产物预览">
    <div v-if="rendered.lines === 0" class="cv-empty">（无内容）</div>
    <div v-else v-html="rendered.html"></div>
  </div>
</template>
