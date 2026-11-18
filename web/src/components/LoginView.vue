<script setup lang="ts">
/**
 * 登录 / 接入页。
 *
 * 与控制台内页的分工：内页按「偏密度、零装饰」排数据，这一屏是全站唯一没有
 * 数据密度要求的地方，因此只保留品牌图纸与凭据输入，不堆说明文字。
 *
 * 所有颜色取自 style.css 的设计令牌，5 套配色 × 明暗自动生效。
 */
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NTooltip } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import { AlertCircle, ArrowRight, KeyRound, Moon, Sun } from 'lucide-vue-next';
import BrandMark from './BrandMark.vue';
import { UI_CORE_VERSION } from '../version';
import {
  connect,
  connecting,
  initialize,
  loginError,
  secretRequired,
  setupChecking,
  setupRequired,
  theme,
  toggleTheme,
} from '../workspace';

const tokenDraft = ref('');
const secretDraft = ref('');
const tokenInput = ref<InputInst | null>(null);
const secretInput = ref<InputInst | null>(null);
const isSetup = computed(() => setupRequired.value || secretRequired.value);
const lede = computed(() => {
  if (setupRequired.value && secretRequired.value) {
    return '此实例尚未初始化：设置管理令牌与数据加密密钥后即可使用。';
  }
  if (setupRequired.value) return '此实例尚未设置管理令牌，请先完成初始化。';
  if (secretRequired.value) {
    return '此实例尚未设置数据加密密钥；请输入管理令牌并为已有数据设置密钥。';
  }
  return '此实例受管理令牌保护。';
});

async function submitLogin(): Promise<void> {
  if (setupChecking.value) return;
  const value = tokenDraft.value.trim();
  const secret = secretDraft.value.trim();
  if (setupRequired.value && value.length === 0) {
    loginError.value = '请设置管理令牌';
    tokenInput.value?.focus();
    return;
  }
  if (setupRequired.value && value.length < 8) {
    loginError.value = '管理令牌至少 8 位';
    tokenInput.value?.focus();
    return;
  }
  if (!setupRequired.value && secretRequired.value && value.length === 0) {
    loginError.value = '请输入管理令牌';
    tokenInput.value?.focus();
    return;
  }
  if (secretRequired.value && secret.length < 16) {
    loginError.value = '加密密钥至少 16 位';
    secretInput.value?.focus();
    return;
  }
  if (isSetup.value) await initialize(value, secret);
  else await connect(value);
}

onMounted(() => tokenInput.value?.focus());
</script>

<template>
  <div class="login-wrap">
    <!-- 左：品牌与图纸。颜色只来自边框/强调两级令牌。 -->
    <section class="login-visual" aria-label="星迹 产品概览">
      <header class="lv-head">
        <!-- 品牌锁版与控制台侧栏同构：英文主标 + 次级中文名，避免首屏与控制台叫法不一。 -->
        <div class="lv-brand">
          <BrandMark :size="26" />
          <span class="lv-wordmark">Startrails<span class="lv-cn">星迹</span></span>
        </div>
        <span class="lv-edition">自托管</span>
      </header>

      <!-- 窄屏专用：把桌面图纸收成一条轨道印记，品牌仍在，但不与表单争高度 -->
      <div class="lv-chart-sm" aria-hidden="true">
        <svg viewBox="0 0 320 72" preserveAspectRatio="xMidYMid meet">
          <g transform="translate(160 36) rotate(-16)">
            <ellipse class="sm-ring" cx="0" cy="0" rx="152" ry="30" stroke-dasharray="540 220" />
            <ellipse class="sm-ring hero" cx="0" cy="0" rx="98" ry="19" stroke-dasharray="330 130" />
          </g>
          <circle class="sm-node" cx="262" cy="19" r="2.4" />
          <path class="sm-cross" d="M262 12V26 M255 19H269" />
        </svg>
      </div>

      <div class="lv-chart">
        <svg class="orbit-chart" viewBox="0 0 560 460" role="img" aria-label="星迹示意图：订阅汇聚为一条稳定轨道，再扇出到多个客户端">
          <!-- 技术图纸底纹：正交网格 + 基准轴，只用 1px 边框色 -->
          <g class="chart-grid">
            <path d="M60 30V430 M160 30V430 M260 30V430 M360 30V430 M460 30V430" />
            <path d="M30 70H530 M30 150H530 M30 230H530 M30 310H530 M30 390H530" />
          </g>
          <path class="chart-axis" d="M0 230H560" />

          <!-- 背景图纸：四层统一 -24° 倾斜的同心轨道，是「源汇聚成稳定轨道」的示意插画。
               它是装饰、跟随 --accent；品牌标记走自己的品牌色（--logo-*），不吃强调色，两套语言不混用。
               外层用中性描边，只有主轨迹与关键节点用强调色。 -->
          <g class="orbit-layer orbit-a">
            <g transform="rotate(-24 280 230)">
              <ellipse class="orbit-ring outer" cx="280" cy="230" rx="236" ry="146" stroke-dasharray="760 160" />
              <circle class="orbit-node ghost" cx="58" cy="180" r="4.5" />
            </g>
          </g>
          <g class="orbit-layer orbit-b">
            <g transform="rotate(-24 280 230)">
              <ellipse class="orbit-ring" cx="280" cy="230" rx="182" ry="112" stroke-dasharray="300 62 240 180" />
              <circle class="orbit-node ghost" cx="385" cy="138" r="4" />
            </g>
          </g>
          <g class="orbit-layer orbit-c">
            <g transform="rotate(-24 280 230)">
              <ellipse class="orbit-ring" cx="280" cy="230" rx="128" ry="79" stroke-dasharray="420 130" />
              <circle class="orbit-node solid" cx="160" cy="257" r="5" />
            </g>
          </g>
          <g class="orbit-layer orbit-d">
            <g transform="rotate(-24 280 230)">
              <ellipse class="orbit-ring hero" cx="280" cy="230" rx="78" ry="48" stroke-dasharray="270 90" />
              <circle class="orbit-node solid" cx="344" cy="258" r="5.5" />
            </g>
          </g>

          <!-- 主星：四芒 + 光晕，落在最内圈，是整张图唯一的实心强调点 -->
          <g class="chart-star" transform="translate(344 258)">
            <circle class="star-halo" r="17" />
            <circle class="star-halo inner" r="10" />
            <path class="star-cross" d="M0 -13V13 M-13 0H13" stroke-linecap="round" />
            <circle class="star-core" r="4.2" />
          </g>

          <!-- 引出标注：只标两端事实，不写成营销词 -->
          <path class="chart-leader" d="M385 138H452" />
          <text class="chart-label" x="458" y="134">IR</text>
          <text class="chart-label sub" x="458" y="148">归一化</text>
          <path class="chart-leader" d="M160 257H96" />
          <text class="chart-label" x="90" y="253" text-anchor="end">订阅</text>
          <text class="chart-label sub" x="90" y="267" text-anchor="end">接入</text>

          <!-- 角标刻度 -->
          <text class="chart-tick" x="30" y="22">00</text>
          <text class="chart-tick" x="530" y="22" text-anchor="end">19 / 目标端</text>
          <text class="chart-tick" x="30" y="448">单实例</text>
          <text class="chart-tick" x="530" y="448" text-anchor="end">v{{ UI_CORE_VERSION }}</text>
        </svg>
      </div>
    </section>

    <!-- 右：接入表单。只保留凭据输入，不堆说明文字。 -->
    <section class="login-panel" aria-label="连接管理面">
      <div class="lp-tools">
        <n-tooltip trigger="hover">
          <template #trigger>
            <button class="lp-theme" type="button" :aria-label="theme === 'dark' ? '切换亮色' : '切换暗色'" @click="toggleTheme">
              <Sun v-if="theme === 'dark'" :size="16" :stroke-width="1.8" />
              <Moon v-else :size="16" :stroke-width="1.8" />
            </button>
          </template>
          {{ theme === 'dark' ? '切换亮色' : '切换暗色' }}
        </n-tooltip>
      </div>

      <div class="lp-inner">
        <div class="lp-eyebrow"><span class="lp-eyebrow-line"></span>接入 / 管理面</div>
        <h1>{{ isSetup ? '初始化管理面' : '连接到控制台' }}</h1>
        <p class="lp-lede">{{ lede }}</p>

        <form class="lp-form" novalidate @submit.prevent="submitLogin">
          <div class="lp-field-head">
            <label for="admin-token">{{ setupRequired ? '设置管理令牌' : '管理令牌' }}</label>
          </div>
          <n-input
            ref="tokenInput"
            v-model:value="tokenDraft"
            class="lp-input mono"
            type="password"
            show-password-on="click"
            :placeholder="setupRequired ? '输入要设置的令牌（至少 8 位）' : '粘贴令牌'"
            size="large"
            :input-props="{ id: 'admin-token', autocomplete: 'off', spellcheck: false, 'aria-label': '管理令牌' }"
          >
            <template #prefix><KeyRound :size="15" :stroke-width="1.8" /></template>
          </n-input>

          <template v-if="secretRequired">
            <div class="lp-field-head">
              <label for="encryption-secret">数据加密密钥</label>
            </div>
            <n-input
              ref="secretInput"
              v-model:value="secretDraft"
              class="lp-input mono"
              type="password"
              show-password-on="click"
              placeholder="至少 16 位；丢失后旧数据无法解密"
              size="large"
              :input-props="{ id: 'encryption-secret', autocomplete: 'off', spellcheck: false, 'aria-label': '数据加密密钥' }"
            >
              <template #prefix><KeyRound :size="15" :stroke-width="1.8" /></template>
            </n-input>
          </template>

          <!-- 错误区常驻占位，出现时不顶动下方内容 -->
          <div class="lp-error-slot" role="alert" aria-live="assertive">
            <div v-if="loginError" class="lp-error">
              <AlertCircle :size="14" :stroke-width="2" />
              <span>{{ loginError }}</span>
            </div>
          </div>

          <n-button
            class="lp-submit"
            attr-type="submit"
            type="primary"
            size="large"
            block
            :loading="connecting || setupChecking"
            :disabled="connecting || setupChecking"
          >
            {{ isSetup ? '设置并进入' : '进入控制台' }}
            <ArrowRight :size="16" :stroke-width="2" />
          </n-button>
        </form>
      </div>

      <div class="lp-legal">
        <span class="brand-name">Startrails</span>
        <span>© 2026</span>
        <a href="https://github.com/vongzh" target="_blank" rel="noopener noreferrer">vongzh</a>
      </div>
    </section>
  </div>
</template>
