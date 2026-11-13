<script setup lang="ts">
import { computed } from 'vue';
import { clientMarkOf } from '../client-icons';

/**
 * 客户端徽标。纯装饰：始终与文字标签同时出现，因此 aria-hidden。
 * 颜色来自全局 --mark-* 令牌（style.css），明暗主题自动适配；
 * tone-* 类也定义在全局，分组标题的色点可以复用同一套色。
 */
const props = withDefaults(
  defineProps<{
    id: string;
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** 表格内联用：只留图形，不画底色与边框。 */
    bare?: boolean;
  }>(),
  { size: 'sm', bare: false },
);

const SIZES = { xs: 16, sm: 20, md: 26, lg: 32 } as const;
const mark = computed(() => clientMarkOf(props.id));
const px = computed(() => SIZES[props.size]);
</script>

<template>
  <span
    class="client-icon"
    :class="[`tone-${mark.tone}`, { bare }]"
    :style="{ width: `${px}px`, height: `${px}px` }"
    :title="mark.label"
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path :d="mark.glyph" />
    </svg>
  </span>
</template>

<style scoped>
.client-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 6px;
  color: var(--mark);
  background: color-mix(in srgb, var(--mark) 13%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--mark) 20%, transparent);
  transition: transform 0.18s ease, background 0.18s ease;
}
.client-icon svg { display: block; width: 74%; height: 74%; }
.client-icon.bare { background: transparent; border-color: transparent; }
</style>
