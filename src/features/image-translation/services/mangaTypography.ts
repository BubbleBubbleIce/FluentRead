/**
 * @file src/features/image-translation/services/mangaTypography.ts
 * 文件职责：在漫画原有区域内排版完整译文，区分对白与大标题并保持东亚标点的阅读习惯。
 * 主要内容：保留词、字素与显式换行，闭标点跟随前字、开标点跟随后字；按真实 Canvas 度量二分适配字号，仅在本次排版内复用长词分段，逐项求最大宽度以兼容大量段落与行；末行过短时平衡行宽而不增加行数，不截字、不横向压缩。
 * 模块边界：纯文字和度量算法，不读取页面、配置或字体资源，不识别、翻译或修补图片；普通图片继续使用独立的通用排版。
 */
import type {ImageTranslationTextLayout} from './rendering';

export const MANGA_TEXT_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", sans-serif';
const OPEN = /^[（【「『《〈“‘(\[]+$/u;
const CLOSE = /^[，。！？、；：）】」』》〉”’….,!?;:)\]]+$/u;
const CJK = /\s+|[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]\p{Mark}*|[^\s\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity:'grapheme'}) : undefined;

function bindPunctuation(tokens: string[]): string[] {
    const result: string[] = [];
    let opening = '';
    for (const token of tokens) {
        if (OPEN.test(token)) {opening += token; continue;}
        if (CLOSE.test(token) && !opening && result.length && !/^\s+$/u.test(result[result.length - 1])) result[result.length - 1] += token;
        else {result.push(opening + token); opening = '';}
    }
    if (opening) result.push(opening);
    return result;
}

/** 准确测量候选整行；长单词仅在必须时拆字素，带组合音标和 emoji 的字素保持完整。 */
export function layoutMangaTranslationText(text: string, width: number, height: number,
    measure: (text: string, size: number) => number, maxSize: number): ImageTranslationTextLayout {
    const normalized = text.replace(/\r\n?/gu, '\n').trim();
    if (!normalized || ![width,height,maxSize].every(value => Number.isFinite(value) && value > 0)) return {lines:[],fontSize:0,lineHeight:0};
    const paragraphs = normalized.split('\n').map(paragraph => paragraph.trim());
    const tokens = paragraphs.map(paragraph => bindPunctuation(paragraph.match(CJK) || []));
    // 字素边界与字号无关；仅缓存真正超宽的词，随本次排版结束释放。
    const splitTokens = new Map<string, string[]>();
    const wrap = (size: number, limit = width) => {
        const lines: string[] = [];
        for (const paragraph of tokens) {
            let current = '', space = '';
            for (const token of paragraph) {
                if (/^\s+$/u.test(token)) {space = ' '; continue;}
                const candidate = current + space + token; space = '';
                if (measure(candidate,size) <= limit) {current = candidate; continue;}
                if (current) {lines.push(current); current = '';}
                if (measure(token,size) <= limit) {current = token; continue;}
                let parts = splitTokens.get(token);
                if (!parts) {
                    parts = bindPunctuation(segmenter ? Array.from(segmenter.segment(token), part => part.segment) : Array.from(token));
                    splitTokens.set(token, parts);
                }
                for (const part of parts) {
                    if (current && measure(current + part,size) > limit) {lines.push(current); current = '';}
                    current += part;
                }
            }
            lines.push(current);
        }
        return {lines,fontSize:size,lineHeight:size * 1.2};
    };
    const fits = (layout: ImageTranslationTextLayout) => layout.lines.length * layout.lineHeight <= height
        && layout.lines.every(line => measure(line,layout.fontSize) <= width);
    // 保留字号与行数，仅在末行明显过短时收拢行宽，避免气泡中留下单独的「了。」。
    const balance = (layout: ImageTranslationTextLayout) => {
        if (paragraphs.length !== 1 || layout.lines.length < 2) return layout;
        const lengths = layout.lines.map(line => measure(line,layout.fontSize));
        if (lengths[lengths.length-1] >= lengths.reduce((largest, length) => Math.max(largest, length), -Infinity) * .55) return layout;
        let low = 0, high = width, best = layout;
        for (let iteration = 0; iteration < 5; iteration++) {
            const limit = (low + high) / 2, candidate = wrap(layout.fontSize,limit);
            if (candidate.lines.length === layout.lines.length && candidate.lines.every(line=>measure(line,layout.fontSize)<=limit)) {high = limit; best = candidate;}
            else low = limit;
        }
        return best;
    };
    let high = Math.min(maxSize,height / 1.2);
    const largest = wrap(high);
    if (fits(largest)) return balance(largest);
    let low = Math.min(1,width / paragraphs.reduce((largest, paragraph) => Math.max(largest, measure(paragraph,1)), 1),height / (paragraphs.length * 1.2)) * .99;
    let best = wrap(low);
    for (let iteration = 0; iteration < 12; iteration++) {
        const candidate = wrap((low + high) / 2);
        if (fits(candidate)) {best = candidate; low = candidate.fontSize;} else high = candidate.fontSize;
    }
    return balance(best);
}
