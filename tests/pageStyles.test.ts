import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TRANSLATION_APPEARANCE_STYLE_ID} from '@/src/app/content/translationAppearance';
import reencounterStyles from '@/src/ui/styles/vocabulary-reencounter.css?inline';

type AppearanceConfig = {translationAppearance: unknown};

const mocks = vi.hoisted(() => ({
    config: {translationAppearance: {} as unknown},
    listeners: new Set<(nextConfig: {translationAppearance: unknown}) => void>(),
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config,
    subscribeConfig: (listener: (nextConfig: AppearanceConfig) => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
    },
}));

describe('页面公共样式与译文外观生命周期', () => {
    let invalidations: Array<() => void>;
    const context = () => ({onInvalidated: (callback: () => void) => { invalidations.push(callback); }}) as never;
    const appearanceStyle = () => document.getElementById(TRANSLATION_APPEARANCE_STYLE_ID);

    beforeEach(() => {
        vi.stubGlobal('document', parseHTML('<!doctype html><html><head></head><body><p>Source</p></body></html>').document);
        invalidations = [];
        mocks.listeners.clear();
        mocks.config.translationAppearance = {lineColor: '#ef4776'};
    });
    afterEach(() => vi.unstubAllGlobals());

    it('安装共享样式时同步当前外观，并随配置变化原位更新或移除外观节点', async () => {
        const {installPageStyles} = await import('@/src/app/content/pageStyles');
        installPageStyles(context());
        expect(document.querySelectorAll('#fluent-read-page-styles')).toHaveLength(1);
        expect(document.getElementById('fluent-read-page-styles')?.parentNode).toBe(document.head);
        expect(reencounterStyles).toContain('::highlight(fluentread-vocabulary-reencounter)');
        expect(document.getElementById('fluent-read-page-styles')?.textContent).toContain(reencounterStyles);
        expect(appearanceStyle()?.textContent).toContain('--fluent-read-translation-line: #ef4776 !important;');
        expect(mocks.listeners.size).toBe(1);

        const [listener] = mocks.listeners;
        listener({translationAppearance: {textColor: '#1d4ed8'}});
        expect(appearanceStyle()?.textContent).toContain('color: #1d4ed8 !important;');
        expect(appearanceStyle()?.textContent).not.toContain('--fluent-read-translation-line');
        listener({translationAppearance: undefined});
        expect(appearanceStyle()).toBeNull();
    });

    it('移除函数与 context 失效都会退订并清理两类样式，重复调用保持安全', async () => {
        const {installPageStyles} = await import('@/src/app/content/pageStyles');
        const remove = installPageStyles(context());
        remove();
        expect(document.getElementById('fluent-read-page-styles')).toBeNull();
        expect(appearanceStyle()).toBeNull();
        expect(mocks.listeners.size).toBe(0);
        expect(() => remove()).not.toThrow();

        installPageStyles(context());
        expect(appearanceStyle()).not.toBeNull();
        invalidations.at(-1)!();
        expect(document.getElementById('fluent-read-page-styles')).toBeNull();
        expect(appearanceStyle()).toBeNull();
        expect(mocks.listeners.size).toBe(0);
    });

    it('文档已有公共样式时不重复注入，也不另建外观订阅', async () => {
        const {installPageStyles} = await import('@/src/app/content/pageStyles');
        const removeFirst = installPageStyles(context());
        const removeSecond = installPageStyles(context());
        expect(document.querySelectorAll('#fluent-read-page-styles')).toHaveLength(1);
        expect(mocks.listeners.size).toBe(1);
        expect(invalidations).toHaveLength(1);
        removeSecond();
        expect(document.getElementById('fluent-read-page-styles')).not.toBeNull();
        removeFirst();
        expect(document.getElementById('fluent-read-page-styles')).toBeNull();
    });

    it('没有 head 时把公共样式挂到根元素', async () => {
        Object.defineProperty(document, 'head', {configurable: true, get: () => null});
        mocks.config.translationAppearance = undefined;
        const {installPageStyles} = await import('@/src/app/content/pageStyles');
        installPageStyles(context());
        expect(document.getElementById('fluent-read-page-styles')?.parentNode).toBe(document.documentElement);
        expect(appearanceStyle()).toBeNull();
    });
});
