<!--
 * @file src/features/settings/ui/LocalTranslationModelSettings.vue
 *
 * 文件职责：呈现本地翻译模型选择、持续下载进度、删除确认和短文本试译。
 * 主要内容：订阅后台持久快照，通过悬停或焦点提示展示模型用途和许可，并在下载按钮边框内说明模型存储与卸载清理规则，主卡片保留语言与资源估算；试译区把输入框与操作栏合成一个输入区，目标语言用标题右侧的分段按钮选择，翻译与取消固定在输入区右下角；页面离开只撤销订阅与试译，不中止下载。
 * 模块边界：通过 runtime 消息操作下载任务，配置交给既有设置持久化；不获取模型文件、不创建推理引擎。
 -->
<template>
  <section class="local-models" aria-labelledby="local-models-title" data-local-translation-models>
    <h3 id="local-models-title" class="local-models-sr-only">{{ t('settings.localTranslation.title') }}</h3>
    <p v-if="!supported" class="local-models-error" role="status">{{ t('settings.localTranslation.unavailable') }}</p>
    <div v-if="loadError" class="local-models-error" role="alert">
      {{ t('settings.localTranslation.statusReadFailed') }}
      <button type="button" class="local-models-icon" :aria-label="t('settings.localTranslation.refresh')" :title="t('settings.localTranslation.refresh')" @click="refresh"><Refresh aria-hidden="true" /></button>
    </div>

    <div class="local-models-list" role="radiogroup" :aria-label="t('settings.localTranslation.title')">
      <article v-for="item in visibleModels" :key="item.value" class="local-model" :class="{selected: selectedModel === item.value}" :data-model="item.value" :data-phase="state(item.value).phase">
        <div class="local-model-title">
          <label class="local-model-choice">
            <input v-model="selectedModel" type="radio" name="local-translation-model" :value="item.value" :disabled="!supported" :aria-label="t('settings.localTranslation.chooseNamed', {name: modelName(item)})" />
            <strong>{{ modelName(item) }}</strong>
          </label>
          <span v-if="item.value === defaultModel" class="local-model-tag">{{ t('settings.localTranslation.recommended') }}</span>
          <span v-else-if="item.engine === 'hunyuan'" class="local-model-tag quality">{{ t('settings.localTranslation.quality') }}</span>
          <FieldHelp button-class="local-model-info" :content="t(item.descriptionKey)" :label="`${modelName(item)}: ${t('settings.localTranslation.license')}`">
            <template #content>
              <div class="local-model-description">
                <p>{{ t(item.descriptionKey) }}</p>
                <p>{{ t('settings.localTranslation.resourcesNote') }}</p>
                <a :href="`https://huggingface.co/${item.repositories[0]}`" target="_blank" rel="noopener noreferrer">{{ t('settings.localTranslation.license') }}<TopRight aria-hidden="true" /></a>
              </div>
            </template>
          </FieldHelp>
        </div>
        <p class="local-model-languages">{{ t(item.languagesKey) }}</p>
        <div class="local-model-resources">
          <span><Download aria-hidden="true" />{{ t('settings.localTranslation.downloadSize', {size: formatBytes(state(item.value).totalBytes)}) }}</span>
          <span><Cpu aria-hidden="true" />{{ t('settings.localTranslation.memory', {size: memoryRange(item)}) }}</span>
        </div>
        <div v-if="showProgress(item.value) || state(item.value).error || item.engine === 'hunyuan' && !hunyuanSupported" class="local-model-progress">
          <progress v-if="showProgress(item.value)" :value="state(item.value).downloadedBytes" :max="state(item.value).totalBytes || 1" :aria-label="modelName(item)" />
          <div v-if="showProgress(item.value)" class="local-model-progress-detail">
            <span>{{ percent(item.value) }}% · {{ formatBytes(state(item.value).downloadedBytes) }} / {{ formatBytes(state(item.value).totalBytes) }}</span>
            <span v-if="state(item.value).phase === 'downloading' && state(item.value).bytesPerSecond > 0">{{ formatBytes(state(item.value).bytesPerSecond) }}/s</span>
          </div>
          <p v-if="state(item.value).error" class="local-models-error" role="alert">{{ t(`settings.localTranslation.error.${state(item.value).error}`) }}</p>
          <p v-if="item.engine === 'hunyuan' && !hunyuanSupported" class="local-models-error" role="status">{{ t('settings.localTranslation.error.browser') }}</p>
        </div>
        <footer class="local-model-actions">
          <span class="local-model-status" :class="{'is-ready': state(item.value).phase === 'ready'}" role="status" aria-live="polite"><Check v-if="state(item.value).phase === 'ready'" aria-hidden="true" />{{ loaded ? t(`settings.localTranslation.phase.${state(item.value).phase}`) : t('settings.localTranslation.statusReading') }}</span>
          <div>
            <button v-if="canDelete(item.value)" type="button" class="local-models-icon" :disabled="busy.has(item.value) || state(item.value).phase === 'removing'" :aria-label="t('modelCache.removeNamed', {name: modelName(item)})" :title="t('settings.localTranslation.remove')" @click="confirmRemove(item)"><Delete aria-hidden="true" /></button>
            <button v-if="isDownloading(item.value)" type="button" class="local-models-button" :disabled="busy.has(item.value)" @click="command(item.value, 'pause')"><VideoPause aria-hidden="true" />{{ t('settings.localTranslation.pause') }}</button>
            <div v-else-if="state(item.value).phase !== 'ready' && !item.legacy" class="local-model-download-control">
              <button type="button" class="local-models-button primary" :disabled="!modelSupported(item) || !loaded || busy.has(item.value) || state(item.value).phase === 'removing'" @click="command(item.value, 'download')"><Download aria-hidden="true" />{{ t(state(item.value).phase === 'error' ? 'settings.localTranslation.retry' : state(item.value).phase === 'paused' ? 'settings.localTranslation.resume' : 'settings.localTranslation.download') }}</button>
              <FieldHelp button-class="local-model-storage-help" :content="t('settings.localTranslation.storageNote')" :label="t('settings.localTranslation.storageHelp')" />
            </div>
          </div>
        </footer>
      </article>
    </div>

    <div class="local-models-notes">
      <p>{{ t('settings.localTranslation.backgroundNote') }}</p>
      <p v-if="loaded && !selectedReady" class="local-models-pending" role="status">{{ t('settings.localTranslation.selectedPending') }}</p>
      <p v-if="operationError" class="local-models-error" role="alert">{{ operationError }}</p>
    </div>

    <section class="local-model-trial" aria-labelledby="local-model-trial-title">
      <header class="local-model-trial-heading">
        <h3 id="local-model-trial-title">{{ t('settings.localTranslation.trial') }}</h3>
        <div class="local-model-trial-target">
          <span aria-hidden="true">{{ t('settings.localTranslation.trialTarget') }}</span>
          <SegmentedControl v-model="trialTarget" compact :label="t('settings.localTranslation.trialTarget')" :options="trialLanguageOptions" :disabled="trialBusy" />
        </div>
      </header>
      <div class="local-model-trial-composer">
        <textarea v-model="trialText" :aria-label="t('settings.localTranslation.trialSource')" rows="3" maxlength="2000" :disabled="trialBusy" />
        <div class="local-model-trial-actions">
          <p v-if="trialBusy" class="local-model-trial-status" role="status">{{ t('settings.localTranslation.trialBusy') }}</p>
          <button v-if="trialBusy" type="button" class="local-models-button" @click="cancelTrial"><Close aria-hidden="true" />{{ t('settings.localTranslation.cancel') }}</button>
          <button v-else type="button" class="local-models-button primary" :disabled="!selectedReady || !trialText.trim()" @click="tryTranslation"><Promotion aria-hidden="true" />{{ t('settings.localTranslation.trialAction') }}</button>
        </div>
      </div>
      <p v-if="trialError" class="local-models-error" role="alert">{{ trialError }}</p>
      <div v-if="trialResult" class="local-model-trial-result" role="status"><p>{{ trialResult }}</p><small>{{ t('settings.localTranslation.trialTime', {seconds: trialSeconds}) }}</small></div>
    </section>
  </section>
</template>

<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import browser from 'webextension-polyfill'
import {ElMessageBox} from 'element-plus'
import {Check, Close, Cpu, Delete, Download, Promotion, Refresh, TopRight, VideoPause} from '@element-plus/icons-vue'
import type {Config} from '@/src/core/config/model'
import {
  DEFAULT_LOCAL_TRANSLATION_MODEL, LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY, LOCAL_TRANSLATION_MODELS,
  getLocalTranslationModel, normalizeLocalTranslationModel, normalizeLocalTranslationDownloadSnapshot, localTranslationErrorKey,
  type LocalTranslationModel, type LocalTranslationModelId, type LocalTranslationDownloadState,
} from '@/src/core/config/localTranslation'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {supportsHunyuanTranslation} from '@/src/platform/browser/localTranslationSupport'
import {useUiI18n} from '@/src/ui/i18n'
import FieldHelp from './components/FieldHelp.vue'
import SegmentedControl from './components/SegmentedControl.vue'

const props = defineProps<{config: Config; service: string}>()
const {t} = useUiI18n()
const supported = browserCapabilities.extensionDom
const hunyuanSupported = supportsHunyuanTranslation()
function modelSupported(model: LocalTranslationModel): boolean { return supported && (model.engine !== 'hunyuan' || hunyuanSupported) }
const defaultModel = DEFAULT_LOCAL_TRANSLATION_MODEL
const tasks = ref<LocalTranslationDownloadState[]>([])
const loaded = ref(false)
const loadError = ref(false)
const operationError = ref('')
const busy = ref(new Set<string>())
let disposed = false
const selectedModel = computed({
  get: () => normalizeLocalTranslationModel(props.config.model[props.service]),
  set: (value: LocalTranslationModelId) => { props.config.model[props.service] = value },
})
const visibleModels = computed(() => LOCAL_TRANSLATION_MODELS.filter((model) => !model.legacy || selectedModel.value === model.value || state(model.value).downloadedBytes > 0))
const selectedReady = computed(() => loaded.value && modelSupported(getLocalTranslationModel(selectedModel.value)) && state(selectedModel.value).phase === 'ready')
function modelName(model: LocalTranslationModel): string { return model.nameKey ? t(model.nameKey) : model.label }
function state(model: LocalTranslationModelId): LocalTranslationDownloadState {
  return tasks.value.find((task) => task.model === model) || {model, phase: 'idle', downloadedBytes: 0, totalBytes: getLocalTranslationModel(model).downloadSizeMb * 1_000_000, bytesPerSecond: 0, updatedAt: 0}
}
function formatBytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${(bytes / 1_000_000).toFixed(bytes > 10_000_000 ? 0 : 1)} MB`
}
function memoryRange(model: LocalTranslationModel): string { return `${formatBytes(model.memoryMb[0] * 1_000_000)} - ${formatBytes(model.memoryMb[1] * 1_000_000)}` }
function percent(model: LocalTranslationModelId): number { const task = state(model); return Math.min(100, Math.floor(task.downloadedBytes * 100 / (task.totalBytes || 1))) }
function isDownloading(model: LocalTranslationModelId): boolean { return ['queued', 'downloading', 'verifying'].includes(state(model).phase) }
function showProgress(model: LocalTranslationModelId): boolean { return !['idle', 'ready', 'removing'].includes(state(model).phase) }
function canDelete(model: LocalTranslationModelId): boolean { return loaded.value && (state(model).downloadedBytes > 0 || isDownloading(model) || state(model).phase === 'ready') }
function applySnapshot(value: unknown): void {
  const snapshot = normalizeLocalTranslationDownloadSnapshot(value)
  if (!snapshot || disposed) return
  tasks.value = snapshot.tasks.map((task) => {
    const previous = tasks.value.find((item) => item.model === task.model)
    return previous && previous.updatedAt > task.updatedAt ? previous : task
  })
}
async function refresh(): Promise<void> {
  if (!supported) return
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadGetLocalTranslationModelState'}) as {success?: boolean} | undefined
    if (!response?.success || !normalizeLocalTranslationDownloadSnapshot(response)) throw new Error('status')
    applySnapshot(response)
    loaded.value = true
    loadError.value = false
  } catch { if (!disposed) loadError.value = true }
}
async function command(model: LocalTranslationModelId, action: 'download' | 'pause' | 'remove'): Promise<void> {
  if (busy.value.has(model)) return
  busy.value.add(model)
  operationError.value = ''
  const type = {download: 'fluentReadPrepareLocalTranslationModel', pause: 'fluentReadPauseLocalTranslationModel', remove: 'fluentReadRemoveLocalTranslationModel'}[action]
  try {
    const response = await browser.runtime.sendMessage({type, model}) as {success?: boolean} | undefined
    if (!response?.success) throw new Error('operation')
    applySnapshot(response)
  } catch { if (!disposed) operationError.value = t('settings.localTranslation.error.unknown') }
  finally { busy.value.delete(model) }
}
async function confirmRemove(model: LocalTranslationModel): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('settings.localTranslation.confirmBody', {size: formatBytes(state(model.value).downloadedBytes)}),
      t('settings.localTranslation.confirmTitle', {name: modelName(model)}),
      {type: 'warning', confirmButtonText: t('settings.localTranslation.confirmAction'), cancelButtonText: t('settings.localTranslation.cancel'), distinguishCancelAndClose: true, closeOnClickModal: false},
    )
  } catch { return }
  if (!disposed) await command(model.value, 'remove')
}
function storageChanged(changes: Record<string, browser.Storage.StorageChange>, area: string): void {
  if (area === 'local' && changes[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY]) applySnapshot(changes[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY].newValue)
}

const trialText = ref('When switching between different filaments, the printer flushes the remaining material to avoid color mixing.')
const trialTarget = ref('zh')
const trialBusy = ref(false)
const trialResult = ref('')
const trialError = ref('')
const trialSeconds = ref('')
const languageLabels: Record<string, string> = {zh: 'area.settings.languageChinese', en: 'area.settings.languageEnglish', ja: 'area.settings.languageJapanese'}
const trialLanguages = computed(() => getLocalTranslationModel(selectedModel.value).engine === 'opus'
  ? selectedModel.value === defaultModel ? ['zh', 'en'] : ['ja', 'en'] : ['zh', 'en', 'ja'])
const trialLanguageOptions = computed(() => trialLanguages.value.map(language => ({value: language, label: t(languageLabels[language] || language)})))
let trialId: string | undefined
function cancelTrial(): void {
  if (trialId) void browser.runtime.sendMessage({type: 'fluentReadCancelLocalTranslationTrial', requestId: trialId}).catch(() => undefined)
  trialId = undefined
  trialBusy.value = false
}
async function tryTranslation(): Promise<void> {
  if (!selectedReady.value || trialBusy.value) return
  const id = crypto.randomUUID()
  trialId = id
  trialBusy.value = true
  trialResult.value = ''
  trialError.value = ''
  const started = performance.now()
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadTryLocalTranslation', requestId: id, model: selectedModel.value, text: trialText.value, targetLanguage: trialTarget.value}) as {success?: boolean; result?: string; error?: string} | undefined
    if (!response?.success || !response.result) throw new Error(response?.error || 'translation')
    if (trialId === id && !disposed) { trialResult.value = response.result; trialSeconds.value = ((performance.now() - started) / 1000).toFixed(1) }
  } catch (error) { if (trialId === id && !disposed) trialError.value = t(localTranslationErrorKey(error)) }
  finally { if (trialId === id) { trialBusy.value = false; trialId = undefined } }
}
watch(selectedModel, () => {
  cancelTrial()
  trialResult.value = ''
  trialError.value = ''
  if (!trialLanguages.value.includes(trialTarget.value)) trialTarget.value = trialLanguages.value[0]!
})
onMounted(() => {
  browser.storage.onChanged.addListener(storageChanged)
  void browser.storage.local.get(LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY).then((stored) => applySnapshot(stored[LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY])).catch(() => undefined)
  void refresh()
})
onUnmounted(() => {
  disposed = true
  browser.storage.onChanged.removeListener(storageChanged)
  cancelTrial()
})
</script>

<style scoped>
.local-models { display: grid; gap: 12px; padding: 0; min-width: 0; color: var(--ink); container-type: inline-size; }
.local-models h3 { margin: 0; font-size: 14px; font-weight: 650; line-height: 1.5; }
.local-models-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.local-models svg { width: 16px; height: 16px; flex: none; }
.local-models-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.local-model { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.local-model.selected { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
.local-model-title { grid-column: 1; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.local-model-choice { display: inline-flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
.local-model-choice input { width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--brand); }
.local-model-choice strong { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.local-model-tag { font-size: 10px; padding: 2px 6px; color: var(--brand-strong); background: var(--brand-soft); border-radius: 4px; }
.local-model-tag.quality { color: #19755a; background: #e9f6ef; }
.local-model-info { margin-left: auto; }
.local-model-languages { margin: 0; font-size: 12px; color: var(--ink); line-height: 1.6; }
.local-model-description { grid-column: 1 / -1; margin: 0; padding-top: 4px; color: inherit; font-size: 12px; line-height: 1.75; }
.local-model-description p { margin: 0 0 4px; }
.local-model-description a { display: inline-flex; align-items: center; gap: 4px; color: inherit; text-decoration: underline; font-size: 12px; }
.local-model-description svg { width: 13px; height: 13px; }
.local-model-resources { display: grid; gap: 3px; color: var(--muted); font-size: 11px; }
.local-model-resources span { display: flex; align-items: center; gap: 7px; line-height: 1.6; }
.local-model-progress { grid-column: 1 / -1; display: grid; gap: 5px; padding-top: 4px; }
.local-model-progress-detail { display: flex; justify-content: space-between; align-items: center; gap: 8px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.local-model-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1.6; color: var(--muted); }
.local-model-status.is-ready { color: #19755a; }
:global(:root.dark) .local-model-status.is-ready { color: #79c9a8; }
.local-model-progress-detail { font-size: 10px; color: var(--muted); }
.local-model progress { width: 100%; height: 6px; border: 0; border-radius: 3px; overflow: hidden; background: var(--surface-soft); accent-color: var(--brand); }
.local-model progress::-webkit-progress-bar { background: var(--surface-soft); }
.local-model progress::-webkit-progress-value { background: var(--brand); }
.local-model progress::-moz-progress-bar { background: var(--brand); }
.local-model-actions, .local-model-actions > div { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.local-model-actions { justify-content: space-between; padding-top: 10px; margin-top: 2px; border-top: 1px solid var(--line); }
.local-models-button, .local-models-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; min-height: 32px; padding: 6px 10px; background: var(--surface); color: var(--ink); font: inherit; font-size: 11px; cursor: pointer; line-height: 1.5; }
.local-models-icon { width: 32px; height: 32px; padding: 6px; flex: none; }
.local-models-button.primary { border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft); }
.local-model-download-control { display: inline-flex; align-items: center; border: 1px solid var(--brand); border-radius: 6px; background: var(--brand-soft); white-space: nowrap; }
.local-model-download-control > .local-models-button { border: 0; border-radius: 5px 0 0 5px; background: transparent; }
.local-model-download-control :deep(.local-model-storage-help) { margin-right: 4px; color: var(--brand-strong); }
.local-models button:disabled { opacity: .55; cursor: default; }
.local-models button:hover:not(:disabled) { border-color: var(--brand); }
.local-models :is(button, input, textarea, select, a):focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.local-models-notes { display: grid; gap: 6px; }
.local-models-notes p { margin: 0; font-size: 11px; line-height: 1.7; color: var(--muted); }
.local-models-notes .local-models-pending { color: var(--ink); }
.local-models-error { margin: 0; color: var(--el-color-danger) !important; font-size: 11px; line-height: 1.65; overflow-wrap: anywhere; }
.local-model-trial { display: grid; gap: 10px; padding-top: 8px; }
.local-model-trial-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.local-model-trial-heading h3 { margin: 0; }
.local-model-trial-target { display: inline-flex; align-items: center; gap: 10px; min-width: 0; color: var(--muted); font-size: 12px; }
.local-model-trial-target :deep(.segmented-control) { width: auto; }
.local-model-trial-target :deep(.segmented-control button) { white-space: nowrap; }
/* 输入框与操作栏合成一个输入区：语言在标题右侧选择，翻译按钮固定在输入区右下角；支持 field-sizing 的浏览器里输入框随内容增高。 */
.local-model-trial-composer { display: grid; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); transition: border-color 150ms ease; }
.local-model-trial-composer:focus-within { border-color: var(--brand); }
.local-model-trial textarea { width: 100%; box-sizing: border-box; field-sizing: content; min-height: 86px; max-height: 220px; resize: none; padding: 12px 14px 4px; border: 0; border-radius: 12px 12px 0 0; outline: 0; background: transparent; color: var(--ink); font: inherit; font-size: 12px; line-height: 1.7; }
.local-model-trial-actions { display: flex; justify-content: flex-end; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 10px 10px; }
.local-model-trial-actions .local-model-trial-status { margin: 0 auto 0 4px; }
.local-model-trial-result { border-left: 2px solid var(--brand); padding: 4px 12px; }
.local-model-trial-result p { margin: 0 0 8px; font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.local-model-trial-result small, .local-model-trial-status { color: var(--muted); font-size: 11px; }
@container (max-width: 620px) {
  .local-models-list { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .local-model { padding: 12px; }
}
</style>
