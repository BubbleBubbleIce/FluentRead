/**
 * @file src/app/background/tabTranslationState.ts
 * 文件职责：维护后台内存中的按标签页全文翻译状态，为右键菜单展示和运行时消息提供轻量、可清理的状态来源。
 * 主要内容：定义 isTranslated、isSiteDisabled 与可选 toolbarStatus，维护瞬时状态及回源查询归属；新查询、直接状态消息、导航或关闭使旧回复失效，同时从 platform 重新导出合法 tabId 判断。
 * 模块边界：该 store 不持久化到浏览器存储、不操作页面 DOM，也不触发翻译；它只保存当前 worker 生命周期内的展示状态，业务会话仍由 full-page feature 管理。
 */
import {type TranslationToolbarStatus} from '@/src/features/full-page-translation/toolbarStatus';
export {isBrowserTabId} from '@/src/platform/browser/ids';

export interface TabTranslationState {
    isTranslated: boolean;
    isSiteDisabled: boolean;
    toolbarStatus?: TranslationToolbarStatus;
}

interface PartialTabTranslationState {
    isTranslated?: boolean;
    isSiteDisabled?: boolean;
    toolbarStatus?: TranslationToolbarStatus;
}

/**
 * 保存后台 service worker 的标签页瞬时状态；持久真值仍由 content script 提供。
 */
export class TabTranslationStateStore {
    private readonly states = new Map<number, PartialTabTranslationState>();
    private readonly queries = new Map<number, object>();
    private readonly documents = new Map<number, object>();

    /** 点击属于当时的文档；状态刷新保持身份，导航和关闭使其失效。 */
    captureDocument(tabId: number): () => boolean {
        const document = this.documents.get(tabId) || {};
        this.documents.set(tabId, document);
        return () => this.documents.get(tabId) === document;
    }

    /** 回源读取属于当时的页面状态；更新、导航、关闭及更新的读取都会使旧回复失效。 */
    beginQuery(tabId: number): () => boolean {
        const query = {};
        this.queries.set(tabId, query);
        return () => this.queries.get(tabId) === query;
    }

    hasCompleteState(tabId: number): boolean {
        const state = this.states.get(tabId);
        return typeof state?.isTranslated === 'boolean'
            && typeof state.isSiteDisabled === 'boolean';
    }

    get(tabId: number): TabTranslationState {
        const state = this.states.get(tabId);
        return {
            ...(state?.toolbarStatus !== undefined ? {toolbarStatus: state.toolbarStatus} : {}),
            isTranslated: state?.isTranslated === true,
            isSiteDisabled: state?.isSiteDisabled === true,
        };
    }

    set(tabId: number, state: TabTranslationState): TabTranslationState {
        this.queries.delete(tabId);
        const snapshot = {...state};
        this.states.set(tabId, snapshot);
        return snapshot;
    }

    setTranslated(tabId: number, isTranslated: boolean, toolbarStatus?: TranslationToolbarStatus): TabTranslationState {
        this.queries.delete(tabId);
        const current = this.states.get(tabId) || {};
        current.isTranslated = isTranslated;
        if (toolbarStatus !== undefined) current.toolbarStatus = isTranslated ? toolbarStatus : 'idle';
        else delete current.toolbarStatus;
        this.states.set(tabId, current);
        return this.get(tabId);
    }

    setSiteDisabled(tabId: number, isSiteDisabled: boolean): TabTranslationState {
        this.queries.delete(tabId);
        const current = this.states.get(tabId) || {};
        current.isSiteDisabled = isSiteDisabled;
        if (isSiteDisabled) current.isTranslated = false;
        this.states.set(tabId, current);
        return this.get(tabId);
    }

    reset(tabId: number): TabTranslationState {
        this.documents.delete(tabId);
        return this.set(tabId, {isTranslated: false, isSiteDisabled: false});
    }

    delete(tabId: number): void {
        this.documents.delete(tabId);
        this.queries.delete(tabId);
        this.states.delete(tabId);
    }
}
