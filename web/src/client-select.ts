import { computed, h } from 'vue';
import type { VNodeChild } from 'vue';
import type { SelectOption } from 'naive-ui';
import ClientIcon from './components/ClientIcon.vue';
import { targetGroups } from './workspace';

/**
 * 签发给谁是最容易选错、代价又最高的一步：下拉选项也带上应用图标。
 * 发布页与顶栏的快速发布共用这一份，避免两处选项漂移。
 */
export const targetSelectOptions = computed<SelectOption[]>(() => [
  {
    type: 'group' as const,
    label: '通用',
    key: 'auto',
    children: [{ label: '自动识别客户端（按 UA）', value: 'auto' }],
  },
  ...targetGroups.value.map((group) => ({
    type: 'group' as const,
    label: group.label,
    key: group.dialect,
    children: group.items.map((item) => ({
      label: item.nodesOnly ? `${item.name}（仅节点）` : item.name,
      value: item.id,
    })),
  })),
]);

export function renderTargetLabel(option: SelectOption): VNodeChild {
  const { type, label, value } = option as { type?: string; label?: string; value?: string };
  if (type === 'group' || typeof value !== 'string') return label ?? '';
  return h('span', { class: 'select-target' }, [
    h(ClientIcon, { id: value, size: 'xs' as const }),
    h('span', null, label ?? value),
  ]);
}
