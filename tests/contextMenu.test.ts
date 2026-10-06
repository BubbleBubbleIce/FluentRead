import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    capability: {browser: 'chrome', imageTranslation: true, areaTranslation: true},
}));
const subscriptions: Array<(config: unknown) => void> = [];

vi.mock('@/src/services/config/store', () => ({
    config: state.config,
    configReady: Promise.resolve(),
    subscribeConfig: (listener: (config: unknown) => void) => {
        subscriptions.push(listener);
        return () => {};
    },
}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: state.capability}));

import {
    buildContextMenuPlan,
    contextMenuItemId,
    CONTEXT_MENU_BUCKET_CONTEXTS,
    normalizeContextMenuEntryPreferences,
    resolveContextMenuEntryToggles,
    resolveContextMenuPresentation,
    type ContextMenuEntryPreferences,
    type ContextMenuItemPresentation,
} from '@/src/core/context-menu/domain';
import {renderContextMenuTitle} from '@/src/core/context-menu/presentation';
import {imageMenuEnabled} from '@/src/app/background/imageContextMenu';
import {readContextMenuSettings} from '@/src/app/background/contextMenuPreferences';
import {runContextMenuAction, toggleSiteExtensionDisabled} from '@/src/app/background/contextMenuActions';
import {
    setSelectionContextMenuHandler,
    translateSelectionFromContextMenu,
} from '@/src/features/selection-translation/content/contextMenuBridge';
import {
    setAreaContextMenuHandler,
    startAreaTranslationFromContextMenu,
} from '@/src/features/area-translation/content/contextMenuBridge';

const ALL_AVAILABLE = {selectionTranslation: true, imageTranslation: true, areaTranslation: true};
const SHOW_ALL = {showTargetLanguage: true, showShortcut: true};
const NEUTRAL = {isTranslated: false, isSiteDisabled: false};
const ZH_CONTEXT = {language: 'zh-CN' as const, targetLanguage: '简体中文', shortcut: 'Option+T'};

function defaultConfig(): Record<string, unknown> {
    return {
        on: true,
        uiLanguage: 'zh-CN',
        to: 'zh-Hans',
        contextMenuEnabled: true,
        contextMenuEntries: {},
        contextMenuShowTargetLanguage: true,
        contextMenuShowShortcut: true,
        floatingBallHotkey: 'Alt+T',
        customFloatingBallHotkey: '',
        selectionTranslatorMode: 'bilingual',
        disableSelectionTranslator: false,
        selectionAreaEnabled: true,
        disableImageTranslator: false,
        imageTranslationContextMenuEnabled: true,
        disabledExtensionDomains: [],
    };
}

function toggles(preferences: ContextMenuEntryPreferences, availability = ALL_AVAILABLE) {
    return resolveContextMenuEntryToggles(preferences, availability);
}

function titlesFor(preferences: ContextMenuEntryPreferences, pageState = NEUTRAL, availability = ALL_AVAILABLE) {
    const plan = buildContextMenuPlan(toggles(preferences, availability));
    return resolveContextMenuPresentation(plan, pageState, SHOW_ALL).map((item, index) => ({
        id: plan[index].menuItemId,
        bucket: plan[index].bucket,
        role: plan[index].role,
        visible: item.visible,
        action: item.action,
        title: renderContextMenuTitle(item, ZH_CONTEXT),
    }));
}

beforeEach(() => {
    subscriptions.length = 0;
    for (const key of Object.keys(state.config)) delete state.config[key];
    Object.assign(state.config, defaultConfig());
    state.capability.imageTranslation = true;
    state.capability.areaTranslation = true;
    state.capability.browser = 'chrome';
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('右键菜单入口偏好', () => {
    it('只接受已知入口的布尔偏好，图片入口不写入偏好表', () => {
        expect(normalizeContextMenuEntryPreferences(null)).toEqual({});
        expect(normalizeContextMenuEntryPreferences('translateSelection')).toEqual({});
        expect(normalizeContextMenuEntryPreferences({
            translateSelection: false,
            translatePage: 'yes',
            translateImage: false,
            unknownEntry: true,
        })).toEqual({translateSelection: false});
    });

    it('缺省偏好按产品默认值，功能不可用时入口一律关闭', () => {
        expect(toggles({})).toEqual({
            translateSelection: true,
            translateImage: true,
            translatePage: true,
            translateArea: false,
            toggleSite: false,
        });
        expect(resolveContextMenuEntryToggles(undefined, ALL_AVAILABLE).translatePage).toBe(true);
        expect(toggles({translateSelection: true, translateArea: true}, {
            selectionTranslation: false,
            imageTranslation: false,
            areaTranslation: false,
        })).toEqual({
            translateSelection: false,
            translateImage: false,
            translatePage: true,
            translateArea: false,
            toggleSite: false,
        });
    });
});

describe('右键菜单结构', () => {
    it('默认三个场景各有一个不带品牌前缀的直达入口', () => {
        expect(titlesFor({})).toEqual([
            {id: contextMenuItemId('selection', 'translateSelection'), bucket: 'selection', role: 'standalone', visible: true, action: 'translateSelection', title: '翻译选中文本'},
            {id: contextMenuItemId('page', 'translatePage'), bucket: 'page', role: 'standalone', visible: true, action: 'translatePage', title: '翻译全文'},
            {id: contextMenuItemId('image', 'translateImage'), bucket: 'image', role: 'standalone', visible: true, action: 'translateImage', title: '翻译这张图片'},
        ]);
    });

    it('所有旧入口都启用时仍然不生成子菜单，链接图片不会命中全文入口', () => {
        const plan = buildContextMenuPlan(toggles({translateArea: true, toggleSite: true}));
        expect(plan).toHaveLength(3);
        expect(plan.every((item) => item.role === 'standalone' && !Object.hasOwn(item, 'parentId') && !Object.hasOwn(item, 'fallbackOnly'))).toBe(true);
        expect(plan.find((item) => item.bucket === 'selection')!.contexts).toEqual(['selection']);
        expect(plan.find((item) => item.bucket === 'page')!.contexts).toEqual(['page']);
        expect(plan.find((item) => item.bucket === 'image')!.contexts).toEqual(['image']);
        expect(CONTEXT_MENU_BUCKET_CONTEXTS.page).not.toContain('link');
    });

    it('关掉某个场景的全部入口后该场景不再创建菜单', () => {
        const items = titlesFor({translateSelection: false, translatePage: false});
        expect(items.map((item) => item.bucket)).toEqual(['image']);
        expect(buildContextMenuPlan(toggles({}, {...ALL_AVAILABLE, imageTranslation: false}))
            .some((item) => item.bucket === 'image')).toBe(false);
    });

    it('页面已翻译时整页入口改为显示原文', () => {
        const items = titlesFor({}, {isTranslated: true, isSiteDisabled: false});
        expect(items.find((item) => item.id === contextMenuItemId('page', 'translatePage'))!.title)
            .toBe('显示页面原文');
        expect(items.some((item) => item.id === contextMenuItemId('selection', 'translatePage'))).toBe(false);
    });

    it('只启用网站开关时它作为一级入口，文案说明会停用当前网站', () => {
        const items = titlesFor({translatePage: false, translateSelection: false, toggleSite: true});
        expect(items.find((item) => item.bucket === 'page')).toEqual({
            id: contextMenuItemId('page', 'toggleSite'),
            bucket: 'page',
            role: 'standalone',
            visible: true,
            action: 'toggleSite',
            title: '不再翻译此网站',
        });
    });
});

describe('网站被关闭时的菜单出口', () => {
    const disabled = {isTranslated: false, isSiteDisabled: true};

    it('选区直达项改为恢复网站的出口', () => {
        const items = titlesFor({}, disabled);
        const selection = items.filter((item) => item.bucket === 'selection');
        expect(selection.filter((item) => item.visible).map((item) => item.title))
            .toEqual(['恢复在此网站使用']);
    });

    it('一级直达项改写为恢复网站，图片场景无处可恢复则直接隐藏', () => {
        const items = titlesFor({}, disabled);
        expect(items.find((item) => item.bucket === 'page')).toEqual({
            id: contextMenuItemId('page', 'translatePage'),
            bucket: 'page',
            role: 'standalone',
            visible: true,
            action: 'toggleSite',
            title: '恢复在此网站使用',
        });
        const image = items.find((item) => item.bucket === 'image')!;
        expect(image.visible).toBe(false);
        expect(image.action).toBe('translateImage');
    });

    it('用户已启用网站开关时它保持可见，不因兜底而重复出现', () => {
        const items = titlesFor({translatePage: false, toggleSite: true}, NEUTRAL);
        const pageToggle = items.filter((item) => item.bucket === 'page' && item.action === 'toggleSite');
        expect(pageToggle).toHaveLength(1);
        expect(pageToggle[0].visible).toBe(true);
    });
});

describe('右键菜单标题渲染', () => {
    function presentation(overrides: Partial<ContextMenuItemPresentation> = {}): ContextMenuItemPresentation {
        return {
            menuItemId: 'preview',
            visible: true,
            action: 'translatePage',
            title: {role: 'standalone', state: 'translate', withTargetLanguage: true, withShortcut: true},
            ...overrides,
        } as ContextMenuItemPresentation;
    }

    it('旧配置启用语言和快捷键时仍然只显示动作名称', () => {
        expect(renderContextMenuTitle(presentation(), ZH_CONTEXT)).toBe('翻译全文');
        expect(renderContextMenuTitle(presentation(), {...ZH_CONTEXT, targetLanguage: '', shortcut: ''}))
            .toBe('翻译全文');
        expect(renderContextMenuTitle(presentation({
            title: {role: 'standalone', state: 'translate', withTargetLanguage: false, withShortcut: false},
            action: 'translateArea',
        }), ZH_CONTEXT)).toBe('截图翻译屏幕区域');
    });

    it('缺少动作时按整页翻译兜底', () => {
        expect(renderContextMenuTitle(presentation({
            action: null,
            title: {role: 'standalone', state: 'translate', withTargetLanguage: false, withShortcut: false},
        }), ZH_CONTEXT)).toBe('翻译全文');
    });

    it('旧附加字段任意变化也只输出当前动作标题', () => {
        expect(renderContextMenuTitle(presentation(), {...ZH_CONTEXT, targetLanguage: 'Deutsch', shortcut: 'Control+P'})).toBe('翻译全文');
    });
});

describe('右键菜单设置快照', () => {
    it('汇总入口开关和界面语言，不计算未展示的附加文案', () => {
        const snapshot = readContextMenuSettings();
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.toggles.translateSelection).toBe(true);
        expect(snapshot.titleContext).toEqual({language: 'zh-CN', targetLanguage: '', shortcut: ''});
        expect(snapshot.signature).toBe(readContextMenuSettings().signature);
    });

    it('仅右键触发仍保留选区菜单入口', () => {
        state.config.selectionTranslatorTrigger = 'contextMenu';
        const snapshot = readContextMenuSettings();
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.toggles.translateSelection).toBe(true);
        expect(buildContextMenuPlan(snapshot.toggles).find((item) => item.bucket === 'selection')?.menuItemId)
            .toBe(contextMenuItemId('selection', 'translateSelection'));
    });

    it('关闭显示偏好后标题不再携带语言与快捷键', () => {
        state.config.contextMenuShowTargetLanguage = false;
        state.config.contextMenuShowShortcut = false;
        const snapshot = readContextMenuSettings();
        expect(snapshot.display).toEqual({showTargetLanguage: false, showShortcut: false});
        expect(snapshot.titleContext).toEqual({language: 'zh-CN', targetLanguage: '', shortcut: ''});
    });

    it('快捷键为空或无法解析时不展示快捷键', () => {
        state.config.floatingBallHotkey = 'none';
        expect(readContextMenuSettings().titleContext.shortcut).toBe('');
        state.config.floatingBallHotkey = 'custom';
        state.config.customFloatingBallHotkey = 'Alt+不存在的键';
        expect(readContextMenuSettings().titleContext.shortcut).toBe('');
    });

    it('扩展总开关或右键开关关闭时整套菜单不再创建', () => {
        state.config.contextMenuEnabled = false;
        expect(readContextMenuSettings().enabled).toBe(false);
        Object.assign(state.config, {contextMenuEnabled: true, on: false});
        const snapshot = readContextMenuSettings();
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.toggles.translateSelection).toBe(false);
        expect(snapshot.toggles.translateArea).toBe(false);
    });

    it('划词、圈选与图片入口分别跟随各自功能开关和浏览器能力', () => {
        state.config.selectionTranslatorMode = 'disabled';
        expect(readContextMenuSettings().toggles.translateSelection).toBe(false);
        state.config.selectionTranslatorMode = 'bilingual';
        state.config.disableSelectionTranslator = true;
        expect(readContextMenuSettings().toggles.translateSelection).toBe(false);
        state.config.selectionAreaEnabled = false;
        expect(readContextMenuSettings().toggles.translateArea).toBe(false);
        state.capability.areaTranslation = false;
        expect(readContextMenuSettings().toggles.translateArea).toBe(false);
        expect(imageMenuEnabled()).toBe(true);
        state.config.imageTranslationContextMenuEnabled = false;
        expect(readContextMenuSettings().toggles.translateImage).toBe(false);
        Object.assign(state.config, {imageTranslationContextMenuEnabled: true, disableImageTranslator: true});
        expect(imageMenuEnabled()).toBe(false);
        Object.assign(state.config, {disableImageTranslator: false});
        state.capability.imageTranslation = false;
        expect(imageMenuEnabled()).toBe(false);
    });
});

describe('右键菜单动作执行', () => {
    it('划词、圈选和图片只发往用户右键所在的 frame', async () => {
        const sendMessage = vi.fn().mockResolvedValue({});
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        await runContextMenuAction('translateSelection', 7, {frameId: 3}, {id: 7}, false);
        expect(sendMessage).toHaveBeenLastCalledWith(7, {type: 'contextMenuTranslate', action: 'selection'}, {frameId: 3});
        await runContextMenuAction('translateArea', 7, {}, {id: 7}, false);
        expect(sendMessage).toHaveBeenLastCalledWith(7, {type: 'contextMenuTranslate', action: 'area'}, {frameId: 0});
        const image = await runContextMenuAction('translateImage', 7, {frameId: -1, srcUrl: 'https://img.test/a.png'}, {id: 7}, false);
        expect(sendMessage).toHaveBeenLastCalledWith(7, {type: 'contextMenuTranslateImage', srcUrl: 'https://img.test/a.png'}, {frameId: 0});
        expect(image).toEqual({handled: true});
    });

    it('整页翻译与恢复原文始终作用于顶层文档，并回传新的翻译状态', async () => {
        const sendMessage = vi.fn().mockResolvedValue({status: 'success', isTranslated: true});
        vi.stubGlobal('browser', {tabs: {sendMessage}});
        expect(await runContextMenuAction('translatePage', 4, {frameId: 2}, {id: 4}, false))
            .toEqual({handled: true, isTranslated: true});
        expect(sendMessage).toHaveBeenLastCalledWith(4, {type: 'contextMenuTranslate', action: 'fullPage'}, {frameId: 0});
        sendMessage.mockResolvedValue({status: 'success'});
        expect(await runContextMenuAction('translatePage', 4, {}, {id: 4}, true))
            .toEqual({handled: true, isTranslated: false});
        expect(sendMessage).toHaveBeenLastCalledWith(4, {type: 'contextMenuTranslate', action: 'restore'}, {frameId: 0});
        sendMessage.mockResolvedValue({status: 'disabled'});
        expect(await runContextMenuAction('translatePage', 4, {}, {id: 4}, false)).toEqual({handled: false});
    });

    it('网站开关按基础域切换名单，并回传切换之后的状态', async () => {
        expect(toggleSiteExtensionDisabled({}, {})).toEqual({handled: false});
        expect(toggleSiteExtensionDisabled({pageUrl: 'chrome://extensions'}, {})).toEqual({handled: false});
        expect(await runContextMenuAction('toggleSite', 1, {pageUrl: 'https://news.example.com/a'}, {id: 1}, false))
            .toEqual({handled: true, isSiteDisabled: true, isTranslated: false});
        expect(state.config.disabledExtensionDomains).toEqual(['example.com']);
        expect(toggleSiteExtensionDisabled({}, {url: 'https://www.example.com/b'}))
            .toEqual({handled: true, isSiteDisabled: false, isTranslated: undefined});
        expect(state.config.disabledExtensionDomains).toEqual([]);
    });
});

describe('后台右键菜单生命周期', () => {
    const event = () => ({addListener: vi.fn()});

    function stubBrowser() {
        const api = {
            contextMenus: {create: vi.fn(), removeAll: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue(undefined), onClicked: event()},
            tabs: {query: vi.fn().mockResolvedValue([{id: 9}]), sendMessage: vi.fn().mockResolvedValue({status: 'success', isTranslated: true}), onActivated: event(), onUpdated: event(), onRemoved: event()},
        };
        vi.stubGlobal('browser', api);
        return api;
    }

    async function settle(times = 100): Promise<void> {
        for (let index = 0; index < times; index += 1) await Promise.resolve();
    }

    async function install() {
        const {installBackgroundContextMenus} = await import('@/src/app/background/contextMenuRuntime');
        const {TabTranslationStateStore} = await import('@/src/app/background/tabTranslationState');
        return installBackgroundContextMenus(new TabTranslationStateStore());
    }

    it('只创建一级条目，页面上下文不包含链接', async () => {
        const api = stubBrowser();
        await install();
        await settle();
        const created = api.contextMenus.create.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>);
        expect(created.map((menu) => menu.id)).toEqual([
            contextMenuItemId('selection', 'translateSelection'),
            contextMenuItemId('page', 'translatePage'),
            contextMenuItemId('image', 'translateImage'),
        ]);
        expect(created[0]).toMatchObject({contexts: ['selection'], title: '翻译选中文本'});
        expect(created.every((menu) => !menu.parentId)).toBe(true);
        expect(created[1].contexts).toEqual(['page']);
    });

    it('设置变化才重建菜单，无关配置变化不重复创建', async () => {
        const api = stubBrowser();
        await install();
        await settle();
        api.contextMenus.create.mockClear();
        subscriptions.at(-1)!(state.config);
        await settle();
        expect(api.contextMenus.create).not.toHaveBeenCalled();
        state.config.contextMenuEntries = {translatePage: false, translateArea: true, toggleSite: true};
        subscriptions.at(-1)!(state.config);
        await settle();
        expect(api.contextMenus.create.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).id)).toContain(
            contextMenuItemId('page', 'translateArea'),
        );
    });

    it('关闭右键菜单后清空全部入口，点击不再触发任何动作', async () => {
        const api = stubBrowser();
        await install();
        await settle();
        state.config.contextMenuEnabled = false;
        subscriptions.at(-1)!(state.config);
        await settle();
        api.contextMenus.create.mockClear();
        expect(api.contextMenus.create).not.toHaveBeenCalled();
        const [handler] = api.contextMenus.onClicked.addListener.mock.calls[0];
        handler({menuItemId: contextMenuItemId('page', 'translatePage')}, {id: 9});
        await settle();
        expect(api.tabs.sendMessage).not.toHaveBeenCalledWith(9, expect.objectContaining({action: 'fullPage'}));
    });

    it('点击整页入口后按 content 回复刷新标题', async () => {
        const api = stubBrowser();
        api.tabs.sendMessage.mockImplementation(async (_tabId: number, message: {type: string}) => ({
            status: 'success',
            isSiteDisabled: false,
            isTranslated: message.type === 'contextMenuTranslate',
        }));
        await install();
        await settle();
        api.contextMenus.update.mockClear();
        const [handler] = api.contextMenus.onClicked.addListener.mock.calls[0];
        handler({menuItemId: contextMenuItemId('page', 'translatePage')}, {id: 9});
        await settle();
        expect(api.tabs.sendMessage).toHaveBeenCalledWith(9, {type: 'contextMenuTranslate', action: 'fullPage'}, {frameId: 0});
        expect(api.contextMenus.update).toHaveBeenCalledWith(
            contextMenuItemId('page', 'translatePage'),
            {title: expect.stringMatching(/^显示页面原文$/u), visible: true},
        );
    });

    it('不支持右键菜单的浏览器不安装菜单，但仍维护标签页状态', async () => {
        vi.stubGlobal('browser', {tabs: {query: vi.fn().mockResolvedValue([]), onActivated: event(), onUpdated: event(), onRemoved: event()}});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const runtime = await install();
        expect(runtime.isSupported).toBe(false);
        await expect(runtime.update(1)).resolves.toBeUndefined();
    });

    it('右键菜单命名空间只有部分方法时不阻断后台启动', async () => {
        const create = vi.fn();
        vi.stubGlobal('browser', {
            contextMenus: {create},
            tabs: {query: vi.fn().mockResolvedValue([]), onActivated: event(), onUpdated: event(), onRemoved: event()},
        });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const runtime = await install();
        expect(runtime.isSupported).toBe(false);
        expect(create).not.toHaveBeenCalled();
        await expect(runtime.update(1)).resolves.toBeUndefined();
    });

    it('Thunderbird 即使暴露完整网页菜单接口也只使用邮件工具栏', async () => {
        const api = stubBrowser();
        state.capability.browser = 'thunderbird';
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const runtime = await install();
        await settle();
        expect(runtime.isSupported).toBe(false);
        expect(api.contextMenus.create).not.toHaveBeenCalled();
        expect(api.contextMenus.onClicked.addListener).not.toHaveBeenCalled();
    });
});

describe('内容脚本右键触发桥', () => {
    it('未挂载覆盖层时如实返回失败，挂载后转交当前实例', () => {
        expect(translateSelectionFromContextMenu()).toBe(false);
        expect(startAreaTranslationFromContextMenu()).toBe(false);

        const openCard = vi.fn().mockReturnValue(true);
        const releaseSelection = setSelectionContextMenuHandler(openCard);
        const beginSelection = vi.fn().mockReturnValue(false);
        const releaseArea = setAreaContextMenuHandler(beginSelection);
        expect(translateSelectionFromContextMenu()).toBe(true);
        expect(startAreaTranslationFromContextMenu()).toBe(false);

        releaseSelection();
        releaseArea();
        expect(translateSelectionFromContextMenu()).toBe(false);
        expect(startAreaTranslationFromContextMenu()).toBe(false);
    });

    it('旧实例的注销句柄不会清掉后一次挂载注册的处理函数', () => {
        const releaseFirst = setSelectionContextMenuHandler(() => false);
        setSelectionContextMenuHandler(() => true);
        releaseFirst();
        expect(translateSelectionFromContextMenu()).toBe(true);

        const releaseFirstArea = setAreaContextMenuHandler(() => false);
        setAreaContextMenuHandler(() => true);
        releaseFirstArea();
        expect(startAreaTranslationFromContextMenu()).toBe(true);
    });
});
