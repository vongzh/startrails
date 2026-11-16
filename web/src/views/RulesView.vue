<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  NTooltip,
} from 'naive-ui';
import { ArrowDown, ArrowUp, FileCode2, Filter, Layers, Plus, Trash2, X } from 'lucide-vue-next';
import type { OverlayMode } from '../api';
import PolicyGroupCard from '../components/PolicyGroupCard.vue';
import {
  addGroup,
  addRule,
  adoptBaseGroups,
  baseGroups,
  busy,
  groupMode,
  groups,
  groupsDirty,
  importRules,
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
const jsonOpen = ref(false);
const jsonDraft = ref('[]');
const groupDraft = ref('');
const ruleInputRow = ref<HTMLElement | null>(null);
const groupInputRow = ref<HTMLElement | null>(null);

function focusInput(row: HTMLElement | null): void {
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const field =
    row?.querySelector<HTMLInputElement>('.n-input__input-el') ??
    row?.querySelector<HTMLInputElement>('input');
  field?.focus();
}

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
const groupNames = computed(() => new Set(groups.value.map((group) => group.name.toLowerCase())));
const policyKnown = (policy: string): boolean => {
  const key = policy.trim().toLowerCase();
  return groupNames.value.has(key) || POLICY_BUILTINS.includes(key);
};

function submitRule(): void {
  const policy = draft.value.policy.trim() || 'DIRECT';
  if (draftKind.value === 'final') {
    addRule({ kind: 'final', policy });
    return;
  }
  if (draftKind.value === 'external') {
    if (draft.value.url.trim() === '') return;
    addRule({
      kind: 'external',
      url: draft.value.url.trim(),
      policy,
      shape: draft.value.shape,
      format: draft.value.format,
    });
    draft.value.url = '';
    return;
  }
  if (draft.value.type !== 'match' && draft.value.value.trim() === '') return;
  addRule({
    kind: 'inline',
    condition: {
      type: draft.value.type,
      ...(draft.value.type === 'match' ? {} : { value: draft.value.value.trim() }),
      ...(noResolveTypes.has(draft.value.type) && draft.value.noResolve ? { noResolve: true } : {}),
    },
    policy,
  });
  draft.value.value = '';
}

function toggleJson(): void {
  jsonOpen.value = !jsonOpen.value;
  if (jsonOpen.value) jsonDraft.value = JSON.stringify(rules.value, null, 2);
}

function applyJson(): void {
  if (importRules(jsonDraft.value)) jsonOpen.value = false;
}

function submitGroup(): void {
  if (!addGroup(groupDraft.value)) {
    notify('error', '策略组名称不能为空，也不能与已有组重名');
    return;
  }
  groupDraft.value = '';
}

const ruleCanSubmit = computed(() => {
  if (draftKind.value === 'final') return true;
  if (draftKind.value === 'external') return draft.value.url.trim().length > 0;
  return draft.value.type === 'match' || draft.value.value.trim().length > 0;
});
</script>

<template>
  <div class="page">
    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>规则</h2>
          <span class="count">{{ rules.length }}</span>
          <n-tag v-if="rulesDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="spacer"></div>
          <n-radio-group v-model:value="ruleMode" size="small">
            <n-radio-button v-for="option in modeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
          <n-button size="small" quaternary @click="toggleJson">
            <template #icon><FileCode2 :size="14" /></template>
            JSON
          </n-button>
          <n-button size="small" :type="rulesDirty ? 'primary' : 'default'" :disabled="!rulesDirty || busy > 0" @click="saveRules()">
            {{ rulesDirty ? '保存规则' : '已保存' }}
          </n-button>
        </div>
        <p class="mode-note">
          <template v-if="ruleMode === 'inherit'">沿用订阅里的规则，下面的清单先存着，生成时不叠上去。</template>
          <template v-else-if="ruleMode === 'replace'">只用下面这份清单，订阅里的规则整份丢掉。</template>
          <template v-else>订阅规则还在。这份清单放在订阅规则</template>
          <n-radio-group v-if="ruleMode === 'merge'" v-model:value="rulePlacement" size="small" style="margin-left: 8px">
            <n-radio-button value="before">之前</n-radio-button>
            <n-radio-button value="after">之后</n-radio-button>
          </n-radio-group>
          <template v-if="ruleMode === 'merge'">。写了兜底就会换掉订阅的 MATCH。</template>
        </p>

        <n-empty v-if="rules.length === 0" description="还没有规则" style="padding: 28px 0">
          <template #icon><Filter :size="28" /></template>
          <n-button size="small" @click="focusInput(ruleInputRow)">添加第一条规则</n-button>
        </n-empty>

        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr><th style="width: 42px">#</th><th>条件</th><th style="width: 128px">策略</th><th style="width: 96px"></th></tr>
            </thead>
            <tbody>
              <tr v-for="(rule, index) in rules" :key="index">
                <td class="num">{{ index + 1 }}</td>
                <td class="mono">{{ ruleLabel(rule) }}</td>
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
                  <div class="row tight end">
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

        <div ref="ruleInputRow" class="stack" style="gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border)">
          <div class="row">
            <n-select
              v-model:value="draftKind"
              :options="[
                { label: '内联', value: 'inline' },
                { label: '规则集', value: 'external' },
                { label: '兜底', value: 'final' },
              ]"
              size="small"
              style="width: 110px"
            />
            <template v-if="draftKind === 'inline'">
              <n-select v-model:value="draft.type" :options="conditionTypes" size="small" style="width: 170px" />
              <n-input
                v-if="draft.type !== 'match'"
                v-model:value="draft.value"
                size="small"
                placeholder="匹配值，例如 example.com 或 cn"
                class="grow"
                @keyup.enter="submitRule"
              />
              <label v-if="noResolveTypes.has(draft.type)" class="row" style="gap: 6px; font-size: 12px">
                <n-switch v-model:value="draft.noResolve" size="small" />
                no-resolve
              </label>
            </template>
            <template v-else-if="draftKind === 'external'">
              <n-input v-model:value="draft.url" size="small" placeholder="https:// 规则集地址" class="grow" @keyup.enter="submitRule" />
              <n-select v-model:value="draft.shape" :options="shapeOptions" size="small" style="width: 110px" />
              <n-select v-model:value="draft.format" :options="formatOptions" size="small" style="width: 90px" />
            </template>
            <n-input v-model:value="draft.policy" size="small" placeholder="DIRECT" style="width: 120px" @keyup.enter="submitRule" />
            <n-button size="small" :disabled="!ruleCanSubmit" @click="submitRule">
              <template #icon><Plus :size="14" /></template>
              添加
            </n-button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>策略组</h2>
          <span class="count">{{ groups.length }}</span>
          <n-tag v-if="groupsDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="spacer"></div>
          <n-radio-group v-model:value="groupMode" size="small">
            <n-radio-button v-for="option in modeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </n-radio-button>
          </n-radio-group>
          <n-button size="small" :type="groupsDirty ? 'primary' : 'default'" :disabled="!groupsDirty || busy > 0" @click="saveGroups()">
            {{ groupsDirty ? '保存分组' : '已保存' }}
          </n-button>
        </div>
        <p class="mode-note">
          <template v-if="groupMode === 'inherit'">沿用订阅里的策略组。下面是订阅现在的组，只读。</template>
          <template v-else-if="groupMode === 'replace'">只用下面这份清单。匹配和地区在每次生成时按当前节点重算，引用的名字不会自动跟着订阅变。</template>
          <template v-else>同名组用这里的策略和成员换掉订阅的；只有订阅里有的组保留；只有这里有的组追加。</template>
        </p>

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
          <div v-if="baseGroups.length > 0" class="row" style="padding: 8px 18px 0">
            <n-button size="tiny" quaternary @click="adoptBaseGroups">带入订阅里的组</n-button>
            <span class="text-3" style="font-size: 12px">带入的是当前节点名。要跟着订阅变，改成匹配或地区。</span>
          </div>
          <n-empty v-if="groups.length === 0" description="还没有策略组，可在下方新建" style="padding: 28px 0">
            <template #icon><Layers :size="28" /></template>
            <n-button size="small" @click="focusInput(groupInputRow)">新建第一个策略组</n-button>
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
          <div ref="groupInputRow" class="row" style="padding: 12px 18px; border-top: 1px solid var(--border)">
            <n-input
              v-model:value="groupDraft"
              size="small"
              placeholder="新策略组名称，例如 流媒体"
              class="grow"
              @keyup.enter="submitGroup"
            />
            <n-button size="small" :disabled="groupDraft.trim() === ''" @click="submitGroup">
              <template #icon><Plus :size="14" /></template>
              新建分组
            </n-button>
          </div>
        </template>
      </section>
    </div>

    <section v-if="jsonOpen" class="card">
      <div class="card-head">
        <h2>规则 JSON</h2>
        <span class="text-3" style="font-size: 12px">内联、规则集和兜底可以混在一个数组里，应用后再保存</span>
        <div class="spacer"></div>
        <n-button size="small" quaternary @click="jsonDraft = JSON.stringify(rules, null, 2)">由列表生成</n-button>
        <n-button size="small" type="primary" @click="applyJson">应用到列表</n-button>
        <n-button aria-label="关闭规则 JSON" size="small" quaternary circle @click="jsonOpen = false">
          <template #icon><X :size="15" /></template>
        </n-button>
      </div>
      <div class="card-body">
        <n-input v-model:value="jsonDraft" type="textarea" :autosize="{ minRows: 10, maxRows: 20 }" class="mono" spellcheck="false" />
      </div>
    </section>

    <p v-if="dirty" class="dirty-note">
      <span class="dot warn"></span>
      改动尚未写入服务端，点击对应卡片的保存按钮后生效。
    </p>
  </div>
</template>

<style scoped>
.mode-note {
  margin: 0;
  padding: 8px 18px 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}
</style>
