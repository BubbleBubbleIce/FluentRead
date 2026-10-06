/**
 * @file src/app/background/contextMenuActions.ts
 * 文件职责：执行右键菜单点击后的实际动作，把菜单语义翻译成发往对应 frame 的运行时消息或网站级配置写入。
 * 主要内容：转发划词、整页、圈选和图片四类翻译请求并回收全文翻译状态，按基础域切换当前网站的扩展开关。
 * 模块边界：本文件只负责动作执行，不创建菜单、不计算标题、不缓存标签页状态；菜单结构归 core/context-menu，生命周期与状态同步归 contextMenuRuntime。
 */
import type {ContextMenuActionId} from '@/src/core/context-menu/domain';
import {getSiteBaseDomain, normalizeDisabledExtensionDomains} from '@/src/core/site-rules/domain';
import {config} from '@/src/services/config/store';
import type {FullPageStateResponse} from './tabTranslationQuery';

export interface ContextMenuClickInfo {
    readonly menuItemId?: unknown;
    readonly srcUrl?: string;
    readonly frameId?: number;
    readonly pageUrl?: string;
}

export interface ContextMenuClickTab {
    readonly id?: number;
    readonly url?: string;
}

/** 点击结果：翻译类动作回传新的全文翻译状态，网站开关回传该网站之后的禁用状态。 */
export interface ContextMenuActionResult {
    readonly handled: boolean;
    readonly isTranslated?: boolean;
    readonly isSiteDisabled?: boolean;
}

function targetFrameId(info: ContextMenuClickInfo): number {
    return Number.isInteger(info.frameId) && info.frameId! >= 0 ? info.frameId! : 0;
}

async function sendToFrame(tabId: number, info: ContextMenuClickInfo, message: Record<string, unknown>): Promise<unknown> {
    return browser.tabs.sendMessage(tabId, message, {frameId: targetFrameId(info)});
}

/**
 * 切换当前网站的扩展开关，并回传切换之后的禁用状态。
 *
 * 与弹窗一致，只写入基础域名单；内容脚本通过配置订阅感知变化，不需要额外广播。
 */
export function toggleSiteExtensionDisabled(info: ContextMenuClickInfo, tab: ContextMenuClickTab): ContextMenuActionResult {
    const domain = getSiteBaseDomain(info.pageUrl || tab.url || '');
    if (!domain) return {handled: false};
    const domains = normalizeDisabledExtensionDomains(config.disabledExtensionDomains);
    const disabled = domains.includes(domain);
    config.disabledExtensionDomains = disabled
        ? domains.filter((item) => item !== domain)
        : [...domains, domain];
    return {handled: true, isSiteDisabled: !disabled, isTranslated: disabled ? undefined : false};
}

/** 执行一次菜单动作；isTranslated 表示页面在动作之后的全文翻译状态，未知时返回 undefined。 */
export async function runContextMenuAction(
    action: ContextMenuActionId,
    tabId: number,
    info: ContextMenuClickInfo,
    tab: ContextMenuClickTab,
    wasTranslated: boolean,
): Promise<ContextMenuActionResult> {
    if (action === 'toggleSite') return toggleSiteExtensionDisabled(info, tab);
    if (action === 'translateImage') {
        await sendToFrame(tabId, info, {type: 'contextMenuTranslateImage', srcUrl: info.srcUrl});
        return {handled: true};
    }
    if (action === 'translateSelection' || action === 'translateArea') {
        await sendToFrame(tabId, info, {
            type: 'contextMenuTranslate',
            action: action === 'translateSelection' ? 'selection' : 'area',
        });
        return {handled: true};
    }
    // 整页翻译始终作用于顶层文档，不能落到用户右键所在的子 frame。
    const response = await browser.tabs.sendMessage(tabId, {
        type: 'contextMenuTranslate',
        action: wasTranslated ? 'restore' : 'fullPage',
    }, {frameId: 0}) as FullPageStateResponse | undefined;
    if (response?.status !== 'success') return {handled: false};
    return {
        handled: true,
        isTranslated: typeof response.isTranslated === 'boolean' ? response.isTranslated : !wasTranslated,
    };
}
