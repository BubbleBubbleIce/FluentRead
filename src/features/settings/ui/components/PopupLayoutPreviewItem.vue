<!--
@file src/features/settings/ui/components/PopupLayoutPreviewItem.vue
文件职责：给菜单栏预览中的实际区域和快捷入口提供一致的直接排序交互；不可编辑时只是一个不带任何行为的容器。
主要内容：整块拖动、可聚焦手柄、方向键排序和插入位置反馈，兼容嵌套的站点栏目并隔离内外拖放事件；手柄与提示色读取当前皮肤变量。
模块边界：只调用父级传入的排序控制器，不持有配置、不读写存储，也不执行预览所代表的业务动作；未传控制器时不响应任何拖放。
-->
<template>
  <component
    :is="as ?? 'div'"
    class="layout-preview-editable-item"
    :class="{
      editable,
      'is-dragging': editable && controller?.draggedItem.value === item.id,
      'insert-before': editable && controller?.dropTarget.value === item.id && controller.dropPosition.value === 'before',
      'insert-after': editable && controller?.dropTarget.value === item.id && controller.dropPosition.value === 'after',
      'horizontal-insertion': axis === 'x',
    }"
    :draggable="editable || undefined"
    @dragstart="start"
    @dragover="over"
    @drop="drop"
    @dragend="finish"
    @dragleave.self="clearTarget"
    @keydown.esc="cancel"
  >
    <button
      v-if="editable && controller"
      class="layout-preview-drag-handle"
      type="button"
      draggable="true"
      :aria-label="t('settings.interface.popupLayout.handleAria', {label: item.label})"
      :title="t('settings.interface.popupLayout.handleAria', {label: item.label})"
      @keydown.up.prevent.stop="controller.move(item.id, -1)"
      @keydown.down.prevent.stop="controller.move(item.id, 1)"
      @keydown.left.prevent.stop="axis === 'x' && controller.move(item.id, -1)"
      @keydown.right.prevent.stop="axis === 'x' && controller.move(item.id, 1)"
    ><span aria-hidden="true">⠿</span></button>
    <slot />
  </component>
</template>

<script setup lang="ts">
import type {usePopupLayoutReorder} from '../usePopupLayoutReorder'
import {useUiI18n} from '@/src/ui/i18n'

const props = defineProps<{
  as?: string
  item: {id: string; label: string}
  editable: boolean
  controller?: ReturnType<typeof usePopupLayoutReorder>
  axis?: 'x' | 'y'
}>()
const {t} = useUiI18n()

function start(event: DragEvent) {
  if (!props.editable || !props.controller) return
  event.stopPropagation()
  if ((event.target as HTMLElement).closest('[data-preview-action]')) {
    event.preventDefault()
    return
  }
  props.controller.start(event, props.item.id)
}

function over(event: DragEvent) {
  if (!props.editable || !props.controller) return
  event.stopPropagation()
  props.controller.over(event, props.item.id, props.axis)
}

function drop(event: DragEvent) {
  if (!props.editable || !props.controller) return
  event.stopPropagation()
  props.controller.drop(event, props.item.id, props.axis)
}

function finish(event: DragEvent) {
  if (!props.editable || !props.controller) return
  event.stopPropagation()
  props.controller.finish()
}

function clearTarget() {
  const controller = props.controller
  // 从旧项离开的事件可能晚于新项的 dragover，不清除另一个项的插入提示。
  if (props.editable && controller && controller.dropTarget.value === props.item.id) controller.dropTarget.value = null
}

function cancel(event: KeyboardEvent) {
  if (!props.editable || !props.controller) return
  event.stopPropagation()
  props.controller.finish()
}
</script>

<style scoped>
.layout-preview-editable-item { position: relative; min-width: 0; }
.editable { cursor: grab; outline: 1px dashed color-mix(in srgb, var(--layout-preview-accent) 35%, transparent); outline-offset: 2px; }
.editable:hover, .editable:focus-within { outline-color: var(--layout-preview-accent); }
.editable:active { cursor: grabbing; }
.is-dragging { opacity: .4; }
.layout-preview-drag-handle {
  position: absolute;
  z-index: 2;
  top: 2px;
  left: -14px;
  display: grid;
  width: 18px;
  height: 22px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--layout-preview-accent) 25%, transparent);
  border-radius: 6px;
  color: var(--layout-preview-accent);
  background: var(--layout-preview-surface);
  font-size: 16px;
  cursor: grab;
}
.layout-preview-drag-handle:focus-visible { outline: 2px solid var(--layout-preview-accent); outline-offset: 2px; }
.insert-before::before, .insert-after::after {
  position: absolute;
  z-index: 3;
  right: 0;
  left: 0;
  height: 3px;
  border-radius: 3px;
  background: var(--layout-preview-accent);
  content: '';
}
.insert-before::before { top: -6px; }
.insert-after::after { bottom: -6px; }
.horizontal-insertion.insert-before::before, .horizontal-insertion.insert-after::after {
  top: 0;
  bottom: 0;
  width: 3px;
  height: auto;
}
.horizontal-insertion.insert-before::before { right: auto; left: -5px; }
.horizontal-insertion.insert-after::after { right: -5px; left: auto; }
</style>
