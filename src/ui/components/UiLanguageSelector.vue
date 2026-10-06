<!--
 * @file src/ui/components/UiLanguageSelector.vue
 * 文件职责：提供一个在设置页和其他扩展页面保持统一外观的界面语言选择器。
 * 主要内容：用 FluentRead 风格的 Element Plus 控件展示缓存的多语言选项、即时切换文案并通过共享配置 patch 持久化；保存期间锁定交互，拒绝已关闭或失活的旧事件，失败时保留原语言并给出可访问的错误反馈。
 * 模块边界：组件不直接读取 storage，语言状态和持久化由 src/ui/i18n.ts 统一协调；语言显示规则仍由 core/i18n 提供。
 -->
<template>
  <div class="ui-language-selector" :class="{ compact }">
    <span v-if="!compact" class="ui-language-label">{{ t('language.selectorLabel') }}</span>
    <ElSelect
      :key="controlRevision"
      class="ui-language-select"
      :model-value="language"
      :disabled="!selectionContext.active.value"
      :aria-busy="saving"
      data-testid="ui-language-select"
      :aria-label="t('language.selectorLabel')"
      :title="t('language.selectorLabel')"
      :placeholder="t('language.selectorLabel')"
      popper-class="ui-language-select-popper"
      fit-input-width
      :onChange="selectorActions.change"
      :onVisibleChange="selectorActions.visible"
    >
      <ElOption
        v-for="option in languageOptions"
        :key="option.value"
        :value="option.value"
        :label="option.label"
      >
        <span class="ui-language-option">
          <span>{{ option.label }}</span>
        </span>
      </ElOption>
    </ElSelect>
    <span v-if="errorMessage" class="ui-language-error" role="status" aria-live="polite">{{ errorMessage }}</span>
  </div>
</template>

<script setup lang="ts">
import {ElOption} from 'element-plus';
import ElSelect from './UiSelect.vue';
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {getUiLanguageDisplayLabel, UI_LANGUAGE_OPTIONS, type UiLanguage} from '@/src/core/i18n';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';

const props = withDefaults(defineProps<{
  compact?: boolean;
  active?: boolean;
  disabled?: boolean;
}>(), {
  compact: false,
  active: true,
  disabled: false,
});

const {language, t, setLanguage} = useUiI18n();
const errorMessage = ref('');
const saving = ref(false);
const menuOpen = ref(false);
const pageExited = ref(false);
const controlRevision = ref(0);
const context = useSettingsActionContext(() => props.active && !props.disabled && !pageExited.value, () => []);
const selectionContext = useSettingsActionContext(() => context.active.value && !saving.value,
  () => [context.revision.value, language.value, menuOpen.value]);
watch(context.active, () => {
  controlRevision.value += 1;
  menuOpen.value = false;
  if (!context.active.value) errorMessage.value = '';
}, {flush: 'sync'});
watch(saving, value => {if (value) menuOpen.value = false;}, {flush: 'sync'});
watch(language, () => {errorMessage.value = '';}, {flush: 'sync'});
const selectorActions = computed(() => {
  const current = selectionContext.capture();
  return {
    change: (value: unknown) => {if (current()) return handleChange(value);},
    visible: (value: boolean) => {if (current()) menuOpen.value = value;},
  };
});
function buildLanguageOptions(language: UiLanguage) {
  return UI_LANGUAGE_OPTIONS.map(option => ({value: option.value, label: getUiLanguageDisplayLabel(option.value, language)}));
}
const languageOptions = computed(() => buildLanguageOptions(language.value));

async function handleChange(value: unknown): Promise<void> {
  const option = UI_LANGUAGE_OPTIONS.find(item => item.value === value);
  if (!selectionContext.active.value || !menuOpen.value || !option || option.value === language.value) return;
  const current = context.capture();
  saving.value = true;
  errorMessage.value = '';
  try {
    await setLanguage(option.value);
  } catch {
    if (current()) errorMessage.value = t('language.saveFailed');
  } finally {
    saving.value = false;
  }
}
function handlePageHide(): void {pageExited.value = true;}
window.addEventListener('pagehide', handlePageHide);
onBeforeUnmount(() => window.removeEventListener('pagehide', handlePageHide));
</script>

<style scoped>
.ui-language-selector {
  display: flex;
  width: 100%;
  max-width: 360px;
  min-width: 0;
  align-items: center;
  gap: 8px;
  color: var(--muted, #687287);
  font-size: 11px;
}

.ui-language-selector.compact {
  min-width: 0;
}

.ui-language-select {
  width: 100%;
  min-width: 0;
}

.ui-language-label {
  flex: 0 0 auto;
  font-weight: 700;
  white-space: nowrap;
}

.ui-language-error {
  color: #c52f58;
  font-size: 10px;
}


.ui-language-option {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.ui-language-option > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 700px) {
  .ui-language-selector:not(.compact) {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
