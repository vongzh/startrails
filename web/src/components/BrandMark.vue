<script setup lang="ts">
/**
 * 星迹品牌标记：原创 SVG 线稿，无底色。
 *
 * 构成：一颗实心星体 + 绕它的扁星环（环的后半被星体遮住）+ 停在环端的四芒星。
 * - 不是「一个空圆圈」：环里有星体作主体，环被压扁到 ry=5.8 并让星体盖住中段，
 *   只留左右两段弧，这样读出来是星环而不是抽象几何圆。
 * - 也不是向外喷射的扇出：整体是静止、闭合、有向心力的形，不带动势。
 * - 四芒星保留原来那颗，落在环的右上端；内凹四角在 22px 下仍是星形，
 *   不会糊成「十字 + 圆点」的加号。
 * - 用 --brand 而不是 --accent：品牌色是身份，不随设置里 5 套强调色漂移；
 *   --brand 只在 :root 与 [data-theme=dark] 定义，各 palette 块刻意不重写。
 * - logo.svg 是完整横版；favicon.svg 是 16px 同源简化版。改骨架时三处一起核。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 24 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <!-- 星环：扁的斜置轨道，中段会被星体盖住 -->
    <ellipse
      cx="22" cy="26" rx="13.4" ry="5.8"
      transform="rotate(-28 22 26)"
      stroke="var(--brand)" stroke-width="2.2"
      opacity="0.9"
    />

    <!-- 星体：实心，盖住环的中段，只留左右两段弧 -->
    <circle cx="22" cy="26" r="7.2" fill="var(--brand)"/>

    <!-- 四芒星：停在星环的右上端 -->
    <path
      d="M33.6 8.5c0.77 3.66 2.24 5.13 5.9 5.9-3.66 0.77-5.13 2.24-5.9 5.9-0.77-3.66-2.24-5.13-5.9-5.9 3.66-0.77 5.13-2.24 5.9-5.9Z"
      fill="var(--brand)"
    />
  </svg>
</template>
