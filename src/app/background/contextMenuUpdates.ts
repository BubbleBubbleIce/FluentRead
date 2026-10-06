/**
 * @file src/app/background/contextMenuUpdates.ts
 * 文件职责：按活动标签页的真实状态更新全局右键菜单，并保证迟到查询不会覆盖当前菜单。
 * 主要内容：捕获设置与结构身份，按接受顺序屏蔽旧请求，只读取一次页面真值，在原生队列内再次确认活动页；查询或单项写入失败受控结束。
 * 模块边界：只处理菜单标题与可见性的异步更新，不创建或删除菜单、不订阅配置、不执行点击；原生串行队列及结构生命周期由安装模块持有。
 */
import {resolveContextMenuPresentation, type ContextMenuPlanItem} from '@/src/core/context-menu/domain';
import {renderContextMenuTitle} from '@/src/core/context-menu/presentation';
import {isBrowserTabId, type TabTranslationState} from './tabTranslationState';
import type {TabTranslationStateReader} from './tabTranslationQuery';
import type {ContextMenuClickTab} from './contextMenuActions';
import type {ContextMenuSettingsSnapshot} from './contextMenuPreferences';

interface ContextMenuUpdateDependencies {
    readonly isSupported: boolean;
    readonly getSettings: () => ContextMenuSettingsSnapshot;
    readonly getPlan: () => readonly ContextMenuPlanItem[];
    readonly mutate: (work: () => Promise<void>) => Promise<void>;
    readonly readTabTranslationState: TabTranslationStateReader;
}

/** 配置与结构读取器提供当前身份；mutate 与重建共享同一原生写入队列。 */
export function createContextMenuUpdater({isSupported, getSettings, getPlan, mutate, readTabTranslationState}: ContextMenuUpdateDependencies) {
    let updateRequest = 0;
    let acceptedUpdate = 0;
    return async (tabId: number, known?: TabTranslationState): Promise<void> => {
        if (!isSupported || getPlan().length === 0 || !isBrowserTabId(tabId)) return;
        const snapshot = getSettings(), items = getPlan(), request = ++updateRequest;
        const ownsMenu = () => snapshot === getSettings() && items === getPlan();
        const current = () => ownsMenu() && request === acceptedUpdate;
        try {
            // 只接受当前活动页；忽略后台页请求时，不取消已接受的活动页更新。
            const activeTabs = await browser.tabs.query({active: true, lastFocusedWindow: true}) as ContextMenuClickTab[];
            if (!ownsMenu() || request < acceptedUpdate || !activeTabs.some(tab => tab.id === tabId)) return;
            acceptedUpdate = request;
            const state = known ?? await readTabTranslationState(tabId, true);
            if (!current()) return;
            await mutate(async () => {
                if (!current()) return;
                // 真值查询与原生写入可能排队很久，落地前重新确认当前活动页。
                const active = await browser.tabs.query({active: true, lastFocusedWindow: true}) as ContextMenuClickTab[];
                if (!current() || !active.some(tab => tab.id === tabId)) return;
                for (const item of resolveContextMenuPresentation(items, state, snapshot.display)) {
                    if (!current()) return;
                    try {
                        await browser.contextMenus.update(item.menuItemId,
                            {title: renderContextMenuTitle(item, snapshot.titleContext), visible: item.visible});
                    } catch (error) {
                        console.error('Failed to update context menu:', error);
                    }
                }
            });
        } catch (error) {
            console.error('Failed to update context menu:', error);
        }
    };

}
