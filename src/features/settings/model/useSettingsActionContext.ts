/**
 * @file src/features/settings/model/useSettingsActionContext.ts
 * 文件职责：限定设置组件的操作只属于当前活跃配置上下文。
 * 主要内容：同步失效服务或配置切换前捕获的回调，覆盖隐藏、缓存停用和卸载。
 * 模块边界：只管理操作身份，不持久化、不触发网络，也不替代业务字段校验。
 */
import {computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue'

export function useSettingsActionContext(enabled: () => boolean, identity: () => readonly unknown[]) {
  const viewActive = ref(true)
  const revision = ref(0)
  const active = computed(() => viewActive.value && enabled())
  watch(() => [active.value, ...identity()], () => {revision.value += 1}, {flush: 'sync'})
  onActivated(() => {viewActive.value = true})
  onDeactivated(() => {viewActive.value = false})
  onBeforeUnmount(() => {viewActive.value = false})

  function capture(): () => boolean {
    const captured = revision.value
    return () => active.value && captured === revision.value
  }
  // 外部控件可能缓存事件或延迟发出关闭通知；调用方可据此重建所属控件。
  return {active, capture, revision: computed(() => revision.value)}
}
