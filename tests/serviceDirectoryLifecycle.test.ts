/**
 * @file tests/serviceDirectoryLifecycle.test.ts
 * 文件职责：验证服务目录和免费权重设置的实际组件生命周期、缓存模板及有界读取。
 * 主要内容：覆盖停用与切换、迟到后台快照、轮询合并、目录焦点、搜索计算与旧 DOM 事件。
 * 模块边界：编译真实 Vue setup 和缓存客户端模板，浏览器消息和展示控件使用受控端口；真实 UI 另行验证。
 */
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import vue from '@vitejs/plugin-vue'
import {createServer, type ViteDevServer} from 'vite'
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc'
import ts from 'typescript'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {calculateFreeTranslationWeightSnapshot, FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS} from '@/src/services/translation/freeWeights'

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue')
let server: ViteDevServer, app: import('vue').App, state: Record<string, any>, props: Record<string, any>
let shown: import('vue').Ref<boolean>, nodes: Node[]
type Node = {tag: string; props: Record<string, any>; value?: string; focus?: () => void; closest?: () => unknown; parent?: Node; children?: Node[]}
const focus = vi.fn(), scroll = vi.fn(), emitted = vi.fn(), send = vi.fn()
const intervals = new Map<number, () => void>(), timeouts = new Map<number, () => void>()
let timerId = -1
const timerCount = () => intervals.size + timeouts.size
async function tickIntervals(count = 1) {for (let i = 0; i < count; i++) {for (const callback of [...intervals.values()]) callback();await settle()}}
const providerNames = ['microsoft', 'google']
const catalog = [{value: 'machine', label: 'Machine', disabled: true}, {value: 'microsoft', label: 'Microsoft'}, {value: 'google', label: 'Google'}]
async function settle() {await runtime.nextTick();await Promise.resolve();await runtime.nextTick();await Promise.resolve()}
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no});return {promise, resolve, reject}}
function response(ids = props.config.freeTranslationOrder) {return {success: true, snapshot: calculateFreeTranslationWeightSnapshot(ids, [], 123)}}
function node(predicate: (n: Node) => boolean) {const found = [...nodes].reverse().find(predicate);expect(found).toBeDefined();return found!}
beforeEach(async () => {
  vi.clearAllMocks();intervals.clear();timeouts.clear();send.mockReset();send.mockResolvedValue({success: false});vi.stubGlobal('__fluentreadDirectorySend', send)
  server = await createServer({root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'silent',
    resolve: {alias: {'@': process.cwd()}}, server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill']},
    plugins: [{name: 'service-directory-controlled-ports', enforce: 'pre', resolveId(id) {
      if (id === 'webextension-polyfill') return '\0directory-browser'
      if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0directory-i18n'
      if (id.endsWith('.vue') && !/\/(?:ServiceCatalog|FreeTranslationSettings)\.vue$/u.test(id)) return '\0directory-display'
      return null
    }, load(id) {
      if (id === '\0directory-browser') return 'export default {runtime: {sendMessage: (...args) => globalThis.__fluentreadDirectorySend(...args)}}'
      if (id === '\0directory-i18n') return 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text})'
      if (id === '\0directory-display') return "import {h} from 'vue';export default {setup(_, {attrs, slots}) {return () => h('button', {...attrs, 'data-directory-port': attrs.item?.value}, slots.default?.())}}"
      return null
    }}, vue()]})
})
afterEach(async () => {app?.unmount();await settle();vi.restoreAllMocks();await server?.close();vi.unstubAllGlobals()})
async function mount(name: string, values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  const path = `src/features/settings/ui/services/${name}.vue`, filename = resolve(path)
  const component = (await server.ssrLoadModule(`/${path}`)).default, {descriptor} = parse(readFileSync(filename, 'utf8'), {filename})
  const bindings = compileScript(descriptor, {id: 'directory-lifecycle'}).bindings
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'directory-lifecycle',
    compilerOptions: {mode: 'function', cacheHandlers: true, bindingMetadata: bindings, expressionPlugins: ['typescript']}})
  expect(template.errors).toEqual([]);component.ssrRender = undefined
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime)
  if (!vi.isMockFunction(globalThis.setInterval)) {
    const originalInterval = globalThis.setInterval, originalTimeout = globalThis.setTimeout, clearInterval = globalThis.clearInterval, clearTimeout = globalThis.clearTimeout
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number, ...args: any[]) => {
      if (ms !== FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS) return originalInterval(callback, ms, ...args)
      const id = timerId--;intervals.set(id, callback);return id
    }) as typeof setInterval)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: any) => {if (!intervals.delete(id)) clearInterval(id)}) as typeof globalThis.clearInterval)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number, ...args: any[]) => {
      if (ms !== 10_000) return originalTimeout(callback, ms, ...args)
      const id = timerId--;timeouts.set(id, callback);return id
    }) as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: any) => {if (!timeouts.delete(id)) clearTimeout(id)}) as typeof globalThis.clearTimeout)
  }
  nodes = [];shown = runtime.ref(true)
  function remove(n: Node) {if (n.parent?.children) {const list = n.parent.children, index = list.indexOf(n);if (index >= 0) list.splice(index, 1)}n.parent = undefined}
  function insert(n: Node, parent: Node, anchor?: Node | null) {remove(n);const list = parent.children ||= [];const index = anchor ? list.indexOf(anchor) : -1;list.splice(index < 0 ? list.length : index, 0, n);n.parent = parent}
  const renderer = runtime.createRenderer<Node, Node>({patchProp: (n, key, _before, value) => {n.props[key] = value;if (key === 'value') n.value = value}, insert, remove,
    createElement: tag => {const n = {tag, tagName: tag.toUpperCase(), value: '', props: {}, focus, addEventListener: () => {}, removeEventListener: () => {}, closest: () => ({querySelector: () => ({scrollTo: scroll})})};nodes.push(n);return n},
    createText: () => ({tag: '#text', props: {}}), createComment: () => ({tag: '#comment', props: {}}), setText: () => {}, setElementText: () => {},
    parentNode: n => n.parent || null, nextSibling: n => {const list = n.parent?.children || [];return list[list.indexOf(n) + 1] || null}, querySelector: () => null, setScopeId: () => {}, cloneNode: n => ({...n}),
    insertStaticContent: (_html, parent, anchor) => {const start = {tag: '#static-start', props: {}}, end = {tag: '#static-end', props: {}};insert(start, parent, anchor);insert(end, parent, anchor);return [start, end]}})
  const source = runtime.shallowReactive({active: true, context: {}, ...values})
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component, {...source, ...listeners, ref: (vm: any) => {if (vm) {state = vm.$.setupState;props = vm.$.props}}})
    : runtime.h({render: () => null}, {key: 'other'})})})
  const display = {setup(_props: unknown, {attrs, slots}: any) {return () => runtime.h('input', attrs, slots.default?.())}}
  app.component('el-input', display);app.component('el-input-number', display);app.component('el-switch', display)
  app.component('el-tooltip', {setup(_props: unknown, {slots}: any) {return () => runtime.h('span', null, slots.default?.())}})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};app.mount({tag: '#root', props: {}});await settle()
}
async function mountFree(values: Record<string, unknown> = {}) {await mount('FreeTranslationSettings', {config: runtime.reactive(new Config()), ...values})}
async function mountCatalog(values: Record<string, unknown> = {}) {await mount('ServiceCatalog', {service: 'microsoft', defaultService: 'microsoft', services: catalog,
  favoriteServices: [], configuredServices: [], modelOptions: [], showModel: false, maximumModels: 5, maximumModelLength: 50, customModelCount: 0, allowCustomModels: false, ...values}, {'onUpdate:service': emitted, 'onAdd:service': emitted})}
function invalidate(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'cached') shown.value = false
  if (reason === 'unmount') app.unmount()
  if (reason === 'config') props.config = runtime.reactive(new Config())
  if (reason === 'context') props.context = {}
  if (reason === 'advanced') props.advanced = true
  if (reason === 'sequential') props.config.freeTranslationMode = 'sequential'
  if (reason === 'service') props.service = 'google'
}

describe('免费设置的轮询和模板事件归属', () => {
  it.each(['hidden', 'cached', 'unmount', 'config', 'advanced', 'sequential'])('%s之后丢弃旧权重响应，停用时不再轮询', async reason => {
    const pending = deferred<unknown>();send.mockReturnValueOnce(pending.promise);await mountFree();const old = response();expect(send).toHaveBeenCalledOnce()
    invalidate(reason);await settle();pending.resolve(old);await settle();expect(state.weightSnapshot?.observedAt).not.toBe(123)
    if (reason !== 'config') {await tickIntervals(2);expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(0)}
  })
  it('初始顺序策略与高级字段不创建权重计时器，回到分流模式创建一条轮询', async () => {
    const config = runtime.reactive(new Config());config.freeTranslationMode = 'sequential';await mountFree({config});expect(send).not.toHaveBeenCalled();expect(timerCount()).toBe(0)
    state.setMode('balanced');await settle();expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(1)
    props.advanced = true;await settle();expect(timerCount()).toBe(0);props.advanced = false;await settle();expect(send).toHaveBeenCalledTimes(2);expect(timerCount()).toBe(1)
  })
  it('同一轮读取合并并发调用，完成后允许下一轮', async () => {
    await mountFree();send.mockClear();const pending = deferred<unknown>();send.mockReturnValue(pending.promise)
    const first = state.refreshWeights(), second = state.refreshWeights();expect(send).toHaveBeenCalledOnce();pending.resolve(response());await Promise.all([first, second]);expect(state.weightSnapshot.observedAt).toBe(123)
    send.mockResolvedValue({success: false});await state.refreshWeights();expect(send).toHaveBeenCalledTimes(2);expect(state.weightSnapshot).toBeNull()
  })
  it('同一渲染批次中的顺序变更只读取最终一次，旧状态立即回退本地', async () => {
    await mountFree();state.weightSnapshot = response().snapshot;send.mockClear()
    props.config.freeTranslationOrder = ['microsoft'];props.config.freeTranslationOrder = [...providerNames];props.config.myMemoryEmail = 'fixture@example.test'
    expect(state.weightSnapshot).toBeNull();await settle();expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(1)
  })
  it('悬挂读取十秒结束等待，迟到失败不污染下一轮且没有未处理拒绝', async () => {
    await mountFree();const pending = deferred<unknown>();send.mockReturnValueOnce(pending.promise);let ended = false
    void state.refreshWeights().then(() => {ended = true});for (const callback of [...timeouts.values()]) callback();await settle();expect(ended).toBe(true);expect(state.weightSnapshot).toBeNull()
    send.mockResolvedValue(response());await state.refreshWeights();expect(state.weightSnapshot.observedAt).toBe(123);pending.reject(new Error('late'));await settle();expect(state.weightSnapshot.observedAt).toBe(123);expect(timerCount()).toBe(1)
  })
  it('拒绝后台仍属于旧启停集合的快照，保留当前全目录和本地分配', async () => {
    await mountFree();send.mockResolvedValue(response(['google']));await state.refreshWeights();expect(state.weightSnapshot).toBeNull();expect(state.displayedWeightSnapshot.entries).toHaveLength(13)
    send.mockResolvedValue(response());await state.refreshWeights();expect(state.weightSnapshot.observedAt).toBe(123)
  })
  it.each(['entries', 'total', 'weight', 'provider', 'status'])('损坏的%s快照回退本地而不使模板崩溃', async reason => {
    await mountFree();const value = response() as any
    if (reason === 'entries') value.snapshot.entries = null
    if (reason === 'total') value.snapshot.total = Number.NaN
    if (reason === 'weight') value.snapshot.entries[0].weight = -1
    if (reason === 'provider') value.snapshot.entries[0].providerId = 'unknown'
    if (reason === 'status') value.snapshot.entries[0].status = 'unknown'
    send.mockResolvedValue(value);await state.refreshWeights();expect(state.weightSnapshot).toBeNull();await settle()
  })
  it('实际缓存模板的旧模式、开关和邮箱事件不得写入新配置', async () => {
    await mountFree();const mode = node(n => n.props.value === 'sequential').props.onChange
    const toggle = node(n => n.props['aria-label'] === '启用 DeepLX').props['onUpdate:modelValue']
    const email = node(n => n.props['aria-label'] === 'settings.services.library.memoryEmail');const update = email.props['onUpdate:modelValue'], commit = email.props.onChange
    invalidate('config');await settle();mode();toggle(true);update('late@example.test');commit()
    expect(props.config.freeTranslationMode).toBe('balanced');expect(props.config.freeTranslationOrder).not.toContain('deeplx');expect(props.config.myMemoryEmail).toBe('');expect(state.myMemoryEmailDraft).toBe('')
    node(n => n.props.value === 'sequential').props.onChange();expect(props.config.freeTranslationMode).toBe('sequential')
  })
  it('隐藏清空未提交邮箱并拒绝直接动作，重开不复活旧超时回调', async () => {
    await mountFree();state.myMemoryEmailDraft = 'draft@example.test';invalidate('hidden');await settle();expect(state.myMemoryEmailDraft).toBe('')
    state.setMode('sequential');state.toggle('deeplx', true);state.move('microsoft', 1);state.myMemoryEmailDraft = 'late@example.test';state.commitMyMemoryEmail();expect(props.config.myMemoryEmail).toBe('');expect(props.config.freeTranslationMode).toBe('balanced');expect(props.config.freeTranslationOrder).not.toContain('deeplx')
    app.unmount();await mountFree({advanced: true});const old = node(n => n.props['aria-label'] === '每个服务最多等待（秒）').props['onUpdate:modelValue'];const initial = props.config.freeTranslationTimeoutMs
    props.active = false;await settle();props.active = true;await settle();old(9);expect(props.config.freeTranslationTimeoutMs).toBe(initial)
    node(n => n.props['aria-label'] === '每个服务最多等待（秒）').props['onUpdate:modelValue'](9);expect(props.config.freeTranslationTimeoutMs).toBe(9000)
  })
  it('未知模式、非布尔开关与分流模式排序不写入配置', async () => {
    await mountFree();const original = props.config.freeTranslationOrder.slice();state.setMode('unknown');state.toggle('deeplx', 'yes');state.move('microsoft', 1)
    expect(props.config.freeTranslationMode).toBe('balanced');expect(props.config.freeTranslationOrder).toEqual(original)
    state.setMode('sequential');state.move('microsoft', 2);expect(props.config.freeTranslationOrder).toEqual(original);state.move('microsoft', 1);expect(props.config.freeTranslationOrder[1]).toBe('microsoft')
  })
  it('冷却总量为零的完整快照正常显示，读取失败回退且恢复支持新请求', async () => {
    await mountFree();const ids = props.config.freeTranslationOrder
    const snapshot = calculateFreeTranslationWeightSnapshot(ids, ids.map((providerId: string) => ({providerId, retryAt: 1000, failures: 1, category: 'network' as const})), 123)
    send.mockResolvedValueOnce({success: true, snapshot});await state.refreshWeights();expect(state.displayedWeightSnapshot.total).toBe(0);expect(state.weightStatus('microsoft')).toBe('cooling')
    send.mockRejectedValueOnce(new Error('offline'));await state.refreshWeights();expect(state.weightSnapshot).toBeNull()
    send.mockResolvedValueOnce(response());await state.refreshWeights();expect(state.weightStatus('microsoft')).toBe('ready')
  })
  it('省略可选 active 属性仍可正常读取与选择服务', async () => {
    await mountFree({active: undefined});expect(send).toHaveBeenCalledOnce();app.unmount();await mountCatalog({active: undefined});state.selectService('google');expect(emitted).toHaveBeenCalledWith('google')
  })
})

describe('服务目录的搜索和导航归属', () => {
  it('空搜索不读取逐项搜索字段，有关键词时缓存文本并在目录更新后失效', async () => {
    let reads = 0
    const item = runtime.reactive({value: 'custom:fixture', label: 'Fixture', get description() {reads++;return 'Ｆｕｌｌ Width'}, searchTerms: ['Alias']})
    await mountCatalog({services: [item]});reads = 0;state.serviceQuery = ' ';await settle();expect(reads).toBe(0)
    state.serviceQuery = 'full';await settle();expect(state.visibleDirectoryGroups[0].items[0].value).toBe('custom:fixture');const first = reads;expect(first).toBeGreaterThan(0)
    state.serviceQuery = 'ALIAS';await settle();expect(reads).toBe(first);state.serviceQuery = 'missing';await settle();expect(state.visibleDirectoryGroups).toEqual([]);expect(reads).toBe(first)
    item.label = 'Missing';await settle();expect(state.visibleDirectoryGroups[0].items[0].label).toBe('Missing');expect(reads).toBeGreaterThan(first)
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('实际缓存模板的旧目录选择在%s之后失效', async reason => {
    await mountCatalog();const old = node(n => n.props['data-directory-port'] === 'google').props.onSelect
    invalidate(reason);await settle();old('google');expect(emitted).not.toHaveBeenCalled()
    if (reason === 'service' || reason === 'context') {const target = reason === 'service' ? 'microsoft' : 'google';node(n => n.props['data-directory-port'] === target).props.onSelect(target);expect(emitted).toHaveBeenCalledWith(target)}
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('目录延迟焦点与滚动在%s之后失效', async reason => {
    await mountCatalog();state.directoryOpen = true;state.directoryToggle = {focus};state.addButton = {closest: () => ({querySelector: () => ({scrollTo: scroll})})}
    props.service = 'google';if (reason === 'service') props.service = 'microsoft';else invalidate(reason);await settle();expect(focus).not.toHaveBeenCalled()
    if (reason === 'service') expect(scroll).toHaveBeenCalledOnce();else expect(scroll).not.toHaveBeenCalled()
  })
  it('正常切换关闭目录、恢复一次焦点并滚动，重复当前服务只收起目录', async () => {
    await mountCatalog();state.directoryOpen = true;props.service = 'google';await settle();expect(state.directoryOpen).toBe(false);expect(focus).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce()
    focus.mockClear();scroll.mockClear();state.directoryOpen = true;await state.selectService('google');await settle();expect(focus).toHaveBeenCalledOnce();expect(scroll).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled()
  })
  it('隐藏或替换上下文后旧搜索、创建和展开回调不能修改当前目录', async () => {
    await mountCatalog();const search = node(n => n.tag === 'input').props.onInput
    const add = node(n => n.props['data-testid'] === 'custom-service-add').props.onClick, open = node(n => n.props.class === 'mobile-directory-toggle').props.onClick
    state.serviceQuery = 'draft';state.directoryOpen = true;invalidate('hidden');await settle();expect(state.directoryOpen).toBe(false);expect(state.serviceQuery).toBe('')
    props.active = true;await settle();search({currentTarget: {value: 'late'}});add();open();expect(state.directoryOpen).toBe(false);expect(state.serviceQuery).toBe('');expect(emitted).not.toHaveBeenCalled()
    node(n => n.props['data-testid'] === 'custom-service-add').props.onClick();expect(emitted).toHaveBeenCalledOnce()
  })
  it('拒绝目录标题、未知服务和停用动作，配置选择与默认服务保持分离', async () => {
    await mountCatalog();state.selectService('machine');state.selectService('missing');expect(emitted).not.toHaveBeenCalled();state.selectService('google');expect(emitted).toHaveBeenCalledWith('google');expect(props.defaultService).toBe('microsoft')
    emitted.mockClear();props.active = false;await settle();state.selectService('google');expect(emitted).not.toHaveBeenCalled()
  })
})
