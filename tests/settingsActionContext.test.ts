/**
 * @file tests/settingsActionContext.test.ts
 * 文件职责：验证设置操作身份在真实 Vue 生命周期和同步上下文切换中的有效范围。
 * 主要内容：覆盖对象身份、重复值、可见性、缓存停用、重开和卸载后的捕获回调。
 * 模块边界：使用 Vue renderer 与 KeepAlive，不触及浏览器端口或持久化。
 */
import {KeepAlive, computed, createRenderer, h, ref, type App} from 'vue'
import {afterEach, describe, expect, it} from 'vitest'
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext'

let app: App
afterEach(() => app?.unmount())
function mount() {
  const enabled = ref(true), identity = ref<object>({}), shown = ref(true)
  let context!: ReturnType<typeof useSettingsActionContext>
  const renderer = createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
    remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
    setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
    setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]})
  const component = {setup() {context = useSettingsActionContext(() => enabled.value, () => [identity.value]);return () => null}}
  app = renderer.createApp({setup: () => () => h(KeepAlive, null, {default: () => shown.value ? h(component) : h({render: () => null}, {key: 'other'})})})
  app.mount({})
  return {context, enabled, identity, shown}
}

describe('设置操作的活跃身份', () => {
  it('同步拒绝替换前的回调，重复同一身份保持有效，新身份可创建新回调', () => {
    const {context, identity} = mount(), original = context.capture()
    const firstRevision = context.revision.value
    expect(original()).toBe(true);identity.value = identity.value;expect(original()).toBe(true);expect(context.revision.value).toBe(firstRevision)
    identity.value = {};expect(original()).toBe(false);expect(context.capture()()).toBe(true);expect(context.revision.value).toBeGreaterThan(firstRevision)
  })
  it('隐藏后重开不复活旧回调，计算属性可重新绑定新回调', () => {
    const {context, enabled} = mount(), actions = computed(() => context.capture()), first = actions.value
    enabled.value = false;expect(context.active.value).toBe(false);expect(first()).toBe(false);expect(actions.value()).toBe(false)
    enabled.value = true;expect(first()).toBe(false);expect(actions.value()).toBe(true);expect(actions.value).not.toBe(first)
  })
  it('缓存停用拒绝旧回调，恢复支持新操作，卸载后所有新旧操作无效', async () => {
    const {context, shown} = mount(), first = context.capture()
    const {nextTick} = await import('vue');shown.value = false;await nextTick();expect(first()).toBe(false)
    shown.value = true;await nextTick();expect(first()).toBe(false);const current = context.capture();expect(current()).toBe(true)
    app.unmount();expect(current()).toBe(false);expect(context.capture()()).toBe(false)
  })
})
