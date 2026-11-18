<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { InputInst } from 'naive-ui';
import {
  NAutoComplete,
  NButton,
  NEmpty,
  NInput,
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
import { ArrowDown, ArrowUp, Copy, FileCode2, Filter, Layers, Pencil, Plus, Trash2, X } from 'lucide-vue-next';
import type { OverlayMode } from '../api';
import PolicyGroupCard from '../components/PolicyGroupCard.vue';
import { parseRuleText } from '../rule-text';
import {
  addGroup,
  addRule,
  adoptBaseGroups,
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
const groupDraft = ref('');
const ruleModalOpen = ref(false);
const editingRuleIndex = ref<number | null>(null);
const groupModalOpen = ref(false);
const ruleValueInput = ref<InputInst | null>(null);
const ruleUrlInput = ref<InputInst | null>(null);
const groupNameInput = ref<InputInst | null>(null);
const batchTextInput = ref<InputInst | null>(null);

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
    notify('error', '复合条件（AND / OR / NOT）请点击右上角「批量 → JSON」编辑');
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

function openAddGroup(): void {
  groupDraft.value = '';
  groupModalOpen.value = true;
  void nextTick(() => groupNameInput.value?.focus());
}

function submitGroup(): void {
  if (!addGroup(groupDraft.value)) {
    notify('error', '策略组名称不能为空，也不能与已有组重名');
    return;
  }
  groupDraft.value = '';
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
                支持 <span class="mono">DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / IP-CIDR6 / GEOSITE / GEOIP / MATCH / HTTP 规则集</span>；会自动去除开头的 <span class="mono">-</span>、首尾引号、行尾逗号及注释。
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
      style="max-width: 400px; width: 90vw"
      :mask-closable="true"
    >
      <div class="stack" style="gap: 12px">
        <div class="field">
          <label>策略组名称</label>
          <n-input
            ref="groupNameInput"
            v-model:value="groupDraft"
            size="small"
            placeholder="例如 流媒体、Proxy、AI"
            @keyup.enter="submitGroup"
          />
        </div>
        <div class="row end">
          <n-button size="small" quaternary @click="groupModalOpen = false">取消</n-button>
          <n-button size="small" type="primary" :disabled="groupDraft.trim() === ''" @click="submitGroup">新建</n-button>
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
</style>
