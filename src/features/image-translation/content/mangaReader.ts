/**
 * @file src/features/image-translation/content/mangaReader.ts
 * 文件职责：把漫画站点的正文图片、超长图分段、可读画布、公开背景图和页面生命周期接入同一连续翻译会话。
 * 主要内容：按站点规则发现正文，圈选页发布区域入口；已确认的 GANMA 路径内页码和 Mangahub 正整数查询页码不视为换章，其他查询参数仍参与章节身份，来源授权保留完整地址；已开启的同章哔哩哔哩会话在可见的原站加载提示期间保留等待，不识别空像素；按位置判断可见页，会话通知后一次测量就绪的附近图片并按数值排序；来源重绘更新身份，当前页优先的有界队列与附近页共享像素预算，换章、隐藏和卸载清理监听器。
 * 模块边界：只检查已展示正文，不抓取章节、不读取站点私有数据或绕过访问限制；图片与画布的读取、翻译、缓存和原图恢复通过注入端口复用图片运行时。
 */
import {createMangaSession, type MangaTranslationStatus} from './mangaSession';
import {normalizeMangaPrefetchPages, normalizeMangaCachePages, resolveMangaSite, type MangaSiteRule} from '@/src/core/config/manga';
import {imageLoadTracker} from './imageLoads';
import type {MangaImageSegment} from './mangaImageSegments';
type MangaSurface = HTMLElement | MangaImageSegment;
type MangaCandidate = {image: MangaSurface; identity: string; ready: boolean; visible: boolean; pixels: number};
const isSegment = (surface: MangaSurface): surface is MangaImageSegment => 'image' in surface;
const isCanvas = (surface: MangaSurface): surface is HTMLCanvasElement => !isSegment(surface) && surface.tagName === 'CANVAS';
const isImage = (surface: MangaSurface): surface is HTMLImageElement => !isSegment(surface) && surface.tagName === 'IMG';
interface SurfacePorts<T> {
    identity: (surface: T) => string | null;
    translate: (surface: T) => Promise<void>;
    reuse: (surface: T) => boolean;
    restore: (surface: T) => void;
    release: (surface: T) => void;
    failed: (surface: T) => boolean;
    update: () => void;
}

/** 精确站点与通用阅读器都需要 DOM 候选检查；网站目录不等同于逐站实测通过。 */
export function mangaReaderSelector(href: string, rules: MangaSiteRule[] = []): string | null {
    return resolveMangaSite(href, rules)?.selector ?? null;
}

export function createMangaReader(ports: {
    enabled: () => boolean;
    siteRules?: () => MangaSiteRule[];
    prefetchPages?: () => number;
    cachePages?: () => number;
    identity: (image: HTMLImageElement) => string;
    translate: (image: HTMLImageElement) => Promise<void>;
    reuse?: (image: HTMLImageElement) => boolean;
    warm?: (images: HTMLImageElement[]) => void;
    resetCache?: () => void;
    restore: (image: HTMLImageElement) => void;
    release: (image: HTMLImageElement) => void;
    failed: (image: HTMLImageElement) => boolean;
    changed: (status: MangaTranslationStatus) => void;
    canvas?: SurfacePorts<HTMLCanvasElement>;
    segments?: SurfacePorts<MangaImageSegment> & {
        prepare: (images: HTMLImageElement[]) => ReadonlyMap<HTMLImageElement, MangaImageSegment[]>;
        pixels: (segment: MangaImageSegment) => number;
        bounds: (segment: MangaImageSegment) => DOMRect;
    };
    background?: SurfacePorts<HTMLElement> & {
        prepare: (elements: HTMLElement[]) => void;
        pixels: (element: HTMLElement) => number;
        bounds: (element: HTMLElement) => DOMRect;
    };
}) {
    let disposed = false;
    let cacheRoute = '';
    let frame: number | null = null;
    const observed = new Set<HTMLElement>();
    let discovered: HTMLImageElement[] = [];
    let discoveredCanvases: HTMLCanvasElement[] = [];
    let discoveredBackgrounds: HTMLElement[] = [];
    let backgroundReader = false;
    let discoveryDirty = true;
    let discoverySelector: string | null = null;
    let areaFallback = false;
    const decorate = (status: MangaTranslationStatus): MangaTranslationStatus => ({...status, pageCount: observed.size, areaFallback});
    const session = createMangaSession<MangaSurface>({
        translate: surface => isSegment(surface) ? ports.segments!.translate(surface) : isImage(surface) ? ports.translate(surface) : isCanvas(surface) ? ports.canvas!.translate(surface) : ports.background!.translate(surface),
        reuse: surface => isSegment(surface) ? ports.segments!.reuse(surface) : isImage(surface) ? ports.reuse?.(surface) === true : isCanvas(surface) ? ports.canvas!.reuse(surface) : ports.background!.reuse(surface),
        restore: surface => isSegment(surface) ? ports.segments!.restore(surface) : isImage(surface) ? ports.restore(surface) : isCanvas(surface) ? ports.canvas!.restore(surface) : ports.background!.restore(surface),
        release: surface => isSegment(surface) ? ports.segments!.release(surface) : isImage(surface) ? ports.release(surface) : isCanvas(surface) ? ports.canvas!.release(surface) : ports.background!.release(surface),
        failed: surface => isSegment(surface) ? ports.segments!.failed(surface) : isImage(surface) ? ports.failed(surface) : isCanvas(surface) ? ports.canvas!.failed(surface) : ports.background!.failed(surface),
        changed: status => ports.changed(decorate(status)),
    });
    let intersection: IntersectionObserver | null = null;
    let mutation: MutationObserver | null = null;

    function observeReader(): void {
        if (mutation) return;
        intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(scheduleLayout);
        mutation = new MutationObserver(records => {
            const content = records.filter(record => !(record.target instanceof Element && record.target.closest('[data-fluent-read-ui]')));
            if (content.some(record => record.type === 'childList' || record.attributeName !== 'style' || backgroundReader)) schedule();
            else if (content.length) scheduleLayout();
        });
        mutation.observe(document.documentElement, {subtree: true, childList: true, attributes: true,
            attributeFilter: ['src', 'srcset', 'sizes', 'media', 'type', 'class', 'id', 'data-manga-reader', 'hidden', 'aria-hidden', 'width', 'height', 'style']});
    }

    function refresh(): void {
        if (disposed) return;
        const url = new URL(window.location?.href || 'about:blank');
        const site = resolveMangaSite(url.href, ports.siteRules?.());
        const chapterUrl = new URL(url.href);
        if (site?.chapterPath) chapterUrl.pathname = site.chapterPath;
        if (site?.pageQueryParameter) {
            const pages = chapterUrl.searchParams.getAll(site.pageQueryParameter);
            if (pages.length === 1 && /^[1-9]\d{0,3}$/.test(pages[0])) chapterUrl.searchParams.delete(site.pageQueryParameter);
        }
        const route = `${chapterUrl.origin}${chapterUrl.pathname}${chapterUrl.search}`;
        const sameChapter = route === cacheRoute;
        if (route !== cacheRoute) {ports.resetCache?.(); cacheRoute = route;discoveryDirty = true;}
        backgroundReader = !!site?.backgroundSelector;
        const selector = site?.selector ?? null;
        const custom = site?.custom === true;
        const available = ports.enabled() && selector !== null;
        if (available) observeReader();
        else {
            intersection?.disconnect(); mutation?.disconnect();
            intersection = null; mutation = null;
            observed.clear();
            discovered = [];
            discoveredCanvases = [];
            discoveredBackgrounds = [];
            discoveryDirty = true;
        }
        let images: HTMLImageElement[] = [];
        const selectorKey = `${selector}:${site?.canvasSelector ?? ''}:${site?.backgroundSelector ?? ''}`;
        if (available) {
            // 自定义 CSS 选择器可能依赖任意属性或状态，保留动态查询；已知站点复用正文发现结果。
            if (custom || discoveryDirty || discoverySelector !== selectorKey) {
                discoveryDirty = false;
                discoverySelector = selectorKey;
                discovered = [];
                discoveredCanvases = [];
                discoveredBackgrounds = [];
                try { discovered = Array.from(document.querySelectorAll(selector!))
                    .filter((image): image is HTMLImageElement => image.tagName === 'IMG' && !image.closest('[data-fluent-read-ui]')); }
                catch { /* 无效用户选择器保持原图，不中断站点或生命周期。 */ }
                if (site?.canvasSelector && ports.canvas) {
                    discoveredCanvases = Array.from(document.querySelectorAll(site.canvasSelector))
                        .filter((element): element is HTMLCanvasElement => element.tagName === 'CANVAS' && !element.closest('[data-fluent-read-ui]'));
                }
                if (site?.backgroundSelector && ports.background) {
                    discoveredBackgrounds = Array.from(document.querySelectorAll<HTMLElement>(site.backgroundSelector))
                        .filter(element => !element.closest('[data-fluent-read-ui]'));
                }
            }
            images = discovered;
        }
        if (site?.generic) images = images.filter(image => {
            const rect = image.getBoundingClientRect();
            return rect.width >= 240 && rect.height >= 240 && !image.closest('nav, header, footer, aside, [data-ad], [class*="recommend"], [class*="thumbnail"], [class*="avatar"]');
        });
        if (site?.name === 'Pixiv') {
            const expanded = images.filter(image => image.closest('.gtm-expand-full-size-illust') && image.getBoundingClientRect().width > 0);
            if (expanded.length) images = expanded;
        }
        const canvases = discoveredCanvases.map(canvas => ({canvas, identity: ports.canvas!.identity(canvas)})).filter(page => page.identity !== null);
        ports.background?.prepare(discoveredBackgrounds);
        const backgrounds = discoveredBackgrounds.map(element => ({element, identity: ports.background!.identity(element)})).filter(page => page.identity !== null);
        const segmented = ports.segments?.prepare(images);
        const current = new Set<HTMLElement>([...images, ...canvases.map(page => page.canvas), ...backgrounds.map(page => page.element)]);
        observed.forEach(image => {
            if (current.has(image)) return;
            intersection?.unobserve(image);
            observed.delete(image);
        });
        current.forEach(image => {
            if (observed.has(image)) return;
            observed.add(image);
            intersection?.observe(image);
        });
        // 同一帧共享祖先样式，避免连续图片在滚动时重复读取阅读器容器。
        const ancestorStyles = new Map<Element, CSSStyleDeclaration>();
        const inViewport = (image: Element, rect: DOMRect) => {
            let left=Math.max(0,rect.left),right=Math.min(window.innerWidth,rect.right);
            let top=Math.max(0,rect.top),bottom=Math.min(window.innerHeight,rect.bottom);
            if (right<=left || bottom<=top) return false;
            for (let parent=image.parentElement;parent;parent=parent.parentElement) {
                let style=ancestorStyles.get(parent);
                if (!style) {style=getComputedStyle(parent);ancestorStyles.set(parent,style);}
                if (style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || style.opacity==='0') return false;
                if (parent===document.documentElement || parent===document.scrollingElement) continue;
                const x=/^(hidden|clip|auto|scroll)$/.test(style.overflowX),y=/^(hidden|clip|auto|scroll)$/.test(style.overflowY);
                if (!x && !y) continue;
                const clip=parent.getBoundingClientRect();
                if (x) {left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
                if (y) {top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
            }
            return right>left && bottom>top;
        };
        // 无法直接读取的正文提供可见区域圈选，推广封面不进入连续翻译。
        areaFallback = false;
        if (available && images.length === 0 && canvases.length === 0 && backgrounds.length === 0 && site?.areaSelector) {
            try {areaFallback = Array.from(document.querySelectorAll(site.areaSelector)).some(element => {
                if (element.closest('[data-fluent-read-ui]')) return false;
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                return rect.width >= 240 && rect.height >= 80 && rect.bottom > 0 && rect.top < window.innerHeight
                    && rect.right > 0 && rect.left < window.innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && inViewport(element, rect);
            });} catch { /* 无效选择器不影响宿主页面。 */ }
        }
        const candidates: MangaCandidate[] = [...images.flatMap<MangaCandidate>(image => {
            const rect = image.getBoundingClientRect();
            const style = getComputedStyle(image);
            // 明确阅读器内的正文允许可点击图片和 presentation 角色，不能复用普通悬浮图标的装饰图排除。
            const ready = image.complete && image.naturalWidth >= 80 && image.naturalHeight >= 40
                && rect.width >= 80 && rect.height >= 40 && style.visibility !== 'hidden'
                && style.visibility !== 'collapse' && style.display !== 'none';
            const segments = segmented?.get(image);
            if (segments) return segments.flatMap(segment => {
                const identity = ports.segments!.identity(segment);
                return identity ? [{image: segment, identity, ready, visible: ready && inViewport(image, ports.segments!.bounds(segment)), pixels: ports.segments!.pixels(segment)}] : [];
            });
            return [{image, identity: `${ports.identity(image)}:${imageLoadTracker.revision(image)}`, ready, visible: ready
                && inViewport(image,rect), pixels: image.naturalWidth * image.naturalHeight}];
        }), ...canvases.map(({canvas, identity}) => {
            const rect = canvas.getBoundingClientRect(), style = getComputedStyle(canvas);
            const ready = rect.width >= 80 && rect.height >= 40 && style.display !== 'none'
                && style.visibility !== 'hidden' && style.visibility !== 'collapse';
            return {image: canvas, identity: identity!, ready, visible: ready && inViewport(canvas, rect), pixels: canvas.width * canvas.height};
        }), ...backgrounds.map(({element, identity}) => {
            const rect = ports.background!.bounds(element), style = getComputedStyle(element);
            const ready = rect.width >= 80 && rect.height >= 40 && style.display !== 'none'
                && style.visibility !== 'hidden' && style.visibility !== 'collapse';
            return {image: element, identity: identity!, ready, visible: ready && inViewport(element, rect), pixels: ports.background!.pixels(element)};
        })];
        const anchor = candidates.reduce((last, page, index) => page.visible ? index : last, -1);
        const ahead = ports.prefetchPages ? normalizeMangaPrefetchPages(ports.prefetchPages()) : 0;
        const firstVisible=candidates.findIndex(page=>page.visible);
        const nearby=new Set<MangaSurface>(),upcoming=new Set<MangaSurface>();let retainedPixels=0;
        // 关闭预译也保留附近已完成结果：GPU 较快时，下页可能在返页期间完成，不能立刻释放并重复识别。
        // 提前页和前后各两张共享像素预算；先准备最近下页，历史项仅保留不调度。
        const retain=(index:number)=>{
            const page=candidates[index];
            if (nearby.has(page.image)) return true;
            const pixels=page.pixels;
            if (!page.ready || retainedPixels+pixels>8_000_000) return false;
            nearby.add(page.image);retainedPixels+=pixels;return true;
        };
        if(anchor>=0)for(let index=anchor+1;index<candidates.length && index<=anchor+ahead;index++) {
            if (!candidates[index].ready) continue;
            if (!retain(index)) break;
            upcoming.add(candidates[index].image);
        }
        for (let index=firstVisible-1;index>=0 && index>=firstVisible-2;index--) retain(index);
        if(anchor>=0)for(let index=anchor+1;index<candidates.length && index<=anchor+2;index++)retain(index);
        // 仅已开启的同章会话等待已核对的可见原站加载提示，首次进入或真正离开正文不发布虚假入口。
        const waiting = available && sameChapter && session.status().active && current.size === 0 && !!site?.loadingSelector
            && Array.from(document.querySelectorAll(site.loadingSelector)).some(element => {
                const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible'
                    && style.opacity !== '0' && inViewport(element, rect);
            });
        session.refresh({
            route, available: available && (!(site?.generic || site?.requireContent) || current.size > 0 || areaFallback || waiting),
            suspended: document.hidden,
            pages: candidates.map(page => ({image: page.image, identity: page.identity,
                visible: page.visible && !document.hidden, retain: nearby.has(page.image),
                prefetch: upcoming.has(page.image) || (document.hidden && page.visible)})),
        });
        // 仅重建已完成页面，前后一屏内按可见页优先；不因轻量容量扩大付费预译窗口。
        if (ports.warm) {
            const nearbyPages: Array<{image: HTMLImageElement; visible: boolean; distance: number}> = [];
            // refresh 端口可能归还宿主样式，故在其后测量；以下排序期间不再调用 DOM 或会话端口。
            for (const page of candidates) {
                if (!page.ready || !isImage(page.image)) continue;
                const rect = page.image.getBoundingClientRect();
                if (rect.right > -window.innerWidth && rect.left < 2 * window.innerWidth
                    && rect.bottom > -window.innerHeight && rect.top < 2 * window.innerHeight) {
                    nearbyPages.push({image: page.image, visible: page.visible, distance: Math.abs(rect.top)});
                }
            }
            nearbyPages.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
            ports.warm(nearbyPages.slice(0, normalizeMangaCachePages(ports.cachePages?.())).map(page => page.image));
        }
        ports.canvas?.update();
        ports.background?.update();
        ports.segments?.update();
    }

    function scheduleLayout(): void {
        if (disposed || frame !== null) return;
        if (!session.status().available && !mangaReaderSelector(window.location?.href || 'about:blank', ports.siteRules?.())) return;
        frame = window.requestAnimationFrame(() => { frame = null; refresh(); });
    }
    function schedule(): void { discoveryDirty = true; scheduleLayout(); }
    function loaded(event: Event): void {
        const image = event.target as HTMLImageElement;
        if (observed.has(image)) imageLoadTracker.loaded(event);
        schedule();
    }
    document.addEventListener('load', loaded, true);
    document.addEventListener('visibilitychange', scheduleLayout);
    document.addEventListener('fluentread-route-change', schedule);
    window.addEventListener('scroll', scheduleLayout, true);
    window.addEventListener('resize', scheduleLayout);
    refresh();
    return {
        status: () => decorate(session.status()),
        schedule,
        retry(image: MangaSurface) { refresh();return session.retry(image); },
        toggle() { discoveryDirty = true; refresh(); if (areaFallback) return false; const toggled = session.toggle(); refresh(); return toggled; },
        dispose() {
            disposed = true;
            if (frame !== null) window.cancelAnimationFrame(frame);
            intersection?.disconnect();
            mutation?.disconnect();
            observed.clear();
            discovered = [];
            discoveredCanvases = [];
            discoveredBackgrounds = [];
            ports.background?.prepare([]);
            ports.segments?.prepare([]);
            document.removeEventListener('load', loaded, true);
            document.removeEventListener('visibilitychange', scheduleLayout);
            document.removeEventListener('fluentread-route-change', schedule);
            window.removeEventListener('scroll', scheduleLayout, true);
            window.removeEventListener('resize', scheduleLayout);
            areaFallback = false;
            session.dispose();
        },
    };
}
