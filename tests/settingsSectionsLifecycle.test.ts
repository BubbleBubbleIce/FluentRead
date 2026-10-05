import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const key = '__frSettingsSectionsLifecycle';
let server: ViteDevServer | undefined, app: import('vue').App | undefined;
afterEach(async () => {app?.unmount(); app = undefined; await server?.close();server = undefined;
    delete (globalThis as Record<string, unknown>)[key];vi.unstubAllGlobals();vi.useRealTimers();});

function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
async function settle() {await runtime.nextTick();for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick();}
async function mountSections({ready = Promise.resolve()} = {}) {
    const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
    const query = vi.fn((_options: Record<string, unknown>) => Promise.resolve([] as {id?: number}[]));
    const send = vi.fn((_id: number, _message: {type: string; isEnabled?: boolean; mode?: string}) => Promise.resolve());
    const patch = vi.fn(() => Promise.resolve());const theme = vi.fn();const unsubscribe = vi.fn();
    const media = {matches: false, onchange: null as (() => void) | null};
    const location = {hash: '', search: '', protocol: 'chrome-extension:'};
    vi.stubGlobal('window', Object.assign(new EventTarget(), {location, navigator: {userAgent: ''}, matchMedia: () => media,
        requestAnimationFrame: (fn: FrameRequestCallback) => {frames.set(++nextFrame, fn);return nextFrame;},
        cancelAnimationFrame: (id: number) => frames.delete(id)}));
    const findTarget = vi.fn(() => null as HTMLElement | null);vi.stubGlobal('document', {querySelector: findTarget});
    const data = {config: {}, configReady: ready, subscribeConfig: () => unsubscribe, requestConfigPatch: patch,
        handoffPendingConfigPatches: vi.fn(() => Promise.resolve()), theme,
        browser: {runtime: {sendMessage: vi.fn(() => Promise.resolve())}, tabs: {query, sendMessage: send}}};
    (globalThis as Record<string, unknown>)[key] = data;
    const mocks: Plugin = {name: 'settings-sections-lifecycle-mocks', enforce: 'pre', resolveId(id) {
        if (id.endsWith('.vue') && !id.endsWith('/SettingsSections.vue')) return '\0sections-child';
        if (id.endsWith('/src/ui/i18n')) return '\0sections-i18n';
        if (id.endsWith('/src/services/config/store')) return '\0sections-config';
        if (id.endsWith('/src/ui/interfaceAppearance')) return '\0sections-appearance';
        if (id === 'webextension-polyfill') return '\0sections-browser';
        if (id === 'element-plus') return '\0sections-element';
        if (id === '@element-plus/icons-vue') return '\0sections-icons';
        if (id.endsWith('/src/platform/browser/capabilities')) return '\0sections-capabilities';return null;
    }, load(id) {
        if (id === '\0sections-child') return 'export default {render: () => null};';
        if (id === '\0sections-i18n') return `import {ref} from 'vue';export const useUiI18n = () => ({language: ref('zh-CN'), t: k => k, translateLegacy: t => t}); export const localizeServiceOptions = options => options;`;
        if (id === '\0sections-config') return `export const {config, configReady, subscribeConfig, requestConfigPatch, handoffPendingConfigPatches} = globalThis.${key};`;
        if (id === '\0sections-appearance') return `export const applyInterfaceTheme = globalThis.${key}.theme;`;
        if (id === '\0sections-browser') return `export default globalThis.${key}.browser;`;
        if (id === '\0sections-element') return 'export const ElMessage = Object.assign(() => {}, {warning: () => {}});';
        if (id === '\0sections-icons') return 'export const ArrowRight = {};export const InfoFilled = {};export const Edit = {};';
        if (id === '\0sections-capabilities') return "export const browserCapabilities = {browser: 'chrome'};";return null;
    }};
    server = await createServer({configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
        plugins: [mocks, vue()], resolve: {alias: {'@': resolve(process.cwd())}},
        ssr: {noExternal: ['element-plus', '@element-plus/icons-vue', 'webextension-polyfill']},server: {hmr: false, middlewareMode: true}});
    const component = (await server.ssrLoadModule('/src/features/settings/ui/SettingsSections.vue')).default;
    component.ssrRender = undefined;component.render = () => null;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
        remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
        setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
        setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
    const visible = runtime.ref(true);const props = runtime.reactive({activeSection: 'settings-translation', onNavigateSection: undefined as undefined | ((section: string, target?: string) => void)});
    let state!: Record<string, any>;
    app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
        : runtime.h({render: () => null}, {key: 'other'})})});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};
    app.mount({});await settle();
    return {state, props, visible, query, send, patch, theme, unsubscribe, frames, findTarget, location, data};
}

describe('设置主表单实际组件异步归属', () => {
    it('缓存离开时关闭全文与悬浮录制，恢复暂选模式，返回后仍可录制', async () => {
        const {state, visible} = await mountSections();vi.useFakeTimers();
        state.config.floatingBallHotkey = 'Shift+Q';state.handleHotkeyChange('custom');
        vi.advanceTimersByTime(100);expect(state.showCustomHotkeyDialog).toBe(true);
        visible.value = false;await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);expect(state.config.floatingBallHotkey).toBe('Shift+Q');
        state.handleCustomHotkeyConfirm('Alt+K');state.openCustomMouseHotkeyDialog();
        expect(state.config.customFloatingBallHotkey).toBe('');expect(state.showCustomMouseHotkeyDialog).toBe(false);
        visible.value = true;await settle();state.openCustomMouseHotkeyDialog();expect(state.showCustomMouseHotkeyDialog).toBe(true);
    });
    it('根组件导航时只委托定位，不再创建另一条逐帧查找链', async () => {
        const {state, props, frames} = await mountSections();const navigate = vi.fn();props.onNavigateSection = navigate;await settle();
        state.openSettingsSection('settings-interface', 'translation-sentence-highlight-style');
        expect(navigate).toHaveBeenCalledWith('settings-interface', 'translation-sentence-highlight-style');expect(frames.size).toBe(0);
    });
    it('独立定位最新操作取代旧操作，离开或卸载后旧帧不能滚动', async () => {
        const {state, frames, findTarget, visible} = await mountSections();const scroll = vi.fn();
        state.openSettingsSection('settings-sites', 'first');const stale = [...frames.values()][0];
        state.openSettingsSection('settings-services', 'second');expect(frames.size).toBe(1);
        findTarget.mockReturnValue({scrollIntoView: scroll} as unknown as HTMLElement);stale(0);expect(scroll).not.toHaveBeenCalled();
        visible.value = false;await settle();expect(frames.size).toBe(0);stale(0);expect(scroll).not.toHaveBeenCalled();
        visible.value = true;await settle();state.openSettingsSection('settings-sites', 'third');
        const late = [...frames.values()][0];app?.unmount();app = undefined;late(0);expect(scroll).not.toHaveBeenCalled();
    });
    it('卸载后到达的配置水合不改主题或提交旧配置', async () => {
        const ready = deferred<void>();const {theme, patch, unsubscribe} = await mountSections({ready: ready.promise});
        app?.unmount();app = undefined;ready.resolve();await settle();
        expect(theme).not.toHaveBeenCalled();expect(patch).not.toHaveBeenCalled();expect(unsubscribe).toHaveBeenCalledOnce();
    });
    it('快速设置更新共用一次标签页查询，发送最新状态，过滤非法 ID', async () => {
        const {state, query, send} = await mountSections();const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);
        for (let i = 0; i < 100; i++) state.floatingBallEnabled = i % 2 === 0;
        state.imageTranslationEnabled = true;state.config.on = false;state.handlePluginStateChange(false);await settle();
        expect(query).toHaveBeenCalledOnce();tabs.resolve([{id: 0}, {id: -1}, {}, {id: 3}]);await settle();
        expect(send.mock.calls.filter(([id]) => id === 0)).toHaveLength(4);
        expect(send.mock.calls.filter(([id]) => id === 3)).toHaveLength(4);
        expect(send.mock.calls.filter(([id]) => id !== 0 && id !== 3)).toHaveLength(0);
        expect(send.mock.calls.filter(([,message]) => message.type === 'toggleFloatingBall').every(([,message]) => message.isEnabled === false)).toBe(true);
        expect(send.mock.calls.filter(([,message]) => message.type === 'updateSelectionTranslatorMode').every(([,message]) => message.mode === 'disabled')).toBe(true);
    });
    it('拒绝查询后释放任务，随后仍能广播；卸载后的结果不继续发消息', async () => {
        const {state, query, send} = await mountSections();query.mockRejectedValueOnce(new Error('tabs unavailable'));
        state.floatingBallEnabled = true;await settle();expect(send).not.toHaveBeenCalled();
        query.mockResolvedValueOnce([{id: 1}]);state.floatingBallEnabled = false;await settle();expect(send).toHaveBeenCalledOnce();
        const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);state.imageTranslationEnabled = true;await settle();
        app?.unmount();app = undefined;tabs.resolve([{id: 1}]);await settle();expect(send).toHaveBeenCalledOnce();
    });
    it('服务列表直接复用已筛选能力结果，切换显示模式不会再分配同样的列表', async () => {
        const {state} = await mountSections();const first = state.configurationCompute.filteredServices;
        expect(first).toBe(state.availableServiceOptions);state.config.display = 2;await settle();
        expect(state.configurationCompute.filteredServices).toBe(first);
    });
    it('查询完成时采用外部最新模式和进度偏好，单个标签页同步异常不阻止其余消息', async () => {
        const {state, query, send} = await mountSections();const tabs = deferred<{id?: number}[]>();query.mockReturnValueOnce(tabs.promise);
        state.selectionAreaTranslationEnabled = true;state.config.translationProgressPanelEnabled = false;state.handleTranslationProgressPanelChange(false);
        state.config.selectionTranslatorMode = 'bilingual';await settle();
        state.config.selectionTranslatorMode = 'translation-only';state.config.translationProgressPanelEnabled = true;await settle();
        send.mockImplementationOnce(() => {throw new Error('closed tab');});send.mockRejectedValueOnce(new Error('missing content script'));
        tabs.resolve([{id: 1}, {id: 2}]);await settle();expect(query).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledTimes(6);
        expect(send).toHaveBeenCalledWith(2, {type: 'toggleTranslationProgressPanel', isEnabled: true});
        expect(send).toHaveBeenCalledWith(2, {type: 'updateSelectionTranslatorMode', mode: 'translation-only'});
    });
    it('已缓存或卸载时到达的规则检查不会继续导航或打开自定义服务', async () => {
        const {state, visible, props} = await mountSections();const navigate = vi.fn();props.onNavigateSection = navigate;await settle();
        const inspect = state.inspectSiteRule('stale');visible.value = false;await settle();await inspect;
        expect(navigate).not.toHaveBeenCalled();state.openCustomProviderDialog();expect(state.customProviderDialogOpen).toBe(false);
        visible.value = true;await settle();const late = state.inspectSiteRule('closed');app?.unmount();app = undefined;await late;
        expect(navigate).not.toHaveBeenCalled();
    });
});
