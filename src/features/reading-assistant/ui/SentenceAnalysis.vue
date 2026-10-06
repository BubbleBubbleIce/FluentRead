<!--
 * @file src/features/reading-assistant/ui/SentenceAnalysis.vue
 * 文件职责：在原文片段下展示当前界面语言的句中作用和词性，让学习者先总览结构，再点击查看含义。
 * 主要内容：保留原文顺序和未标注文字，双行片段呈现主语、谓语等明确作用及词性，不混入英文角色名称；完整作用和含义点击可查，通用说明按需展开，支持方向键切换及深浅主题。
 * 模块边界：只接收已经锚定的标注，不进行词性猜测、不发起请求，不写入宿主网页。
 -->
<template>
  <section class="fr-sentence-analysis" :aria-label="translateLegacy('词性与句法')">
    <div class="fr-sentence-tokens" role="group" :aria-label="translateLegacy('原文词性标注')" :title="translateLegacy('点击原文片段，查看词性和句中作用')" @keydown="navigateAnnotations">
      <template v-for="(annotation, index) in annotations" :key="`${annotation.start}-${annotation.end}`">
        <span class="fr-sentence-gap">{{ source.slice(index ? annotations[index - 1].end : 0, annotation.start) }}</span>
        <button type="button" :data-pos="annotation.part.id" :data-role="describeSentenceRole(annotation.role).id" :aria-pressed="selected === index" :tabindex="selected === index ? 0 : -1" :aria-label="`${annotation.text} · ${annotationLabel(annotation)}`" :title="annotationLabel(annotation)" @click="selectAnnotation(index)">
          <span class="fr-sentence-token-text">{{ annotation.text }}</span>
          <span class="fr-sentence-token-meta">{{ annotationLabel(annotation) }}</span>
        </button>
      </template>
      <span>{{ source.slice(annotations[annotations.length - 1]?.end || 0) }}</span>
    </div>
    <div v-if="active" ref="detail" class="fr-sentence-detail" aria-live="polite">
      <div class="fr-sentence-detail-heading"><strong>{{ active.text }}</strong><span>{{ partLabel(active) }}</span></div>
      <p class="fr-sentence-meaning">{{ active.meaning }}</p>
      <p class="fr-sentence-role"><span>{{ translateLegacy('句中作用') }}</span>{{ roleDescription(active) }}</p>
      <details :key="selected" class="fr-sentence-reference">
        <summary>{{ translateLegacy('词性说明') }}</summary>
        <p>{{ translateLegacy(active.part.description) }}</p>
        <p>{{ translateLegacy('AI 根据原文分析；同一个词在不同句子中可能有不同词性。') }}</p>
      </details>
    </div>
  </section>
</template>
<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {describeSentenceRole, summarizeSentenceRole, type SentenceAnnotation} from '../sentenceAnalysis';
const props = defineProps<{source: string; annotations: SentenceAnnotation[]}>();
const {translateLegacy} = useUiI18n();
const selected = ref(0);
const detail = ref<HTMLElement>();
function partLabel(annotation: SentenceAnnotation): string {
  return translateLegacy(annotation.part.id === 'other' ? '其他' : annotation.part.label);
}
function annotationLabel(annotation: SentenceAnnotation): string {
  return `${translateLegacy(describeSentenceRole(annotation.role).label)} · ${partLabel(annotation)}`;
}
function roleDescription(annotation: SentenceAnnotation): string {
  const role = describeSentenceRole(annotation.role);
  return role.id !== 'other' && summarizeSentenceRole(annotation.role) === annotation.role.trim()
    ? translateLegacy(role.label) : annotation.role;
}
async function selectAnnotation(index: number): Promise<void> {
  selected.value = index;
  await nextTick();
  const element = detail.value;
  const viewport = element?.closest<HTMLElement>('.fr-reading-result');
  if (!element || !viewport) return;
  const box = element.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  if (box.bottom > bounds.bottom) viewport.scrollTop += Math.min(box.bottom - bounds.bottom + 8, box.top - bounds.top);
}

function navigateAnnotations(event: KeyboardEvent): void {
  const last = props.annotations.length - 1;
  const next = event.key === 'ArrowRight' ? Math.min(last, selected.value + 1)
    : event.key === 'ArrowLeft' ? Math.max(0, selected.value - 1)
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1;
  if (next < 0 || !(event.target instanceof HTMLButtonElement)) return;
  event.preventDefault(); event.stopPropagation();
  void selectAnnotation(next);
  (event.currentTarget as HTMLElement).querySelectorAll('button')[next]?.focus({preventScroll: true});
}

const active = computed(() => props.annotations[selected.value] || props.annotations[0]);
watch(() => [props.source, props.annotations.length] as const, ([source, length], [previousSource]) => {
  if (source !== previousSource || selected.value >= length) selected.value = 0;
});
</script>
<style scoped>
.fr-sentence-analysis { margin: 10px 0; }
.fr-sentence-tokens { line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.fr-sentence-tokens button { --pos-color: #846242; font: inherit; display: inline-flex; flex-direction: column; align-items: flex-start; vertical-align: top; gap: 3px; max-width: 100%; margin: 3px 0; padding: 6px 8px; border: 0; border-bottom: 3px solid color-mix(in srgb,var(--pos-color) 55%,transparent); border-radius: 7px 7px 0 0; background: color-mix(in srgb,var(--pos-color) 5%,transparent); color: inherit; cursor: pointer; text-align: start; white-space: normal; overflow-wrap: anywhere; }
.fr-sentence-token-text { max-width: 100%; font-size: 14px; line-height: 1.5; }
.fr-sentence-token-meta { max-width: 100%; font-size: 11px; line-height: 1.5; color: var(--fr-reading-muted, var(--el-text-color-secondary, #756a74)); white-space: normal; overflow-wrap: anywhere; user-select: none; }
.fr-dark-theme .fr-sentence-token-meta { color: #b6a9b5; }
.fr-sentence-tokens button[data-pos=noun], .fr-sentence-tokens button[data-pos=pronoun] { --pos-color:#3c7fbb; }
.fr-sentence-tokens button[data-pos=verb], .fr-sentence-tokens button[data-pos=auxiliary] { --pos-color:#bd5481; }
.fr-sentence-tokens button[data-pos=adjective], .fr-sentence-tokens button[data-pos=adverb] { --pos-color:#398579; }
.fr-sentence-tokens button[data-pos=article], .fr-sentence-tokens button[data-pos=determiner] { --pos-color:#9c713b; }
.fr-sentence-tokens button[data-pos=conjunction], .fr-sentence-tokens button[data-pos=preposition] { --pos-color:#8067bc; }
.fr-sentence-tokens button[data-role=subject] { --pos-color:#398579; }
.fr-sentence-tokens button[data-role=predicate] { --pos-color:#bd5481; }
.fr-sentence-tokens button[data-role=object], .fr-sentence-tokens button[data-role=indirect-object] { --pos-color:#527fbb; }
.fr-sentence-tokens button[data-role=attribute], .fr-sentence-tokens button[data-role=postmodifier] { --pos-color:#a4792c; }
.fr-sentence-tokens button[aria-pressed=true] { border-bottom-color: var(--pos-color); box-shadow: inset 0 0 0 1.5px var(--pos-color); background: color-mix(in srgb,var(--pos-color) 7%,transparent); }
.fr-sentence-tokens button:hover { background: color-mix(in srgb,var(--pos-color) 10%,transparent); }
.fr-sentence-tokens button:focus-visible, .fr-sentence-reference summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.fr-sentence-detail { margin: 10px 0 0; border-top: 1px solid var(--fr-answer-border,#e9e9ef); padding-top: 10px; }
.fr-sentence-detail-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
.fr-sentence-detail-heading strong { font-size: 13px; }
.fr-sentence-detail-heading > span { font-size: 11px; opacity: .75; }
.fr-sentence-detail p { margin: 4px 0 0; overflow-wrap: anywhere; }
.fr-sentence-meaning { font-size: 14px; line-height: 1.7; }
.fr-sentence-role { font-size: 12px; }
.fr-sentence-role > span { margin-inline-end: 8px; opacity: .65; }
.fr-sentence-reference { margin-top: 6px; font-size: 11px; color: var(--fr-reading-muted, var(--el-text-color-secondary, #756a74)); }
.fr-sentence-reference summary { cursor: pointer; width: fit-content; }
.fr-sentence-reference p { line-height: 1.7; }
.fr-dark-theme .fr-sentence-reference { color: #b6a9b5; }
</style>
