<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { InputInst } from 'naive-ui';
import {
  NAutoComplete,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
} from 'naive-ui';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, FileCode2, Filter, Layers, Pencil, Plus, Trash2, X } from 'lucide-vue-next';
import type { OverlayMode } from '../api';
import PolicyGroupCard from '../components/PolicyGroupCard.vue';
import { parseRuleText } from '../rule-text';
import {
  addGroup,
  addRule,
  adoptBaseGroups,
  annotationMap,
  baseGroups,
  busy,
  copyText,
  discardGroups,
  discardRules,
  exportRuleText,
  groupMode,
  groups,
  groupsDirty,
  importRules,
  importRuleText,
  moveRule,
  nodes,
  notify,
  removeRule,
  ruleLabel,
  ruleMode,
  rulePlacement,
  rules,
  rulesDirty,
  saveGroups,
  saveRules,
  updateRule,
} from '../workspace';
import type { GroupDraft, GroupMemberDraft } from '../workspace';

const draftKind = ref<'inline' | 'external' | 'final'>('inline');
const draft = ref({
  type: 'domainSuffix',
  value: '',
  policy: 'DIRECT',
  noResolve: false,
  url: '',
  shape: 'domain' as 'domain' | 'ipcidr' | 'rules',
  format: 'text' as 'text' | 'yaml',
});
const batchOpen = ref(false);
const batchTab = ref<'text' | 'json'>('text');
const textDraft = ref('');
const jsonDraft = ref('[]');
const emptyGroupDraft = (): GroupDraft => ({
  name: '',
  strategy: 'select',
  testUrl: '',
  interval: null,
  tolerance: null,
  lazy: false,
  hidden: false,
  members: [],
});
const groupDraft = ref<GroupDraft>(emptyGroupDraft());
const pendingMember = ref<{ kind: GroupMemberDraft['kind']; value: string }>({ kind: 'ref', value: '' });
const ruleModalOpen = ref(false);
const editingRuleIndex = ref<number | null>(null);
const groupModalOpen = ref(false);
const ruleValueInput = ref<InputInst | null>(null);
const ruleUrlInput = ref<InputInst | null>(null);
const groupNameInput = ref<InputInst | null>(null);
const batchTextInput = ref<InputInst | null>(null);

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

const ruleTextPlaceholder = [
  '# 直接粘贴 Clash / Surge 规则或 JS 覆写数组行（支持引号与末尾逗号）',
  '"DOMAIN-SUFFIX,qq.com,DIRECT",',
  '"IP-CIDR,192.168.31.0/24,🏡 Home-CG,no-resolve",',
  '- GEOSITE,cn,DIRECT',
  'RULE-SET,https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt,REJECT,domain,text',
  'MATCH,🌈 Daily',
].join('\n');

const textPreview = computed(() => parseRuleText(textDraft.value));

const modeOptions: { label: string; value: OverlayMode }[] = [
  { label: '继承', value: 'inherit' },
  { label: '替换', value: 'replace' },
  { label: '组合', value: 'merge' },
];

const conditionTypes = [
  { label: 'DOMAIN-SUFFIX', value: 'domainSuffix' },
  { label: 'DOMAIN', value: 'domain' },
  { label: 'DOMAIN-KEYWORD', value: 'domainKeyword' },
  { label: 'IP-CIDR', value: 'ipCidr' },
  { label: 'IP-CIDR6', value: 'ipCidr6' },
  { label: 'GEOSITE', value: 'geosite' },
  { label: 'GEOIP', value: 'geoip' },
  { label: 'MATCH', value: 'match' },
];

const shapeOptions = [
  { label: 'domain', value: 'domain' },
  { label: 'ipcidr', value: 'ipcidr' },
  { label: 'rules', value: 'rules' },
];

const formatOptions = [
  { label: 'text', value: 'text' },
  { label: 'yaml', value: 'yaml' },
];

const dirty = computed(() => rulesDirty.value || groupsDirty.value);
const noResolveTypes = new Set(['ipCidr', 'ipCidr6', 'geoip']);

const POLICY_BUILTINS = ['direct', 'reject', 'reject-drop', 'proxy', 'pass', 'compatible', 'block'];
const POLICY_SUGGEST_BUILTINS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PROXY'];

const groupNames = computed(() => new Set([
  ...groups.value.map((group) => group.name.toLowerCase()),
  ...(groupMode.value !== 'replace' ? baseGroups.value.map((group) => group.name.toLowerCase()) : []),
]));

const policyKnown = (policy: string): boolean => {
  const key = policy.trim().toLowerCase();
  return groupNames.value.has(key) || POLICY_BUILTINS.includes(key);
};

const policyOptions = computed(() => {
  const candidates = new Set<string>(POLICY_SUGGEST_BUILTINS);
  for (const group of groups.value) candidates.add(group.name);
  if (groupMode.value !== 'replace') {
    for (const group of baseGroups.value) candidates.add(group.name);
  }
  const query = draft.value.policy.trim().toLowerCase();
  return [...candidates]
    .filter((name) => query === '' || name.toLowerCase().includes(query))
    .map((name) => ({ label: name, value: name }));
});

function openAddRule(): void {
  editingRuleIndex.value = null;
  draftKind.value = 'inline';
  draft.value = {
    type: 'domainSuffix',
    value: '',
    policy: 'DIRECT',
    noResolve: false,
    url: '',
    shape: 'domain',
    format: 'text',
  };
  ruleModalOpen.value = true;
  void nextTick(() => {
    if (draftKind.value === 'external') ruleUrlInput.value?.focus();
    else if (draftKind.value === 'inline') ruleValueInput.value?.focus();
  });
}

function openEditRule(index: number): void {
  const target = rules.value[index];
  if (target === undefined) return;
  if (target.kind === 'inline' && (target.condition.children !== undefined || target.condition.child !== undefined)) {
    notify('error', '复合条件（AND / OR / NOT）请点击右上角「批量导入 → 规则文本或 JSON」编辑');
    return;
  }
  editingRuleIndex.value = index;
  if (target.kind === 'final') {
    draftKind.value = 'final';
    draft.value = {
      type: 'domainSuffix',
      value: '',
      policy: target.policy,
      noResolve: false,
      url: '',
      shape: 'domain',
      format: 'text',
    };
  } else if (target.kind === 'external') {
    draftKind.value = 'external';
    draft.value = {
      type: 'domainSuffix',
      value: '',
      policy: target.policy,
      noResolve: false,
      url: target.url,
      shape: (target.shape as 'domain' | 'ipcidr' | 'rules' | undefined) ?? 'domain',
      format: (target.format as 'text' | 'yaml' | undefined) ?? 'text',
    };
  } else {
    draftKind.value = 'inline';
    draft.value = {
      type: target.condition.type,
      value: target.condition.value ?? '',
      policy: target.policy,
      noResolve: target.condition.noResolve === true,
      url: '',
      shape: 'domain',
      format: 'text',
    };
  }
  ruleModalOpen.value = true;
  void nextTick(() => {
    if (draftKind.value === 'external') ruleUrlInput.value?.focus();
    else if (draftKind.value === 'inline') ruleValueInput.value?.focus();
  });
}

function submitRule(): void {
  if (!ruleCanSubmit.value) return;
  const policy = draft.value.policy.trim() || 'DIRECT';
  const nextRule =
    draftKind.value === 'final'
      ? ({ kind: 'final', policy } as const)
      : draftKind.value === 'external'
        ? ({
            kind: 'external',
            url: draft.value.url.trim(),
            policy,
            shape: draft.value.shape,
            format: draft.value.format,
          } as const)
        : ({
            kind: 'inline',
            condition: {
              type: draft.value.type,
              ...(draft.value.type === 'match' ? {} : { value: draft.value.value.trim() }),
              ...(noResolveTypes.has(draft.value.type) && draft.value.noResolve ? { noResolve: true } : {}),
            },
            policy,
          } as const);

  if (editingRuleIndex.value !== null) {
    updateRule(editingRuleIndex.value, nextRule);
  } else {
    addRule(nextRule);
  }
  editingRuleIndex.value = null;
  ruleModalOpen.value = false;
}

function toggleBatch(): void {
  batchOpen.value = !batchOpen.value;
  if (batchOpen.value) {
    textDraft.value = exportRuleText();
    jsonDraft.value = JSON.stringify(rules.value, null, 2);
    void nextTick(() => {
      if (batchTab.value === 'text') batchTextInput.value?.focus();
    });
  }
}

function copyAllRuleText(): void {
  const text = exportRuleText();
  if (text === '') {
    notify('error', '当前列表没有规则可复制');
    return;
  }
  void copyText(text, `已复制 ${rules.value.length} 条规则`);
}

function applyText(mode: 'append' | 'replace'): void {
  const result = importRuleText(textDraft.value, mode);
  if (result.rules.length > 0 && result.skipped.length === 0) {
    batchOpen.value = false;
  }
}

function applyJson(): void {
  if (importRules(jsonDraft.value)) batchOpen.value = false;
}

const groupNameDuplicate = computed(() => {
  const name = groupDraft.value.name.trim();
  return name.length > 0 && groups.value.some((item) => item.name === name);
});

const groupCanSubmit = computed(
  () => groupDraft.value.name.trim().length > 0 && !groupNameDuplicate.value,
);

const groupRefOptions = computed(() => {
  if (pendingMember.value.kind !== 'ref') return [];
  const existing = new Set(
    groupDraft.value.members.filter((item) => item.kind === 'ref').map((item) => item.value),
  );
  const candidates = new Set<string>(['DIRECT', 'REJECT']);
  for (const g of groups.value) candidates.add(g.name);
  if (groupMode.value !== 'replace') {
    for (const g of baseGroups.value) candidates.add(g.name);
  }
  for (const node of nodes.value) {
    const ann = annotationMap.value.get(node.nodeKey);
    if (ann?.excluded === true) continue;
    const label = ann?.alias ?? node.name;
    if (label !== '') candidates.add(label);
  }
  const query = pendingMember.value.value.trim().toLowerCase();
  return [...candidates]
    .filter((name) => !existing.has(name) && (query === '' || name.toLowerCase().includes(query)))
    .slice(0, 40)
    .map((name) => ({ label: name, value: name }));
});

const quickGroupRefs = computed(() => {
  const existing = new Set(
    groupDraft.value.members.filter((item) => item.kind === 'ref').map((item) => item.value),
  );
  const candidates = [
    ...groups.value.map((g) => g.name),
    ...(groupMode.value !== 'replace' ? baseGroups.value.map((g) => g.name) : []),
    'DIRECT',
    'REJECT',
  ];
  const items: string[] = [];
  for (const name of candidates) {
    if (!existing.has(name) && !items.includes(name)) items.push(name);
  }
  return items.slice(0, 6);
});

function groupMemberKey(member: GroupMemberDraft): string {
  return `${member.kind}:${member.value}`;
}

function groupMemberLabel(member: GroupMemberDraft): string {
  if (member.kind === 'match') return `匹配 ${member.value}`;
  if (member.kind === 'region') return `地区 ${member.value}`;
  if (member.kind === 'rest') return '其余节点';
  return member.value;
}

function addDraftMember(member: GroupMemberDraft): void {
  if (member.kind === 'rest') {
    if (groupDraft.value.members.some((item) => item.kind === 'rest')) return;
    groupDraft.value.members = [...groupDraft.value.members, { kind: 'rest', value: '' }];
    return;
  }
  const value = member.value.trim();
  if (value === '') return;
  if (groupDraft.value.members.some((item) => item.kind === member.kind && item.value === value)) return;
  groupDraft.value.members = [...groupDraft.value.members, { kind: member.kind, value }];
}

function commitPendingMember(): void {
  addDraftMember(pendingMember.value);
  pendingMember.value = { ...pendingMember.value, value: '' };
}

function selectDraftRefMember(value: string | number): void {
  const text = String(value).trim();
  if (text !== '') addDraftMember({ kind: 'ref', value: text });
  pendingMember.value = { ...pendingMember.value, value: '' };
}

function selectDraftRegionMember(value: string): void {
  if (value !== '') addDraftMember({ kind: 'region', value });
  pendingMember.value = { ...pendingMember.value, value: '' };
}

function removeDraftMember(member: GroupMemberDraft): void {
  groupDraft.value.members = groupDraft.value.members.filter(
    (item) => !(item.kind === member.kind && item.value === member.value),
  );
}

function moveDraftMember(index: number, direction: number): void {
  const next = index + direction;
  if (next < 0 || next >= groupDraft.value.members.length) return;
  const list = [...groupDraft.value.members];
  const current = list[index];
  const other = list[next];
  if (current === undefined || other === undefined) return;
  list[index] = other;
  list[next] = current;
  groupDraft.value.members = list;
}

function setDraftStrategy(strategy: 'select' | 'url-test' | 'fallback'): void {
  groupDraft.value.strategy = strategy;
  if (strategy !== 'select') {
    if (groupDraft.value.testUrl.trim() === '') {
      groupDraft.value.testUrl = 'https://www.gstatic.com/generate_204';
    }
    if (groupDraft.value.interval === null) groupDraft.value.interval = 300;
    if (strategy === 'url-test' && groupDraft.value.tolerance === null) groupDraft.value.tolerance = 50;
  }
}

function applyGroupPreset(kind: 'main' | 'auto' | 'ai' | 'fallback'): void {
  const knownNames = groups.value.map((g) => g.name);
  if (kind === 'main') {
    groupDraft.value = {
      name: '🚀 节点选择',
      strategy: 'select',
      testUrl: '',
      interval: null,
      tolerance: null,
      lazy: false,
      hidden: false,
      members: [
        ...knownNames.map((name): GroupMemberDraft => ({ kind: 'ref', value: name })),
        { kind: 'rest', value: '' },
        { kind: 'ref', value: 'DIRECT' },
      ],
    };
  } else if (kind === 'auto') {
    groupDraft.value = {
      name: '♻️ 自动选择',
      strategy: 'url-test',
      testUrl: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      lazy: true,
      hidden: false,
      members: [{ kind: 'rest', value: '' }],
    };
  } else if (kind === 'ai') {
    groupDraft.value = {
      name: '🤖 AI',
      strategy: 'select',
      testUrl: '',
      interval: null,
      tolerance: null,
      lazy: false,
      hidden: false,
      members: [
        { kind: 'region', value: 'US' },
        { kind: 'region', value: 'JP' },
        { kind: 'region', value: 'SG' },
      ],
    };
  } else {
    groupDraft.value = {
      name: '🌍 故障转移',
      strategy: 'fallback',
      testUrl: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: null,
      lazy: true,
      hidden: false,
      members: [{ kind: 'rest', value: '' }],
    };
  }
}

function openAddGroup(): void {
  groupDraft.value = emptyGroupDraft();
  pendingMember.value = { kind: 'ref', value: '' };
  groupModalOpen.value = true;
  void nextTick(() => groupNameInput.value?.focus());
}

function submitGroup(): void {
  if (!groupCanSubmit.value) {
    notify('error', groupNameDuplicate.value ? '已存在同名策略组，请换一个名称' : '策略组名称不能为空');
    return;
  }
  // 如果用户在输入框里已经填了/选了待加入成员但忘了点「加入」，替他一并带上。
  if (pendingMember.value.kind !== 'rest' && pendingMember.value.value.trim() !== '') {
    commitPendingMember();
  }
  if (!addGroup(groupDraft.value)) {
    notify('error', '策略组名称不能为空，也不能与已有组重名');
    return;
  }
  groupDraft.value = emptyGroupDraft();
  groupModalOpen.value = false;
}

const ruleCanSubmit = computed(() => {
  if (draftKind.value === 'final') return true;
  if (draftKind.value === 'external') return draft.value.url.trim().length > 0;
  return draft.value.type === 'match' || draft.value.value.trim().length > 0;
});
</script>

<template>
  <div class="page">
    <section v-if="batchOpen" class="card">
      <div class="card-head">
        <h2>批量规则</h2>
        <span class="text-3" style="font-size: 12px">支持直接粘贴脚本数组行、YAML 列表或 CSV 规则，应用后再点保存</span>
        <div class="spacer"></div>
        <n-button aria-label="关闭批量规则" size="small" quaternary circle @click="batchOpen = false">
          <template #icon><X :size="15" /></template>
        </n-button>
      </div>
      <div class="card-body">
        <n-tabs v-model:value="batchTab" type="line" size="small">
          <n-tab-pane name="text" tab="规则文本">
            <div class="stack" style="gap: 10px">
              <p class="text-3" style="font-size: 12px; margin: 0">
                支持 <span class="mono">DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / HOST* / IP-CIDR / IP-CIDR6 / GEOSITE / GEOIP / AND / OR / NOT / MATCH / FINAL / HTTP 规则集</span>（含 subconverter 前缀）；会自动去除开头的 <span class="mono">-</span>、首尾引号、行尾逗号及注释。
              </p>
              <n-input
                ref="batchTextInput"
                v-model:value="textDraft"
                type="textarea"
                :autosize="{ minRows: 8, maxRows: 18 }"
                class="mono"
                spellcheck="false"
                :placeholder="ruleTextPlaceholder"
              />
              <div v-if="textDraft.trim().length > 0" class="stack" style="gap: 6px">
                <div class="row tight" style="flex-wrap: wrap; gap: 8px; font-size: 12px">
                  <n-tag size="small" :type="textPreview.rules.length > 0 ? 'success' : 'default'" :bordered="false">
                    可导入 {{ textPreview.rules.length }} 条
                  </n-tag>
                  <n-tag v-if="textPreview.skipped.length > 0" size="small" type="warning" :bordered="false">
                    跳过 {{ textPreview.skipped.length }} 行
                  </n-tag>
                </div>
                <div v-if="textPreview.skipped.length > 0" class="skip-list mono">
                  <div v-for="item in textPreview.skipped" :key="item.line" class="skip-item">
                    <span>第 {{ item.line }} 行 · {{ item.reason }}</span>
                    <span class="text-3">{{ item.text }}</span>
                  </div>
                </div>
              </div>
              <div class="row" style="flex-wrap: wrap; gap: 8px">
                <n-button size="small" quaternary :disabled="rules.length === 0" @click="textDraft = exportRuleText()">
                  由当前列表生成
                </n-button>
                <n-button
                  size="small"
                  quaternary
                  :disabled="textDraft.trim() === ''"
                  @click="copyText(textDraft, '已复制当前规则文本')"
                >
                  <template #icon><Copy :size="14" /></template>
                  复制文本
                </n-button>
                <div class="spacer"></div>
                <n-button size="small" secondary :disabled="textPreview.rules.length === 0" @click="applyText('append')">
                  追加到列表
                </n-button>
                <n-button size="small" type="primary" :disabled="textPreview.rules.length === 0" @click="applyText('replace')">
                  替换列表
                </n-button>
              </div>
            </div>
          </n-tab-pane>
          <n-tab-pane name="json" tab="JSON">
            <div class="stack" style="gap: 10px">
              <p class="text-3" style="font-size: 12px; margin: 0">
                内联、规则集和兜底可混在一个数组里（含 AND / OR / NOT 复合条件），应用后再点保存。
              </p>
              <n-input
                v-model:value="jsonDraft"
                type="textarea"
                :autosize="{ minRows: 10, maxRows: 20 }"
                class="mono"
                spellcheck="false"
              />
              <div class="row" style="flex-wrap: wrap; gap: 8px">
                <n-button size="small" quaternary @click="jsonDraft = JSON.stringify(rules, null, 2)">
                  由列表生成
                </n-button>
                <n-button
                  size="small"
                  quaternary
                  :disabled="jsonDraft.trim() === ''"
                  @click="copyText(jsonDraft, '已复制规则 JSON')"
                >
                  <template #icon><Copy :size="14" /></template>
                  复制 JSON
                </n-button>
                <div class="spacer"></div>
                <n-button size="small" type="primary" @click="applyJson">应用到列表</n-button>
              </div>
            </div>
          </n-tab-pane>
        </n-tabs>
      </div>
    </section>

    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>规则</h2>
          <span class="count">{{ rules.length }}</span>
          <n-tag v-if="rulesDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="head-actions">
            <n-button size="small" quaternary @click="openAddRule">
              <template #icon><Plus :size="14" /></template>
              添加规则
            </n-button>
            <n-button size="small" quaternary :disabled="rules.length === 0" @click="copyAllRuleText">
              <template #icon><Copy :size="14" /></template>
              复制
            </n-button>
            <n-button size="small" :type="batchOpen ? 'primary' : 'default'" quaternary @click="toggleBatch">
              <template #icon><FileCode2 :size="14" /></template>
              批量
            </n-button>
            <n-button v-if="rulesDirty" size="small" quaternary :disabled="busy > 0" @click="discardRules()">
              放弃
            </n-button>
            <n-button size="small" :type="rulesDirty ? 'primary' : 'default'" :disabled="!rulesDirty || busy > 0" @click="saveRules()">
              {{ rulesDirty ? '保存规则' : '已保存' }}
            </n-button>
          </div>
        </div>

        <div class="mode-strip">
          <n-radio-group v-model:value="ruleMode" size="small">
            <n-radio-button v-for="option in modeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
          <n-radio-group v-if="ruleMode === 'merge'" v-model:value="rulePlacement" size="small">
            <n-radio-button value="before">订阅之前</n-radio-button>
            <n-radio-button value="after">订阅之后</n-radio-button>
          </n-radio-group>
          <p class="mode-note">
            <template v-if="ruleMode === 'inherit'">沿用订阅里的规则，下面的清单先存着，生成时不叠上去。</template>
            <template v-else-if="ruleMode === 'replace'">只用下面这份清单，订阅里的规则整份丢掉。</template>
            <template v-else>订阅规则保留；本清单放在订阅规则{{ rulePlacement === 'before' ? '之前' : '之后' }}，写了兜底会替换订阅的 MATCH。</template>
          </p>
        </div>

        <n-empty v-if="rules.length === 0" :class="{ 'scope-disabled': ruleMode === 'inherit' }" description="还没有规则" style="padding: 28px 0">
          <template #icon><Filter :size="28" /></template>
          <div class="row tight" style="justify-content: center">
            <n-button size="small" @click="openAddRule">添加第一条规则</n-button>
            <n-button size="small" secondary @click="() => { batchTab = 'text'; if (!batchOpen) toggleBatch(); }">
              批量导入
            </n-button>
          </div>
        </n-empty>

        <div v-else class="tbl-wrap" :class="{ 'scope-disabled': ruleMode === 'inherit' }">
          <table class="tbl">
            <thead>
              <tr><th style="width: 42px">#</th><th>条件</th><th style="width: 120px">策略</th><th style="width: 118px"></th></tr>
            </thead>
            <tbody>
              <tr v-for="(rule, index) in rules" :key="index">
                <td class="num">{{ index + 1 }}</td>
                <td class="mono rule-cond">{{ ruleLabel(rule) }}</td>
                <td>
                  <n-tooltip v-if="!policyKnown(rule.policy)" trigger="hover">
                    <template #trigger>
                      <n-tag size="small" type="warning" :bordered="true" class="mono" style="cursor: help">
                        {{ rule.policy }}
                      </n-tag>
                    </template>
                    不是内置策略，也找不到同名策略组：产物会原样写这个值，客户端可能拒绝整份配置。
                  </n-tooltip>
                  <n-tag v-else size="small" type="primary" :bordered="false" class="mono">{{ rule.policy }}</n-tag>
                </td>
                <td class="actions">
                  <div class="row tight end compact-actions">
                    <n-button aria-label="编辑规则" quaternary circle size="tiny" @click="openEditRule(index)">
                      <template #icon><Pencil :size="13" /></template>
                    </n-button>
                    <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveRule(index, -1)">
                      <template #icon><ArrowUp :size="13" /></template>
                    </n-button>
                    <n-button aria-label="下移" quaternary circle size="tiny" :disabled="index === rules.length - 1" @click="moveRule(index, 1)">
                      <template #icon><ArrowDown :size="13" /></template>
                    </n-button>
                    <n-button aria-label="删除规则" quaternary circle size="tiny" type="error" @click="removeRule(index)">
                      <template #icon><Trash2 :size="13" /></template>
                    </n-button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>策略组</h2>
          <span class="count">{{ groups.length }}</span>
          <n-tag v-if="groupsDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="head-actions">
            <n-button v-if="groupMode !== 'inherit'" size="small" quaternary @click="openAddGroup">
              <template #icon><Plus :size="14" /></template>
              新建分组
            </n-button>
            <n-button v-if="groupsDirty" size="small" quaternary :disabled="busy > 0" @click="discardGroups()">
              放弃
            </n-button>
            <n-button size="small" :type="groupsDirty ? 'primary' : 'default'" :disabled="!groupsDirty || busy > 0" @click="saveGroups()">
              {{ groupsDirty ? '保存分组' : '已保存' }}
            </n-button>
          </div>
        </div>

        <div class="mode-strip">
          <n-radio-group v-model:value="groupMode" size="small">
            <n-radio-button v-for="option in modeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
          <p class="mode-note">
            <template v-if="groupMode === 'inherit'">
              沿用订阅里的策略组。下面是订阅现在的组，只读<template v-if="groups.length > 0">（已编排的 {{ groups.length }} 个自定义组会保留，切回替换或组合即可继续用）</template>。
            </template>
            <template v-else-if="groupMode === 'replace'">只用下面这份清单。匹配和地区在每次生成时按当前节点重算，引用的名字不会自动跟着订阅变。</template>
            <template v-else>同名组用这里的策略和成员换掉订阅的；只有订阅里有的组保留；只有这里有的组追加。</template>
          </p>
        </div>

        <div v-if="groupMode === 'inherit'" class="card-body stack" style="gap: 8px">
          <n-empty v-if="baseGroups.length === 0" description="订阅里没有策略组" style="padding: 28px 0">
            <template #icon><Layers :size="28" /></template>
          </n-empty>
          <div v-for="group in baseGroups" :key="group.name" class="row">
            <span class="strong" style="font-size: 13px">{{ group.name }}</span>
            <n-tag size="small" :bordered="false">{{ group.strategy ?? 'select' }}</n-tag>
            <span class="text-3" style="font-size: 12px">{{ group.members.length }} 个成员</span>
          </div>
        </div>

        <template v-else>
          <div v-if="baseGroups.length > 0" class="row" style="padding: 10px 18px 0">
            <n-button size="tiny" quaternary @click="adoptBaseGroups">带入订阅里的组</n-button>
            <span class="text-3" style="font-size: 12px">带入的是当前节点名。要跟着订阅变，改成匹配或地区。</span>
          </div>
          <n-empty v-if="groups.length === 0" description="还没有策略组" style="padding: 28px 0">
            <template #icon><Layers :size="28" /></template>
            <n-button size="small" @click="openAddGroup">新建第一个策略组</n-button>
          </n-empty>
          <div v-else class="card-body stack" style="gap: 14px">
            <PolicyGroupCard
              v-for="(policyGroup, index) in groups"
              :key="policyGroup.name"
              :group="policyGroup"
              :index="index"
              :total="groups.length"
            />
          </div>
        </template>
      </section>
    </div>

    <n-modal
      v-model:show="ruleModalOpen"
      preset="card"
      :title="editingRuleIndex === null ? '添加规则' : `编辑第 ${editingRuleIndex + 1} 条规则`"
      style="max-width: 500px; width: 92vw"
      :mask-closable="true"
    >
      <div class="stack" style="gap: 12px">
        <div class="field">
          <label>规则类型</label>
          <n-radio-group v-model:value="draftKind" size="small">
            <n-radio-button value="inline">内联规则</n-radio-button>
            <n-radio-button value="external">规则集</n-radio-button>
            <n-radio-button value="final">兜底 MATCH</n-radio-button>
          </n-radio-group>
        </div>

        <template v-if="draftKind === 'inline'">
          <div class="field">
            <label>匹配条件</label>
            <n-select v-model:value="draft.type" :options="conditionTypes" size="small" />
          </div>
          <div v-if="draft.type !== 'match'" class="field">
            <label>匹配值</label>
            <n-input
              ref="ruleValueInput"
              v-model:value="draft.value"
              size="small"
              placeholder="例如 example.com、192.168.0.0/16 或 cn"
              @keyup.enter="submitRule"
            />
          </div>
          <label v-if="noResolveTypes.has(draft.type)" class="row" style="gap: 8px; font-size: 13px">
            <n-switch v-model:value="draft.noResolve" size="small" />
            <span>no-resolve（匹配 IP 时不触发本地 DNS 解析）</span>
          </label>
        </template>

        <template v-else-if="draftKind === 'external'">
          <div class="field">
            <label>规则集地址</label>
            <n-input
              ref="ruleUrlInput"
              v-model:value="draft.url"
              size="small"
              placeholder="https://... 规则集 URL"
              @keyup.enter="submitRule"
            />
          </div>
          <div class="row">
            <div class="field grow">
              <label>形状</label>
              <n-select v-model:value="draft.shape" :options="shapeOptions" size="small" />
            </div>
            <div class="field grow">
              <label>格式</label>
              <n-select v-model:value="draft.format" :options="formatOptions" size="small" />
            </div>
          </div>
        </template>

        <div class="field">
          <label>目标策略</label>
          <n-auto-complete
            v-model:value="draft.policy"
            :options="policyOptions"
            :get-show="() => true"
            size="small"
            placeholder="策略组名，或 DIRECT / REJECT / PROXY"
            @keyup.enter="submitRule"
          />
          <span v-if="draft.policy.trim() !== '' && !policyKnown(draft.policy)" class="text-3" style="font-size: 11.5px; color: var(--warn)">
            当前不是内置策略，也未在策略组列表中找到，保存后按原值写出。
          </span>
        </div>

        <div class="row end" style="margin-top: 4px">
          <n-button size="small" quaternary @click="ruleModalOpen = false">取消</n-button>
          <n-button size="small" type="primary" :disabled="!ruleCanSubmit" @click="submitRule">
            {{ editingRuleIndex === null ? '添加到列表' : '应用改动' }}
          </n-button>
        </div>
      </div>
    </n-modal>

    <n-modal
      v-model:show="groupModalOpen"
      preset="card"
      title="新建策略组"
      style="max-width: 580px; width: 92vw"
      :mask-closable="true"
    >
      <div class="stack" style="gap: 14px">
        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <span class="text-3" style="font-size: 12px">快捷模板：</span>
          <n-button size="tiny" secondary @click="applyGroupPreset('main')">🚀 节点选择</n-button>
          <n-button size="tiny" secondary @click="applyGroupPreset('auto')">♻️ 自动测速</n-button>
          <n-button size="tiny" secondary @click="applyGroupPreset('ai')">🤖 AI 专用</n-button>
          <n-button size="tiny" secondary @click="applyGroupPreset('fallback')">🌍 故障转移</n-button>
        </div>

        <div class="row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap">
          <div class="field grow" style="min-width: 180px">
            <label>策略组名称</label>
            <n-input
              ref="groupNameInput"
              v-model:value="groupDraft.name"
              size="small"
              placeholder="例如 🌈 Daily、流媒体、AI"
              @keyup.enter="submitGroup"
            />
          </div>
          <div class="field" style="width: 158px">
            <label>策略类型</label>
            <n-select
              :value="groupDraft.strategy"
              :options="strategyOptions"
              size="small"
              @update:value="setDraftStrategy"
            />
          </div>
          <label class="row" style="gap: 6px; font-size: 12.5px; height: 28px">
            <n-switch v-model:value="groupDraft.hidden" size="small" />
            隐藏
          </label>
        </div>
        <p v-if="groupNameDuplicate" class="text-3" style="margin: -8px 0 0; font-size: 12px; color: var(--err)">
          已有同名策略组，请换一个名称
        </p>

        <div v-if="groupDraft.strategy !== 'select'" class="stack" style="gap: 6px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius)">
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <div class="field grow" style="min-width: 180px">
              <label>测速地址</label>
              <n-input
                v-model:value="groupDraft.testUrl"
                size="small"
                placeholder="https://www.gstatic.com/generate_204"
              />
            </div>
            <div class="field" style="width: 96px">
              <label>间隔（秒）</label>
              <n-input-number v-model:value="groupDraft.interval" size="small" :min="1" placeholder="300" />
            </div>
            <div v-if="groupDraft.strategy === 'url-test'" class="field" style="width: 86px">
              <label>容差（ms）</label>
              <n-input-number v-model:value="groupDraft.tolerance" size="small" :min="0" placeholder="50" />
            </div>
          </div>
          <label class="row" style="gap: 6px; font-size: 12px">
            <n-switch v-model:value="groupDraft.lazy" size="small" />
            <span>懒测速（仅在被选中时才测速）</span>
          </label>
          <span v-if="groupDraft.testUrl.trim() === ''" class="text-3" style="font-size: 11.5px; color: var(--warn)">
            测速组需要填写测速地址；留空在 Clash / mihomo 中会退回手选
          </span>
        </div>

        <div class="field">
          <div class="row" style="justify-content: space-between">
            <label>成员配置</label>
            <span class="text-3" style="font-size: 11.5px">已选 {{ groupDraft.members.length }} 项</span>
          </div>
          <div class="tag-input" style="margin-top: 4px">
            <n-tag
              v-for="(member, memberIndex) in groupDraft.members"
              :key="groupMemberKey(member)"
              size="small"
              closable
              :bordered="false"
              @close="removeDraftMember(member)"
            >
              <span class="member-chip">
                <span>{{ groupMemberLabel(member) }}</span>
                <span v-if="groupDraft.members.length > 1" class="member-arrows">
                  <button
                    type="button"
                    class="tag-step"
                    aria-label="前移成员"
                    :disabled="memberIndex === 0"
                    @click.stop="moveDraftMember(memberIndex, -1)"
                  >
                    <ChevronLeft :size="11" />
                  </button>
                  <button
                    type="button"
                    class="tag-step"
                    aria-label="后移成员"
                    :disabled="memberIndex === groupDraft.members.length - 1"
                    @click.stop="moveDraftMember(memberIndex, 1)"
                  >
                    <ChevronRight :size="11" />
                  </button>
                </span>
              </span>
            </n-tag>

            <div class="member-adder-row">
              <n-select
                :value="pendingMember.kind"
                :options="memberKinds"
                size="small"
                style="width: 84px"
                @update:value="(value: GroupMemberDraft['kind']) => (pendingMember = { kind: value, value: '' })"
              />
              <n-select
                v-if="pendingMember.kind === 'region'"
                :value="pendingMember.value || null"
                :options="regionOptions"
                size="small"
                placeholder="选择地区即加入"
                style="width: 140px"
                @update:value="selectDraftRegionMember"
              />
              <n-input
                v-else-if="pendingMember.kind === 'match'"
                v-model:value="pendingMember.value"
                size="small"
                placeholder="/USA|美国/i"
                style="flex: 1; min-width: 110px"
                @keyup.enter="commitPendingMember"
              />
              <n-auto-complete
                v-else-if="pendingMember.kind === 'ref'"
                v-model:value="pendingMember.value"
                :options="groupRefOptions"
                :get-show="() => true"
                clear-after-select
                size="small"
                placeholder="节点名、组名或 DIRECT"
                style="flex: 1; min-width: 110px"
                @select="selectDraftRefMember"
                @keyup.enter="commitPendingMember"
              />
              <n-button
                v-if="pendingMember.kind !== 'region'"
                size="small"
                :disabled="
                  pendingMember.kind === 'rest'
                    ? groupDraft.members.some((item) => item.kind === 'rest')
                    : pendingMember.value.trim() === ''
                "
                @click="commitPendingMember"
              >
                加入
              </n-button>
            </div>
          </div>

          <div class="row" style="gap: 5px; flex-wrap: wrap; margin-top: 6px">
            <span class="text-3" style="font-size: 11.5px">快捷加入：</span>
            <n-button
              v-for="refName in quickGroupRefs"
              :key="`qref:${refName}`"
              size="tiny"
              quaternary
              @click="addDraftMember({ kind: 'ref', value: refName })"
            >
              + {{ refName }}
            </n-button>
            <n-button
              v-if="!groupDraft.members.some((item) => item.kind === 'rest')"
              size="tiny"
              quaternary
              @click="addDraftMember({ kind: 'rest', value: '' })"
            >
              + 其余节点
            </n-button>
          </div>
          <span v-if="groupDraft.members.length === 0" class="text-3" style="font-size: 11.5px; color: var(--warn); margin-top: 4px">
            未添加成员时，生成配置会暂时回退到 DIRECT；建议在上方选好成员再创建
          </span>
        </div>

        <div class="row end">
          <n-button size="small" quaternary @click="groupModalOpen = false">取消</n-button>
          <n-button size="small" type="primary" :disabled="!groupCanSubmit" @click="submitGroup">创建策略组</n-button>
        </div>
      </div>
    </n-modal>

    <p v-if="dirty" class="dirty-note">
      <span class="dot warn"></span>
      改动尚未写入服务端，点击对应卡片的保存按钮后生效。
    </p>
  </div>
</template>

<style scoped>
.rule-cond {
  word-break: break-all;
}

.skip-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 132px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 11.5px;
}

.skip-item {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 10px;
}

.skip-item .text-3 {
  overflow-wrap: anywhere;
}

.member-adder-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 220px;
  min-width: 0;
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
  border: none;
  background: transparent;
  color: inherit;
  padding: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.7;
}

.tag-step:hover:not(:disabled) {
  opacity: 1;
}

.tag-step:disabled {
  opacity: 0.25;
  cursor: default;
}
</style>
