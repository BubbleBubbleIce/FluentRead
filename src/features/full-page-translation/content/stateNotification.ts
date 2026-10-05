/**
 * @file src/features/full-page-translation/content/stateNotification.ts
 * 文件职责：向当前文档和后台发布全文会话开始及恢复状态。
 * 主要内容：发布页面事件与后台会话及工具栏状态，隔离文档通知和扩展失效异常；页面回调改变会话后不再发送旧状态。
 * 模块边界：不拥有全文会话、不接收页面事件作为命令，也不修改标签页状态；后台决定发送 frame 的权限。
 */
import {type TranslationToolbarStatus} from '../toolbarStatus';
let toolbarStatus: TranslationToolbarStatus = 'idle';
export function getTranslationToolbarStatus(): TranslationToolbarStatus { return toolbarStatus; }
export function notifyTranslationToolbarStatus(status: TranslationToolbarStatus): void {
    if (toolbarStatus === status) return;
    toolbarStatus = status;
    sendState(true);
}
function sendState(isTranslated: boolean): void {
    try {
        if (typeof browser === 'undefined' || !browser.runtime?.sendMessage) return;
        void Promise.resolve(browser.runtime.sendMessage({type: 'fullPageTranslationState', isTranslated, toolbarStatus})).catch(() => undefined);
    } catch { /* 扩展重载时不影响页面。 */ }
}
let revision = 0;
export function getFullPageTranslationStateRevision(): number { return revision; }

export function notifyFullPageTranslationState(isTranslated: boolean): void {
    const notificationRevision = ++revision;
    toolbarStatus = isTranslated ? 'translating' : 'idle';
    try {
        if (typeof document !== "undefined" && typeof document.dispatchEvent === "function") {
            const CustomEventConstructor = document.defaultView?.CustomEvent ??
                (typeof CustomEvent !== "undefined" ? CustomEvent : null);
            if (CustomEventConstructor) {
                document.dispatchEvent(new CustomEventConstructor(
                    isTranslated ? "fluentread-translation-started" : "fluentread-translation-ended",
                ));
            }
        }
    } catch { /* 页面事件失败不能阻断后台同步。 */ }
    if (revision === notificationRevision) sendState(isTranslated);
}
