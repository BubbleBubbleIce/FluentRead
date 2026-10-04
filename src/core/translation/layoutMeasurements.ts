/**
 * @file src/core/translation/layoutMeasurements.ts
 * 文件职责：在一次同步布局复核中缓存计算样式与几何读数，避免同批段落反复读取共享祖先。
 * 主要内容：按需冻结已读取的布局样式字段，缓存 CSS 属性和边界矩形；宿主或扩展写入布局后显式清空本轮读数，缺失布局 API 时保守降级。
 * 模块边界：只读取调用方传入的元素，不写 DOM、不持有跨任务缓存；调用方负责在布局写入后 invalidate，并在下一任务创建新上下文。
 */
const styleFields = ['position', 'transform', 'overflow', 'overflowY', 'height', 'display',
    'maxHeight', 'webkitLineClamp'] as const;

export type TranslationLayoutStyle = Readonly<Pick<CSSStyleDeclaration, typeof styleFields[number]>> &
    {getPropertyValue: (name: string) => string};

export interface TranslationLayoutMeasurements {
    style: (element: HTMLElement) => TranslationLayoutStyle | undefined;
    rect: (element: HTMLElement) => DOMRect | undefined;
    invalidate: () => void;
}

export function createTranslationLayoutMeasurements(): TranslationLayoutMeasurements {
    let styles = new WeakMap<HTMLElement, TranslationLayoutStyle | undefined>();
    let rects = new WeakMap<HTMLElement, DOMRect | undefined>();
    return {
        style(element) {
            if (styles.has(element)) return styles.get(element);
            let snapshot: TranslationLayoutStyle | undefined;
            try {
                const live = element.ownerDocument?.defaultView?.getComputedStyle(element);
                if (live) {
                    const properties = new Map<string, string>();
                    const fields = new Map<string, string>();
                    snapshot = Object.defineProperties<{getPropertyValue(name: string): string}>({
                        getPropertyValue(name: string) {
                            if (!properties.has(name)) properties.set(name, live.getPropertyValue(name));
                            return properties.get(name)!;
                        },
                    }, Object.fromEntries(styleFields.map(name => [name, {enumerable: true, get() {
                        if (!fields.has(name)) fields.set(name, live[name]);
                        return fields.get(name)!;
                    }}]))) as TranslationLayoutStyle;
                }
            } catch { /* 无布局 API 的 DOM 保守视为未知样式。 */ }
            styles.set(element, snapshot);
            return snapshot;
        },
        rect(element) {
            if (rects.has(element)) return rects.get(element);
            let rect: DOMRect | undefined;
            try { rect = element.getBoundingClientRect(); } catch { /* 布局不可读取。 */ }
            rects.set(element, rect);
            return rect;
        },
        invalidate() {
            styles = new WeakMap();
            rects = new WeakMap();
        },
    };
}
