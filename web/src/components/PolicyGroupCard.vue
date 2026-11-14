<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput, NInputNumber, NSelect, NSwitch, NTag } from 'naive-ui';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-vue-next';
import { addGroupMember, moveGroup, patchGroup, removeGroup, removeGroupMember } from '../workspace';
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

function addMember(): void {
  addGroupMember(props.group, pending.value);
  pending.value = { ...pending.value, value: '' };
}
</script>

<template>
  <div class="stack" style="gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--border)">
    <div class="row">
      <span class="strong" style="font-size: 13px">{{ group.name }}</span>
      <n-select
        :value="group.strategy"
        :options="strategyOptions"
        size="tiny"
        style="width: 150px"
        @update:value="(value) => patchGroup(group.name, { strategy: value })"
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
    <div v-if="group.strategy !== 'select'" class="row">
      <n-input
        :value="group.testUrl"
        size="tiny"
        placeholder="测速地址 https://www.gstatic.com/generate_204"
        class="grow"
        @update:value="(value) => patchGroup(group.name, { testUrl: value })"
      />
      <n-input-number
        :value="group.interval"
        size="tiny"
        :min="1"
        placeholder="间隔秒"
        style="width: 110px"
        @update:value="(value) => patchGroup(group.name, { interval: value })"
      />
      <n-input-number
        v-if="group.strategy === 'url-test'"
        :value="group.tolerance"
        size="tiny"
        :min="0"
        placeholder="容差"
        style="width: 90px"
        @update:value="(value) => patchGroup(group.name, { tolerance: value })"
      />
      <label class="row" style="gap: 4px; font-size: 12px">
        <n-switch :value="group.lazy" size="small" @update:value="(value) => patchGroup(group.name, { lazy: value })" />
        懒测速
      </label>
    </div>
    <div class="tag-input">
      <n-tag
        v-for="member in group.members"
        :key="memberKey(member)"
        size="small"
        closable
        :bordered="false"
        @close="removeGroupMember(group, member)"
      >
        {{ memberLabel(member) }}
      </n-tag>
      <n-select
        :value="pending.kind"
        :options="memberKinds"
        size="tiny"
        style="width: 88px"
        @update:value="(value) => setDraft({ kind: value })"
      />
      <n-select
        v-if="pending.kind === 'region'"
        :value="pending.value || null"
        :options="regionOptions"
        size="tiny"
        placeholder="地区"
        style="width: 120px"
        @update:value="(value) => setDraft({ value })"
      />
      <n-input
        v-else-if="pending.kind !== 'rest'"
        :value="pending.value"
        size="tiny"
        :placeholder="pending.kind === 'match' ? '/USA|美国/i' : '节点名、组名或 DIRECT'"
        style="width: 180px"
        @update:value="(value) => setDraft({ value })"
        @keyup.enter="addMember"
      />
      <n-button size="tiny" :disabled="pending.kind !== 'rest' && pending.value.trim() === ''" @click="addMember">添加</n-button>
    </div>
  </div>
</template>
