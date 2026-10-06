<!--
 * @file src/features/settings/ui/LocalTtsSettings.vue
 * 文件职责：统一管理在线与本地朗读的来源策略、音色偏好及 Kokoro 模型。
 * 主要内容：先选择在线优先、本地优先、仅在线或仅本地，再显示对应来源的音色与模型管理；切换来源保留隐藏偏好，自动音色不标成固定语言，模型说明只显示一次；下载模型时在说明下方显示真实进度条、百分比和已下载体积，重开设置页也会接上仍在进行的下载。
 * 模块边界：只修改传入的配置副本并调用后台模型管理消息，不执行 TTS 推理，也不直接访问 Offscreen 或缓存存储；下载进度只读取后台转存的变化事件。
 -->
<template>
  <SettingsGroup class="speech-settings" :title="t('settings.experience.speechTitle')" data-testid="speech-settings">
    <SettingsItem class="speech-source-row" :label="t('settings.localTts.source')" :description="modeDescription">
      <SegmentedControl
        v-model="ttsMode"
        :options="modeOptions"
        :label="t('settings.localTts.source')"
      />
    </SettingsItem>

    <SettingsItem v-if="ttsMode !== 'local-only'" :label="t('settings.experience.onlineSpeechTitle')" :help="translateLegacy('留空时根据语言自动尝试免费 Edge 音色；选择多个音色后，朗读失败时按此顺序尝试，无需 API Key')" data-testid="speech-online-voices">
      <el-select v-model="config.selectionTtsVoices" multiple filterable collapse-tags collapse-tags-tooltip :aria-label="translateLegacy('划词翻译备用音色顺序')" :placeholder="translateLegacy('自动按语言选择')">
        <el-option v-for="item in SELECTION_TTS_VOICE_OPTIONS" :key="item.value" :label="`${item.label} · ${item.locale}`" :value="item.value" />
      </el-select>
    </SettingsItem>

    <SettingsItem v-if="ttsMode !== 'online-only'" :label="t('settings.localTts.voice')" data-testid="speech-local-voice">
      <el-select v-model="localVoice" :aria-label="t('settings.localTts.voice')" filterable>
        <el-option
          v-for="option in voiceOptions"
          :key="option.value"
          :label="option.value === 'auto' ? translateLegacy(option.label) : `${translateLegacy(option.label)} · ${option.locale}`"
          :value="option.value"
        />
      </el-select>
    </SettingsItem>

    <div v-if="ttsMode !== 'online-only'" class="local-tts-model-row" data-testid="local-tts-model-row">
      <div class="local-tts-model-copy">
        <div class="local-tts-model-heading">
          <span class="local-tts-model-icon" aria-hidden="true"><Cpu /></span>
          <div>
            <strong>{{ t('settings.localTts.model') }}</strong>
            <small>{{ t('settings.localTts.modelDescription', {size: LOCAL_TTS_MODEL.downloadSizeMb}) }}</small>
          </div>
        </div>
        <DownloadProgress
          v-if="downloading"
          class="local-tts-model-progress"
          :progress="progress"
          :label="t('settings.localTts.statusDownloading')"
          data-testid="local-tts-progress"
        />
        <p v-else class="local-tts-model-status" role="status" aria-live="polite">
          {{ !statusLoaded
            ? t('settings.localTts.statusReading')
            : downloaded
              ? t('settings.localTts.statusReady')
              : t('settings.localTts.statusNotDownloaded') }}
        </p>
      </div>
      <button
        v-if="downloaded"
        type="button"
        class="local-tts-model-action"
        :disabled="removing || downloading || !browserCapabilities.extensionDom"
        data-testid="local-tts-remove"
        :aria-label="t('settings.localTts.remove')"
        @click="removeModel"
      >
        <component :is="removing ? Loading : Delete" :class="{'is-loading': removing}" aria-hidden="true" />
        {{ removing ? t('modelCache.removing') : t('settings.localTts.remove') }}
      </button>
      <button
        v-else
        type="button"
        class="local-tts-model-action"
        :disabled="!statusLoaded || downloading || !browserCapabilities.extensionDom"
        data-testid="local-tts-download"
        :aria-label="t('settings.localTts.download')"
        @click="downloadModel"
      >
        <component :is="downloading ? Loading : Download" :class="{'is-loading': downloading}" aria-hidden="true" />
        {{ downloading ? t('settings.localTts.statusDownloading') : t('settings.localTts.download') }}
      </button>
    </div>

    <p v-if="ttsMode !== 'online-only' && !browserCapabilities.extensionDom" class="local-tts-warning" role="status">{{ t('settings.localTts.unavailable') }}</p>
    <p v-if="errorMessage" class="local-tts-error" role="alert">{{ errorMessage }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, toRef} from 'vue'
import browser from 'webextension-polyfill'
import {Cpu, Delete, Download, Loading} from '@element-plus/icons-vue'
import type {Config} from '@/src/core/config/model'
import {SELECTION_TTS_VOICE_OPTIONS} from '@/src/core/config/selectionTts'
import {
  LOCAL_TTS_MODE_OPTIONS,
  LOCAL_TTS_MODEL,
  LOCAL_TTS_VOICE_OPTIONS,
  LOCAL_TTS_MODEL_STATE_KEY,
  normalizeLocalTtsMode,
  normalizeLocalTtsVoice,
  type LocalTtsMode,
  type LocalTtsVoiceId,
} from '@/src/core/config/localTts'
import {LOCAL_TTS_DOWNLOAD_ID, type DownloadProgress as DownloadProgressValue} from '@/src/core/download/progress'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {watchDownloadProgress} from '@/src/platform/storage/downloadProgress'
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue'
import {useUiI18n} from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
import SegmentedControl from './components/SegmentedControl.vue'

const props = defineProps<{config: Config}>()
const config = toRef(props, 'config')
const {t, translateLegacy} = useUiI18n()

const ttsMode = computed<LocalTtsMode>({
  get: () => normalizeLocalTtsMode(config.value.selectionTtsMode),
  set: (value) => { config.value.selectionTtsMode = normalizeLocalTtsMode(value) },
})
const localVoice = computed<LocalTtsVoiceId>({
  get: () => normalizeLocalTtsVoice(config.value.selectionTtsLocalVoice),
  set: (value) => { config.value.selectionTtsLocalVoice = normalizeLocalTtsVoice(value) },
})
const modeOptions = computed(() => LOCAL_TTS_MODE_OPTIONS.map((option) => ({
  value: option.value,
  label: t(`settings.localTts.${option.value === 'online-first' ? 'onlineFirst' : option.value === 'local-first' ? 'localFirst' : option.value === 'online-only' ? 'onlineOnly' : 'localOnly'}`),
})))
const modeDescription = computed(() => t(`settings.localTts.mode.${ttsMode.value === 'online-first' ? 'onlineFirst' : ttsMode.value === 'local-first' ? 'localFirst' : ttsMode.value === 'online-only' ? 'onlineOnly' : 'localOnly'}Description`))
const voiceOptions = computed(() => LOCAL_TTS_VOICE_OPTIONS.filter((option) => option.value === 'auto' || LOCAL_TTS_MODEL.voices.includes(option.value as never)))
const downloaded = ref(false)
const statusLoaded = ref(false)
// 本页发起的请求与其他页面发起、仍在进行的下载都算“下载中”；后者只能从实时进度事件得知。
const requesting = ref(false)
const observedDownload = ref(false)
const downloading = computed(() => !downloaded.value && (requesting.value || observedDownload.value))
const progress = ref<DownloadProgressValue>()
const removing = ref(false)
const errorMessage = ref('')
let stopWatchingProgress: (() => void) | undefined
let active = true
let generation = 0
let statusReadFailed = false

function readDownloaded(response: unknown): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  const record = response as {downloaded?: unknown; models?: unknown}
  if (record.downloaded === true) return true
  return Array.isArray(record.models)
    && Boolean(record.models[0] && typeof record.models[0] === 'object' && (record.models[0] as {downloaded?: unknown}).downloaded === true)
}

async function refresh(): Promise<void> {
  if (!active || downloading.value || removing.value) return
  const request = ++generation
  if (!browserCapabilities.extensionDom) {
    statusLoaded.value = true
    return
  }
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadGetLocalTtsModelState'}) as unknown
    if (!active || request !== generation) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(t('settings.localTts.statusReadFailed'))
    }
    downloaded.value = readDownloaded(response)
    if (statusReadFailed) {
      errorMessage.value = ''
      statusReadFailed = false
    }
  } catch {
    if (active && request === generation) {
      statusReadFailed = true
      errorMessage.value = t('settings.localTts.statusReadFailed')
    }
  } finally {
    if (active && request === generation) statusLoaded.value = true
  }
}

async function downloadModel(): Promise<void> {
  if (!active || !statusLoaded.value || downloading.value || removing.value || !browserCapabilities.extensionDom) return
  generation++
  statusReadFailed = false
  errorMessage.value = ''
  progress.value = undefined
  requesting.value = true
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadPrepareLocalTtsModel'}) as unknown
    if (!active) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(response && typeof response === 'object' && typeof (response as {error?: unknown}).error === 'string'
        ? (response as {error: string}).error
        : t('settings.localTts.downloadFailed'))
    }
    downloaded.value = true
  } catch (error) {
    if (active) errorMessage.value = error instanceof Error ? error.message : t('settings.localTts.downloadFailed')
  } finally {
    if (active) {
      requesting.value = false
      observedDownload.value = false
      await refresh()
    }
  }
}

function handleDownloadProgress(_id: string, next: DownloadProgressValue | undefined): void {
  if (!active) return
  progress.value = next
  if (next) {
    observedDownload.value = true
    return
  }
  // 结束事件不说明成败；不是本页发起的下载需要重新读取模型状态。
  const external = observedDownload.value && !requesting.value
  observedDownload.value = false
  if (external) void refresh().catch(() => { if (active) errorMessage.value = t('settings.localTts.statusReadFailed') })
}

async function removeModel(): Promise<void> {
  if (!active || removing.value || downloading.value || !browserCapabilities.extensionDom) return
  generation++
  statusReadFailed = false
  errorMessage.value = ''
  removing.value = true
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadRemoveLocalTtsModel'}) as unknown
    if (!active) return
    if (!response || typeof response !== 'object' || (response as {success?: unknown}).success !== true) {
      throw new Error(response && typeof response === 'object' && typeof (response as {error?: unknown}).error === 'string'
        ? (response as {error: string}).error
        : t('modelCache.removeFailed'))
    }
    downloaded.value = false
  } catch (error) {
    if (active) errorMessage.value = error instanceof Error ? error.message : t('modelCache.removeFailed')
  } finally {
    if (active) {
      removing.value = false
      await refresh()
    }
  }
}

function handleStorageChange(changes: Record<string, browser.Storage.StorageChange>, areaName: string): void {
  if (areaName === 'local' && changes[LOCAL_TTS_MODEL_STATE_KEY]) {
    void refresh()
  }
}

onMounted(() => {
  void refresh()
  browser.storage.onChanged.addListener(handleStorageChange)
  stopWatchingProgress = watchDownloadProgress([LOCAL_TTS_DOWNLOAD_ID], handleDownloadProgress)
})

onUnmounted(() => {
  active = false
  generation++
  browser.storage.onChanged.removeListener(handleStorageChange)
  stopWatchingProgress?.()
})
</script>

<style scoped>
/* 朗读来源有四个选项，给控件列更宽的上限，避免多语言标签换行。 */
.speech-settings :deep(.speech-source-row) { grid-template-columns: minmax(0, 1fr) minmax(280px, 440px); }
@media (max-width: 480px) { .speech-settings :deep(.speech-source-row) { grid-template-columns: minmax(0, 1fr); } }
.local-tts-model-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-width: 0; padding: 16px 20px; border-top: 1px solid var(--line); }
.local-tts-model-copy { min-width: 0; }
.local-tts-model-heading { display: flex; align-items: center; gap: 10px; min-width: 0; }
.local-tts-model-heading > div { display: grid; gap: 3px; min-width: 0; }
.local-tts-model-heading strong { color: var(--ink); font-size: 13px; font-weight: 550; line-height: 1.45; }
.local-tts-model-heading small, .local-tts-model-status, .local-tts-warning, .local-tts-error { color: var(--muted); font-size: 12px; line-height: 1.6; }
.local-tts-model-heading small { overflow-wrap: anywhere; }
.local-tts-model-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 8px; color: var(--brand-strong); background: var(--brand-soft); }
.local-tts-model-icon svg, .local-tts-model-action svg { width: 15px; height: 15px; flex: none; }
.local-tts-model-status { margin: 8px 0 0 42px; }
.local-tts-model-copy:has(.local-tts-model-progress) { flex: 1 1 auto; }
.local-tts-model-progress { max-width: 360px; margin: 10px 0 0 42px; }
.local-tts-model-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 112px; min-height: 34px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.local-tts-model-action:hover:not(:disabled) { border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft); }
.local-tts-model-action:disabled { color: var(--muted); background: var(--surface-soft); opacity: .65; cursor: default; }
.local-tts-warning, .local-tts-error { margin: 0; padding: 0 20px 16px; }
.local-tts-warning, .local-tts-error { color: var(--el-color-danger); }
.is-loading { animation: local-tts-spin 1s linear infinite; }
@keyframes local-tts-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-loading { animation: none; } }
@media (max-width: 700px) { .local-tts-model-row { align-items: flex-start; flex-direction: column; padding: 14px 12px; } .local-tts-model-copy:has(.local-tts-model-progress) { align-self: stretch; } .local-tts-model-action { width: 100%; } .local-tts-warning, .local-tts-error { padding-right: 12px; padding-left: 12px; } }
</style>
