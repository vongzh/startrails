<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NEmpty, NInput, NSelect, NTag, NTooltip } from 'naive-ui';
import { ArrowDown, ArrowUp, FileCode2, Filter, Layers, Plus, Trash2, X } from 'lucide-vue-next';
import {
  addGroup,
  addGroupMember,
  addRule,
  busy,
  groups,
  groupsDirty,
  importRules,
  moveGroup,
  moveRule,
  notify,
  removeGroup,
  removeGroupMember,
  removeRule,
  rules,
  rulesDirty,
  ruleLabel,
  saveGroups,
  saveRules,
} from '../workspace';

const draft = ref({ type: 'domainSuffix', value: '', policy: 'DIRECT' });
const jsonOpen = ref(false);
const jsonDraft = ref('[]');
const memberDrafts = ref<Record<string, string>>({});
const groupDraft = ref('');
const ruleInputRow = ref<HTMLElement | null>(null);
const groupInputRow = ref<HTMLElement | null>(null);

/** 空态 CTA：把焦点交回下方输入行，别让用户对着空卡片找入口。 */
function focusInput(row: HTMLElement | null): void {
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const field =
    row?.querySelector<HTMLInputElement>('.n-input__input-el') ??
    row?.querySelector<HTMLInputElement>('input');
  field?.focus();
}

/**
 * 只列**后端真能存**的三种条件。IR 的条件树目前是 domain / domainSuffix / ipCidr（+ and/or/not），
 * 而 DOMAIN-KEYWORD 与 GEOIP 只在客户端方言里有说法：给个能选、一保存就 400 `invalid-rules` 的下拉
 * 比不给更糟。真要支持得先在 IR、校验、能力表与 7 种方言的渲染里补上，再来加这两项。
 */
const conditionTypes = [
  { label: 'DOMAIN-SUFFIX', value: 'domainSuffix' },
  { label: 'DOMAIN', value: 'domain' },
  { label: 'IP-CIDR', value: 'ipCidr' },
];

const dirty = computed(() => rulesDirty.value || groupsDirty.value);

/**
 * 规则的 policy 会被原样写进产物（`renderRule` 就是模板拼接），写错组名时构建不会报错，
 * 客户端却可能整个配置拒绝加载。这里只做「认不认得」的提示，不限制输入——
 * 各方言的内置策略名并不一致，硬约束会挡掉合法写法。
 */
// 各方言的内置策略取并集（小写比对）：Clash/mihomo 的 DIRECT/REJECT/REJECT-DROP/PASS/COMPATIBLE，
// Surge 同名沿用，block 是 Clash 旧版别名，proxy 是「主代理组」的惯用占位名。
const POLICY_BUILTINS = ['direct', 'reject', 'reject-drop', 'proxy', 'pass', 'compatible', 'block'];
const groupNames = computed(() => new Set(groups.value.map((group) => group.name.toLowerCase())));
const policyKnown = (policy: string): boolean => {
  const key = policy.trim().toLowerCase();
  return groupNames.value.has(key) || POLICY_BUILTINS.includes(key);
};

function submitRule(): void {
  if (draft.value.value.trim() === '') return;
  addRule({ type: draft.value.type, value: draft.value.value.trim() }, draft.value.policy);
  draft.value.value = '';
}

function toggleJson(): void {
  jsonOpen.value = !jsonOpen.value;
  if (jsonOpen.value) jsonDraft.value = JSON.stringify(rules.value, null, 2);
}

function applyJson(): void {
  if (importRules(jsonDraft.value)) jsonOpen.value = false;
}

function addMember(name: string): void {
  const group = groups.value.find((item) => item.name === name);
  if (group === undefined) return;
  addGroupMember(group, memberDrafts.value[name] ?? '');
  memberDrafts.value = { ...memberDrafts.value, [name]: '' };
}

function submitGroup(): void {
  if (!addGroup(groupDraft.value)) {
    notify('error', '策略组名称不能为空，也不能与已有组重名');
    return;
  }
  groupDraft.value = '';
}
</script>

<template>
  <div class="page">
    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>内联规则</h2>
          <span class="count">{{ rules.length }}</span>
          <n-tag v-if="rulesDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="spacer"></div>
          <n-button size="small" quaternary @click="toggleJson">
            <template #icon><FileCode2 :size="14" /></template>
            JSON
          </n-button>
          <n-button size="small" :type="rulesDirty ? 'primary' : 'default'" :disabled="!rulesDirty || busy > 0" @click="saveRules()">
            {{ rulesDirty ? '保存规则' : '已保存' }}
          </n-button>
        </div>

        <n-empty v-if="rules.length === 0" description="还没有内联规则" style="padding: 36px 0">
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
                      <!-- 加描边：这个主题里 warning 与 primary 的底色差得不远，光靠颜色读不出来。 -->
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

        <div ref="ruleInputRow" class="row" style="padding: 12px 18px; border-top: 1px solid var(--border)">
          <n-select v-model:value="draft.type" :options="conditionTypes" size="small" style="width: 170px" />
          <n-input v-model:value="draft.value" size="small" placeholder="匹配值，例如 example.com" class="grow" @keyup.enter="submitRule" />
          <n-input v-model:value="draft.policy" size="small" placeholder="DIRECT" style="width: 120px" @keyup.enter="submitRule" />
          <n-button size="small" :disabled="draft.value.trim() === ''" @click="submitRule">
            <template #icon><Plus :size="14" /></template>
            添加
          </n-button>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>策略组</h2>
          <span class="count">{{ groups.length }}</span>
          <n-tag v-if="groupsDirty" size="small" type="warning" :bordered="false">未保存</n-tag>
          <div class="spacer"></div>
          <n-button size="small" :type="groupsDirty ? 'primary' : 'default'" :disabled="!groupsDirty || busy > 0" @click="saveGroups()">
            {{ groupsDirty ? '保存分组' : '已保存' }}
          </n-button>
        </div>

        <n-empty v-if="groups.length === 0" description="还没有策略组，可在下方新建" style="padding: 36px 0">
          <template #icon><Layers :size="28" /></template>
          <n-button size="small" @click="focusInput(groupInputRow)">新建第一个策略组</n-button>
        </n-empty>

        <div v-else class="card-body stack" style="gap: 12px">
          <div
            v-for="(group, index) in groups"
            :key="group.name"
            class="stack"
            style="gap: 7px; padding-bottom: 12px; border-bottom: 1px solid var(--border)"
          >
            <div class="row">
              <span class="strong" style="font-size: 13px">{{ group.name }}</span>
              <n-tag size="small" :bordered="false">{{ group.members.length }} 成员</n-tag>
              <div class="spacer"></div>
              <n-button aria-label="上移" quaternary circle size="tiny" :disabled="index === 0" @click="moveGroup(index, -1)">
                <template #icon><ArrowUp :size="13" /></template>
              </n-button>
              <n-button aria-label="下移" quaternary circle size="tiny" :disabled="index === groups.length - 1" @click="moveGroup(index, 1)">
                <template #icon><ArrowDown :size="13" /></template>
              </n-button>
              <n-button aria-label="删除策略组" quaternary circle size="tiny" type="error" @click="removeGroup(group.name)">
                <template #icon><Trash2 :size="13" /></template>
              </n-button>
            </div>
            <div class="tag-input">
              <n-tag
                v-for="member in group.members"
                :key="member"
                size="small"
                closable
                :bordered="false"
                @close="removeGroupMember(group, member)"
              >
                {{ member }}
              </n-tag>
              <n-input
                v-model:value="memberDrafts[group.name]"
                size="tiny"
                placeholder="+ 添加成员"
                style="width: 132px"
                @keyup.enter="addMember(group.name)"
              />
            </div>
          </div>
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
      </section>
    </div>

    <section v-if="jsonOpen" class="card">
      <div class="card-head">
        <h2>规则 JSON</h2>
        <span class="text-3" style="font-size: 12px">支持 and / or / not 嵌套，应用后再保存</span>
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
