/**
 * @file src/app/background/contextMenuRuntime.ts
 * 文件职责：管理后台右键菜单的安装、状态同步和点击路由，让菜单结构随设置重建，让标题随当前标签页的翻译与网站状态更新。
 * 主要内容：等待配置就绪后按菜单结构创建条目，串行执行原生菜单写入与重建，以配置、结构及活动页查询归属屏蔽迟到回复，并把仍有效的点击交给动作模块执行。
 * 模块边界：这里只编排 browser.contextMenus、tabs 与 app 层状态，不推导菜单结构、不渲染文案、不执行翻译；结构归 core/context-menu，文案归 core/context-menu/presentation，动作归 contextMenuActions。
 */
import {
    buildContextMenuPlan,
    resolveContextMenuPresentation,
    type ContextMenuPlanItem,
} from '@/src/core/context-menu/domain';
import {configReady, subscribeConfig} from '@/src/services/config/store';
import {runContextMenuAction, type ContextMenuClickInfo, type ContextMenuClickTab} from './contextMenuActions';
import {readContextMenuSettings, type ContextMenuSettingsSnapshot} from './contextMenuPreferences';
import {renderContextMenuTitle} from '@/src/core/context-menu/presentation';
import {isBrowserTabId, type TabTranslationState, TabTranslationStateStore} from './tabTranslationState';
import {createTabTranslationStateReader} from './tabTranslationQuery';
import {ensureUiLanguageBundle} from '@/src/platform/i18n/uiLanguageBundles';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {createContextMenuUpdater} from './contextMenuUpdates';

const NEUTRAL_STATE: TabTranslationState = {isTranslated: false, isSiteDisabled: false};

export interface BackgroundContextMenuRuntime {
    readonly isSupported: boolean;
    update(tabId: number): Promise<void>;
}

/**
 * 组装右键菜单与标签页生命周期。
 *
 * 该模块只保存 worker 瞬时状态；页面是否已翻译仍以 content script 的回复为真值。
 */
export function installBackgroundContextMenus(
    tabTranslationStates: TabTranslationStateStore,
): BackgroundContextMenuRuntime {
    // Thunderbird 使用邮件工具栏；Firefox Android 可能只暴露不完整的菜单接口。
    const menus = browser.contextMenus;
    const isSupported = browserCapabilities.browser !== 'thunderbird'
        && typeof menus?.create === 'function'
        && typeof menus.removeAll === 'function'
        && typeof menus.update === 'function'
        && typeof menus.onClicked?.addListener === 'function';
    let settings: ContextMenuSettingsSnapshot = readContextMenuSettings();
    let plan: readonly ContextMenuPlanItem[] = [];
    let syncQueue: Promise<void> = Promise.resolve();
    let mutationQueue: Promise<void> = Promise.resolve();
    const readTabTranslationState = createTabTranslationStateReader(tabTranslationStates);

    // 已发出的原生写入无法取消；让后续更新和结构重建排在它之后，保证最新结果最后落地。
    const mutate = (work: () => Promise<void>): Promise<void> => {
        mutationQueue = mutationQueue.catch(() => undefined).then(work);
        return mutationQueue;
    };
    const update = createContextMenuUpdater({
        isSupported, getSettings: () => settings, getPlan: () => plan, mutate, readTabTranslationState,
    });

    const createItems = async (snapshot: ContextMenuSettingsSnapshot): Promise<ContextMenuPlanItem[]> => {
        const items = snapshot.enabled ? [...buildContextMenuPlan(snapshot.toggles)] : [];
        const initial = resolveContextMenuPresentation(items, NEUTRAL_STATE, snapshot.display);
        for (const [index, item] of items.entries()) {
            if (snapshot !== settings) break;
            await menus.create({
                id: item.menuItemId,
                title: renderContextMenuTitle(initial[index], snapshot.titleContext),
                visible: initial[index].visible,
                contexts: [...item.contexts],
            });
        }
        return items;
    };

    const sync = (): Promise<void> => {
        const requested = settings;
        syncQueue = syncQueue
            .then(async () => {
                if (requested !== settings) return;
                // 菜单标题是一次性写入的原生文案；先取得界面语言资源，避免非中文用户看到中文回退。
                await ensureUiLanguageBundle(requested.titleContext.language);
                if (requested !== settings) return;
                await mutate(async () => {
                    if (requested !== settings) return;
                    plan = [];
                    await menus.removeAll();
                    const items = await createItems(requested);
                    // 重建期间设置又变了：撤掉本轮已创建项，让后一次同步重新生成。
                    if (requested !== settings) {
                        await menus.removeAll();
                        return;
                    }
                    plan = items;
                });
                if (requested !== settings) return;
                const active = (await browser.tabs.query({active: true, lastFocusedWindow: true}) as ContextMenuClickTab[])
                    .find((tab) => typeof tab.id === 'number');
                if (active?.id !== undefined) await update(active.id);
            })
            .catch((error) => {
                plan = [];
                console.error('Error syncing context menu:', error);
            });
        return syncQueue;
    };

    const handleClick = async (info: ContextMenuClickInfo, tab: ContextMenuClickTab): Promise<void> => {
        const snapshot = settings, items = plan;
        const item = items.find((entry) => entry.menuItemId === info.menuItemId);
        if (!item || !isBrowserTabId(tab.id)) return;
        const currentDocument = tabTranslationStates.captureDocument(tab.id);
        try {
            const state = await readTabTranslationState(tab.id, true);
            if (!currentDocument() || snapshot !== settings || items !== plan) return;
            const [presentation] = resolveContextMenuPresentation([item], state, snapshot.display);
            if (!presentation.visible) return;
            const result = await runContextMenuAction(presentation.action, tab.id, info, tab, state.isTranslated);
            if (!currentDocument() || !result.handled) return;
            if (typeof result.isSiteDisabled === 'boolean') tabTranslationStates.setSiteDisabled(tab.id, result.isSiteDisabled);
            if (typeof result.isTranslated === 'boolean') tabTranslationStates.setTranslated(tab.id, result.isTranslated);
            await update(tab.id, tabTranslationStates.get(tab.id));
        } catch (error) {
            console.error('Failed to send message to content script:', error);
        }
    };

    if (!isSupported) {
        console.log('不支持右键菜单');
    } else {
        void configReady.then(() => {
            settings = readContextMenuSettings();
            void sync();
            subscribeConfig(() => {
                const next = readContextMenuSettings();
                if (next.signature === settings.signature) return;
                settings = next;
                void sync();
            });
        }).catch(error => console.error('Error initializing context menu:', error));

        browser.contextMenus.onClicked.addListener((info: any, tab: any) => void handleClick(info as ContextMenuClickInfo, (tab ?? {}) as ContextMenuClickTab));
    }

    browser.tabs.onActivated.addListener((activeInfo: any) => { if (isSupported) void update(activeInfo.tabId); });
    browser.tabs.onUpdated.addListener((tabId: any, changeInfo: any) => { if (changeInfo.status !== 'loading') return; tabTranslationStates.reset(tabId); if (isSupported) void update(tabId); });
    browser.tabs.onRemoved.addListener((tabId: any) => tabTranslationStates.delete(tabId));

    return {isSupported, update};
}
