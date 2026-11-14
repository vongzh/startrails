<script setup lang="ts">
import { Info } from 'lucide-vue-next';
import PreviewPane from '../components/PreviewPane.vue';

/**
 * 这一页只回答一个问题：客户端实际会拉到什么。
 *
 * 它不提供任何编辑入口——节点取舍、规则、DNS 与 TUN 都在「配置」页。
 * 把「改」和「看」放在同一页，用户很容易在核对产物时顺手改掉某样东西，
 * 然后再也说不清「刚才看到的那一版到底是什么」。
 */
</script>

<template>
  <div class="page output-page">
    <div class="scope-note">
      <Info :size="13" />
      只读：这就是客户端最终拿到的字节；配置一改，它的 ETag 就变，客户端命中缓存时不会再下载。
    </div>
    <PreviewPane />
  </div>
</template>
