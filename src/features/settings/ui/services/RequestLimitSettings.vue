<!--
 * @file src/features/settings/ui/services/RequestLimitSettings.vue
 * 文件职责：在翻译服务设置中编辑当前模型或整个服务的请求限制，并展示实际生效的一组数值。
 * 主要内容：与服务页其他页签一致，按“左标签、右控件”逐行排列：作用范围与限制方式用分段按钮直接切换，下方三项数值各占一行；作用范围下注明当前模型名或“所有模型合计”，用限制方式切换沿用上一级与整组自定义，保留停用的自定义值，按实际模型隔离设置，窄容器改为上下排列。
 * 模块边界：只更新传入 Config 的请求限制映射，持久化由设置页现有订阅与保存队列处理；调度计数及真实网络请求由 services 层负责。
 -->
<template>
  <div class="request-limit-settings" data-testid="request-limit-settings" :data-scope="scope" :data-model="model || ''">
    <div v-if="model" class="connection-field request-limit-scope">
      <div class="connection-field-label"><strong>{{ t('settings.requestLimits.scope') }}</strong></div>
      <div class="connection-field-control">
        <SegmentedControl
          compact :label="t('settings.requestLimits.scope')" :options="scopeOptions" data-request-limit-scope
          :model-value="scope" :disabled="!active" :onUpdate:modelValue="actions.scope"
        />
        <small class="request-limit-hint" data-request-limit-scope-hint>{{ scope === 'model' ? t('settings.organization.modelScope', {model}) : t('settings.requestLimits.serviceScope') }}</small>
      </div>
    </div>
    <div class="connection-field request-limit-inheritance">
      <div class="connection-field-label"><strong>{{ t('settings.requestLimits.mode') }}</strong></div>
      <div class="connection-field-control">
        <SegmentedControl
          compact :label="t('settings.requestLimits.mode')" :options="modeOptions" data-request-limit-mode
          :model-value="preference?.enabled ? 'custom' : 'inherit'" :disabled="!active" :onUpdate:modelValue="actions.mode"
        />
        <small v-if="scope === 'model' && servicePreference?.enabled" class="request-limit-hint request-limit-cap">{{ t('settings.requestLimits.serviceCap') }}</small>
      </div>
    </div>
    <RequestLimitFields layout="service" :active="active" :model-value="preference?.enabled ? preference.limits : inherited" :disabled="!preference?.enabled" :onUpdate:modelValue="actions.limits" />
  </div>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import {useSettingsActionContext} from '../../model/useSettingsActionContext';
import type {Config} from '@/src/core/config/model';
import {
  getModelRequestLimitPreference, getServiceRequestLimitPreference, normalizeTranslationRequestLimits,
  withModelRequestLimit, withServiceRequestLimit, type RequestLimitPreference, type TranslationRequestLimits,
} from '@/src/core/config/requestLimits';
import {useUiI18n} from '@/src/ui/i18n';
import SegmentedControl from '../components/SegmentedControl.vue';
import RequestLimitFields from './RequestLimitFields.vue';

const props = withDefaults(defineProps<{config: Config; service: string; active?: boolean; model?: string}>(), {active: true});
const {t} = useUiI18n();
const scope = ref<'model' | 'service'>(props.model ? 'model' : 'service');
watch(() => [props.config, props.service, props.model], () => { scope.value = props.model ? 'model' : 'service'; }, {flush: 'sync'});
const {active, capture} = useSettingsActionContext(() => props.active !== false, () => [props.config, props.service, props.model, scope.value]);
const actions = computed(() => {
  const current = capture();
  return {scope: (value: unknown) => {if (current() && (value === 'service' || value === 'model' && props.model)) scope.value = value;},
    mode: (value: unknown) => {if (current() && (value === 'inherit' || value === 'custom')) setFollowing(value === 'inherit');},
    limits: (limits: TranslationRequestLimits) => {if (current()) setLimits(limits);}};
});
const servicePreference = computed(() => getServiceRequestLimitPreference(props.config.serviceRequestLimits, props.service));
const preference = computed(() => scope.value === 'model'
  ? getModelRequestLimitPreference(props.config.modelRequestLimits, props.service, props.model || '')
  : servicePreference.value);
const inherited = computed(() => scope.value === 'model' && servicePreference.value?.enabled
  ? servicePreference.value.limits : normalizeTranslationRequestLimits(props.config));
const followLabel = computed(() => t(scope.value === 'model' && servicePreference.value?.enabled
  ? 'settings.requestLimits.followService' : 'settings.requestLimits.followGlobal'));
const scopeOptions = computed(() => [
  {value: 'model', label: t('settings.requestLimits.currentModel')},
  {value: 'service', label: t('settings.requestLimits.entireService')},
]);
const modeOptions = computed(() => [
  {value: 'inherit', label: followLabel.value},
  {value: 'custom', label: t('settings.requestLimits.custom')},
]);

function save(next: RequestLimitPreference): void {
  if (!active.value) return;
  if (scope.value === 'model' && props.model) {
    props.config.modelRequestLimits = withModelRequestLimit(props.config.modelRequestLimits, props.service, props.model, next);
  } else {
    props.config.serviceRequestLimits = withServiceRequestLimit(props.config.serviceRequestLimits, props.service, next);
  }
}
function setFollowing(following: boolean): void {
  save({enabled: !following, limits: {...(preference.value?.limits || inherited.value)}});
}
function setLimits(limits: TranslationRequestLimits): void {
  if (!preference.value?.enabled) return;
  save({enabled: true, limits});
}
</script>

<style scoped>
.request-limit-settings { display: grid; min-width: 0; }
.connection-field { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: start; gap: 16px; min-width: 0; padding: 14px 0; }
.connection-field + .connection-field { border-top: 1px solid var(--line); }
.connection-field-label { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-height: 38px; min-width: 0; }
.connection-field-label strong { color: var(--ink); font-size: 13px; font-weight: 550; line-height: 1.5; }
.connection-field-control { display: grid; gap: 6px; width: 100%; max-width: 360px; min-width: 0; }
.request-limit-hint { display: block; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
@container (max-width: 600px) {
  .connection-field { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .connection-field-label { min-height: 24px; }
  .connection-field-control { max-width: none; }
}
</style>
