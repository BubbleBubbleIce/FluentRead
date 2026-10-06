import {describe, expect, it} from 'vitest';

import {
    TabTranslationStateStore,
} from '@/src/app/background/tabTranslationState';
import {isBrowserTabId} from '@/src/platform/browser/ids';

describe('后台标签页翻译状态', () => {
    it('文档身份跨状态写入与重复捕获保持，导航或关闭后失效', () => {
        const store = new TabTranslationStateStore(), first = store.captureDocument(1), duplicate = store.captureDocument(1);
        store.setTranslated(1,true);expect(first()).toBe(true);expect(duplicate()).toBe(true);store.reset(1);expect(first()).toBe(false);
        const next = store.captureDocument(1);store.delete(1);expect(next()).toBe(false);expect(store.captureDocument(1)()).toBe(true);
    });
    it('preserves explicit result status and clears it for restore or legacy updates', () => {
        const store = new TabTranslationStateStore();
        expect(store.setTranslated(1, true, 'error').toolbarStatus).toBe('error');
        expect(store.setTranslated(1, false, 'translated').toolbarStatus).toBe('idle');
        expect(store.setTranslated(1, true).toolbarStatus).toBeUndefined();
    });
    it('tab id 接受 0 和非负安全整数，拒绝 truthy 但无效的值', () => {
        expect(isBrowserTabId(0)).toBe(true);
        expect(isBrowserTabId(12)).toBe(true);
        expect(isBrowserTabId(-1)).toBe(false);
        expect(isBrowserTabId(1.2)).toBe(false);
        expect(isBrowserTabId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
        expect(isBrowserTabId('1')).toBe(false);
    });

    it('只有翻译和禁用状态均已知时才命中完整缓存', () => {
        const store = new TabTranslationStateStore();
        expect(store.hasCompleteState(0)).toBe(false);
        expect(store.get(0)).toEqual({isTranslated: false, isSiteDisabled: false});

        expect(store.setTranslated(0, true)).toEqual({isTranslated: true, isSiteDisabled: false});
        expect(store.hasCompleteState(0)).toBe(false);
        expect(store.setSiteDisabled(0, false)).toEqual({isTranslated: true, isSiteDisabled: false});
        expect(store.hasCompleteState(0)).toBe(true);
    });

    it('禁用站点会清除翻译态，导航 reset 与关闭 delete 均可重复执行', () => {
        const store = new TabTranslationStateStore();
        expect(store.setSiteDisabled(7, false)).toEqual({isTranslated: false, isSiteDisabled: false});
        store.set(5, {isTranslated: true, isSiteDisabled: false});
        expect(store.setSiteDisabled(5, true)).toEqual({isTranslated: false, isSiteDisabled: true});
        expect(store.reset(5)).toEqual({isTranslated: false, isSiteDisabled: false});
        store.delete(5);
        store.delete(5);
        expect(store.hasCompleteState(5)).toBe(false);
        expect(store.get(5)).toEqual({isTranslated: false, isSiteDisabled: false});
    });
});
