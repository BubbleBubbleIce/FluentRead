import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 编译两个实际统计 SFC，验证迟到消息与卸载；原生模板、焦点和布局由生产浏览器专项验证。
const key = '__fluentReadUsageDashboardLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let server: ViteDevServer;
let app: import('vue').App | undefined;
let state: Record<string, any>;
let messages: Array<{message: Record<string, any>; resolve: (value: unknown) => void}>;
let attributes: Map<string, string>;
let listeners: Set<unknown>;
let subscriptions: Set<unknown>;

function mocks(): Plugin {
    return {name: 'usage-dashboard-lifecycle-mocks', enforce: 'pre', resolveId(id) {
        if (id === 'webextension-polyfill') return '\0usage-browser';
        if (id === 'element-plus') return '\0usage-element';
        if (/\/(?:UiIcon|UiSelect|ServiceIcon)\.vue$/u.test(id)) return '\0usage-component';
        if (/\/src\/services\/config\/store(?:\.ts)?$/u.test(id)) return '\0usage-config';
        if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0usage-i18n';
        return null;
    }, load(id) {
        if (id === '\0usage-browser') return `export default {runtime: {sendMessage: globalThis.${key}.sendMessage}}`;
        if (id === '\0usage-element') return 'export const ElOption = {}; export const ElPopover = {}; export const ElTooltip = {};';
        if (id === '\0usage-component') return 'export default {}';
        if (id === '\0usage-config') return `const s = globalThis.${key}; export const config = {customOpenAIProviders: []}; export const subscribeConfig = s.subscribeConfig;`;
        if (id === '\0usage-i18n') return `import {ref} from 'vue'; export const useUiI18n = () => ({language: ref('zh-CN'), t: key => key, translateLegacy: text => text});`;
        return null;
    }};
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {await Promise.resolve(); await runtime.nextTick();}
}

async function mount(kind: 'model' | 'stats', active = true): Promise<void> {
    const path = kind === 'model' ? 'model-usage/ui/ModelUsageDashboard' : 'translation-stats/ui/TranslationStatsDashboard';
    const component = (await server.ssrLoadModule(`/src/features/${path}.vue`)).default;
    component.ssrRender = undefined;
    component.render = () => null;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
        patchProp: () => undefined, insert: () => undefined, remove: () => undefined, createElement: () => ({}),
        createText: () => ({}), createComment: () => ({}), setText: () => undefined, setElementText: () => undefined,
        parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
        cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
    });
    app = renderer.createApp(component, {active});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => undefined;
    const vm = app.mount({});
    state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
    await settle();
}

beforeEach(async () => {
    app = undefined;
    messages = []; attributes = new Map(); listeners = new Set(); subscriptions = new Set();
    const settings = {
        hasAttribute: (name: string) => attributes.has(name),
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
    };
    vi.stubGlobal('document', {visibilityState: 'visible', querySelector: () => settings,
        addEventListener: (_name: string, listener: unknown) => listeners.add(listener),
        removeEventListener: (_name: string, listener: unknown) => listeners.delete(listener)});
    Object.assign(globalThis, {[key]: {
        sendMessage: (message: Record<string, any>) => new Promise(resolve => messages.push({message, resolve})),
        subscribeConfig: (listener: unknown) => {subscriptions.add(listener); return () => subscriptions.delete(listener);},
    }});
    server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', plugins: [mocks(), vue()],
        root: process.cwd(), resolve: {alias: {'@': resolve(process.cwd(), '.')}},
        server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill', 'element-plus']}});
});

afterEach(async () => {
    app?.unmount();
    await server?.close();
    delete (globalThis as any)[key];
    vi.unstubAllGlobals();
});

describe.each(['model', 'stats'] as const)('%s 统计面板真实组件生命周期', (kind) => {
    it('卸载后迟到的清除成功不得查询、写状态或解除新弹窗的背景禁用', async () => {
        await mount(kind);
        await state.openResetDialog();
        const pending = kind === 'model' ? state.resetUsage() : state.resetStats();
        const reset = messages.find(item => item.message.action === 'reset')!;
        expect(reset).toBeDefined();
        app!.unmount(); app = undefined;
        attributes.set('inert', 'new-dialog');
        reset.resolve({success: true, data: {cleared: true}});
        await settle();
        // 若错误实现继续查询，先放行才能收集完整失败而不留下悬挂任务。
        for (const item of messages) if (item !== reset) item.resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await pending;
        expect(messages.filter(item => item.message.action === 'query')).toHaveLength(1);
        expect(attributes.get('inert')).toBe('new-dialog');
        expect(state.resetMessage).toBe('');
        expect(listeners.size).toBe(0);
        expect(subscriptions.size).toBe(0);
    });

    it('卸载后迟到的清除失败不得修改组件错误状态', async () => {
        await mount(kind);
        await state.openResetDialog();
        const pending = kind === 'model' ? state.resetUsage() : state.resetStats();
        app!.unmount(); app = undefined;
        messages.find(item => item.message.action === 'reset')!.resolve({success: false, error: 'late-reset-error'});
        await pending;
        expect(state.resetError).toBe('');
    });

    it('未打开弹窗的隐藏面板卸载时不得解除已有背景禁用', async () => {
        attributes.set('inert', 'other-dialog');
        await mount(kind, false);
        app!.unmount(); app = undefined;
        expect(messages).toEqual([]);
        expect(attributes.get('inert')).toBe('other-dialog');
    });

    it('关闭弹窗保留原有 inert，自己设置的 inert 在卸载时释放', async () => {
        await mount(kind, false);
        attributes.set('inert', 'preexisting');
        await state.openResetDialog();
        state.closeResetDialog();
        expect(attributes.get('inert')).toBe('preexisting');
        attributes.delete('inert');
        await state.openResetDialog();
        expect(attributes.has('inert')).toBe(true);
        app!.unmount(); app = undefined;
        expect(attributes.has('inert')).toBe(false);
    });

    it('卸载后不再发送快照或请求列表查询', async () => {
        await mount(kind);
        messages[0].resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await settle();
        app!.unmount(); app = undefined;
        const snapshot = state.loadSnapshot();
        await settle();
        for (const item of messages.slice(1)) item.resolve({success: true, data: {selected: {totals: {requestCount: 0}}}});
        await snapshot;
        const page = state.loadRequestPage(0);
        await settle();
        for (const item of messages.slice(1)) item.resolve({success: true, data: {items: [], totalCount: 0, offset: 0}});
        await page;
        expect(messages).toHaveLength(1);
    });
});
