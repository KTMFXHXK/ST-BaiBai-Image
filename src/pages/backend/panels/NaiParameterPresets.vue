<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { settings } from '@/state/settings';
import {
  applyNaiParameterPreset, captureNaiParameters, naiParametersMatch, newNaiParameterPreset,
} from '@/backends/naiParameterPresets';

const active = computed(() => settings.nai.parameterPresets.find(p => p.id === settings.nai.activeParameterPresetId));
const dirty = computed(() => !!active.value && !naiParametersMatch(settings.nai, active.value));
const options = computed(() => [
  { value: '', label: '自定义（当前参数）' },
  ...settings.nai.parameterPresets.map(p => ({ value: p.id, label: p.name })),
]);
const nameMode = ref<'' | 'create' | 'rename'>('');
const nameDraft = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const action = ref<'' | 'overwrite' | 'delete' | 'switch'>('');
const nextId = ref('');
const actionTitle = computed(() => ({ overwrite: '覆盖参数方案', delete: '删除参数方案', switch: '切换参数方案' })[action.value || 'switch']);
const actionText = computed(() => {
  if (action.value === 'overwrite') return `用当前参数覆盖「${active.value?.name}」？`;
  if (action.value === 'delete') return `删除「${active.value?.name}」？当前实际参数会保留。`;
  return '切换会替换当前参数。如需保留当前调整，请取消并先另存为方案或覆盖保存。';
});

function applySelection(id: string) {
  const preset = settings.nai.parameterPresets.find(p => p.id === id);
  if (preset) applyNaiParameterPreset(settings.nai, preset);
  else settings.nai.activeParameterPresetId = '';
}

function select(id: string) {
  if (id === (active.value?.id ?? '')) return;
  if (id && (dirty.value || (!active.value && settings.nai.parameterPresets.length))) {
    nextId.value = id;
    action.value = 'switch';
  } else applySelection(id);
}

function openName(mode: 'create' | 'rename') {
  nameMode.value = mode;
  nameDraft.value = mode === 'rename' ? active.value?.name ?? '' : `参数方案 ${settings.nai.parameterPresets.length + 1}`;
  nextTick(() => { nameInput.value?.focus(); nameInput.value?.select(); });
}

function saveName() {
  const name = nameDraft.value.trim();
  if (!name) return;
  if (nameMode.value === 'create') {
    const preset = newNaiParameterPreset(name, settings.nai);
    settings.nai.parameterPresets.push(preset);
    settings.nai.activeParameterPresetId = preset.id;
  } else if (active.value) active.value.name = name;
  nameMode.value = '';
}

function confirmAction() {
  if (action.value === 'switch') applySelection(nextId.value);
  else if (action.value === 'overwrite' && active.value) active.value.parameters = captureNaiParameters(settings.nai);
  else if (action.value === 'delete' && active.value) {
    settings.nai.parameterPresets = settings.nai.parameterPresets.filter(p => p.id !== active.value!.id);
    settings.nai.activeParameterPresetId = '';
  }
  action.value = '';
}
</script>

<template>
  <div class="parameter-presets bbi-field">
    <div class="bbi-field-head">
      <span class="bbi-field-label">参数方案</span>
      <span class="preset-state" role="status">{{ dirty ? '已修改，未覆盖方案' : active ? '与已保存方案一致' : '当前为自定义参数' }}</span>
    </div>
    <BbiSelect :model-value="active?.id ?? ''" :options="options" aria-label="参数方案" @update:model-value="select" />
    <div class="preset-actions">
      <button class="bbi-btn" type="button" @click="openName('create')">另存为方案</button>
      <button class="bbi-btn" type="button" :disabled="!active || !dirty" @click="action = 'overwrite'">覆盖保存</button>
      <button class="bbi-btn" type="button" :disabled="!active" @click="openName('rename')">改名</button>
      <button class="bbi-btn bbi-btn-danger" type="button" :disabled="!active" @click="action = 'delete'">删除方案</button>
    </div>
    <p class="bbi-field-hint">保存本栏全部参数。可与画师串取相同名称，切换画师串后在这里选择对应参数方案。修改参数会自动保存为当前设置，点击“覆盖保存”才更新方案。</p>
    <ModalMask :open="!!nameMode" @close="nameMode = ''">
      <form class="bbi-modal" role="dialog" aria-modal="true" :aria-label="nameMode === 'create' ? '另存参数方案' : '参数方案改名'" @submit.prevent="saveName" @keydown.esc.stop.prevent="nameMode = ''">
        <header class="bbi-modal-head"><span class="bbi-modal-title">{{ nameMode === 'create' ? '另存参数方案' : '参数方案改名' }}</span></header>
        <label class="bbi-field">
          <span class="bbi-field-label">方案名称</span>
          <input ref="nameInput" v-model="nameDraft" class="bbi-input" aria-label="方案名称" maxlength="100" required />
        </label>
        <footer class="bbi-modal-foot">
          <button class="bbi-btn" type="button" @click="nameMode = ''">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="submit" :disabled="!nameDraft.trim()">保存方案</button>
        </footer>
      </form>
    </ModalMask>
    <ConfirmDialog :open="!!action" :title="actionTitle" :tone="action === 'delete' ? 'danger' : 'primary'" @cancel="action = ''" @confirm="confirmAction">{{ actionText }}</ConfirmDialog>
  </div>
</template>

<style scoped>
.preset-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.preset-state { font-size: 12px; color: var(--bbi-ink-muted); }
.parameter-presets { padding-bottom: 12px; margin-bottom: 16px; border-bottom: 1px solid var(--bbi-line); }
</style>
