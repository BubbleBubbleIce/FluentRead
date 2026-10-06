/**
 * @file tests/contextMenuRuntimeOwnership.test.ts
 * 文件职责：验证原生右键菜单异步查询、结构重建和点击的归属及写入次序。
 * 主要内容：使用真实菜单快照与后台 runtime，延迟浏览器 API 回复以覆盖切换标签页、配置关闭、状态乱序和原生写入交错。
 * 模块边界：浏览器 API、语言加载与翻译动作是受控端口；不表示操作系统菜单或真实翻译服务验证。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const state = vi.hoisted(() => ({config: {} as Record<string, any>, listeners: [] as Array<() => void>,
    ready: Promise.resolve(), language: vi.fn(), action: vi.fn(), capabilities: {browser: 'chrome', imageTranslation: true, areaTranslation: true}}));
vi.mock('@/src/services/config/store', () => ({config: state.config, configReady: {then: (fn: () => void) => state.ready.then(fn)}, subscribeConfig: (fn: () => void) => {state.listeners.push(fn);return () => {};}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: state.capabilities}));
vi.mock('@/src/platform/i18n/uiLanguageBundles', () => ({ensureUiLanguageBundle: state.language}));
vi.mock('@/src/app/background/contextMenuActions', () => ({runContextMenuAction: state.action}));
function deferred<T = unknown>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
const neutral = {status: 'success', isTranslated: false, isSiteDisabled: false};
const pageId = 'fluent-read:page:translatePage';
let active: number, api: any;
async function settle() {for (let i = 0; i < 100; i++) await Promise.resolve();}
function change(values: Record<string, unknown>) {Object.assign(state.config, values);state.listeners.at(-1)!();}
async function install() {const {installBackgroundContextMenus} = await import('@/src/app/background/contextMenuRuntime');const {TabTranslationStateStore} = await import('@/src/app/background/tabTranslationState');return installBackgroundContextMenus(new TabTranslationStateStore());}
async function start() {const runtime = await install();await settle();api.contextMenus.update.mockClear();api.contextMenus.create.mockClear();api.contextMenus.removeAll.mockClear();api.tabs.sendMessage.mockClear();return runtime;}
function pageTitles() {return api.contextMenus.update.mock.calls.filter(([id]: any[]) => id === pageId).map(([, value]: any[]) => value.title);}
beforeEach(() => {
    vi.resetModules();vi.clearAllMocks();state.listeners.length = 0;state.ready = Promise.resolve();active = 9;
    for (const key of Reflect.ownKeys(state.config)) delete state.config[key as string];
    Object.assign(state.config, {on: true, uiLanguage: 'zh-CN', contextMenuEnabled: true, contextMenuEntries: {}, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false, disableImageTranslator: false, selectionAreaEnabled: true, imageTranslationContextMenuEnabled: true});
    state.language.mockResolvedValue(undefined);state.action.mockResolvedValue({handled: false});
    const event = () => ({addListener: vi.fn()});
    api = {contextMenus: {create: vi.fn().mockResolvedValue(undefined), removeAll: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined), onClicked: event()},
        tabs: {query: vi.fn(async () => [{id: active}]), sendMessage: vi.fn().mockResolvedValue(neutral), onActivated: event(), onUpdated: event(), onRemoved: event()}};
    vi.stubGlobal('browser', api);
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('右键菜单原生写入的异步归属', () => {
    it('回复期间活动页改变时旧页面不写全局标题', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();active = 10;reply.resolve({...neutral, isTranslated: true});await old;
        expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
    it('回复期间菜单关闭时旧查询不写已删除的菜单', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();change({contextMenuEnabled: false});await settle();reply.resolve({...neutral, isTranslated: true});await old;
        expect(api.contextMenus.update).not.toHaveBeenCalled();expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    });
    it('同一活动页较早查询晚返回时不能覆盖较新查询', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        const old = runtime.update(9);await settle();await runtime.update(9);reply.resolve({...neutral, isTranslated: true});await old;
        expect(pageTitles()).toEqual(['翻译全文']);
    });
    it('已发出的原生写入完成后再写最新状态，不能让旧写入最后落地', async () => {
        const runtime = await start(), write = deferred();let pending = false, overlap = false;
        api.contextMenus.update.mockImplementationOnce(async () => {pending = true;await write.promise;pending = false;});
        api.contextMenus.update.mockImplementation(() => {if (pending) overlap = true;return Promise.resolve();});
        const old = runtime.update(9);await settle();api.tabs.sendMessage.mockResolvedValue({...neutral, isTranslated: true});const next = runtime.update(9);await settle();
        write.resolve(undefined);await Promise.all([old, next]);expect(overlap).toBe(false);expect(pageTitles().at(-1)).toBe('显示页面原文');
    });
    it('原生更新未完成时重建等待它结束，再创建新结构', async () => {
        const runtime = await start(), write = deferred();api.contextMenus.update.mockReturnValueOnce(write.promise);
        const old = runtime.update(9);await settle();change({contextMenuEntries: {translateSelection: false}});await settle();
        const removalsWhilePending = api.contextMenus.removeAll.mock.calls.length;write.resolve(undefined);await old;await settle();expect(removalsWhilePending).toBe(0);
        expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);expect(api.contextMenus.create.mock.calls.map(([item]: any[]) => item.id)).toEqual([pageId,'fluent-read:image:translateImage']);
    });
    it('结构创建期间配置关闭，停止余下条目并撤回本轮', async () => {
        const create = deferred();api.contextMenus.create.mockReturnValueOnce(create.promise);await install();await settle();
        change({contextMenuEnabled: false});create.resolve(undefined);await settle();
        expect(api.contextMenus.create).toHaveBeenCalledTimes(1);expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(3);
    });
    it('点击等待状态时菜单被关闭，不再执行旧动作', async () => {
        await start();const reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId: pageId}, {id: 9});await settle();change({contextMenuEnabled: false});await settle();reply.resolve(neutral);await settle();
        expect(state.action).not.toHaveBeenCalled();
    });
    it('点击等待状态时同 ID 菜单已重建，不借用新菜单的动作', async () => {
        await start();const reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId: pageId}, {id: 9});await settle();change({uiLanguage: 'en-US'});await settle();reply.resolve(neutral);await settle();
        expect(state.action).not.toHaveBeenCalled();
    });
    it('目标语言、快捷键和旧附加显示偏好改变不重建菜单', async () => {
        await start();change({to: 'en', floatingBallHotkey: 'Alt+P', contextMenuShowTargetLanguage: false, contextMenuShowShortcut: false});await settle();
        expect(api.contextMenus.create).not.toHaveBeenCalled();expect(api.contextMenus.removeAll).not.toHaveBeenCalled();
    });
    it('一次状态更新只查询一次页面真值', async () => {
        const runtime = await start();await runtime.update(9);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);expect(api.contextMenus.update).toHaveBeenCalledTimes(3);
    });
    it('活动页查询失败通过事件路径受控结束，后续更新仍可执行', async () => {
        await start();const error = vi.spyOn(console,'error').mockImplementation(() => {});api.tabs.query.mockRejectedValueOnce(new Error('query unavailable'));
        api.tabs.onActivated.addListener.mock.calls[0][0]({tabId: 9});await settle();expect(error).toHaveBeenCalled();
        api.tabs.onActivated.addListener.mock.calls[0][0]({tabId: 9});await settle();expect(pageTitles()).toEqual(['翻译全文']);
    });
    it('外部快照的图片配置不混入全局配置', async () => {
        const {readContextMenuSettings} = await import('@/src/app/background/contextMenuPreferences');
        const source = {...state.config, disableImageTranslator: true};expect(readContextMenuSettings(source as any).toggles.translateImage).toBe(false);
        state.config.disableImageTranslator = true;source.disableImageTranslator = false;expect(readContextMenuSettings(source as any).toggles.translateImage).toBe(true);
    });
    it('不读取菜单不展示的目标语言与快捷键字段', async () => {
        const {readContextMenuSettings} = await import('@/src/app/background/contextMenuPreferences');let reads = 0;
        for(const key of ['to','floatingBallHotkey','customFloatingBallHotkey']) Object.defineProperty(state.config,key,{configurable:true,get:()=>{reads++;return 'Alt+T';}});
        readContextMenuSettings();expect(reads).toBe(0);
    });
    it('配置就绪失败被接住，不订阅、不创建菜单', async () => {
        const ready = deferred<void>();state.ready = ready.promise;const error = vi.spyOn(console,'error').mockImplementation(() => {});await install();ready.reject(new Error('config unavailable'));await settle();expect(error).toHaveBeenCalled();expect(state.listeners).toHaveLength(0);expect(api.contextMenus.create).not.toHaveBeenCalled();
    });
    it('后台页请求不覆盖也不取消正在等待的活动页更新，非法 ID 不查询', async () => {
        const runtime = await start(), reply = deferred();api.tabs.sendMessage.mockReturnValueOnce(reply.promise);const old = runtime.update(9);await settle();await runtime.update(10);await runtime.update(-1);reply.resolve({...neutral,isTranslated:true});await old;expect(pageTitles()).toEqual(['显示页面原文']);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('活动页查询乱序时只接受较新的请求', async () => {
        const runtime = await start(), query = deferred();api.tabs.query.mockReturnValueOnce(query.promise);const old = runtime.update(9);await settle();await runtime.update(9);query.resolve([{id:9}]);await old;expect(pageTitles()).toEqual(['翻译全文']);expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('配置在活动页查询中改变时不读取旧页，当前原生更新失败仍继续其他条目', async () => {
        const runtime = await start(), query = deferred();api.tabs.query.mockReturnValueOnce(query.promise);const old = runtime.update(9);await settle();change({contextMenuEnabled:false});await settle();query.resolve([{id:9}]);await old;expect(api.tabs.sendMessage).not.toHaveBeenCalled();
        change({contextMenuEnabled:true});await settle();api.contextMenus.update.mockClear();const error = vi.spyOn(console,'error').mockImplementation(() => {});api.contextMenus.update.mockRejectedValueOnce(new Error('native unavailable'));await runtime.update(9);expect(error).toHaveBeenCalled();expect(api.contextMenus.update).toHaveBeenCalledTimes(3);
    });
    it('排队的更新失效时跳过它，新查询失败后队列仍可重试', async () => {
        const runtime = await start(), write = deferred();api.contextMenus.update.mockReturnValueOnce(write.promise);const first = runtime.update(9);await settle();const second = runtime.update(9);await settle();const third = runtime.update(9);await settle();write.resolve(undefined);await Promise.all([first,second,third]);expect(pageTitles()).toEqual(['翻译全文']);
        const error = vi.spyOn(console,'error').mockImplementation(() => {});api.tabs.query.mockResolvedValueOnce([{id:9}]).mockRejectedValueOnce(new Error('queued query failed'));await runtime.update(9);await runtime.update(9);expect(error).toHaveBeenCalled();expect(pageTitles()).toHaveLength(2);
    });
    it('设置突发变化只构建最后一份快照，语言加载期间改变也失效', async () => {
        await start();change({uiLanguage:'en-US'});change({uiLanguage:'ja-JP'});await settle();expect(api.contextMenus.removeAll).toHaveBeenCalledTimes(1);
        const language = deferred();state.language.mockReturnValueOnce(language.promise);api.contextMenus.create.mockClear();change({uiLanguage:'fr-FR'});await settle();change({contextMenuEnabled:false});language.resolve(undefined);await settle();expect(api.contextMenus.create).not.toHaveBeenCalled();
    });
    it('等待原生队列的重建失效时不创建，后续创建失败仍可重建', async () => {
        const runtime = await start(), write = deferred();api.contextMenus.update.mockReturnValueOnce(write.promise);const old = runtime.update(9);await settle();change({uiLanguage:'en-US'});await settle();change({contextMenuEnabled:false});write.resolve(undefined);await old;await settle();expect(api.contextMenus.create).not.toHaveBeenCalled();
        const error = vi.spyOn(console,'error').mockImplementation(() => {});api.contextMenus.create.mockRejectedValueOnce(new Error('native create failed'));change({contextMenuEnabled:true});await settle();expect(error).toHaveBeenCalled();api.contextMenus.create.mockClear();change({uiLanguage:'zh-CN'});await settle();expect(api.contextMenus.create).toHaveBeenCalledTimes(3);
    });
    it('没有活动页时只建结构，导航和关闭维护状态，缺失点击目标不会发消息', async () => {
        api.tabs.query.mockResolvedValue([]);const runtime = await start();expect(api.contextMenus.update).not.toHaveBeenCalled();api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'complete'});api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});api.tabs.onRemoved.addListener.mock.calls[0][0](9);
        const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];click({menuItemId:pageId},undefined);click({menuItemId:'missing'},{id:9});await settle();await runtime.update(9);expect(state.action).not.toHaveBeenCalled();expect(api.tabs.sendMessage).not.toHaveBeenCalled();
    });
    it('图片隐藏时点击不执行，可见动作失败受控，成功按回复更新网站状态', async () => {
        await start();const click = api.contextMenus.onClicked.addListener.mock.calls[0][0];api.tabs.sendMessage.mockResolvedValue({...neutral,isSiteDisabled:true});click({menuItemId:'fluent-read:image:translateImage'},{id:9});await settle();expect(state.action).not.toHaveBeenCalled();
        const error = vi.spyOn(console,'error').mockImplementation(() => {});state.action.mockRejectedValueOnce(new Error('action failed'));click({menuItemId:pageId},{id:9});await settle();expect(error).toHaveBeenCalled();
        state.action.mockResolvedValueOnce({handled:true,isSiteDisabled:false});click({menuItemId:pageId},{id:9});await settle();expect(pageTitles().at(-1)).toBe('翻译全文');
        state.action.mockResolvedValueOnce({handled:true,isTranslated:true});click({menuItemId:pageId},{id:9});await settle();expect(pageTitles().at(-1)).toBe('恢复在此网站使用');
    });
    it('可见动作返回未处理时保留当前状态且不刷新菜单', async () => {
        await start();api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});await settle();expect(state.action).toHaveBeenCalledTimes(1);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
    it.each([['loading','query'],['removed','query'],['loading','action'],['removed','action']])('%s 在 %s 等待期间发生时旧点击和动作结果不借用新文档', async (event, phase) => {
        await start();const pending = deferred();if(phase==='query') api.tabs.sendMessage.mockReturnValueOnce(pending.promise);else state.action.mockReturnValueOnce(pending.promise);
        api.contextMenus.onClicked.addListener.mock.calls[0][0]({menuItemId:pageId},{id:9});await settle();if(event==='loading') api.tabs.onUpdated.addListener.mock.calls[0][0](9,{status:'loading'});else api.tabs.onRemoved.addListener.mock.calls[0][0](9);await settle();api.contextMenus.update.mockClear();
        pending.resolve(phase==='query' ? neutral : {handled:true,isTranslated:true});await settle();expect(state.action).toHaveBeenCalledTimes(phase==='query' ? 0 : 1);expect(api.contextMenus.update).not.toHaveBeenCalled();
    });
});
