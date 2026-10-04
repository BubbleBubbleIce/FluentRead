/**
 * @file src/features/full-page-translation/content/viewportStability.ts
 * 文件职责：隔离全文翻译对页面滚动稳定性的辅助逻辑，避免动态页面在插入译文时发生视觉跳动或重复重排。
 * 主要内容：局部变化只补偿同一滚动面上方的内容，全量恢复按已知 owner 保护文档和各内层滚动面的上沿；单次只读捕获共享祖先与几何，写入后重新测量锚点，另提供滚动空闲门控。
 * 模块边界：本文件只管理可逆的浏览器视口状态与延迟回调，具体重启目标仍由全文 runtime 决定。
 */
import {getComposedParent, maxComposedAncestorDepth} from '@/src/core/translation/public';

const TRANSLATION_ARTIFACT_SELECTOR = [
    '[data-fr-translation-segment="true"]',
    '[data-fr-translation-owned="true"]',
    '.fluent-read-bilingual-content',
].join(',');

const FULL_PAGE_SCROLL_IDLE_MS = 220;

function isElementNode(node: Node | null | undefined): node is Element {
    return Boolean(node && node.nodeType === 1 && typeof (node as Element).matches === 'function');
}

function asHTMLElement(node: unknown): HTMLElement | null {
    if (!node || typeof node !== 'object' || (node as Node).nodeType !== 1) return null;
    const element = node as HTMLElement;
    return typeof element.tagName === 'string' && typeof element.style === 'object' ? element : null;
}

interface FullPageViewportAnchor {
    element: HTMLElement;
    top: number;
    scrollContainer: HTMLElement | null;
    relativeToScrollContainer?: boolean;
}

function isExcluded(element: HTMLElement, excludedNodes: readonly Node[]): boolean {
    return excludedNodes.some((excluded) => excluded === element ||
        (isElementNode(excluded) && (excluded.contains(element) || element.contains(excluded))));
}

interface ViewportCaptureMeasurements {
    scrollContainers: Map<HTMLElement, HTMLElement | null | undefined>;
    rects: Map<HTMLElement, DOMRect>;
}

function captureRect(element: HTMLElement, measurements: ViewportCaptureMeasurements): DOMRect {
    if (measurements.rects.has(element)) return measurements.rects.get(element)!;
    const rect = element.getBoundingClientRect();
    measurements.rects.set(element, rect);
    return rect;
}

function findScrollableAncestor(element: HTMLElement, measurements: ViewportCaptureMeasurements): HTMLElement | null | undefined {
    let current = asHTMLElement(getComposedParent(element));
    const path: HTMLElement[] = [];
    let container: HTMLElement | null | undefined = null;
    while (current && current !== document.body) {
        if (measurements.scrollContainers.has(current)) {
            container = measurements.scrollContainers.get(current);
            break;
        }
        if (path.length >= maxComposedAncestorDepth) {
            container = undefined;
            break;
        }
        path.push(current);
        try {
            // scrollHeight/clientHeight 会在每次译文写入后强制整页布局。先排除普通的
            // overflow:visible 祖先，只对实际允许滚动的容器测量几何；两项条件仍需同时成立。
            const style = current.ownerDocument.defaultView?.getComputedStyle(current);
            if (style && /(auto|scroll|overlay)/u.test(style.overflowY) &&
                current.scrollHeight > current.clientHeight) {
                container = current;
                break;
            }
        } catch {
            // Host custom elements can throw while their layout is being rebuilt.
        }
        current = asHTMLElement(getComposedParent(current));
    }
    for (const ancestor of path) measurements.scrollContainers.set(ancestor, container);
    return container;
}

function viewportTopOf(scrollContainer: HTMLElement | null, measurements: ViewportCaptureMeasurements): number {
    return scrollContainer
        ? captureRect(scrollContainer, measurements).top + scrollContainer.clientTop
        : 0;
}

function changedElement(node: Node): HTMLElement | null {
    const element = asHTMLElement(node) ?? asHTMLElement(node.parentElement);
    return element?.isConnected ? element : null;
}

/** 变化元素完全位于给定滚动面视口上沿之上时才会推动该滚动面中的阅读位置。 */
function isAboveViewportTop(element: HTMLElement, scrollContainer: HTMLElement | null,
    measurements: ViewportCaptureMeasurements): boolean {
    const rect = captureRect(element, measurements);
    return (rect.width > 0 || rect.height > 0) && rect.bottom <= viewportTopOf(scrollContainer, measurements);
}

/**
 * 译文在可见段落后展开时，下面的内容自然下移；这不是需要滚动抵消的偏移。
 * 只有变化完全发生在当前滚动面的视口上方时，才主动维持阅读位置。
 * 页首必须保持在页首；整页恢复则用视口上沿的内容锚点保护阅读位置。
 */
function shouldCompensateViewportChange(
    scrollContainer: HTMLElement | null,
    changedNodes: readonly Node[],
    measurements: ViewportCaptureMeasurements,
): boolean {
    if ((scrollContainer?.scrollTop ?? window.scrollY) === 0) return false;
    if (changedNodes.length === 0) return true;
    return changedNodes.some((node) => {
        const element = changedElement(node);
        return Boolean(element && findScrollableAncestor(element, measurements) === scrollContainer &&
            isAboveViewportTop(element, scrollContainer, measurements));
    });
}

/**
 * 命中测试需要最新布局与绘制属性，在逐段写入译文时代价最高。局部变化只有落在
 * 自身已离开顶部的滚动面视口上方时才可能补偿；这是任一锚点返回补偿的必要条件，
 * 全部不满足时结果必然为空，因此跳过命中测试。读取异常时回到完整路径处理。
 */
function mayCompensateLocalViewportChange(changedNodes: readonly Node[], measurements: ViewportCaptureMeasurements): boolean {
    try {
        return changedNodes.some((node) => {
            const element = changedElement(node);
            if (!element) return false;
            const scrollContainer = findScrollableAncestor(element, measurements);
            return scrollContainer !== undefined && (scrollContainer?.scrollTop ?? window.scrollY) !== 0 &&
                isAboveViewportTop(element, scrollContainer, measurements);
        });
    } catch {
        return true;
    }
}

function captureViewportAnchor(excludedNodes: readonly Node[] = []): FullPageViewportAnchor | null {
    if (typeof document === 'undefined' || typeof window === 'undefined' ||
        typeof document.elementFromPoint !== 'function') return null;
    const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
    if (excludedNodes.length > 0 && !mayCompensateLocalViewportChange(excludedNodes, measurements)) return null;

    // 整页恢复同时移除屏幕上下方的译文，保住中部会把下方收缩也算作滚动量。
    const anchorRatios = excludedNodes.length === 0 ? [0.01, 0.02, 0.04] : [0.5, 0.33, 0.66];
    for (const ratio of anchorRatios) {
        const x = Math.max(0, Math.floor((window.innerWidth || 0) / 2));
        const y = Math.max(0, Math.min((window.innerHeight || 1) - 1,
            Math.floor((window.innerHeight || 1) * ratio)));
        let element = asHTMLElement(document.elementFromPoint(x, y));
        while (element && isExcluded(element, excludedNodes)) element = element.parentElement;
        if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
        try {
            const rect = captureRect(element, measurements);
            if (!(rect.width || rect.height)) continue;
            const scrollContainer = findScrollableAncestor(element, measurements);
            if (scrollContainer === undefined) continue;
            if (!shouldCompensateViewportChange(scrollContainer, excludedNodes, measurements)) continue;
            return {element, top: rect.top, scrollContainer};
        } catch {
            // The page may detach the candidate between hit testing and layout.
        }
    }
    return null;
}

/** 读取浏览器实际采用的滚动量；仅对亚像素取整试一次修正，更差时回到首个结果。 */
function applyScrollCompensation(scrollContainer: HTMLElement | null, offset: number): void {
    const read = () => scrollContainer ? scrollContainer.scrollTop : window.scrollY;
    const apply = (delta: number) => {
        if (scrollContainer) scrollContainer.scrollTop += delta;
        else window.scrollBy(0, delta);
    };
    const initial = read();
    apply(offset);
    if (!Number.isFinite(initial)) return;
    const desired = initial + offset;
    const first = read();
    const error = desired - first;
    // 大差值可能来自边界夹紧、滚动吸附或异步平滑滚动，不能追加推测性的滚动。
    if (!(Math.abs(error) > 0.01 && Math.abs(error) < 1)) return;
    apply(desired + error - read());
    if (Math.abs(read() - desired) > Math.abs(error)) apply(first - read());
}

function restoreViewportAnchor(anchor: FullPageViewportAnchor | null): void {
    if (!anchor?.element.isConnected) return;
    try {
        const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
        if (anchor.relativeToScrollContainer &&
            findScrollableAncestor(anchor.element, measurements) !== anchor.scrollContainer) return;
        const surfaceTop = anchor.relativeToScrollContainer ? viewportTopOf(anchor.scrollContainer, measurements) : 0;
        const offset = captureRect(anchor.element, measurements).top - surfaceTop - anchor.top;
        if (Math.abs(offset) <= 0.5) return;
        if (anchor.scrollContainer?.isConnected) applyScrollCompensation(anchor.scrollContainer, offset);
        else if (typeof window.scrollBy === 'function') applyScrollCompensation(null, offset);
    } catch {
        // Scroll anchoring is a best-effort visual safeguard and must not break translation.
    }
}

/** 整体恢复只保护每个滚动面的上沿，避免把下半部译文收缩也抵消掉。 */
function captureRestorationAnchor(scrollContainer: HTMLElement | null,
    measurements: ViewportCaptureMeasurements): FullPageViewportAnchor | null {
    if ((scrollContainer?.scrollTop ?? window.scrollY) === 0) return null;
    try {
        const rect = scrollContainer ? captureRect(scrollContainer, measurements) : null;
        const left = Math.max(0, rect?.left ?? 0);
        const right = Math.min(window.innerWidth, rect?.right ?? window.innerWidth);
        const top = Math.max(0, viewportTopOf(scrollContainer, measurements));
        const bottom = Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight);
        if (right <= left || bottom <= top) return null;
        for (const ratio of [0.01, 0.02, 0.04]) {
            const x = Math.floor((left + right) / 2), y = Math.floor(top + (bottom - top) * ratio);
            let element = asHTMLElement(document.elementFromPoint(x, y));
            while (element?.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
                const inner = asHTMLElement(element.shadowRoot.elementFromPoint(x, y));
                if (!inner || inner === element) break;
                element = inner;
            }
            while (element?.matches(TRANSLATION_ARTIFACT_SELECTOR)) element = asHTMLElement(getComposedParent(element));
            if (!element || findScrollableAncestor(element, measurements) !== scrollContainer) continue;
            const anchorRect = captureRect(element, measurements);
            if (!(anchorRect.width || anchorRect.height)) continue;
            return {element, top: anchorRect.top - viewportTopOf(scrollContainer, measurements),
                scrollContainer, relativeToScrollContainer: true};
        }
    } catch { /* 局部布局或命中测试不可读时，不能阻断其它滚动面与恢复。 */ }
    return null;
}

let anchorDepth = 0;

/**
 * 锚点捕获要做命中测试、边界矩形和滚动祖先查找，成本等同一次强制重排。
 * 嵌套调用复用最外层锚点：内层写入仍被同一次补偿覆盖，而每个 DOM 写入
 * 不再各自付一遍测量开销。
 */
export function withFullPageViewportAnchor<T>(callback: () => T, excludedNodes: readonly Node[] = []): T {
    if (anchorDepth > 0) return callback();
    const anchor = captureViewportAnchor(excludedNodes);
    anchorDepth += 1;
    try {
        return callback();
    } finally {
        anchorDepth -= 1;
        restoreViewportAnchor(anchor);
    }
}

/** 使用待恢复 owner 的祖先发现滚动面，不扫描整页；补偿采用面内相对位置。 */
export function withFullPageRestorationAnchors<T>(callback: () => T, changedNodes: readonly Node[]): T {
    if (anchorDepth > 0 || changedNodes.length === 0 || typeof document === 'undefined' ||
        typeof window === 'undefined' || typeof document.elementFromPoint !== 'function') return callback();
    const measurements: ViewportCaptureMeasurements = {scrollContainers: new Map(), rects: new Map()};
    const surfaces = new Set<HTMLElement | null>([null]);
    for (const node of changedNodes) {
        const element = changedElement(node);
        if (!element) continue;
        for (let container = findScrollableAncestor(element, measurements); container;
            container = findScrollableAncestor(container, measurements)) surfaces.add(container);
    }
    const anchors = [...surfaces].map(surface => captureRestorationAnchor(surface, measurements));
    anchorDepth += 1;
    try { return callback(); }
    finally {
        anchorDepth -= 1;
        anchors.forEach(restoreViewportAnchor);
    }
}

export interface FullPageScrollController {
    readonly isScrolling: boolean;
    note(): void;
    defer(target: HTMLElement): boolean;
    dispose(): void;
}

export function createFullPageScrollController(options: {
    isActive: () => boolean;
    onIdle: (targets: readonly HTMLElement[]) => void;
    afterIdle: () => void;
}): FullPageScrollController {
    let scrolling = false;
    let idleTimer: number | null = null;
    const deferredTargets = new Set<HTMLElement>();

    const settle = (): void => {
        idleTimer = null;
        if (!options.isActive()) return;
        scrolling = false;
        const targets = [...deferredTargets];
        deferredTargets.clear();
        options.onIdle(targets);
        options.afterIdle();
    };

    return {
        get isScrolling(): boolean { return scrolling; },
        note(): void {
            if (!options.isActive()) return;
            scrolling = true;
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(settle, FULL_PAGE_SCROLL_IDLE_MS);
        },
        defer(target: HTMLElement): boolean {
            if (!scrolling || !target.isConnected) return false;
            deferredTargets.add(target);
            return true;
        },
        dispose(): void {
            if (idleTimer !== null) window.clearTimeout(idleTimer);
            idleTimer = null;
            scrolling = false;
            deferredTargets.clear();
        },
    };
}
