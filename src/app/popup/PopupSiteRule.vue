<!--
 * @file src/app/popup/PopupSiteRule.vue
 * 文件职责：渲染 Popup 的当前网站规则模块，使该区域既能保持默认嵌套视觉，也能作为独立模块参与用户布局排序。
 * 主要内容：紧凑展示始终翻译和禁用扩展两个开关，不显示域名；把操作意图绑定当前页面、配置、开关及活跃会话后交回 Popup composition root。
 * 模块边界：组件不读取标签页、不修改配置、不发送浏览器消息；域名解析、状态计算、保存与即时页面通知仍由 PopupApp 负责。
-->
<template>
  <div class="site-rule-row" data-popup-module="siteRule" :title="!props.supported ? t('popup.unsupportedPage') : undefined">
    <div class="site-rule-actions">
      <button
        class="site-rule-button"
        :class="{ enabled: props.alwaysTranslated, 'global-enabled': props.autoTranslate }"
        data-setting="always-translate-site"
        :data-site-domain="props.domain"
        :data-enabled="props.alwaysTranslated"
        type="button"
        role="switch"
        :aria-checked="props.alwaysTranslated"
        :aria-label="props.switchLabel"
        :disabled="!props.supported || props.translating || props.autoTranslate || props.extensionDisabled"
        :onClick="actions.always"
      >
        <span>{{ props.autoTranslate ? '全局自动翻译' : props.alwaysTranslated ? '始终翻译已开启' : '始终翻译此网站' }}</span>
        <i aria-hidden="true" />
      </button>
      <button
        class="site-rule-button site-disable-rule-button"
        :class="{ enabled: props.extensionDisabled }"
        data-setting="disable-extension-site"
        :data-site-domain="props.domain"
        :data-enabled="props.extensionDisabled"
        type="button"
        role="switch"
        :aria-checked="props.extensionDisabled"
        :aria-label="props.extensionSwitchLabel"
        :disabled="!props.supported || props.translating"
        :onClick="actions.disabled"
      >
        <span>{{ props.extensionDisabled ? '已禁用扩展' : '在此网站禁用扩展' }}</span>
        <i aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import {computed} from 'vue';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';
const {t} = useUiI18n();
const props = withDefaults(defineProps<{
  active?: boolean
  context?: unknown
  domain: string
  supported: boolean
  alwaysTranslated: boolean
  extensionDisabled: boolean
  autoTranslate: boolean
  translating: boolean
  switchLabel: string
  extensionSwitchLabel: string
}>(), {active: true})

const emit = defineEmits<{
  'set-always-translated': [enabled: boolean]
  'set-extension-disabled': [enabled: boolean]
}>()
const {capture} = useSettingsActionContext(() => props.active && props.supported,
  () => [props.context, props.domain, props.alwaysTranslated, props.extensionDisabled, props.autoTranslate, props.translating]);
const actions = computed(() => {
  const current = capture(), always = !props.alwaysTranslated, disabled = !props.extensionDisabled;
  return {always: () => {if (current() && !props.translating && !props.autoTranslate && !props.extensionDisabled) emit('set-always-translated', always)},
    disabled: () => {if (current() && !props.translating) emit('set-extension-disabled', disabled)}};
});
</script>
