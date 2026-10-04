import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTranslationLayoutMeasurements} from '@/src/core/translation/layoutMeasurements';
import {hasActiveTranslationLineClamp, hasTranslationHeightOverflow} from '@/src/core/translation/serialization';
import {beginTranslation, createTranslationTruncationLayoutBatch, ensureTranslationTruncationLayout,
    markTranslationComplete, restoreAllTranslations, restoreTranslation, setBilingualContent} from '@/src/features/full-page-translation/content/state';

afterEach(() => restoreAllTranslations());

const style = (overrides: object = {}) => ({position: 'static', transform: 'none', display: 'block',
    overflow: 'visible', overflowY: 'visible', height: '100px', maxHeight: 'none', webkitLineClamp: 'none',
    getPropertyValue: vi.fn(() => ''), ...overrides});
const rect = (bottom = 100) => ({top: 0, bottom} as DOMRect);

describe('synchronous translation layout measurements', () => {
    it('同轮冻结样式并缓存 CSS 属性与几何，显式失效后读取宿主最新布局', () => {
        const {document, window} = parseHTML('<html><body><p>Source.</p></body></html>');
        const owner = document.querySelector('p')!;
        const live = style();
        const readStyle = vi.fn(() => live);
        const readRect = vi.fn(() => rect());
        Object.defineProperty(window, 'getComputedStyle', {value: readStyle, configurable: true});
        owner.getBoundingClientRect = readRect;
        const measurements = createTranslationLayoutMeasurements();
        const first = measurements.style(owner)!;
        expect(first.height).toBe('100px');
        expect(measurements.style(owner)).toBe(first);
        first.getPropertyValue('line-clamp');
        first.getPropertyValue('line-clamp');
        expect(live.getPropertyValue).toHaveBeenCalledTimes(1);
        expect(measurements.rect(owner)).toBe(measurements.rect(owner));
        expect(readRect).toHaveBeenCalledTimes(1);
        live.height = '200px';
        expect(first.height).toBe('100px');
        measurements.invalidate();
        expect(measurements.style(owner)?.height).toBe('200px');
        expect(measurements.rect(owner)?.bottom).toBe(100);
        expect(readStyle).toHaveBeenCalledTimes(2);
        expect(readRect).toHaveBeenCalledTimes(2);
    });

    it('布局 API 失败也只探测一次，失效后允许恢复', () => {
        const {document, window} = parseHTML('<html><body><p>Source.</p></body></html>');
        const owner = document.querySelector('p')!;
        const readStyle = vi.fn().mockImplementationOnce(() => {throw new Error('No style');}).mockReturnValue(style());
        const readRect = vi.fn().mockImplementationOnce(() => {throw new Error('No rect');}).mockReturnValue(rect());
        Object.defineProperty(window, 'getComputedStyle', {value: readStyle, configurable: true});
        owner.getBoundingClientRect = readRect;
        const measurements = createTranslationLayoutMeasurements();
        expect(measurements.style(owner)).toBeUndefined();
        expect(measurements.style(owner)).toBeUndefined();
        expect(measurements.rect(owner)).toBeUndefined();
        expect(measurements.rect(owner)).toBeUndefined();
        expect(readStyle).toHaveBeenCalledTimes(1);
        expect(readRect).toHaveBeenCalledTimes(1);
        measurements.invalidate();
        expect(measurements.style(owner)).toBeDefined();
        expect(measurements.rect(owner)).toBeDefined();
        expect(createTranslationLayoutMeasurements().style({} as HTMLElement)).toBeUndefined();
        expect(createTranslationLayoutMeasurements().style({ownerDocument: {}} as HTMLElement)).toBeUndefined();
        Object.defineProperty(window, 'getComputedStyle', {value: () => undefined, configurable: true});
        expect(createTranslationLayoutMeasurements().style(owner)).toBeUndefined();
    });

    it('未知几何不能据此扩大容器', () => {
        const {document, window} = parseHTML('<html><body><main><p>Source.</p></main></body></html>');
        Object.defineProperty(window, 'getComputedStyle', {value: () => style(), configurable: true});
        const owner = document.querySelector('p')!;
        const main = document.querySelector('main')!;
        main.getBoundingClientRect = () => rect();
        owner.getBoundingClientRect = () => {throw new Error('No rect');};
        expect(hasTranslationHeightOverflow(main, owner, createTranslationLayoutMeasurements())).toBe(false);
        main.getBoundingClientRect = () => {throw new Error('No rect');};
        expect(hasTranslationHeightOverflow(main, owner, createTranslationLayoutMeasurements())).toBe(false);
    });

    it('计算样式属性读取失败时不解除未知 line-clamp', () => {
        const {document, window} = parseHTML('<html><body><p>Source.</p></body></html>');
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: () => {
            const live = style();
            Object.defineProperty(live, 'webkitLineClamp', {get() {throw new Error('Unreadable property');}});
            return live;
        }});
        const owner = document.querySelector('p')!;
        expect(hasActiveTranslationLineClamp(owner)).toBe(false);
        expect(hasActiveTranslationLineClamp(owner, createTranslationLayoutMeasurements())).toBe(false);
    });

    it('500 段同批布局复核只读取一次共享 main 的 transform，逐项调用不跨轮保留读数', () => {
        const {document, window} = parseHTML('<html><body><main></main></body></html>');
        const main = document.querySelector('main')!;
        let mainTransformReads = 0;
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (element: HTMLElement) => {
            const live = style();
            Object.defineProperty(live, 'transform', {get() {if (element === main) mainTransformReads += 1; return 'none';}});
            return live;
        }});
        const owners: HTMLElement[] = [];
        main.getBoundingClientRect = () => rect();
        for (let index = 0; index < 500; index += 1) {
            const owner = document.createElement('p');
            owner.textContent = `Source ${index}.`;
            owner.getBoundingClientRect = () => rect();
            main.appendChild(owner);
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, owner.textContent, [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '译文';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            owners.push(owner);
        }
        mainTransformReads = 0;
        owners.forEach(owner => expect(ensureTranslationTruncationLayout(owner)).toBe(true));
        expect(mainTransformReads).toBeGreaterThanOrEqual(500);
        mainTransformReads = 0;
        const reconcile = createTranslationTruncationLayoutBatch();
        owners.forEach(owner => expect(reconcile(owner)).toBe(true));
        expect(mainTransformReads).toBe(1);
    });

    it('同批解除共享裁剪后立即废弃旧样式，恢复兄弟段落仍沿用首个租约基线', () => {
        const {document, window} = parseHTML('<html><body><main style="-webkit-line-clamp:2;max-height:20px;overflow:hidden"><p>First source.</p><p>Second source.</p></main></body></html>');
        const main = document.querySelector('main')!;
        const originalStyle = main.getAttribute('style');
        let mainReads = 0;
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (element: HTMLElement) => {
            if (element === main) mainReads += 1;
            return style({height: element.style.height || '100px', overflowY: element.style.overflow || 'visible',
                maxHeight: element.style.maxHeight || 'none', webkitLineClamp: element.style.getPropertyValue('-webkit-line-clamp') || 'none',
                getPropertyValue: (name: string) => element.style.getPropertyValue(name) || '',
            });
        }});
        const owners = Array.from(document.querySelectorAll<HTMLElement>('p'));
        [main, ...owners].forEach(owner => {owner.getBoundingClientRect = () => rect();});
        owners.forEach(owner => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, owner.textContent!, [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '译文';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
        });
        mainReads = 0;
        const reconcile = createTranslationTruncationLayoutBatch();
        owners.forEach(owner => expect(reconcile(owner)).toBe(true));
        expect(mainReads).toBeGreaterThan(1);
        expect(main.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        restoreTranslation(owners[0]!);
        expect(main.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        restoreTranslation(owners[1]!);
        expect(main.getAttribute('style')).toBe(originalStyle);
    });
});
