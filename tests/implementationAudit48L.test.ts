import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import type {Config} from '@/src/core/config/model';
import type {ContentFeatureDefinition, ContentFeatureRuntime} from '@/src/app/content/featureRegistry';

const ports = vi.hoisted(() => ({createUi: vi.fn(), writingMount: vi.fn(), writingUnmount: vi.fn()}));
vi.mock('@/src/platform/shadow-ui/vue', () => ({createVueShadowUi: ports.createUi}));
vi.mock('@/src/features/vocabulary/ui/SentenceActions.vue', () => ({default: {name: 'ControlledSentenceActions'}}));
// 未启用的兄弟功能不进入本次 DOM 证据；学习装配、注册表和句子挂载体均使用实际源码。
vi.mock('@/src/features/vocabulary/content/reencounter', () => ({mountVocabularyReencounter: vi.fn(), unmountVocabularyReencounter: vi.fn()}));
vi.mock('@/src/features/writing-assistant/public', () => ({mountWritingAssistant: ports.writingMount,
    unmountWritingAssistant: ports.writingUnmount, isWritingAssistantMounted: () => false}));

import {createLearningContentFeatures} from '@/src/app/content/learningFeatures';
import {createContentFeatureRegistry, rejectUnsupportedContentFeature, type ContentFeatureRegistry} from '@/src/app/content/featureRegistry';
import {mountSentenceActions, unmountSentenceActions, isSentenceActionsMounted} from '@/src/features/vocabulary/content/public';
import {browserCapabilities, resolveBrowserCapabilities} from '@/src/platform/browser/capabilities';

const ctx = {isInvalid: false} as ContentScriptContext;
const capabilities = resolveBrowserCapabilities({browser: 'chrome', manifestVersion: 3});
let document: Document;
let registries: ContentFeatureRegistry[];
interface ControlledSurface {shadowHost: HTMLElement; remove: ReturnType<typeof vi.fn>}
let surfaces: ControlledSurface[];
let listeners: Set<HTMLElement>;
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
    return {promise, resolve, reject};
}
function activation(controller = new AbortController(), isCurrent = () => !controller.signal.aborted): ContentFeatureRuntime {
    return {ctx, signal: controller.signal, isCurrent};
}
function surface(connected = true): ControlledSurface {
    const shadowHost = document.createElement('fluent-read-sentence-actions');
    shadowHost.id = 'fluent-read-sentence-actions';
    const root = shadowHost.attachShadow({mode: 'open'});
    root.append(document.createElement('button'));
    const click = () => undefined;
    root.addEventListener('click', click);
    listeners.add(shadowHost);
    if (connected) document.body.append(shadowHost);
    const ui = {shadowHost, remove: vi.fn(() => {
        root.removeEventListener('click', click);
        listeners.delete(shadowHost);
        shadowHost.remove();
    })};
    surfaces.push(ui);
    return ui;
}
function registry(features: ContentFeatureDefinition[], onError?: (id: string, phase: 'mount' | 'unmount', error: unknown) => void) {
    const result = createContentFeatureRegistry(features, {capabilities, onError});
    registries.push(result);
    return result;
}
function learning() {
    const config = {on: true, bilingualSentenceHighlightEnabled: true, writing: {enabled: false}};
    return {config, registry: registry(createLearningContentFeatures(ctx, config as Config, capabilities))};
}
function onlyStatus(rows: {status: string}[]) {return rows[0].status;}
beforeEach(() => {
    vi.clearAllMocks();
    document = parseHTML('<html><body><article><p>Original sentence <em>stays intact.</em></p></article></body></html>').document as unknown as Document;
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {location: {href: 'https://example.test/article'}});
    vi.stubGlobal('MutationObserver', vi.fn());
    registries = []; surfaces = []; listeners = new Set();
    ports.createUi.mockReset().mockImplementation(async () => surface());
});
afterEach(() => {
    registries.forEach(value => value.unmountAll());
    unmountSentenceActions();
    surfaces.forEach(ui => {if (listeners.has(ui.shadowHost)) ui.remove();});
    expect(listeners.size).toBe(0);
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('48L 真实学习装配与句子 UI 所有权', () => {
    it('实际宿主 remove 后查询为 false，公开 reconcile 仅替换旧 UI 并保留原文节点', async () => {
        const {registry: runtime} = learning();
        const article = document.querySelector('article')!, text = article.firstChild!.firstChild!, emphasis = article.querySelector('em')!;
        const original = article.innerHTML;
        expect(onlyStatus(await runtime.mountEnabled(activation()))).toBe('mounted');
        const old = surfaces[0]; old.shadowHost.remove();
        expect(old.shadowHost.isConnected).toBe(false);
        expect(isSentenceActionsMounted()).toBe(false);
        expect(old.remove).not.toHaveBeenCalled();
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('mounted');
        expect(ports.createUi).toHaveBeenCalledTimes(2);
        expect(old.remove).toHaveBeenCalledOnce();
        expect(surfaces[1].shadowHost.isConnected).toBe(true);
        expect(isSentenceActionsMounted()).toBe(true);
        expect(article.innerHTML).toBe(original);
        expect(article.firstChild!.firstChild).toBe(text); expect(article.querySelector('em')).toBe(emphasis);
        expect(listeners.size).toBe(1);
        await runtime.reconcileEnabled(); expect(ports.createUi).toHaveBeenCalledTimes(2);
        expect(ports.writingMount).not.toHaveBeenCalled();
    });
    it('宿主在同一文档内移动，以及协调前断开再接回，均复用同一 UI', async () => {
        const {registry: runtime} = learning(); await runtime.mountEnabled(activation());
        const old = surfaces[0], target = document.createElement('aside'); document.body.append(target);
        target.append(old.shadowHost); expect(isSentenceActionsMounted()).toBe(true);
        await runtime.reconcileEnabled();
        old.shadowHost.remove(); expect(isSentenceActionsMounted()).toBe(false);
        document.body.append(old.shadowHost); expect(isSentenceActionsMounted()).toBe(true);
        await runtime.reconcileEnabled();
        expect(ports.createUi).toHaveBeenCalledOnce(); expect(old.remove).not.toHaveBeenCalled();
    });
    it('祖先被移除后的恢复仅清理所属宿主，重新接回祖先不会复活旧 UI', async () => {
        const {registry: runtime} = learning(); await runtime.mountEnabled(activation());
        const parent = document.createElement('section'), hostText = document.createTextNode('Host-owned sibling');
        document.body.append(parent); parent.append(hostText, surfaces[0].shadowHost); parent.remove();
        expect(isSentenceActionsMounted()).toBe(false); await runtime.reconcileEnabled();
        expect(surfaces[0].remove).toHaveBeenCalledOnce(); expect(parent.firstChild).toBe(hostText);
        document.body.append(parent); expect(parent.childNodes).toHaveLength(1);
        expect(document.querySelectorAll('fluent-read-sentence-actions')).toHaveLength(1);
    });
    it('同 ID 的宿主页面节点不冒充所属 UI，也不会被恢复或卸载删除', async () => {
        const {registry: runtime} = learning(); await runtime.mountEnabled(activation()); surfaces[0].shadowHost.remove();
        const foreign = document.createElement('div'); foreign.id = 'fluent-read-sentence-actions'; foreign.textContent = 'Host text'; document.body.append(foreign);
        expect(isSentenceActionsMounted()).toBe(false); await runtime.reconcileEnabled(); runtime.unmountAll();
        expect(foreign.isConnected).toBe(true); expect(foreign.textContent).toBe('Host text');
    });
    it('已断开的所属 UI 遇到关闭配置仍释放资源，反复关闭不重复清理', async () => {
        const {config, registry: runtime} = learning(); await runtime.mountEnabled(activation());
        const old = surfaces[0]; old.shadowHost.remove(); config.on = false;
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('skipped'); await runtime.reconcileEnabled();
        expect(old.remove).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0); expect(isSentenceActionsMounted()).toBe(false);
        config.on = true; await runtime.reconcileEnabled(); expect(ports.createUi).toHaveBeenCalledTimes(2);
    });
    it('20 个并发恢复复用在途 Promise，后续 20 次协调不重复挂载、监听或观察', async () => {
        const {registry: runtime} = learning(); await runtime.mountEnabled(activation()); surfaces[0].shadowHost.remove();
        const gate = deferred<ReturnType<typeof surface>>(); ports.createUi.mockReturnValueOnce(gate.promise);
        const interval = vi.spyOn(globalThis, 'setInterval');
        const requests = Array.from({length: 20}, () => runtime.reconcileEnabled());
        expect(ports.createUi).toHaveBeenCalledTimes(2); gate.resolve(surface());
        expect((await Promise.all(requests)).every(rows => onlyStatus(rows) === 'mounted')).toBe(true);
        for (let i = 0; i < 20; i++) await runtime.reconcileEnabled();
        expect(ports.createUi).toHaveBeenCalledTimes(2); expect(surfaces).toHaveLength(2);
        expect(surfaces[0].remove).toHaveBeenCalledOnce(); expect(listeners.size).toBe(1);
        expect(MutationObserver).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    });
    it('恢复创建失败保留旧 UI 所有权，接回旧宿主后协调不会重复挂载', async () => {
        const {registry: runtime} = learning(); await runtime.mountEnabled(activation());
        const old = surfaces[0]; old.shadowHost.remove(); ports.createUi.mockRejectedValueOnce(new Error('controlled creation failure'));
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('failed'); expect(old.remove).not.toHaveBeenCalled();
        document.body.append(old.shadowHost); expect(isSentenceActionsMounted()).toBe(true);
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('mounted'); expect(ports.createUi).toHaveBeenCalledTimes(2);
    });
    it('创建结果仍断开时只重试一次并报告失败，下次显式协调可以恢复', async () => {
        const {registry: runtime} = learning(); ports.createUi.mockImplementationOnce(async () => surface(false)).mockImplementationOnce(async () => surface(false));
        expect(onlyStatus(await runtime.mountEnabled(activation()))).toBe('failed'); expect(ports.createUi).toHaveBeenCalledTimes(2);
        expect(surfaces[0].remove).toHaveBeenCalledOnce(); expect(surfaces[1].remove).not.toHaveBeenCalled();
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('mounted'); expect(ports.createUi).toHaveBeenCalledTimes(3);
        expect(surfaces[1].remove).toHaveBeenCalledOnce();
    });
    it('恢复等待期间关闭配置，迟到 UI 不留监听，重新开启只建立一个新 UI', async () => {
        const {config, registry: runtime} = learning(); await runtime.mountEnabled(activation()); surfaces[0].shadowHost.remove();
        const gate = deferred<ReturnType<typeof surface>>(); ports.createUi.mockReturnValueOnce(gate.promise);
        const pending = runtime.reconcileEnabled(); config.on = false;
        await runtime.reconcileEnabled(); const late = surface(); gate.resolve(late);
        expect(onlyStatus(await pending)).toBe('skipped'); expect(late.remove).toHaveBeenCalledOnce(); expect(listeners.size).toBe(0);
        config.on = true; await runtime.reconcileEnabled(); expect(ports.createUi).toHaveBeenCalledTimes(3); expect(listeners.size).toBe(1);
    });
    it('取消并卸载后，新激活先完成，旧迟到 UI 不影响新 host 或 pending 去重', async () => {
        const {registry: runtime} = learning(), oldController = new AbortController();
        const oldGate = deferred<ReturnType<typeof surface>>(), currentGate = deferred<ReturnType<typeof surface>>();
        ports.createUi.mockReturnValueOnce(oldGate.promise).mockReturnValueOnce(currentGate.promise);
        const oldRequest = runtime.mountEnabled(activation(oldController)); oldController.abort(); runtime.unmountAll();
        const currentRequest = runtime.mountEnabled(activation());
        const late = surface(); oldGate.resolve(late); expect(onlyStatus(await oldRequest)).toBe('skipped');
        const duplicate = runtime.reconcileEnabled(); expect(ports.createUi).toHaveBeenCalledTimes(2);
        const current = surface(); currentGate.resolve(current);
        expect(onlyStatus(await currentRequest)).toBe('mounted'); expect(onlyStatus(await duplicate)).toBe('mounted');
        expect(late.remove).toHaveBeenCalledOnce(); expect(current.remove).not.toHaveBeenCalled(); expect(isSentenceActionsMounted()).toBe(true);
    });
    it('直接挂载逆序完成只留下最新 owner，卸载后的迟到 UI 也被释放', async () => {
        const oldGate = deferred<ReturnType<typeof surface>>(), currentGate = deferred<ReturnType<typeof surface>>();
        ports.createUi.mockReturnValueOnce(oldGate.promise).mockReturnValueOnce(currentGate.promise);
        const oldRequest = mountSentenceActions(ctx), currentRequest = mountSentenceActions(ctx), current = surface();
        currentGate.resolve(current); await currentRequest; const old = surface(); oldGate.resolve(old); await oldRequest;
        expect(old.remove).toHaveBeenCalledOnce(); expect(current.remove).not.toHaveBeenCalled(); expect(isSentenceActionsMounted()).toBe(true);
        const lateGate = deferred<ReturnType<typeof surface>>(); ports.createUi.mockReturnValueOnce(lateGate.promise);
        const lateRequest = mountSentenceActions(ctx); unmountSentenceActions(); const late = surface(); lateGate.resolve(late); await lateRequest;
        expect(current.remove).toHaveBeenCalledOnce(); expect(late.remove).toHaveBeenCalledOnce(); expect(isSentenceActionsMounted()).toBe(false);
    });
});

describe('48L 注册表公开状态合同', () => {
    it('未注入 options 时使用生产浏览器能力门控，而不是绕过默认能力', async () => {
        const mount = vi.fn(), isEnabled = vi.fn(() => true);
        const runtime = createContentFeatureRegistry([{id: 'default-capability', requiredCapability: 'imageTranslation', isEnabled, mount}]);
        registries.push(runtime);
        expect(onlyStatus(await runtime.mountEnabled(activation()))).toBe(browserCapabilities.imageTranslation ? 'mounted' : 'skipped');
        expect(mount).toHaveBeenCalledTimes(browserCapabilities.imageTranslation ? 1 : 0);
    });
    it('显式 false 不被历史 Set 覆盖，显式外部 true 仍兼容并归入清理所有权', async () => {
        let actual = true, enabled = true; const mount = vi.fn(() => {actual = true;}), unmount = vi.fn(() => {actual = false;});
        const runtime = registry([{id: 'external', isEnabled: () => enabled, isMounted: () => actual, mount, unmount}]);
        await runtime.mountEnabled(activation()); expect(mount).not.toHaveBeenCalled(); actual = false;
        await runtime.reconcileEnabled(); expect(mount).toHaveBeenCalledOnce();
        enabled = false; await runtime.reconcileEnabled(); expect(unmount).toHaveBeenCalledOnce();
    });
    it('没有 isMounted 的定义继续由 Set 去重，关闭并重开才重新挂载', async () => {
        let enabled = true; const mount = vi.fn(), unmount = vi.fn();
        const runtime = registry([{id: 'set-only', isEnabled: () => enabled, mount, unmount}]);
        await runtime.mountEnabled(activation()); await runtime.reconcileEnabled(); expect(mount).toHaveBeenCalledOnce();
        enabled = false; await runtime.reconcileEnabled(); enabled = true; await runtime.reconcileEnabled();
        expect(mount).toHaveBeenCalledTimes(2); expect(unmount).toHaveBeenCalledOnce();
    });
    it('空激活、已取消及已失效激活均不读取启用条件', async () => {
        const isEnabled = vi.fn(() => true), mount = vi.fn(), runtime = registry([{id: 'inactive', isEnabled, mount}]);
        expect(onlyStatus(await runtime.reconcileEnabled())).toBe('skipped');
        const controller = new AbortController(); controller.abort(); await runtime.mountEnabled(activation(controller));
        await runtime.mountEnabled(activation(new AbortController(), () => false)); expect(isEnabled).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled();
    });
    it('不支持的 capability 先于配置门控，支持的定义按注册顺序执行', async () => {
        const disabled = vi.fn(() => true), mount = vi.fn(), runtime = createContentFeatureRegistry([
            {id: 'unsupported', requiredCapability: 'imageTranslation', isEnabled: disabled, mount},
            {id: 'healthy', isEnabled: () => true, mount},
        ], {capabilities: resolveBrowserCapabilities({browser: 'userscript', manifestVersion: 2})}); registries.push(runtime);
        expect((await runtime.mountEnabled(activation())).map(row => row.status)).toEqual(['skipped', 'mounted']);
        expect(disabled).not.toHaveBeenCalled(); expect(mount).toHaveBeenCalledOnce();
    });
    it('挂载异常上报但不阻断后续功能，无清理回调也可关闭', async () => {
        let enabled = true; const error = new Error('controlled mount failure'), onError = vi.fn(), later = vi.fn();
        const runtime = registry([{id: 'broken', isEnabled: () => true, mount: () => {throw error;}}, {id: 'healthy', isEnabled: () => enabled, mount: later}], onError);
        expect((await runtime.mountEnabled(activation())).map(row => row.status)).toEqual(['failed', 'mounted']);
        expect(onError).toHaveBeenCalledWith('broken', 'mount', error); expect(later).toHaveBeenCalledOnce();
        enabled = false; await runtime.reconcileEnabled();
    });
    it('等待中激活失效且 mount 拒绝时不报告产品错误，也不启动后续功能', async () => {
        let current = true; const gate = deferred<void>(), later = vi.fn(), onError = vi.fn();
        const runtime = registry([{id: 'pending', isEnabled: () => true, mount: () => gate.promise}, {id: 'later', isEnabled: () => true, mount: later}], onError);
        const pending = runtime.mountEnabled(activation(new AbortController(), () => current)); current = false; gate.reject(new Error('cancelled port'));
        expect((await pending).map(row => row.status)).toEqual(['skipped', 'skipped']); expect(onError).not.toHaveBeenCalled(); expect(later).not.toHaveBeenCalled();
    });
    it('没有状态查询的迟到挂载关闭时仍卸载，当前失效则不清理新激活的 singleton', async () => {
        let enabled = true, current = true; const unmount = vi.fn();
        const runtime = registry([{id: 'config-close', isEnabled: () => enabled, mount: () => {enabled = false;}, unmount},
            {id: 'activation-close', isEnabled: () => true, mount: () => {current = false;}, unmount}]);
        expect((await runtime.mountEnabled(activation(new AbortController(), () => current))).map(row => row.status)).toEqual(['skipped', 'skipped']);
        expect(unmount).toHaveBeenCalledOnce();
    });
    it('卸载异常仍清掉 Set，逆序总清理继续释放其他定义', async () => {
        let enabled = true; const error = new Error('controlled remove failure'), onError = vi.fn(), mount = vi.fn(), order: string[] = [];
        const runtime = registry([{id: 'first', isEnabled: () => enabled, mount, unmount: () => {order.push('first');}},
            {id: 'last', isEnabled: () => enabled, mount, unmount: () => {order.push('last'); throw error;}}], onError);
        await runtime.mountEnabled(activation()); enabled = false; await runtime.reconcileEnabled();
        expect(onError).toHaveBeenCalledWith('last', 'unmount', error); enabled = true; await runtime.reconcileEnabled(); expect(mount).toHaveBeenCalledTimes(4);
        order.length = 0; runtime.unmountAll(); expect(order).toEqual(['last', 'first']);
    });
    it('unsupported 公共帮助函数保留受支持入口，拒绝入口只清理一次并返回明确响应', () => {
        const unmount = vi.fn(), send = vi.fn();
        expect(rejectUnsupportedContentFeature(true, unmount, send, 'unsupported')).toBe(false); expect(unmount).not.toHaveBeenCalled();
        expect(rejectUnsupportedContentFeature(false, unmount, send, 'unsupported')).toBe(true);
        expect(unmount).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledWith({status: 'unsupported', error: 'unsupported'});
    });
});
