/**
 * @file src/core/context-menu/domain.ts
 * 文件职责：定义右键菜单的产品模型，把“用户右键了什么”映射为可创建的菜单结构，并按页面状态解析每一项的显示文案与点击动作。
 * 主要内容：声明选区、页面和图片三类右键场景的入口目录与出现条件，每个场景只选择一个启用的直达操作，并在网站被关闭时改写入口，让菜单始终留有一个可执行的出口。 可核对的公开符号包括 ContextMenuBucket、ContextMenuActionId、CONTEXT_MENU_ENTRIES、CONTEXT_MENU_BUCKET_CONTEXTS、resolveContextMenuEntryToggles、buildContextMenuPlan、resolveContextMenuPresentation。
 * 模块边界：本文件是纯数据推导，不调用 browser.contextMenus、不读取配置存储、不生成本地化文案；菜单生命周期由 app/background 编排，标题渲染由 presentation.ts 完成。
 */

/** 右键场景：每个场景只提供一个直达操作，避免浏览器自动创建品牌子菜单。 */
export type ContextMenuBucket = 'selection' | 'page' | 'image';

export type ContextMenuActionId =
    | 'translateSelection'
    | 'translatePage'
    | 'translateArea'
    | 'translateImage'
    | 'toggleSite';

export type ContextMenuItemRole = 'standalone';

/** 直达操作的文案状态：翻译、恢复原文或切换当前网站。 */
export type ContextMenuTitleState =
    | 'translate'
    | 'restore'
    | 'disableSite'
    | 'enableSite';

export interface ContextMenuEntryDefinition {
    readonly id: ContextMenuActionId;
    readonly buckets: readonly ContextMenuBucket[];
    /** 未被用户显式设置时的默认可见性；图片入口由图片翻译设置单独持有。 */
    readonly defaultEnabled: boolean;
    /** 该动作是否会把内容译成目标语言，决定标题能否附带语言名。 */
    readonly translatesIntoTarget: boolean;
    /** 该动作是否拥有可提示的快捷键。 */
    readonly hasShortcut: boolean;
    /** 是否由右键菜单设置持有显示开关；图片入口的开关归图片翻译设置。 */
    readonly preferenceOwned: boolean;
}

/** 目录顺序即菜单显示顺序：先处理“我右键的这个东西”，再提供页面级动作，最后才是网站级开关。 */
export const CONTEXT_MENU_ENTRIES: readonly ContextMenuEntryDefinition[] = Object.freeze([
    Object.freeze({id: 'translateSelection', buckets: Object.freeze(['selection'] as const), defaultEnabled: true, translatesIntoTarget: true, hasShortcut: false, preferenceOwned: true}),
    Object.freeze({id: 'translateImage', buckets: Object.freeze(['image'] as const), defaultEnabled: true, translatesIntoTarget: true, hasShortcut: false, preferenceOwned: false}),
    Object.freeze({id: 'translatePage', buckets: Object.freeze(['page'] as const), defaultEnabled: true, translatesIntoTarget: true, hasShortcut: true, preferenceOwned: true}),
    Object.freeze({id: 'translateArea', buckets: Object.freeze(['page'] as const), defaultEnabled: false, translatesIntoTarget: true, hasShortcut: false, preferenceOwned: true}),
    Object.freeze({id: 'toggleSite', buckets: Object.freeze(['selection', 'page'] as const), defaultEnabled: false, translatesIntoTarget: false, hasShortcut: false, preferenceOwned: true}),
]) as readonly ContextMenuEntryDefinition[];

/** 三个场景的原生 contexts；不注册 link，避免链接图片同时命中全文和图片操作。 */
export const CONTEXT_MENU_BUCKET_CONTEXTS: Readonly<Record<ContextMenuBucket, readonly string[]>> = Object.freeze({
    selection: Object.freeze(['selection'] as const),
    page: Object.freeze(['page'] as const),
    image: Object.freeze(['image'] as const),
}) as Readonly<Record<ContextMenuBucket, readonly string[]>>;

const BUCKET_ORDER: readonly ContextMenuBucket[] = Object.freeze(['selection', 'page', 'image'] as const);

export type ContextMenuEntryToggles = Readonly<Record<ContextMenuActionId, boolean>>;

/** 用户显式设置过的入口偏好；未出现的入口沿用产品默认值。 */
export type ContextMenuEntryPreferences = Partial<Record<ContextMenuActionId, boolean>>;

/** 只接受已知入口的布尔值，避免旧配置或导入文件把无效键写回存储。 */
export function normalizeContextMenuEntryPreferences(value: unknown): ContextMenuEntryPreferences {
    const preferences: ContextMenuEntryPreferences = {};
    if (!value || typeof value !== 'object') return preferences;
    const source = value as Record<string, unknown>;
    for (const entry of CONTEXT_MENU_ENTRIES) {
        const preferred = source[entry.id];
        if (entry.preferenceOwned && typeof preferred === 'boolean') preferences[entry.id] = preferred;
    }
    return preferences;
}

/** 功能可用性：入口只在对应能力真正可用时出现，避免点了没有反应的菜单。 */
export interface ContextMenuFeatureAvailability {
    readonly selectionTranslation: boolean;
    readonly imageTranslation: boolean;
    readonly areaTranslation: boolean;
}

export interface ContextMenuDisplayOptions {
    readonly showTargetLanguage: boolean;
    readonly showShortcut: boolean;
}

export interface ContextMenuPageState {
    readonly isTranslated: boolean;
    readonly isSiteDisabled: boolean;
}

export interface ContextMenuPlanItem {
    readonly menuItemId: string;
    readonly bucket: ContextMenuBucket;
    readonly role: ContextMenuItemRole;
    readonly action: ContextMenuActionId;
    /** 每个场景直接注册一级入口，不生成子菜单。 */
    readonly contexts: readonly string[];
}

export interface ContextMenuTitleDescriptor {
    readonly role: ContextMenuItemRole;
    readonly state: ContextMenuTitleState;
    readonly withTargetLanguage: boolean;
    readonly withShortcut: boolean;
}

export interface ContextMenuItemPresentation {
    readonly menuItemId: string;
    readonly visible: boolean;
    readonly title: ContextMenuTitleDescriptor;
    /** 实际点击动作；网站被关闭时翻译入口会改写为恢复网站。 */
    readonly action: ContextMenuActionId | null;
}

const MENU_ID_PREFIX = 'fluent-read';

export function contextMenuItemId(bucket: ContextMenuBucket, suffix: ContextMenuActionId | 'group'): string {
    return `${MENU_ID_PREFIX}:${bucket}:${suffix}`;
}

/**
 * 把用户偏好与功能可用性合并为最终的入口开关。
 *
 * 图片入口不读取偏好表：它的唯一真源是图片翻译设置里的右键开关，避免两处开关互相打架。
 */
export function resolveContextMenuEntryToggles(
    preferences: ContextMenuEntryPreferences | undefined,
    availability: ContextMenuFeatureAvailability,
): ContextMenuEntryToggles {
    const capable: Readonly<Record<ContextMenuActionId, boolean>> = {
        translateSelection: availability.selectionTranslation,
        translatePage: true,
        translateArea: availability.areaTranslation,
        translateImage: availability.imageTranslation,
        toggleSite: true,
    };
    const toggles = {} as Record<ContextMenuActionId, boolean>;
    for (const entry of CONTEXT_MENU_ENTRIES) {
        const preferred = entry.preferenceOwned
            ? preferences?.[entry.id] ?? entry.defaultEnabled
            : true;
        toggles[entry.id] = preferred && capable[entry.id];
    }
    return Object.freeze(toggles);
}

function entriesInBucket(bucket: ContextMenuBucket): readonly ContextMenuEntryDefinition[] {
    return CONTEXT_MENU_ENTRIES.filter((entry) => entry.buckets.includes(bucket));
}

function buildBucketPlan(bucket: ContextMenuBucket, toggles: ContextMenuEntryToggles): ContextMenuPlanItem[] {
    // 原生菜单同时命中多个条目时，Chrome 会自动折叠为带扩展名的子菜单。
    // 按目录优先选择与当前对象最相关的操作；保留已保存的其他偏好作为后备。
    const entry = entriesInBucket(bucket).find((entry) => toggles[entry.id]);
    if (!entry) return [];
    return [Object.freeze({
        menuItemId: contextMenuItemId(bucket, entry.id),
        bucket, role: 'standalone', action: entry.id,
        contexts: CONTEXT_MENU_BUCKET_CONTEXTS[bucket],
    })];
}

/** 依据启用项生成菜单结构；结构在设置变化时重建，页面状态变化只更新标题与可见性。 */
export function buildContextMenuPlan(toggles: ContextMenuEntryToggles): readonly ContextMenuPlanItem[] {
    return Object.freeze(BUCKET_ORDER.flatMap((bucket) => buildBucketPlan(bucket, toggles)));
}

function bucketHasSiteToggle(bucket: ContextMenuBucket): boolean {
    return entriesInBucket(bucket).some((entry) => entry.id === 'toggleSite');
}

function definitionOf(action: ContextMenuActionId): ContextMenuEntryDefinition {
    return CONTEXT_MENU_ENTRIES.find((entry) => entry.id === action)!;
}

type ActionPresentation = ContextMenuItemPresentation & {readonly action: ContextMenuActionId};

function resolveTranslateState(action: ContextMenuActionId, state: ContextMenuPageState): ContextMenuTitleState {
    if (action === 'toggleSite') return 'disableSite';
    return action === 'translatePage' && state.isTranslated ? 'restore' : 'translate';
}

function resolveStandalone(
    item: ContextMenuPlanItem,
    state: ContextMenuPageState,
    options: ContextMenuDisplayOptions,
): ActionPresentation {
    const action = item.action;
    if (state.isSiteDisabled) {
        // 网站被关闭时不留死入口：能承载网站开关的场景改写为恢复，其余场景直接隐藏。
        const canRecover = bucketHasSiteToggle(item.bucket);
        return Object.freeze<ActionPresentation>({
            menuItemId: item.menuItemId,
            visible: canRecover,
            title: {role: 'standalone', state: 'enableSite', withTargetLanguage: false, withShortcut: false},
            action: canRecover ? 'toggleSite' : action,
        });
    }
    const definition = definitionOf(action);
    const titleState = resolveTranslateState(action, state);
    return Object.freeze<ActionPresentation>({
        menuItemId: item.menuItemId,
        visible: true,
        title: {
            role: 'standalone',
            state: titleState,
            // 恢复原文不会译出新内容，标题里不应再出现译入语言。
            withTargetLanguage: options.showTargetLanguage && definition.translatesIntoTarget && titleState === 'translate',
            withShortcut: options.showShortcut && definition.hasShortcut,
        },
        action,
    });
}

/** 把页面状态映射为每个菜单项的标题描述与可见性；结构保持不变，只做就地更新。 */
export function resolveContextMenuPresentation(
    plan: readonly ContextMenuPlanItem[],
    state: ContextMenuPageState,
    options: ContextMenuDisplayOptions,
): readonly ActionPresentation[] {
    return plan.map((item) => resolveStandalone(item, state, options));
}
