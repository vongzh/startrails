<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAutoComplete, NButton, NInput, NInputNumber, NSelect, NSwitch, NTag } from 'naive-ui';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Trash2 } from 'lucide-vue-next';
import {
  addGroupMember,
  annotationMap,
  baseGroups,
  groupMode,
  groups,
  moveGroup,
  moveGroupMember,
  nodes,
  patchGroup,
  removeGroup,
  removeGroupMember,
} from '../workspace';
import type { GroupDraft, GroupMemberDraft } from '../workspace';

const props = defineProps<{
  group: GroupDraft;
  index: number;
  total: number;
}>();

const pending = ref<{ kind: GroupMemberDraft['kind']; value: string }>({ kind: 'ref', value: '' });

const strategyOptions = [
  { label: 'select 手选', value: 'select' },
  { label: 'url-test 测速', value: 'url-test' },
  { label: 'fallback 故障转移', value: 'fallback' },
];
const memberKinds = [
  { label: '引用', value: 'ref' },
  { label: '匹配', value: 'match' },
  { label: '地区', value: 'region' },
  { label: '其余', value: 'rest' },
];
const regionOptions = [
  { label: '香港 HK', value: 'HK' },
  { label: '台湾 TW', value: 'TW' },
  { label: '日本 JP', value: 'JP' },
  { label: '新加坡 SG', value: 'SG' },
  { label: '美国 US', value: 'US' },
  { label: '英国 UK', value: 'UK' },
  { label: '德国 DE', value: 'DE' },
  { label: '韩国 KR', value: 'KR' },
];

const refOptions = computed(() => {
  if (pending.value.kind !== 'ref') return [];
  const existing = new Set(
    props.group.members.filter((item) => item.kind === 'ref').map((item) => item.value),
  );
  const candidates = new Set<string>(['DIRECT', 'REJECT']);
  for (const g of groups.value) {
    if (g.name !== props.group.name) candidates.add(g.name);
  }
  if (groupMode.value !== 'replace') {
    for (const g of baseGroups.value) {
      if (g.name !== props.group.name) candidates.add(g.name);
    }
  }
  for (const node of nodes.value) {
    const ann = annotationMap.value.get(node.nodeKey);
    if (ann?.excluded === true) continue;
    const label = ann?.alias ?? node.name;
    if (label !== '') candidates.add(label);
  }
  const query = pending.value.value.trim().toLowerCase();
  return [...candidates]
    .filter((name) => !existing.has(name) && (query === '' || name.toLowerCase().includes(query)))
    .slice(0, 40)
    .map((name) => ({ label: name, value: name }));
});

function memberKey(member: GroupMemberDraft): string {
  return `${member.kind}:${member.value}`;
}

function memberLabel(member: GroupMemberDraft): string {
  if (member.kind === 'match') return `匹配 ${member.value}`;
  if (member.kind === 'region') return `地区 ${member.value}`;
  if (member.kind === 'rest') return '其余节点';
  return member.value;
}

function setDraft(patch: Partial<{ kind: GroupMemberDraft['kind']; value: string }>): void {
  pending.value = { ...pending.value, ...patch };
}

function setStrategy(strategy: 'select' | 'url-test' | 'fallback'): void {
  if (strategy === 'select') {
    patchGroup(props.group.name, { strategy });
    return;
  }
  patchGroup(props.group.name, {
    strategy,
    ...(props.group.testUrl.trim() === '' ? { testUrl: 'https://www.gstatic.com/generate_204' } : {}),
    ...(props.group.interval === null ? { interval: 300 } : {}),
    ...(strategy === 'url-test' && props.group.tolerance === null ? { tolerance: 50 } : {}),
  });
}

function addMember(): void {
  addGroupMember(props.group, pending.value);
  pending.value = { ...pending.value, value: '' };
}

function selectRefMember(value: string | number): void {
  const text = String(value).trim();
  if (text !== '') addGroupMember(props.group, { kind: 'ref', value: text });
  pending.value = { ...pending.value, value: '' };
}
</script>

<template>
  <div class="stack" style="gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--border)">
    <div class="row group-head">
      <span class="strong" style="font-size: 13px">{{ group.name }}</span>
      <n-select
        :value="group.strategy"
        :options="strategyOptions"
        size="tiny"
        style="width: 146px"
        @update:value="setStrategy"
      />
      <n-tag size="small" :bordered="false">{{ group.members.length }} 成员</n-tag>
      <div class="spacer"></div>
      <label class="row" style="gap: 4px; font-size: 12px">
        <n-switch :value="group.hidden" size="small" @update:value="(value) => patchGroup(group.name, { hidden: value })" />
        隐藏
      </label>
      <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveGroup(index, -1)">
        <template #icon><ArrowUp :size="13" /></template>
      </n-button>
      <n-button aria-label="下移" quaternary circle size="tiny" :disabled="index === total - 1" @click="moveGroup(index, 1)">
        <template #icon><ArrowDown :size="13" /></template>
      </n-button>
      <n-button aria-label="删除策略组" quaternary circle size="tiny" type="error" @click="removeGroup(group.name)">
        <template #icon><Trash2 :size="13" /></template>
      </n-button>
    </div>
    <div v-if="group.strategy !== 'select'" class="stack" style="gap: 4px">
      <div class="row">
        <n-input
          :value="group.testUrl"
          size="tiny"
          placeholder="测速地址 https://www.gstatic.com/generate_204"
          class="grow"
          style="min-width: 180px"
          @update:value="(value: string) => patchGroup(group.name, { testUrl: value })"
        />
        <n-input-number
          :value="group.interval"
          size="tiny"
          :min="1"
          placeholder="间隔秒"
          style="width: 106px"
          @update:value="(value) => patchGroup(group.name, { interval: value })"
        />
        <n-input-number
          v-if="group.strategy === 'url-test'"
          :value="group.tolerance"
          size="tiny"
          :min="0"
          placeholder="容差"
          style="width: 88px"
          @update:value="(value) => patchGroup(group.name, { tolerance: value })"
        />
        <label class="row" style="gap: 4px; font-size: 12px">
          <n-switch :value="group.lazy" size="small" @update:value="(value) => patchGroup(group.name, { lazy: value })" />
          懒测速
        </label>
      </div>
      <p v-if="group.testUrl.trim() === ''" class="hint-line" style="color: var(--warn)">
        测速组需要填写测速地址；留空在 Clash / mihomo 中会退回手选
      </p>
    </div>
    <div class="tag-input">
      <n-tag
        v-for="(member, memberIndex) in group.members"
        :key="memberKey(member)"
        size="small"
        closable
        :bordered="false"
        @close="removeGroupMember(group, member)"
      >
        <span class="member-chip">
          <span>{{ memberLabel(member) }}</span>
          <span v-if="group.members.length > 1" class="member-arrows">
            <button
              type="button"
              class="tag-step"
              aria-label="前移成员"
              :disabled="memberIndex === 0"
              @click.stop="moveGroupMember(group, memberIndex, -1)"
            >
              <ChevronLeft :size="11" />
            </button>
            <button
              type="button"
              class="tag-step"
              aria-label="后移成员"
              :disabled="memberIndex === group.members.length - 1"
              @click.stop="moveGroupMember(group, memberIndex, 1)"
            >
              <ChevronRight :size="11" />
            </button>
          </span>
        </span>
      </n-tag>
      <div class="member-adder-row">
        <n-select
          :value="pending.kind"
          :options="memberKinds"
          size="small"
          style="width: 84px"
          @update:value="(value: GroupMemberDraft['kind']) => setDraft({ kind: value, value: '' })"
        />
        <n-select
          v-if="pending.kind === 'region'"
          :value="pending.value || null"
          :options="regionOptions"
          size="small"
          placeholder="地区"
          style="width: 120px"
          @update:value="(value: string) => setDraft({ value })"
        />
        <n-input
          v-else-if="pending.kind === 'match'"
          :value="pending.value"
          size="small"
          placeholder="/USA|美国/i"
          style="flex: 1; min-width: 110px; max-width: 210px"
          @update:value="(value: string) => setDraft({ value })"
          @keyup.enter="addMember"
        />
        <n-auto-complete
          v-else-if="pending.kind === 'ref'"
          :value="pending.value"
          :options="refOptions"
          :get-show="() => true"
          clear-after-select
          size="small"
          placeholder="节点名、组名或 DIRECT"
          style="flex: 1; min-width: 110px; max-width: 220px"
          @update:value="(value: string) => setDraft({ value })"
          @select="selectRefMember"
          @keyup.enter="addMember"
        />
        <n-button
          size="small"
          :disabled="
            pending.kind === 'rest'
              ? group.members.some((item) => item.kind === 'rest')
              : pending.value.trim() === ''
          "
          @click="addMember"
        >
          添加
        </n-button>
      </div>
    </div>
    <p v-if="group.members.length === 0" class="hint-line" style="color: var(--warn)">
      策略组至少需要 1 个成员，空组会在生成时跳过或导致客户端报错
    </p>
  </div>
</template>

<style scoped>
.hint-line {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.member-adder-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  max-width: 100%;
}
.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.member-arrows {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}
.tag-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  width: 15px;
  height: 15px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.tag-step:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-3);
}
.tag-step:disabled {
  opacity: 0.28;
  cursor: default;
}
</style>
