/**
 * @file src/app/background/tabTranslationQuery.ts
 * 文件职责：把「向 content script 回源查询某标签页全文翻译真值」下沉为后台共享函数，供右键菜单与工具栏角标复用同一份真值来源。
 * 主要内容：createTabTranslationStateReader 绑定 TabTranslationStateStore 返回读取器，命中完整缓存直接返回，否则只向顶层发送 getFullPageTranslationState；只允许当前查询写回，旧读取等待共享仓库中最新的在途查询，导航或关闭后的回复不复活缓存。
 * 模块边界：这里只封装状态查询与缓存写回，不渲染菜单文案、不设置图标角标、不发起正文翻译；展示决策与生命周期监听仍归各自 runtime 模块。
 */
import {normalizeTranslationToolbarStatus} from '@/src/features/full-page-translation/toolbarStatus';
import {type TabTranslationState, TabTranslationStateStore} from './tabTranslationState';

export interface FullPageStateResponse {
    status?: string;
    isTranslated?: boolean;
    isSiteDisabled?: boolean;
    toolbarStatus?: unknown;
}

/** 读取标签页翻译真值：force 为 true 时跳过缓存强制回源，用于菜单点击等需要最新态的场景。 */
export type TabTranslationStateReader = (tabId: number, force?: boolean) => Promise<TabTranslationState>;

// 菜单和角标使用不同读取器，但共享同一个仓库及在途查询；最新查询完成即释放条目。
const pendingQueries = new WeakMap<TabTranslationStateStore, Map<number, Promise<TabTranslationState>>>();

/**
 * 绑定状态仓库返回真值读取器。
 *
 * 命中完整缓存直接返回；否则向 content script 查询并写回缓存。浏览器内部页或尚未注入内容脚本的页面查询失败，沿用当前 worker 的安全默认值。
 */
export function createTabTranslationStateReader(
    tabTranslationStates: TabTranslationStateStore,
): TabTranslationStateReader {
    let pending = pendingQueries.get(tabTranslationStates);
    if (!pending) {
        pending = new Map();
        pendingQueries.set(tabTranslationStates, pending);
    }
    const queries = pending;
    return (tabId: number, force = false): Promise<TabTranslationState> => {
        if (!force && tabTranslationStates.hasCompleteState(tabId)) return Promise.resolve(tabTranslationStates.get(tabId));
        const current = tabTranslationStates.beginQuery(tabId);
        // 先登记 Promise 再调用浏览器端口，同步异常也能读取已登记的最新查询身份。
        const query: Promise<TabTranslationState> = Promise.resolve().then(async () => {
            try {
                const response = await browser.tabs.sendMessage(tabId, {
                    type: 'getFullPageTranslationState',
                }, {frameId: 0}) as FullPageStateResponse | undefined;
                if (current() && response?.status === 'success') {
                    return tabTranslationStates.set(tabId, {
                        toolbarStatus: normalizeTranslationToolbarStatus(response.toolbarStatus),
                        isTranslated: response.isTranslated === true,
                        isSiteDisabled: response.isSiteDisabled === true,
                    });
                }
            } catch {
                // 内部页或尚未注入内容脚本的页面查询失败，沿用当前安全状态。
            }
            if (current()) return tabTranslationStates.set(tabId, tabTranslationStates.get(tabId));
            const latest = queries.get(tabId);
            return latest && latest !== query ? latest : tabTranslationStates.get(tabId);
        }).finally(() => {if (queries.get(tabId) === query) queries.delete(tabId);});
        queries.set(tabId, query);
        return query;
    };
}
