<!--
 * @file src/features/settings/ui/TranslationCacheSettings.vue
 * 文件职责：在高级选项原有位置提供紧凑的翻译缓存管理卡，展示用量、开关、清空和可调整的容量与条数上限。
 * 主要内容：从后台读取统计，折叠展示上限编辑，通过字段级补丁保存；保存终态同步忙时暂缓的父级上限更新，保留无外部更新的失败草稿，提供重试及离页保护。
 * 模块边界：界面不访问 IndexedDB、不决定淘汰顺序，不直接修改父组件配置；缓存管理经 services/translation，持久化及跨页同步经 services/config。
 -->
<template>
  <SettingsGroup :title="t('settings.cache.title')" :description="t('settings.cache.description')">
    <div class="translation-cache-settings" data-translation-cache-settings>
      <SettingsItem :label="t('settings.cache.enabled')" :description="t('settings.cache.enabledDescription')">
        <el-switch :model-value="props.config.useCache" :disabled="busy"
          :aria-label="t('settings.cache.enabled')" @change="changeEnabled" />
      </SettingsItem>

      <div class="translation-cache-usage">
        <div class="translation-cache-metrics" aria-live="polite" :aria-busy="loading">
          <div>
            <span>{{ t('settings.cache.size') }}</span>
            <strong data-cache-bytes>{{ stats ? formatBytes(stats.bytes) : '—' }}
              <small>/ {{ formatBytes(props.config.translationCacheMaxBytes) }}</small>
            </strong>
          </div>
          <div>
            <span>{{ t('settings.cache.entries') }}</span>
            <strong data-cache-entries>{{ stats ? formatCount(stats.entries) : '—' }}
              <small>/ {{ formatCount(props.config.translationCacheMaxEntries) }}</small>
            </strong>
          </div>
        </div>
        <div class="translation-cache-actions">
          <el-button size="small" :disabled="busy" :loading="loading" @click="refreshStats">
            {{ t('settings.cache.refresh') }}
          </el-button>
          <el-button size="small" :disabled="busy" :loading="clearing" @click="clearCache">
            {{ t('settings.cache.clear') }}
          </el-button>
        </div>
      </div>
      <p class="translation-cache-estimate" data-cache-estimate
        :title="t(capacity.basedOnUsage ? 'settings.cache.capacityMeasured' : 'settings.cache.capacityAssumed')">
        {{ t('settings.cache.capacity', {entries: formatCount(capacity.entries), pages: formatEstimate(capacity.pages)}) }}
        <span>{{ t('settings.cache.capacityApproximate') }}</span>
        <FieldHelp :content="t('settings.cache.estimate')" />
      </p>

      <details class="translation-cache-limits" data-cache-limits>
        <summary>{{ t('settings.cache.adjustLimits') }}</summary>
        <form class="translation-cache-limit-form" @submit.prevent="saveLimits">
          <label>
            <span>{{ t('settings.cache.maxSize') }}</span>
            <el-input-number v-model="draftMiB" :min="MIN_TRANSLATION_CACHE_MAX_BYTES / MIB"
              :max="MAX_TRANSLATION_CACHE_MAX_BYTES / MIB" :step="1" :precision="0"
              :disabled="busy" :aria-label="t('settings.cache.maxSize')" />
          </label>
          <label>
            <span>{{ t('settings.cache.maxEntries') }}</span>
            <el-input-number v-model="draftEntries" :min="MIN_TRANSLATION_CACHE_MAX_ENTRIES"
              :max="MAX_TRANSLATION_CACHE_MAX_ENTRIES" :step="100" :precision="0"
              :disabled="busy" :aria-label="t('settings.cache.maxEntries')" />
          </label>
          <el-button native-type="submit" type="primary" size="small"
            :disabled="busy || !limitsValid || !limitsChanged" :loading="saving">
            {{ t('common.save') }}
          </el-button>
        </form>
        <p class="translation-cache-note">{{ t('settings.cache.limitPolicy', {
          size: formatBytes(DEFAULT_TRANSLATION_CACHE_MAX_BYTES),
          entries: formatCount(DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES),
        }) }}</p>
      </details>
      <p v-if="errorKey" class="translation-cache-feedback is-error" role="alert">
        {{ t(errorKey) }}
      </p>
      <p v-if="statusKey" class="translation-cache-feedback" role="status">{{ t(statusKey) }}</p>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import browser from 'webextension-polyfill';
import type {Config} from '@/src/core/config/model';
import {
  DEFAULT_TRANSLATION_CACHE_MAX_BYTES,
  DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES,
  MIN_TRANSLATION_CACHE_MAX_BYTES,
  MAX_TRANSLATION_CACHE_MAX_BYTES,
  MIN_TRANSLATION_CACHE_MAX_ENTRIES,
  MAX_TRANSLATION_CACHE_MAX_ENTRIES,
} from '@/src/core/config/translationCache';
import {requestConfigPatch} from '@/src/services/config/store';
import {
  clearManagedTranslationCache,
  estimateTranslationCacheCapacity,
  getTranslationCacheStats,
  type TranslationCacheStats,
} from '@/src/services/translation/cacheManagement';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import FieldHelp from './components/FieldHelp.vue';

const props = defineProps<{config: Config}>();
const {language, t} = useUiI18n();
const MIB = 1024 * 1024;
const stats = ref<TranslationCacheStats | null>(null);
const loading = ref(false);
const clearing = ref(false);
const saving = ref(false);
const busy = computed(() => loading.value || clearing.value || saving.value);
const errorKey = ref('');
const statusKey = ref('');
const draftMiB = ref<number | undefined>(props.config.translationCacheMaxBytes / MIB);
const draftEntries = ref<number | undefined>(props.config.translationCacheMaxEntries);
let disposed = false;
let pendingLimitsRefresh = false;

const limitsValid = computed(() => Number.isInteger(draftMiB.value)
  && Number(draftMiB.value) * MIB >= MIN_TRANSLATION_CACHE_MAX_BYTES
  && Number(draftMiB.value) * MIB <= MAX_TRANSLATION_CACHE_MAX_BYTES
  && Number.isInteger(draftEntries.value)
  && Number(draftEntries.value) >= MIN_TRANSLATION_CACHE_MAX_ENTRIES
  && Number(draftEntries.value) <= MAX_TRANSLATION_CACHE_MAX_ENTRIES);
const limitsChanged = computed(() => Number(draftMiB.value) * MIB !== props.config.translationCacheMaxBytes
  || draftEntries.value !== props.config.translationCacheMaxEntries);
const capacity = computed(() => estimateTranslationCacheCapacity(stats.value, {
  maxBytes: props.config.translationCacheMaxBytes,
  maxEntries: props.config.translationCacheMaxEntries,
}));

watch(() => [props.config.translationCacheMaxBytes, props.config.translationCacheMaxEntries], () => {
  if (saving.value) {
    pendingLimitsRefresh = true;
    return;
  }
  draftMiB.value = props.config.translationCacheMaxBytes / MIB;
  draftEntries.value = props.config.translationCacheMaxEntries;
});

function formatCount(value: number): string {
  return new Intl.NumberFormat(language.value).format(value);
}

function formatEstimate(value: number): string {
  return new Intl.NumberFormat(language.value, {maximumFractionDigits: 2}).format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${formatCount(value)} B`;
  const unit = value < MIB ? 'KiB' : 'MiB';
  const amount = value / (value < MIB ? 1024 : MIB);
  return `${new Intl.NumberFormat(language.value, {maximumFractionDigits: 2}).format(amount)} ${unit}`;
}

async function readStats(): Promise<void> {
  loading.value = true;
  try {
    const snapshot = await getTranslationCacheStats();
    if (!disposed) stats.value = snapshot;
  } catch {
    if (!disposed) {
      stats.value = null;
      errorKey.value = 'settings.cache.readFailed';
    }
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function refreshStats(): Promise<void> {
  if (busy.value || disposed) return;
  errorKey.value = '';
  statusKey.value = '';
  await readStats();
}

async function clearCache(): Promise<void> {
  if (busy.value || disposed) return;
  clearing.value = true;
  errorKey.value = '';
  statusKey.value = '';
  try {
    await clearManagedTranslationCache();
    if (disposed) return;
    statusKey.value = 'settings.cache.cleared';
    await readStats();
  } catch {
    if (!disposed) errorKey.value = 'settings.cache.clearFailed';
  } finally {
    if (!disposed) clearing.value = false;
  }
}

async function persistPatch(patch: Partial<Config>): Promise<void> {
  saving.value = true;
  errorKey.value = '';
  statusKey.value = '';
  try {
    await requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime));
    if (disposed) return;
    statusKey.value = 'settings.cache.saved';
    await readStats();
  } catch {
    if (!disposed) errorKey.value = 'settings.cache.saveFailed';
  } finally {
    if (!disposed) {
      saving.value = false;
      // 输入在保存期间禁用；被暂缓的父级权威更新应在终态同步一次。
      // 没有外部更新时保留失败的用户草稿，便于原值重试。
      if (pendingLimitsRefresh) {
        pendingLimitsRefresh = false;
        draftMiB.value = props.config.translationCacheMaxBytes / MIB;
        draftEntries.value = props.config.translationCacheMaxEntries;
      }
    }
  }
}

async function changeEnabled(value: string | number | boolean): Promise<void> {
  if (busy.value || disposed || typeof value !== 'boolean') return;
  await persistPatch({useCache: value});
}

async function saveLimits(): Promise<void> {
  if (busy.value || disposed || !limitsValid.value || !limitsChanged.value) return;
  await persistPatch({
    translationCacheMaxBytes: Number(draftMiB.value) * MIB,
    translationCacheMaxEntries: Number(draftEntries.value),
  });
}

onMounted(() => { void refreshStats(); });
onUnmounted(() => { disposed = true; });
</script>

<style scoped>
.translation-cache-usage {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 16px 20px 8px;
  border-top: 1px solid var(--line);
}
.translation-cache-metrics { display: flex; flex-wrap: wrap; gap: 12px 32px; min-width: 0; }
.translation-cache-metrics > div { display: grid; gap: 5px; }
.translation-cache-metrics span { color: var(--muted); font-size: 12px; }
.translation-cache-metrics strong { color: var(--ink); font-size: 15px; font-variant-numeric: tabular-nums; }
.translation-cache-metrics small { color: var(--muted); font-size: 12px; font-weight: 400; }
.translation-cache-actions { display: flex; align-items: center; }
.translation-cache-estimate { display: flex; align-items: center; flex-wrap: wrap; margin: 0; padding: 0 20px 12px; color: var(--ink); font-size: 12px; line-height: 1.6; }
.translation-cache-estimate span { margin-left: 6px; color: var(--muted); font-size: 11px; }
.translation-cache-note { margin: 0; padding: 0 20px 14px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.translation-cache-limits { border-top: 1px solid var(--line); }
.translation-cache-limits summary { padding: 14px 20px; color: var(--ink); font-size: 13px; cursor: pointer; }
.translation-cache-limits summary:focus-visible { outline: 2px solid var(--brand); outline-offset: -3px; }
.translation-cache-limit-form { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 14px; padding: 14px 20px 12px; }
.translation-cache-limit-form label { display: grid; gap: 7px; min-width: 0; }
.translation-cache-limit-form label > span { color: var(--muted); font-size: 12px; }
.translation-cache-limit-form :deep(.el-input-number) { width: 170px; max-width: 100%; }
.translation-cache-feedback { margin: 0; padding: 0 20px 14px; color: var(--brand-strong); font-size: 12px; line-height: 1.6; }
.translation-cache-feedback.is-error { color: var(--el-color-danger); }
@media (max-width: 480px) {
  .translation-cache-usage { gap: 12px; padding: 14px 12px 8px; }
  .translation-cache-metrics { gap: 12px 20px; }
  .translation-cache-limit-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-right: 12px; padding-left: 12px; }
  .translation-cache-limit-form :deep(.el-input-number) { width: 100%; }
  .translation-cache-limit-form > .el-button { justify-self: start; }
  .translation-cache-note, .translation-cache-feedback, .translation-cache-estimate { padding-right: 12px; padding-left: 12px; }
}
</style>
