<!--
@file src/features/settings/ui/components/WritingStylePreview.vue
文件职责：把写作助手的长度、风格、语气和角色偏好翻译成一段可以直接读到的示例草稿，让用户改设置时立刻看到差别。
主要内容：以固定反馈场景组合示例段落并在变化时逐段过渡，说明自定义描述只在真实生成时生效，并提示已开启的对照译文。
模块边界：本组件只展示示例文本，不调用模型、不保存配置、不影响真实草稿；示例语料由 core 配置注册表提供。
-->
<template>
  <div class="style-preview">
    <div class="preview-head">
      <strong :title="t('writing.experience.previewNote')">{{ t('writing.experience.previewTitle') }}</strong>
    </div>

    <p class="preview-scenario">{{ scenario }}</p>

    <TransitionGroup tag="div" class="preview-body" :css="animated" :name="animated ? 'preview' : ''" data-i18n-ignore>
      <p v-for="paragraph in paragraphs" :key="paragraph.text">{{ paragraph.text }}</p>
    </TransitionGroup>

    <p v-if="referenceLabel" class="preview-note" data-i18n-ignore>{{ t('writing.previewReference', {language: referenceLabel}) }}</p>
    <p v-if="fallbackNote" class="preview-note">{{ fallbackNote }}</p>
  </div>
</template>

<script setup lang="ts">
import {computed} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {type WritingLength, type WritingStyle} from '@/src/core/config/writing';
import {WRITING_PREVIEW_SCENARIO, writingPreviewFallbacks, writingPreviewParagraphs} from '@/src/core/config/writingPreview';

const props = defineProps<{
  length: WritingLength; style: WritingStyle; tone: string; role: string;
  referenceLabel?: string; animated: boolean;
}>();
const {t, translateLegacy} = useUiI18n();

const scenario = computed(() => translateLegacy(WRITING_PREVIEW_SCENARIO));
// 示例段落自行取译文并标记忽略，防止切换时把半段文字交给界面翻译。
const paragraphs = computed(() => writingPreviewParagraphs({length: props.length, style: props.style, tone: props.tone, role: props.role})
  .map(item => ({slot: item.slot, text: translateLegacy(item.text)})));
const fallbackNote = computed(() => {
  const fallbacks = writingPreviewFallbacks({tone: props.tone, role: props.role});
  if (!fallbacks.length) return '';
  return translateLegacy(fallbacks.length === 2 ? '自定义语气和角色会在真实生成时生效，示例先用默认表达'
    : fallbacks[0] === 'tone' ? '自定义语气会在真实生成时生效，示例先用默认表达'
      : '自定义角色会在真实生成时生效，示例先用默认表达');
});
</script>

<style scoped>
.style-preview {
  margin-top: 4px;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-soft);
}

.preview-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.preview-head strong { color: var(--ink); font-size: 12px; font-weight: 600; }

.preview-scenario {
  margin: 8px 0 10px;
  padding-left: 9px;
  border-left: 2px solid color-mix(in srgb, var(--brand) 45%, var(--line));
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}

.preview-body {
  position: relative;
}

.preview-body p { margin: 0; color: var(--ink); font-size: 12px; line-height: 1.9; }
.preview-body p + p { margin-top: 6px; }
.preview-note { margin: 9px 0 0; color: var(--muted); font-size: 10.5px; line-height: 1.65; }

.preview-enter-active, .preview-leave-active { transition: opacity .26s ease, transform .26s ease; }
.preview-enter-from { opacity: 0; transform: translateY(-4px); }
.preview-leave-to { position: absolute; opacity: 0; transform: translateY(4px); }

@media (max-width: 600px) {
  .preview-head { flex-direction: column; gap: 4px; }
}

@media (prefers-reduced-motion: reduce) {
  .preview-enter-active, .preview-leave-active { transition: none; }
}
</style>
