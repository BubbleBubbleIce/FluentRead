<!--
 * @file src/features/settings/ui/services/RequestHeaderSettings.vue
 * 文件职责：在 AI 服务接口兼容区域编辑全局的按域名请求头移除名单。
 * 主要内容：默认空名单、域名校验、独立 Origin/Referer 开关、删除与自动保存；不支持的运行环境提供明确说明。
 * 模块边界：只修改父级配置，由既有配置 store 持久化和后台 DNR 安装；不读取密钥、不直接发起连接测试。
 -->
<template>
  <div class="connection-field" data-testid="request-header-rules">
    <div class="connection-field-label"><strong>{{ t('settings.headers.title') }}</strong><FieldHelp :content="t('settings.headers.help')" /></div>
    <div class="connection-field-control">
      <p v-if="!supported" class="provider-field-help">{{ t('settings.headers.unsupported') }}</p>
      <template v-else>
        <div class="fluentread-header-add">
          <el-input :model-value="domain" :onUpdate:modelValue="actions.domain" :aria-label="t('settings.headers.domain')" placeholder="api.example.com" data-testid="request-header-domain" :maxlength="253" :onKeyup="withKeys(actions.add, ['enter'])" />
          <el-button :disabled="!normalizedDomain || config.requestHeaderRules.length >= MAX_REQUEST_HEADER_RULES" data-testid="request-header-add" :onClick="actions.add">{{ t('settings.headers.add') }}</el-button>
        </div>
        <p v-if="domain && !normalizedDomain" class="error-text">{{ t('settings.headers.invalid') }}</p>
        <div v-for="rule in config.requestHeaderRules" :key="rule.domain" class="fluentread-header-rule" :data-header-rule-domain="rule.domain">
          <strong>{{ rule.domain }}</strong>
          <div class="fluentread-header-controls">
            <el-checkbox :model-value="rule.removeOrigin" :onUpdate:modelValue="actions.flag.bind(null, rule.domain, 'removeOrigin')" :aria-label="t('settings.headers.origin')">{{ t('settings.headers.origin') }}</el-checkbox>
            <el-checkbox :model-value="rule.removeReferer" :onUpdate:modelValue="actions.flag.bind(null, rule.domain, 'removeReferer')" :aria-label="t('settings.headers.referer')">{{ t('settings.headers.referer') }}</el-checkbox>
            <el-button link type="danger" :aria-label="t('settings.headers.removeDomain', {domain: rule.domain})" :onClick="actions.remove.bind(null, rule.domain)">{{ t('settings.headers.remove') }}</el-button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
<script setup lang="ts">
import {computed, ref, watch, withKeys} from 'vue';
import {ElButton, ElCheckbox, ElInput} from 'element-plus';
import 'element-plus/es/components/checkbox/style/css';
import browser from 'webextension-polyfill';
import {useSettingsActionContext} from '../../model/useSettingsActionContext';
import type {Config} from '@/src/core/config/model';
import {MAX_REQUEST_HEADER_RULES, normalizeRequestHeaderDomain} from '@/src/core/config/requestHeaders';
import {useUiI18n} from '@/src/ui/i18n';
import FieldHelp from '../components/FieldHelp.vue';
const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t} = useUiI18n();
const domain = ref('');
const normalizedDomain = computed(() => normalizeRequestHeaderDomain(domain.value));
const supported = Boolean(browser.declarativeNetRequest?.updateDynamicRules);
const {active, capture} = useSettingsActionContext(() => props.active !== false, () => [props.config]);
const actions = computed(() => {
    const current = capture();
    return {domain: (value: unknown) => {if (current() && typeof value === 'string') domain.value = value;}, add: () => {if (current()) add();}, remove: (host: string) => {if (current()) remove(host);},
        flag: (host: string, key: 'removeOrigin' | 'removeReferer', value: unknown) => {
            if (!current() || !supported || typeof value !== 'boolean') return;
            const rule = props.config.requestHeaderRules.find(rule => rule.domain === host);
            if (rule) rule[key] = value;
        }};
});
watch(() => [active.value, props.config], () => {domain.value = '';}, {flush: 'sync'});
function add() {
    if (!active.value || !supported) return;
    const host = normalizedDomain.value;
    if (!host || props.config.requestHeaderRules.length >= MAX_REQUEST_HEADER_RULES) return;
    if (!props.config.requestHeaderRules.some(rule => rule.domain === host)) {
        props.config.requestHeaderRules.push({domain: host, removeOrigin: true, removeReferer: false});
    }
    domain.value = '';
}
function remove(host: string) {
    if (!active.value || !supported) return;
    props.config.requestHeaderRules = props.config.requestHeaderRules.filter(rule => rule.domain !== host);
}
</script>
<style scoped>
.fluentread-header-add, .fluentread-header-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.fluentread-header-add .el-input { flex: 1; min-width: 160px; }
.fluentread-header-rule { margin-top: 12px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.fluentread-header-rule > strong { display: block; overflow-wrap: anywhere; }
.fluentread-header-controls .el-checkbox { margin-right: 8px; }
</style>
