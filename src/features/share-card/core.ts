/**
 * @file src/features/share-card/core.ts
 * 文件职责：提供分享摘录、文字换行和导出容量的纯规则，保证双语正文完整且长词和 emoji 不被截断。
 * 主要内容：净化换行与控制字符、只提取安全来源域名、按字素和词边界换行、限制输出高度并明确返回空内容或超长错误。
 * 模块边界：不解析 HTML、不读取网页、不访问 Canvas 或配置存储；字体度量由渲染端传入。
 */
export interface ShareCardExcerpt {original: string; translation: string; source: string}
export const SHARE_CARD_MAX_CHARACTERS = 3000;
export const SHARE_CARD_MAX_HEIGHT = 3000;
export function cleanCardText(value: string): string {
    return value.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
}
export function cardSourceDomain(href: string): string {
    try {
        const url = new URL(href);
        return /^https?:$/u.test(url.protocol) ? url.hostname.replace(/^www\./u, '') : '';
    } catch { return ''; }
}
export function validateCardExcerpt(excerpt: ShareCardExcerpt): 'empty' | 'long' | null {
    if (!cleanCardText(excerpt.original) || !cleanCardText(excerpt.translation)) return 'empty';
    return excerpt.original.length + excerpt.translation.length > SHARE_CARD_MAX_CHARACTERS ? 'long' : null;
}
/** Intl.Segmenter 保持组合字、旗帜和 ZWJ emoji 完整；旧环境至少保持 Unicode 码点完整。 */
export function cardGraphemes(text: string): string[] {
    if (typeof Intl.Segmenter === 'function') {
        return Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text), item => item.segment);
    }
    return Array.from(text);
}
/** 优先在空白处换行，过长单词与 CJK 才按字素拆分；显式换行始终保留。 */
export function wrapCardText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
    const lines: string[] = [];
    for (const paragraph of cleanCardText(text).split('\n')) {
        let line = '';
        for (const token of paragraph.match(/\S+|[\t ]+/gu) ?? []) {
            const candidate = line + token;
            if (measure(candidate) <= maxWidth) { line = candidate; continue; }
            if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
            if (!token.trim()) continue;
            // 整词在新行放得下时不重复分词/逐字度量；保留长词字素拆分。
            if (!line && candidate !== token && measure(token) <= maxWidth) { line = token; continue; }
            for (const grapheme of cardGraphemes(token)) {
                if (line && measure(line + grapheme) > maxWidth) { lines.push(line); line = ''; }
                line += grapheme;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}
