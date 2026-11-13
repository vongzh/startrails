<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  dateZhCN,
  darkTheme,
  zhCN,
} from 'naive-ui';
import type { GlobalThemeOverrides } from 'naive-ui';
import Shell from './Shell.vue';
import { applyTheme, palette, theme } from './workspace';

watchEffect(() => applyTheme());

/**
 * 组件库跟着设计令牌走，而不是各写一份十六进制：
 * 换配色只改 style.css 的 data-palette 块，这里读计算后的变量。
 */
const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
};

const themeOverrides = computed<GlobalThemeOverrides>(() => {
  // 显式依赖：配色或明暗一变就重算，读取的是 applyTheme 之后的新变量。
  const dark = theme.value === 'dark';
  void palette.value;

  const accent = cssVar('--accent', '#5a5ad2');
  const accentHover = cssVar('--accent-hover', accent);
  const accentOn = cssVar('--accent-on', dark ? '#101014' : '#ffffff');
  const ring = cssVar('--accent-ring', 'rgba(90,90,210,.24)');
  const surface = cssVar('--surface', dark ? '#121418' : '#ffffff');
  const surface2 = cssVar('--surface-2', surface);
  const surface3 = cssVar('--surface-3', dark ? '#1e222a' : '#f1f2f4');
  const text = cssVar('--text', dark ? '#ebecef' : '#141519');
  const text2 = cssVar('--text-2', dark ? '#a1a5af' : '#565a63');
  const text3 = cssVar('--text-3', dark ? '#7e828c' : '#75787f');
  const divider = cssVar('--divider', dark ? '#1d2026' : '#eff0f3');
  const borderStrong = cssVar('--border-strong', dark ? '#32363f' : '#d7d8df');

  return {
    common: {
      primaryColor: accent,
      primaryColorHover: accentHover,
      primaryColorPressed: accentHover,
      primaryColorSuppl: accentHover,
      textColorPrimary: accentOn,
      textColorHoverPrimary: accentOn,
      textColorPressedPrimary: accentOn,
      textColorFocusPrimary: accentOn,
      infoColor: accent,
      successColor: cssVar('--ok', dark ? '#3fbe8c' : '#11805c'),
      warningColor: cssVar('--warn', dark ? '#dfa13c' : '#a2650a'),
      errorColor: cssVar('--danger', dark ? '#ef736b' : '#bf3a31'),
      borderRadius: '9px',
      borderRadiusSmall: '7px',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontFamilyMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '13px',
      fontSizeSmall: '12px',
      fontWeightStrong: '620',
      textColorBase: text,
      textColor1: text,
      textColor2: text2,
      textColor3: text3,
      textColorDisabled: dark ? '#4b5158' : '#b8bec8',
      dividerColor: divider,
      borderColor: borderStrong,
      hoverColor: surface3,
      bodyColor: cssVar('--bg', dark ? '#08090b' : '#f5f5f7'),
      cardColor: surface,
      modalColor: surface,
      popoverColor: surface,
      tableColor: surface,
      tableHeaderColor: surface,
      tagColor: surface3,
      invertedColor: text,
      popoverColorModal: surface,
      boxShadow1: dark ? '0 1px 2px rgba(0,0,0,.5)' : '0 1px 2px rgba(20,21,25,.04)',
      boxShadow2: dark ? '0 16px 48px -16px rgba(0,0,0,.8)' : '0 16px 48px -24px rgba(20,21,25,.24)',
    },
    Button: { fontWeight: '540', paddingSmall: '0 10px', heightSmall: '28px', borderRadiusSmall: '7px' },
    Input: {
      color: surface,
      colorFocus: surface,
      border: `1px solid ${borderStrong}`,
      borderHover: `1px solid ${accent}`,
      borderFocus: `1px solid ${accent}`,
      boxShadowFocus: `0 0 0 3px ${ring}`,
      heightSmall: '28px',
    },
    Select: { peers: { InternalSelection: { heightSmall: '28px' } } },
    Tag: { borderRadius: '5px', heightSmall: '19px', fontSizeSmall: '11px' },
    Switch: { railHeightSmall: '18px', railWidthSmall: '32px' },
    Message: { borderRadius: '9px' },
    Drawer: { color: surface },
    Empty: { iconColor: dark ? '#3a3f48' : '#dfe3e9', iconSizeSmall: '28px' },
    Tabs: { tabFontWeightActive: '600' },
  };
});
</script>

<template>
  <n-config-provider
    :theme="theme === 'dark' ? darkTheme : null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider :max="3" placement="bottom-right">
      <n-dialog-provider>
        <Shell />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
