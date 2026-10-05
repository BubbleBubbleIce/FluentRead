<!--
 * @file src/features/settings/ui/services/RequestLimitFields.vue
 * 文件职责：在全局与服务设置中复用请求限制的三项数值，每项各占一行，沿用所在页面的行式表单与 Element Plus 外观。
 * 主要内容：显示并发、每秒和每分钟限制，只提交合法整数，保留输入过程中的空值而不覆盖已保存配置；全局页用“标题 + 说明、控件靠右”的设置行，服务页（service 布局）用“左标签带提示、右侧紧凑输入框”的连接字段行；继承状态切换时重建数字控件，避免当前组件版本保留过期的 aria-disabled。
 * 模块边界：本组件只校验并发与频率的表单值并发出更新，不选择配置作用域、不持久化，也不执行请求。
 -->
<template>
  <div class="request-limit-fields" :class="{ 'is-service': layout === 'service' }">
    <SettingsItem
      v-for="field in fields" :key="field.key" :label="translateLegacy(field.label)"
      :description="layout === 'service' ? '' : helpOf(field)"
    >
      <template v-if="layout === 'service'" #copy>
        <div class="request-limit-label"><strong>{{ translateLegacy(field.label) }}</strong><FieldHelp :content="helpOf(field)" /></div>
      </template>
      <div class="request-limit-number">
        <el-input-number
          :key="`${field.key}-${disabled ? 'inherit' : 'custom'}`"
          :model-value="modelValue[field.key]" :disabled="disabled || !active" :min="field.min" :max="field.max" :step="1" :controls="false"
          :aria-label="translateLegacy(field.label)" :onChange="actions.update.bind(null, field.key)"
        />
      </div>
    </SettingsItem>
  </div>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import {useSettingsActionContext} from '../../model/useSettingsActionContext';
import FieldHelp from '../components/FieldHelp.vue';
import type {TranslationRequestLimits} from '@/src/core/config/requestLimits';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsItem from '../components/SettingsItem.vue';

const props = withDefaults(defineProps<{modelValue: TranslationRequestLimits; active?: boolean; disabled?: boolean; layout?: 'settings' | 'service'}>(), {active: true, disabled: false, layout: 'settings'});
const emit = defineEmits<{'update:model-value': [value: TranslationRequestLimits]}>();
const {translateLegacy, t} = useUiI18n();
const {active, capture} = useSettingsActionContext(() => props.active !== false, () => [props.modelValue, props.disabled]);
const actions = computed(() => {
  const current = capture();
  return {update: (key: keyof TranslationRequestLimits, value: number | undefined) => {if (current()) update(key, value);}};
});
const fields = [
  {key: 'maxConcurrentTranslations', label: '翻译并发数', min: 1, max: 100, help: '设置同时执行的翻译任务上限；增加并发可能加快翻译，也会增加资源占用，并受服务限流约束'},
  {key: 'translationRequestsPerSecond', label: '每秒最多请求数', min: 0, max: 1000, help: '设为 0 表示不限速'},
  {key: 'translationRequestsPerMinute', label: '每分钟最多请求数', min: 0, max: 10000, help: '设为 0 表示不限速'},
] as const;

function helpOf(field: typeof fields[number]): string {
  return field.key === 'maxConcurrentTranslations' ? translateLegacy(field.help) : t('settings.requestLimits.rateHelp');
}

function update(key: keyof TranslationRequestLimits, value: number | undefined): void {
  if (!active.value || props.disabled) return;
  const field = fields.find(field => field.key === key);
  if (!field) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.min || value > field.max) return;
  emit('update:model-value', {...props.modelValue, [key]: value});
}
</script>

<style scoped>
.request-limit-fields { display: grid; min-width: 0; }
.request-limit-fields :deep(.settings-item + .settings-item) { border-top: 1px solid var(--line); }
.request-limit-number { width: 132px; max-width: 100%; min-width: 0; }
.request-limit-number :deep(.el-input-number) { width: 100%; }
.request-limit-label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }

/* 服务配置页：与“连接与密钥”等连接字段行使用同一套列宽、行高和分隔线。 */
.request-limit-fields.is-service :deep(.settings-item) {
  grid-template-columns: 140px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-height: 0;
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.request-limit-fields.is-service :deep(.settings-item-copy) { justify-content: center; min-height: 38px; }
.request-limit-fields.is-service :deep(.settings-item-control) { justify-content: flex-start; }
.request-limit-fields.is-service :deep(.el-input__wrapper) { min-height: 38px; border-radius: 10px; }
@container (max-width: 600px) {
  .request-limit-fields.is-service :deep(.settings-item) { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .request-limit-fields.is-service :deep(.settings-item-copy) { min-height: 24px; }
}
</style>
