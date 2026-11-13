<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NEmpty, NInput, NRadioButton, NRadioGroup, NSelect, NTag } from 'naive-ui';
import { ExternalLink, Search } from 'lucide-vue-next';
import ClientIcon from '../components/ClientIcon.vue';
import { clientNameOf, evidence } from '../workspace';

const search = ref('');
const value = ref('');
const clientTarget = ref('');

const VALUE_LABELS: Record<string, string> = {
  support: '支持',
  passthrough: '透传',
  unverified: '待核实',
  reject: '不支持',
};

const VALUE_TONE: Record<string, 'success' | 'info' | 'warning' | 'error' | 'default'> = {
  support: 'success',
  passthrough: 'info',
  unverified: 'warning',
  reject: 'error',
};

const targets = computed(() => [...new Set(evidence.value.map((item) => item.target))].sort());
const targetOptions = computed(() => [
  { label: '全部客户端', value: '' },
  ...targets.value.map((item) => ({ label: clientNameOf(item), value: item })),
]);

const valueCounts = computed(() => {
  const map = new Map<string, number>();
  for (const item of evidence.value) map.set(item.value, (map.get(item.value) ?? 0) + 1);
  return map;
});

const list = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return evidence.value.filter((item) => {
    if (value.value !== '' && item.value !== value.value) return false;
    if (clientTarget.value !== '' && item.target !== clientTarget.value) return false;
    if (needle.length === 0) return true;
    return (
      item.subject.toLowerCase().includes(needle) ||
      item.note.toLowerCase().includes(needle) ||
      item.scope.toLowerCase().includes(needle) ||
      item.target.toLowerCase().includes(needle)
    );
  });
});

function sourceOf(item: { source: string }): string {
  const first = item.source.split(',')[0] ?? '';
  return first.trim();
}
</script>

<template>
  <div class="page">
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">核实条目</div>
        <div class="stat-value">{{ evidence.length }}<small>条</small></div>
        <div class="stat-foot">覆盖 {{ targets.length }} 个客户端</div>
      </div>
      <div class="stat">
        <div class="stat-label">已核实支持</div>
        <div class="stat-value">{{ valueCounts.get('support') ?? 0 }}<small>条</small></div>
        <div class="stat-foot">有官方文档依据</div>
      </div>
      <div class="stat">
        <div class="stat-label">透传</div>
        <div class="stat-value">{{ valueCounts.get('passthrough') ?? 0 }}<small>条</small></div>
        <div class="stat-foot">原样保留，不改写字段</div>
      </div>
      <div class="stat">
        <div class="stat-label">待核实</div>
        <div class="stat-value">{{ valueCounts.get('unverified') ?? 0 }}<small>条</small></div>
        <div class="stat-foot">未取得依据，按拒绝处理</div>
      </div>
    </div>

    <section class="card">
      <div class="card-head filters">
        <h2>能力清单</h2>
        <n-radio-group v-model:value="value" size="small">
          <n-radio-button value="">全部</n-radio-button>
          <n-radio-button v-for="entry in ['support', 'passthrough', 'unverified', 'reject']" :key="entry" :value="entry">
            {{ VALUE_LABELS[entry] }} {{ valueCounts.get(entry) ?? 0 }}
          </n-radio-button>
        </n-radio-group>
        <span class="badge outline">{{ list.length }} 条</span>
        <div class="spacer"></div>
        <n-input v-model:value="search" size="small" placeholder="搜索协议、特性或备注" clearable style="flex: 1; min-width: 150px; max-width: 300px">
          <template #prefix><Search :size="14" /></template>
        </n-input>
        <n-select v-model:value="clientTarget" :options="targetOptions" size="small" style="width: 168px" />
      </div>

      <n-empty v-if="list.length === 0" description="没有匹配的条目" style="padding: 40px 0">
        <template #icon><Search :size="30" /></template>
        <template #extra>
          <n-button size="small" quaternary @click="search = ''; value = ''; clientTarget = ''">清除筛选</n-button>
        </template>
      </n-empty>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 120px">客户端</th>
              <th class="col-optional" style="width: 96px">范围</th>
              <th class="col-wide-only" style="width: 190px">对象</th>
              <th style="width: 90px">结论</th>
              <th class="col-optional">依据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in list" :key="index">
              <td>
                <span class="client-pill">
                  <ClientIcon :id="item.target" size="xs" />
                  <span>{{ clientNameOf(item.target) }}</span>
                </span>
                <div class="addr-mobile">{{ item.subject }}<template v-if="item.scope !== 'node'"> · {{ item.scope }}</template></div>
                <div class="addr-mobile" style="white-space: normal; line-height: 1.5">{{ item.note }}</div>
              </td>
              <td class="text-3 col-optional" style="font-size: 12px">{{ item.scope }}</td>
              <td class="mono col-wide-only">{{ item.subject }}</td>
              <td>
                <n-tag size="small" :type="VALUE_TONE[item.value] ?? 'default'" :bordered="false">
                  {{ VALUE_LABELS[item.value] ?? item.value }}
                </n-tag>
              </td>
              <td class="col-optional">
                <div class="text-2" style="font-size: 12.5px">{{ item.note }}</div>
                <a
                  v-if="sourceOf(item).startsWith('http')"
                  :href="sourceOf(item)"
                  target="_blank"
                  rel="noreferrer noopener"
                  class="mono text-3"
                  style="font-size: 11px; display: inline-flex; align-items: center; gap: 3px; word-break: break-all; margin-top: 2px"
                >
                  {{ sourceOf(item) }}
                  <ExternalLink :size="10" />
                </a>
                <div v-else class="mono text-3" style="font-size: 11px; word-break: break-all">{{ item.source }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
