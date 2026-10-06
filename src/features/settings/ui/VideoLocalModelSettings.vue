<!--
 * @file src/features/settings/ui/VideoLocalModelSettings.vue
 * 文件职责：提供 X 本地视频字幕模型选择与下载管理，向用户呈现模型推荐、可用状态和缓存操作。
 * 主要内容：模型卡片作为唯一选择入口，保留推荐、Tiny/Base 状态和真实进度条、百分比及已下载体积，同步播放器发起的下载；各模型命令状态独立，命令结束重读权威缓存，区分读取与命令错误；管理识别缓存，并在卸载时作废异步提交及移除监听。
 * 模块边界：通过视频 feature 公共配置和后台消息获取模型，不直接执行识别、下载权重或操作网页播放器；下载进度只读取后台转存的变化事件。
 -->
<template>
  <section class="video-model-management" aria-labelledby="video-model-management-title">
    <div class="video-model-download-heading">
      <div>
        <h3 id="video-model-management-title">本地 AI 字幕模型</h3>
        <p class="video-model-status" role="status">{{ !modelStateLoaded ? '正在读取模型状态…' : downloaded.includes(config.videoLocalModel) ? '当前模型已下载，可直接生成' : '一般选择 Tiny；语音不清楚时可换 Base' }}</p>
      </div>
      <span class="video-model-local-badge"><Cpu aria-hidden="true" />本地运行</span>
    </div>
    <p v-if="!browserCapabilities.extensionDom" class="capability-warning" role="status">当前浏览器不支持本地 AI 字幕，无法下载或运行本地模型</p>
    <div class="video-model-list" role="radiogroup" aria-label="本地 AI 字幕模型">
      <article v-for="item in modelOptions" :key="item.value" class="video-model-card" :class="{ selected: item.value === config.videoLocalModel, disabled: !config.videoTranslationEnabled || !browserCapabilities.extensionDom }" @click="selectModel(item.value)">
        <label class="video-model-choice">
          <input v-model="config.videoLocalModel" type="radio" name="video-local-model" :value="item.value" :disabled="!config.videoTranslationEnabled || !browserCapabilities.extensionDom" />
          <span class="video-model-card-heading">
            <span class="video-model-icon" aria-hidden="true"><Cpu /></span>
            <strong>{{ item.label }}</strong>
            <span v-if="item.value === recommendedModel" class="video-model-recommended">推荐</span>
            <span v-if="item.value === config.videoLocalModel" class="video-model-selected">当前选择</span>
          </span>
        </label>
        <p class="video-model-description">{{ item.description }}</p>
        <p class="video-model-size">{{ t('modelCache.downloadSize', {size: item.downloadSizeMb}) }}</p>
        <div class="video-model-card-footer">
          <DownloadProgress v-if="isDownloading(item.value)" class="video-model-progress" :progress="progress[item.value]" :label="t('video.aiDownloadingModel')" :data-video-model-progress="item.value" />
          <span v-else class="video-model-availability" role="status">
            <Check v-if="downloaded.includes(item.value)" aria-hidden="true" />
            {{ !modelStateLoaded ? '读取中…' : downloaded.includes(item.value) ? '可离线使用' : '尚未下载' }}
          </span>
          <button v-if="downloaded.includes(item.value)" type="button" class="video-model-download-button" :disabled="removing.includes(item.value)" :aria-label="t('modelCache.removeNamed', {name: translateLegacy(item.label)})" @click.stop="removeModel(item.value)"><Delete aria-hidden="true" />{{ t(removing.includes(item.value) ? 'modelCache.removing' : 'modelCache.remove') }}</button>
          <button v-else type="button" class="video-model-download-button" :aria-label="t('video.modelDownloadAria', {model: translateLegacy(item.label)})" :disabled="!modelStateLoaded || isDownloading(item.value) || !config.videoTranslationEnabled || !browserCapabilities.extensionDom" @click.stop="config.videoLocalModel = item.value; download(item.value)">
            <component :is="isDownloading(item.value) ? Loading : Download" :class="{ 'is-loading': isDownloading(item.value) }" aria-hidden="true" />
            {{ isDownloading(item.value) ? '下载中…' : '下载模型' }}
          </button>
        </div>
      </article>
    </div>
    <p class="video-model-guidance">支持桌面版 Chrome、Edge 和 Firefox，首次下载需联网，识别速度取决于 CPU 和内存</p>
    <p v-if="downloadError || modelReadError" class="video-model-error" role="alert">{{ downloadError || modelReadError }}</p>
  </section>
  <section class="video-ai-cache-panel" data-video-ai-cache aria-labelledby="video-ai-cache-title">
    <div class="video-ai-cache-copy">
      <div class="video-ai-cache-heading">
        <Files aria-hidden="true" />
        <h3 id="video-ai-cache-title">已识别视频缓存</h3>
        <span class="video-ai-cache-status" role="status">{{ cacheStats ? t('video.cacheCount', {count: cacheStats.entries}) : cacheError ? '读取失败' : '读取中…' }}</span>
      </div>
      <p>最多保留 32 个视频、7 天；只保存字幕文字和时间，不保存音频</p>
      <p v-if="cacheError" class="video-model-error" role="alert">{{ cacheError }}</p>
    </div>
    <button type="button" class="video-model-download-button video-ai-cache-clear" :disabled="clearingCache || !cacheStats || cacheStats.entries === 0" @click="clearVideoAiCache">
      <Delete aria-hidden="true" />{{ clearingCache ? '清除中…' : '清除缓存' }}
    </button>
  </section>
</template>

<script lang="ts" setup>
import {useUiI18n} from '@/src/ui/i18n';
import {computed, onMounted, onUnmounted, ref} from 'vue';
import browser from 'webextension-polyfill';
import {Check, Cpu, Delete, Download, Files, Loading} from '@element-plus/icons-vue';
import {
  VIDEO_LOCAL_TRANSCRIPTION_MODELS,
  VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY,
  VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
  VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
  normalizeVideoLocalTranscriptionModels,
  VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
  type VideoLocalTranscriptionModel,
} from '@/src/features/video-subtitle/public';
import type {Config} from '@/src/core/config/model';
import {videoModelDownloadId, type DownloadProgress as DownloadProgressValue} from '@/src/core/download/progress';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {watchDownloadProgress} from '@/src/platform/storage/downloadProgress';
import DownloadProgress from '@/src/ui/components/DownloadProgress.vue';

const {t, translateLegacy} = useUiI18n();
const props = defineProps<{config: Config}>();
// 设置页会整体替换草稿；始终读取最新 prop，避免卡片继续编辑旧配置。
const config = computed(() => props.config);
const modelOptions = VIDEO_LOCAL_TRANSCRIPTION_MODELS;
// 与播放器内的首次下载确认使用同一推荐，避免两处给出不同建议。
const recommendedModel = VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL;
const downloaded = ref<VideoLocalTranscriptionModel[]>([]);
const modelStateLoaded = ref(false);
// 本页发起的请求与播放器里发起、仍在进行的下载都算“下载中”；后者只能从实时进度事件得知。
const downloading = ref<VideoLocalTranscriptionModel[]>([]);
const observedDownloads = ref<VideoLocalTranscriptionModel[]>([]);
const progress = ref<Partial<Record<VideoLocalTranscriptionModel, DownloadProgressValue>>>({});
const downloadError = ref('');
let stopWatchingProgress: (() => void) | undefined;
const modelReadError = ref('');
const removing = ref<VideoLocalTranscriptionModel[]>([]);
const cacheStats = ref<{entries: number; bytes: number; maxEntries: number; ttlMs: number} | null>(null);
const cacheError = ref('');
const clearingCache = ref(false);
let active = true;
let modelGeneration = 0;
let cacheGeneration = 0;

function selectModel(model: VideoLocalTranscriptionModel): void {
  if (!config.value.videoTranslationEnabled || !browserCapabilities.extensionDom) return;
  config.value.videoLocalModel = model;
}

function isDownloading(model: VideoLocalTranscriptionModel): boolean {
  return !downloaded.value.includes(model) && (downloading.value.includes(model) || observedDownloads.value.includes(model));
}

function handleDownloadProgress(id: string, next: DownloadProgressValue | undefined): void {
  if (!active) return;
  const model = modelOptions.find(item => videoModelDownloadId(item.value) === id)!.value;
  progress.value = {...progress.value, [model]: next};
  if (next) {
    if (!observedDownloads.value.includes(model)) observedDownloads.value = [...observedDownloads.value, model];
    return;
  }
  // 结束事件不说明成败；不是本页发起的下载需要重新读取已下载列表。
  const external = observedDownloads.value.includes(model) && !downloading.value.includes(model);
  observedDownloads.value = observedDownloads.value.filter(item => item !== model);
  if (external) void refresh().catch(() => { if (active) modelReadError.value = '无法读取模型缓存，请重试'; });
}

async function refresh(): Promise<void> {
  if (!active || downloading.value.length || removing.value.length) return;
  const request = ++modelGeneration;
  try {
    const stored = await browser.storage.local.get(VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY);
    if (!active || request !== modelGeneration) return;
    downloaded.value = normalizeVideoLocalTranscriptionModels(stored[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]);
    modelReadError.value = '';
  } catch {
    if (active && request === modelGeneration) {
      modelReadError.value = '无法读取模型缓存，请重试';
    }
  } finally {
    if (active && request === modelGeneration) modelStateLoaded.value = true;
  }
}

async function download(model: VideoLocalTranscriptionModel): Promise<void> {
  if (!active) return;
  if (!browserCapabilities.extensionDom) {
    downloadError.value = '当前浏览器不支持本地 AI 字幕';
    return;
  }
  if (downloaded.value.includes(model) || isDownloading(model)) return;
  modelGeneration++;
  downloadError.value = '';
  progress.value = {...progress.value, [model]: undefined};
  downloading.value = [...downloading.value, model];
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadPrepareLocalVideoModel', model}) as {success?: boolean; models?: unknown; error?: string} | undefined;
    if (!active) return;
    if (!response?.success) throw new Error(response?.error || '模型下载失败');
  } catch (error) {
    if (active) downloadError.value = error instanceof Error ? t('video.modelDownloadError', {error: translateLegacy(error.message)}) : '模型下载失败，请检查网络后重试';
  } finally {
    if (active) {
      downloading.value = downloading.value.filter(item => item !== model);
      observedDownloads.value = observedDownloads.value.filter(item => item !== model);
      // 回包可能早于其他命令/外部变化；最后一项本页命令结束后重读权威 storage。
      await refresh();
    }
  }
}

async function removeModel(model: VideoLocalTranscriptionModel): Promise<void> {
  if (!active || removing.value.includes(model)) return;
  modelGeneration++;
  removing.value.push(model);
  downloadError.value = '';
  try {
    const response = await browser.runtime.sendMessage({type: 'fluentReadRemoveLocalVideoModel', model}) as {success?: boolean; error?: string; models?: unknown} | undefined;
    if (!active) return;
    if (!response?.success) throw new Error(response?.error || t('modelCache.removeFailed'));
  } catch (error) { if (active) downloadError.value = error instanceof Error ? translateLegacy(error.message) : t('modelCache.removeFailed'); }
  finally {
    if (active) {
      removing.value = removing.value.filter(item => item !== model);
      await refresh();
    }
  }
}

async function refreshCacheStats(): Promise<void> {
  if (!active) return;
  const request = ++cacheGeneration;
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE}) as {success?: boolean; stats?: typeof cacheStats.value} | undefined;
    if (!active || request !== cacheGeneration) return;
    if (!response?.success || !response.stats) throw new Error('无法读取已识别字幕缓存，请重试');
    cacheStats.value = response.stats;
    cacheError.value = '';
  } catch (error) {
    if (active && request === cacheGeneration) cacheError.value = error instanceof Error ? error.message : '无法读取已识别字幕缓存，请重试';
  }
}

async function clearVideoAiCache(): Promise<void> {
  if (!active || clearingCache.value) return;
  cacheGeneration++;
  clearingCache.value = true;
  cacheError.value = '';
  try {
    const response = await browser.runtime.sendMessage({type: VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE}) as {success?: boolean; error?: string} | undefined;
    if (!active) return;
    if (!response?.success) throw new Error(response?.error || '清除已识别字幕失败');
    await refreshCacheStats();
  } catch (error) {
    if (active) cacheError.value = error instanceof Error ? error.message : '清除已识别字幕失败，请重试';
  } finally {
    if (active) clearingCache.value = false;
  }
}

function handleStorageChange(changes: Record<string, browser.Storage.StorageChange>, areaName: string): void {
  if (areaName === 'local' && changes[VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY]) void refresh();
}

// 从播放页返回设置时重新读取 IndexedDB 统计，避免一直显示首次挂载时的零条。
function refreshVisibleCacheStats(): void {
  if (!active || clearingCache.value || document.visibilityState === 'hidden') return;
  void refreshCacheStats();
}

onMounted(() => {
  void refresh();
  void refreshCacheStats();
  browser.storage.onChanged.addListener(handleStorageChange);
  stopWatchingProgress = watchDownloadProgress(modelOptions.map(item => videoModelDownloadId(item.value)), handleDownloadProgress);
  document.addEventListener('visibilitychange', refreshVisibleCacheStats);
  window.addEventListener('focus', refreshVisibleCacheStats);
});
onUnmounted(() => {
  active = false;
  modelGeneration++;
  cacheGeneration++;
  browser.storage.onChanged.removeListener(handleStorageChange);
  stopWatchingProgress?.();
  document.removeEventListener('visibilitychange', refreshVisibleCacheStats);
  window.removeEventListener('focus', refreshVisibleCacheStats);
});
</script>

<style scoped>
.video-model-size { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
.video-model-management {
  display: grid;
  gap: 14px;
  padding: 18px 16px;
  border-top: 1px solid var(--line);
}

.video-model-download-heading,
.video-model-card-heading,
.video-model-card-footer,
.video-ai-cache-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.video-model-download-heading,
.video-model-card-footer { justify-content: space-between; }
.video-model-download-heading { align-items: flex-start; }
h3 { margin: 0; color: var(--ink); font-size: 12.5px; font-weight: 700; line-height: 1.5; }
.video-model-status { margin: 4px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.video-model-choice { display: block; min-width: 0; cursor: pointer; }
.video-model-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.video-model-choice:focus-within .video-model-card-heading { outline: 2px solid var(--brand); outline-offset: 3px; border-radius: 5px; }
.video-model-local-badge,
.video-model-availability,
.video-model-download-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.video-model-local-badge { flex: none; padding: 5px 8px; border-radius: 6px; color: var(--muted); background: var(--surface-soft); font-size: 10px; }
svg { width: 15px; height: 15px; flex: none; }
.video-model-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.video-model-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.video-model-card:not(.disabled) { cursor: pointer; }
.video-model-card.selected { border-color: var(--brand); background: color-mix(in srgb, var(--brand-soft) 25%, var(--surface)); }
.video-model-card-heading { flex-wrap: wrap; gap: 8px; }
.video-model-card-heading strong { color: var(--ink); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.video-model-card-heading::before { width: 15px; height: 15px; flex: none; border: 2px solid var(--line); border-radius: 50%; background: var(--surface); box-shadow: inset 0 0 0 3px var(--surface); content: ''; }
.video-model-choice input:checked + .video-model-card-heading::before { border-color: var(--brand); background: var(--brand); }
.video-model-choice input:disabled + .video-model-card-heading { cursor: default; }
.video-model-choice input:disabled + .video-model-card-heading::before { opacity: .6; }
.video-model-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 8px; color: var(--muted); background: var(--surface-soft); }
.selected .video-model-icon { color: var(--brand-strong); background: var(--brand-soft); }
.video-model-icon svg { width: 18px; height: 18px; }
.video-model-recommended { padding: 3px 6px; border-radius: 5px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; line-height: 1.4; white-space: nowrap; }
.video-model-selected { padding: 3px 6px; border-radius: 5px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; line-height: 1.4; white-space: nowrap; }
.video-model-description { flex: 1; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.65; }
.video-model-availability { justify-content: flex-start; color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.video-model-progress { flex: 1 1 auto; }
.video-model-download-button {
  flex: none;
  min-height: 32px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}
.video-model-download-button:hover:not(:disabled) { color: var(--brand-strong); border-color: var(--brand); background: var(--brand-soft); }
.video-model-download-button:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.video-model-download-button:disabled { color: var(--muted); background: var(--surface-soft); opacity: .65; cursor: default; }
.video-model-guidance { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.65; }
.video-model-error { margin: 0; color: var(--el-color-danger); font-size: 11px; line-height: 1.5; }
.video-ai-cache-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px 20px;
  margin: 0 16px 16px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
}
.video-ai-cache-copy { display: grid; gap: 7px; min-width: 0; flex: 1 1 260px; }
.video-ai-cache-heading { flex-wrap: wrap; gap: 8px; color: var(--muted); }
.video-ai-cache-copy > p { margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.65; }
.video-ai-cache-copy > .video-model-error { color: var(--el-color-danger); }
.video-ai-cache-status { padding: 3px 7px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: var(--surface); font-size: 10px; line-height: 1.4; }
.capability-warning { margin: 6px 0 0; color: var(--el-color-danger); font-size: 11px; line-height: 1.5; }
.is-loading { animation: video-model-spin 1s linear infinite; }
@keyframes video-model-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .is-loading { animation: none; } }
@media (max-width: 480px) {
  .video-model-management { padding: 16px 12px; }
  .video-model-download-heading { flex-wrap: wrap; }
  .video-model-card { padding: 12px; }
  .video-ai-cache-panel { margin: 0 12px 12px; padding: 12px; }
  .video-ai-cache-clear { width: 100%; }
}
</style>
