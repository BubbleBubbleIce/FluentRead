/**
 * @file src/core/context-menu/presentation.ts
 * 文件职责：把右键菜单的状态描述渲染成用户读得懂的本地化标题，只展示操作名称。
 * 主要内容：按动作与状态挑选文案，不追加品牌、目标语言或快捷键；保留旧调用参数兼容已有配置。 可核对的公开符号包括 ContextMenuTitleContext、renderContextMenuTitle。
 * 模块边界：本文件只做纯文案拼装，不读取存储、不操作标签页，也不决定菜单是否创建；结构与可见性由 domain.ts 推导，菜单生命周期由 app/background 负责。
 */

import type {
    ContextMenuActionId,
    ContextMenuItemPresentation,
    ContextMenuTitleState,
} from './domain';
import {translate, type UiLanguage} from '@/src/core/i18n';

export interface ContextMenuTitleContext {
    readonly language: UiLanguage;
    /** 旧调用兼容字段，动作标题不使用目标语言。 */
    readonly targetLanguage: string;
    /** 旧调用兼容字段，动作标题不使用快捷键。 */
    readonly shortcut: string;
}

const TRANSLATE_ACTION_KEYS: Readonly<Record<ContextMenuActionId, string>> = {
    translateSelection: 'contextMenu.translateSelection',
    translatePage: 'contextMenu.translatePage',
    translateArea: 'contextMenu.translateArea',
    translateImage: 'contextMenu.translateImage',
    toggleSite: 'contextMenu.disableSite',
};

const STATE_KEYS: Readonly<Record<Exclude<ContextMenuTitleState, 'translate'>, string>> = {
    restore: 'contextMenu.restorePage',
    disableSite: 'contextMenu.disableSite',
    enableSite: 'contextMenu.enableSite',
};

function baseTitle(presentation: ContextMenuItemPresentation, language: UiLanguage): string {
    const {state} = presentation.title;
    if (state !== 'translate') return translate(STATE_KEYS[state], language);
    return translate(TRANSLATE_ACTION_KEYS[presentation.action ?? 'translatePage'], language);
}

/**
 * 渲染单个菜单项标题。
 *
 * 直达项只展示动作名称，扩展身份由浏览器显示的图标表达。
 */
export function renderContextMenuTitle(
    presentation: ContextMenuItemPresentation,
    context: ContextMenuTitleContext,
): string {
    // 即使旧配置仍启用了附加信息，也只显示动作名称。
    return baseTitle(presentation, context.language);
}
