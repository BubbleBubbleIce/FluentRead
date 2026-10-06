<!--
 @file src/app/popup/PopupLanguageSelect.vue
 文件职责：隔离 Popup 语言选择器的渲染，使关闭的菜单不创建完整语言选项 DOM。
 主要内容：关闭时显示已保存语言在当前界面语言中的主名称，菜单和提示保留完整多语名称；保留 UiSelect 的搜索、键盘与定位及语言文案缓存，拒绝已关闭、禁用、失活或旧选择上下文的事件。
 模块边界：不读写配置或浏览器状态，选择结果通过 v-model 交给 PopupApp 持久化。
-->
<template>
  <UiSelect
    :key="controlRevision"
    :model-value="modelValue"
    :disabled="!context.active.value"
    :title="selectedLabel"
    filterable
    :show-search-icon="false"
    :persistent="false"
    :onUpdate:modelValue="selectActions.choose"
    :onVisibleChange="selectActions.visible"
  >
    <template #label><span data-i18n-ignore>{{ menuOpen ? t('select.search') : selectedLabel.split(' / ')[0] }}</span></template>
    <ElOption v-for="item in languageOptions" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
  </UiSelect>
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {ElOption} from 'element-plus';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';

const props = defineProps<{modelValue: string; source?: boolean; disabled?: boolean}>();
const emit = defineEmits<{(event: 'update:modelValue', value: string): void}>();
const {language, t, translateLegacy} = useUiI18n();
const menuOpen = ref(false);
const pageExited = ref(false);
const controlRevision = ref(0);
const choices = computed(() => props.source ? options.from : options.to);
const context = useSettingsActionContext(() => !props.disabled && !pageExited.value,
  () => [Boolean(props.source), props.modelValue, menuOpen.value]);
// 只在控件所属范围变化时重建，正常选择或外部值同步保留输入焦点和语言列表缓存。
watch(() => [context.active.value, Boolean(props.source)], () => {
  controlRevision.value += 1;
  menuOpen.value = false;
}, {flush: 'sync'});
const selectActions = computed(() => {
  const current = context.capture();
  return {
    choose: (value: string) => {
      if (current() && menuOpen.value && value !== props.modelValue && choices.value.some(item => item.value === value)) {
        emit('update:modelValue', value);
      }
    },
    visible: (value: boolean) => {if (current()) menuOpen.value = value;},
  };
});
function handlePageHide(): void {pageExited.value = true;}
window.addEventListener('pagehide', handlePageHide);
onBeforeUnmount(() => window.removeEventListener('pagehide', handlePageHide));
const label = (item: {value: string; label: string}) => item.value === 'auto'
  ? translateLegacy(item.label)
  : getMultilingualTargetLanguageLabel(item.value, item.label, language.value);
const selectedLabel = computed(() => label(choices.value.find(item => item.value === props.modelValue)
  || {value: props.modelValue, label: props.modelValue}));
const languageOptions = computed(() => choices.value.map(item => ({value: item.value, label: label(item)})));
</script>
