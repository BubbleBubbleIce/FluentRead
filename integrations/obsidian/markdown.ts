/**
 * 只向 Obsidian 翻译请求发送 Markdown 可读文本；输出仍交给原始 ParsedDocument 保留语法。
 */
import type {DocumentSegment} from '../../src/features/document-translation/core/document';

// 引用、列表与标题可以嵌套；必须一起移除，不能把第二层标记继续送给 provider。
const STRUCTURAL_PREFIX = /^(?:\s*(?:>\s*|#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?))+/u;

export function prepareMarkdownSegments(segments: readonly DocumentSegment[]): DocumentSegment[] {
    return segments.map((segment) => {
        const source = (segment.markdownLineStart === false ? segment.source : segment.source.replace(STRUCTURAL_PREFIX, '')).trim();
        return {...segment, source: source || segment.source};
    });
}
