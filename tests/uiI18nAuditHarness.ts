/**
 * @file tests/uiI18nAuditHarness.ts
 * 文件职责：为语言归属审计加载实际 i18n、Selector 和 SettingsSections 客户端模板。
 * 主要内容：使用真实 Vue/KeepAlive、共享 i18n 保存函数及父 props，配置端口保留同步乐观订阅、revision、字段比较和失败权威回读。
 * 模块边界：只替换存储传输、资源加载和无关设置组件；不启动浏览器或监听 TCP，不模拟操作系统焦点，每次显式清理 server/app/context。
 */
import {createRequire} from 'node:module'
import {existsSync, readFileSync} from 'node:fs'
import {basename, resolve} from 'node:path'
import {parseHTML} from 'linkedom'
import vue from '@vitejs/plugin-vue'
import {createServer, type Plugin} from 'vite'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import ts from 'typescript'
import {expect, vi} from 'vitest'
import type {UiLanguage} from '@/src/core/i18n/language'
import type {UiI18nContext} from '@/src/ui/i18n'

export const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
const key = '__frUiLanguageOwnershipAudit'
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no})
  return {promise, resolve, reject}
}
export async function settle() {await runtime.nextTick();for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick()}

export async function createLanguageHarness({parent = false, mount = true, ready = Promise.resolve()} = {}) {
  const dom = parseHTML('<html><body><div id="app"></div></body></html>'), document = dom.document
  const frames = new Map<number, FrameRequestCallback>();let frame = 0, revision = 0
  const listeners = new Set<(config: Record<string, unknown>) => void>(), controls: import('vue').ComponentInternalInstance[] = []
  const requests: Array<{value: UiLanguage; expected: unknown; gate: ReturnType<typeof deferred<void>>}> = []
  const bundles = new Map<UiLanguage, ReturnType<typeof deferred<boolean>>>()
  const config: Record<string, unknown> = {uiLanguage: 'zh-CN', uiLanguageSetupCompleted: false}
  let stored = {...config}, app: import('vue').App | undefined, focused: Element | null = document.body
  const window = {location: {hash: '', search: '', protocol: 'chrome-extension:'}, navigator: {userAgent: ''},
    matchMedia: () => ({matches: false, onchange: null}), requestAnimationFrame: (fn: FrameRequestCallback) => {frames.set(++frame, fn);return frame},
    cancelAnimationFrame: (id: number) => frames.delete(id), addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window)}
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [name, value] of Object.entries({window, document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event})) vi.stubGlobal(name, value)
  const emit = (next: Record<string, unknown>) => {Object.assign(config, next);for (const listener of listeners) listener({...config})}
  const patch = vi.fn(async (value: Record<string, unknown>, _sender?: unknown) => {
    // 父组件退出交接的全配置不属于本夹具的语言请求；不为它创建等待门。
    if (Object.keys(value).some(name => name !== 'uiLanguage' && name !== 'uiLanguageSetupCompleted')) return
    await ready;
    const expected = config.uiLanguage, gate = deferred<void>(), requested = value.uiLanguage as UiLanguage
    requests.push({value: requested, expected, gate});emit(value)
    try {
      await gate.promise
      if (stored.uiLanguage !== expected && stored.uiLanguage !== requested) throw new Error('配置字段已由其他页面更新')
      stored = {...stored, ...value};revision += 1
      if (config.uiLanguage !== stored.uiLanguage || config.uiLanguageSetupCompleted !== stored.uiLanguageSetupCompleted) emit(stored)
    } catch (error) {emit(stored);throw error}
  })
  const data = {config, configReady: ready, requestConfigPatch: patch, getConfigRevision: () => revision,
    subscribeConfig: (listener: (value: Record<string, unknown>) => void) => {listeners.add(listener);listener({...config});return () => listeners.delete(listener)},
    handoffPendingConfigPatches: vi.fn(async () => undefined), applyInterfaceTheme: vi.fn(),
    ensure: vi.fn((value: UiLanguage) => bundles.get(value)?.promise ?? Promise.resolve(true)),
    captureControl: (instance: import('vue').ComponentInternalInstance) => controls.push(instance),
    browser: {runtime: {sendMessage: vi.fn()}, tabs: {query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined)}}}
  ;(globalThis as Record<string, unknown>)[key] = data
  const actual = new Set(['/src/features/settings/ui/SettingsSections.vue','/src/ui/components/UiLanguageSelector.vue'])
  const mocks: Plugin = {name: 'language-ownership-audit-ports', enforce: 'pre', resolveId(id) {
    if (id.endsWith('/UiSelect.vue')) return '\0language-control'
    if (id.endsWith('.vue') && ![...actual].some(file => id.endsWith(file))) return '\0language-child'
    if (id.endsWith('/src/services/config/store')) return '\0language-store'
    if (id.endsWith('/src/platform/i18n/uiLanguageBundles')) return '\0language-bundles'
    if (id.endsWith('/src/ui/interfaceAppearance')) return '\0language-appearance'
    if (id === 'webextension-polyfill') return '\0language-browser'
    if (id === 'element-plus') return '\0language-element'
    if (id === '@element-plus/icons-vue') return '\0language-icons'
    if (id.endsWith('/src/platform/browser/capabilities')) return '\0language-capabilities'
    return null
  }, load(id) {
    const directory = process.env.FLUENTREAD_UI_LANGUAGE_TEST_SOURCE_DIR
    if (directory && (actual.has(id.slice(process.cwd().length)) || id.endsWith('/src/ui/i18n.ts'))) {
      const file = resolve(directory, basename(id));if (existsSync(file)) return readFileSync(file, 'utf8')
    }
    if (id === '\0language-control') return `import {getCurrentInstance,h} from 'vue';export default {inheritAttrs:false,setup(_, {attrs,slots}) {globalThis.${key}.captureControl(getCurrentInstance());return () => h('div', {...attrs,'data-language-control':'true'}, slots.default?.());}};`
    if (id === '\0language-child') return "import {h} from 'vue';export default {inheritAttrs:false,setup(_, {attrs,slots}) {return () => h('div',attrs,slots.default?.());}};"
    if (id === '\0language-store') return `export const {config,configReady,requestConfigPatch,getConfigRevision,subscribeConfig,handoffPendingConfigPatches} = globalThis.${key};`
    if (id === '\0language-bundles') return `export const ensureUiLanguageBundle = globalThis.${key}.ensure;`
    if (id === '\0language-appearance') return `export const applyInterfaceTheme = globalThis.${key}.applyInterfaceTheme;`
    if (id === '\0language-browser') return `export default globalThis.${key}.browser;`
    if (id === '\0language-element') return "import {h} from 'vue';export const ElMessage=Object.assign(() => {},{warning:()=>{}});export const ElOption={props:['value','label'],setup:(p,{slots})=>()=>h('div',{'data-option':p.value},slots.default?.())};"
    if (id === '\0language-icons') return 'export const ArrowRight={render:()=>null};export const InfoFilled=ArrowRight;export const Edit=ArrowRight;'
    if (id === '\0language-capabilities') return "export const browserCapabilities={browser:'chrome'};"
    return null
  }}
  const server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
    plugins: [mocks, vue()], resolve: {alias: {'@': process.cwd()}},
    ssr: {noExternal: ['element-plus', '@element-plus/icons-vue', 'webextension-polyfill']}, server: {hmr: false, middlewareMode: true, watch: null}})
  let context!: UiI18nContext
  try {
    const module = await server.ssrLoadModule('/src/ui/i18n.ts')
    context = module.createUiI18nContext()
    const loadComponent = async (relative: string) => {
      const filename = resolve(relative), directory = process.env.FLUENTREAD_UI_LANGUAGE_TEST_SOURCE_DIR
      const original = directory ? resolve(directory, basename(filename)) : filename
      const source = readFileSync(existsSync(original) ? original : filename, 'utf8'), {descriptor} = parse(source, {filename})
      const script = compileScript(descriptor, {id: 'ui-language-parent-audit'})
      const component = (await server.ssrLoadModule('/' + relative)).default
      const template = compileTemplate({source: descriptor.template!.content, filename, id: 'ui-language-parent-audit',
        compilerOptions: {mode: 'function', cacheHandlers: true, bindingMetadata: script.bindings, expressionPlugins: ['typescript']}})
      expect(template.errors).toEqual([]);component.ssrRender = undefined
      component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime)
      return component
    }
    const selector = mount ? await loadComponent('src/ui/components/UiLanguageSelector.vue') : undefined
    const component = mount ? (parent ? await loadComponent('src/features/settings/ui/SettingsSections.vue') : selector) : undefined
    const visible = runtime.ref(true), props = runtime.reactive({activeSection: 'settings-general'}), parentState: Record<string, any> = {}
    if (component) {
      const renderer = runtime.createRenderer({patchProp(element: any, name: string, _before: unknown, next: unknown) {
        if (/^on[A-Z]/u.test(name)) return
        if (name === 'class') {element.className = String(next ?? '');return}
        if (name === 'style' && typeof next === 'object' && next) {Object.assign(element.style, next);return}
        if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(name))) element.removeAttribute(name)
        else element.setAttribute(name, String(next))
      }, insert: (child: any, owner: any, anchor: any = null) => owner.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
        createElement: tag => {const element = runtime.markRaw(document.createElement(tag));element.focus = () => {focused = element};return element},
        createText: value => document.createTextNode(value), createComment: value => document.createComment(value), setText: (node: any, value) => {node.nodeValue = value},
        setElementText: (element: any, value) => {element.textContent = value}, parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
        querySelector: value => document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
        insertStaticContent: (html, owner: any, anchor: any) => {const template = document.createElement('template');template.innerHTML = html;const first = template.content.firstChild!, last = template.content.lastChild!;owner.insertBefore(template.content, anchor);return [first,last]}})
      app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component, {...(parent ? props : {}), ref: (vm: any) => {if (vm) parentState.value = vm.$.setupState}})
        : runtime.h({render: () => null}, {key: 'cached'})})})
      app.provide(module.UI_I18N_KEY, context);app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {}
      app.mount(document.getElementById('app')!);await settle()
    } else await settle()
    const control = () => controls.at(-1)!, handles = () => ({...control().vnode.props})
    return {context, uiModule: module, props, visible, parentState, document, controls, requests, bundles, data,
      stored: () => stored.uiLanguage, foreign: (value: UiLanguage) => {stored = {...stored, uiLanguage: value};revision += 1;emit(stored)},
      control, handles, selector: () => control().parent!, open: async () => {handles().onVisibleChange?.(true);await settle()},
      change: (value: UiLanguage) => handles().onChange(value), pagehide: () => window.dispatchEvent(new dom.window.Event('pagehide')),
      unmount: () => {app?.unmount();app = undefined}, close: async () => {app?.unmount();context.dispose();await settle();await server.close();delete (globalThis as Record<string,unknown>)[key];vi.unstubAllGlobals()}}
  } catch (error) {app?.unmount();context?.dispose();await server.close();delete (globalThis as Record<string,unknown>)[key];vi.unstubAllGlobals();throw error}
}
