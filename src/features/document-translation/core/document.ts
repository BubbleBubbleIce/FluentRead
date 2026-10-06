/**
 * @file src/features/document-translation/core/document.ts
 * 文件职责：定义文档翻译的纯领域模型，并负责把多种文本格式解析为可翻译片段，再按双语或纯译文模式无损还原原格式结构。
 * 主要内容：覆盖文本格式识别、片段切分、Markdown 容器代码与行内位置保护、字幕标签保留、有界深度的非递归 JSON 遍历、空译文回退、MIME 信息和下载文件命名；文本导出支持有界编码，下载摘录无需处理全文；相同译文保留原文且不重复展示。
 * 模块边界：该文件不读取 File、不解析 PDF/EPUB/DOCX 二进制，也不发起翻译请求；文件 I/O 与压缩包处理归 services/binary，批处理归 services/translation，展示归 preview/presentation。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
    'pdf',
    'epub',
    'docx',
    'html',
    'htm',
    'txt',
    'md',
    'markdown',
    'srt',
    'vtt',
    'ass',
    'ssa',
    'lrc',
    'json',
] as const;

export type DocumentFormat =
    | 'pdf'
    | 'epub'
    | 'docx'
    | 'html'
    | 'txt'
    | 'markdown'
    | 'srt'
    | 'vtt'
    | 'ass'
    | 'lrc'
    | 'json';

export type DocumentRenderMode = 'bilingual' | 'translated';

export interface DocumentSegment {
    id: number;
    source: string;
    /** 可选的阅读上下文，例如 PDF 页码或 ePub 章节。 */
    contextLabel?: string;
    /** 字幕原生时间轴元数据。 */
    timeStart?: string;
    timeEnd?: string;
    /** 结构化文档中的原生位置，例如 `$.items[0].label`。 */
    pathLabel?: string;
    /** 页面或文章预览使用的原生文档角色。 */
    role?: 'title' | 'heading' | 'paragraph' | 'list-item' | 'header' | 'footer' | 'note';
    /** Markdown 片段是否从原始行首开始；false 表示链接/代码后的行内文本，不能剥离列表等前缀。 */
    markdownLineStart?: boolean;
}

export interface PdfDocumentBlock {
    segmentIndex: number;
    /** PDF 视口在缩放比例 1 下的左上角坐标。 */
    x: number;
    y: number;
    width: number;
    height: number;
    fontSize: number;
    /** 以 PDF 视口单位表示的源文本行高中位数。 */
    lineHeight: number;
    /** 此段落块包含的源文本行数。 */
    lineCount: number;
    fontFamily: string;
    fontWeight: 400 | 600 | 700;
    textAlign: 'left' | 'center' | 'right';
}

export interface PdfDocumentPage {
    pageNumber: number;
    width: number;
    height: number;
    segmentIndexes: number[];
    blocks: PdfDocumentBlock[];
}

export interface EpubDocumentChapter {
    path: string;
    source: string;
    segmentOffset: number;
    segmentCount: number;
    title: string;
}

export interface DocxDocumentPart {
    path: string;
    source: string;
    paragraphSegments: Array<{paragraphIndex: number; segmentIndex: number}>;
}

export type BinaryDocumentData =
    | {kind: 'pdf'; bytes: Uint8Array; pages: PdfDocumentPage[]}
    | {kind: 'epub'; bytes: Uint8Array; chapters: EpubDocumentChapter[]}
    | {kind: 'docx'; bytes: Uint8Array; parts: DocxDocumentPart[]};

interface LiteralPart {
    kind: 'literal';
    value: string;
    /** Markdown 源行分组，用于让受保护的行内语法保持原位。 */
    bilingualGroup?: number;
}

interface SegmentPart {
    kind: 'segment';
    segmentIndex: number;
    source: string;
    /** 双语显示源文时使用的原始编码 HTML 文本。 */
    rawSource?: string;
    prefix: string;
    suffix: string;
    /** 双语行需要第二个提示时重复使用的结构前缀。 */
    bilingualPrefix?: string;
    /** Markdown 源行分组，用于渲染一条结构完整的双语行。 */
    bilingualGroup?: number;
}

type DocumentPart = LiteralPart | SegmentPart;

export interface JsonSegmentEntry {
    path: Array<string | number>;
    segmentIndex: number;
    prefix: string;
    suffix: string;
}

export interface MarkdownCodeBlock {
    /** 零基源行范围，左闭右开，包含开启及存在的闭合围栏行。 */
    startLine: number;
    endLine: number;
    /** 开启围栏后未经解释的信息字符串。 */
    info: string;
    closed: boolean;
    /** 仅供展示：剥除开启容器和围栏缩进，保留代码自身的符号及额外缩进。 */
    contentLines: readonly string[];
}

export interface ParsedDocument {
    fileName: string;
    format: DocumentFormat;
    label: string;
    parts: readonly DocumentPart[];
    segments: readonly DocumentSegment[];
    jsonValue?: unknown;
    jsonEntries?: readonly JsonSegmentEntry[];
    /** Markdown 围栏由解析器统一判定，预览无需复制容器状态机。 */
    markdownCodeBlocks?: readonly MarkdownCodeBlock[];
    binary?: BinaryDocumentData;
}

const FORMAT_LABELS: Record<DocumentFormat, string> = {
    pdf: 'PDF 文件',
    epub: 'ePub 电子书',
    docx: 'DOCX 文档',
    html: 'HTML 文件',
    txt: 'TXT 文件',
    markdown: 'Markdown 文件',
    srt: 'SRT 字幕',
    vtt: 'VTT 字幕',
    ass: 'ASS 字幕',
    lrc: 'LRC 歌词',
    json: 'JSON 文件',
};

const PROTECTED_HTML_TAGS = new Set(['head', 'script', 'style', 'pre', 'code', 'textarea']);
const MARKDOWN_PROTECTED_PATTERN = /(`{1,3}[^`\n]+`{1,3}|<https?:\/\/[^>]+>|https?:\/\/[^\s)]+|\$[^$\r\n]+\$|%%[^%\r\n]+%%|(?:^|\s)#[\p{L}\p{N}_/-]+)/gu;
const TIMED_SUBTITLE_PATTERN = /^\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?$/u;
const LRC_TIME_PATTERN = /^(\s*(?:\[[^\]\r\n]+\])+)/u;

function extensionOf(fileName: string): string {
    const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/u);
    return match?.[1] || '';
}

export function getDocumentFormat(fileName: string): DocumentFormat | null {
    const extension = extensionOf(fileName);
    if (extension === 'pdf') return 'pdf';
    if (extension === 'epub') return 'epub';
    if (extension === 'docx') return 'docx';
    if (extension === 'html' || extension === 'htm') return 'html';
    if (extension === 'txt') return 'txt';
    if (extension === 'md' || extension === 'markdown') return 'markdown';
    if (extension === 'srt') return 'srt';
    if (extension === 'vtt') return 'vtt';
    if (extension === 'ass' || extension === 'ssa') return 'ass';
    if (extension === 'lrc') return 'lrc';
    if (extension === 'json') return 'json';
    return null;
}

export function getDocumentAcceptAttribute(): string {
    return SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');
}

export function getDocumentFormatLabel(format: DocumentFormat): string {
    return FORMAT_LABELS[format];
}

export function getDocumentMimeType(format: DocumentFormat): string {
    if (format === 'pdf') return 'application/pdf';
    if (format === 'epub') return 'application/epub+zip';
    if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (format === 'html') return 'text/html;charset=utf-8';
    if (format === 'json') return 'application/json;charset=utf-8';
    return 'text/plain;charset=utf-8';
}

function trimSource(value: string): {prefix: string; source: string; suffix: string} | null {
    const source = value.trim();
    if (!source) return null;
    const start = value.length - value.trimStart().length;
    return {prefix: value.slice(0, start), source, suffix: value.slice(start + source.length)};
}

type SegmentOptions = Pick<SegmentPart, 'bilingualPrefix' | 'bilingualGroup'>
    & Omit<Partial<DocumentSegment>, 'id' | 'source'>;

function addLiteral(parts: DocumentPart[], value: string, bilingualGroup?: number): void {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === 'literal' && last.bilingualGroup === bilingualGroup) {
        last.value += value;
        return;
    }
    parts.push({kind: 'literal', value, bilingualGroup});
}

function addSegment(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    options: SegmentOptions = {},
    transformSource?: (source: string) => string,
): void {
    const trimmed = trimSource(value);
    if (!trimmed) {
        addLiteral(parts, value, options.bilingualGroup);
        return;
    }

    const segmentIndex = segments.length;
    const {bilingualPrefix, bilingualGroup, ...segmentOptions} = options;
    const source = transformSource ? transformSource(trimmed.source) : trimmed.source;
    segments.push({id: segmentIndex, source, ...segmentOptions});
    parts.push({
        kind: 'segment',
        segmentIndex,
        source,
        ...(source === trimmed.source ? {} : {rawSource: trimmed.source}),
        prefix: trimmed.prefix,
        suffix: trimmed.suffix,
        bilingualPrefix,
        bilingualGroup,
    });
}

/** 链接的闭合位置只扫描一次，避免重复未闭合 `[` 的正则回溯；URL 括号按配对保护。 */
function markdownLinkRanges(value: string): Array<{start: number; end: number}> {
    const ranges: Array<{start: number; end: number}> = [];
    let bracketClose = value.indexOf(']');
    if (bracketClose < 0 || !value.includes('[')) return ranges;
    const roundCloses = new Map<number, number>();
    const stack: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '\\') {index += 1; continue;}
        if (value[index] === '(') stack.push(index);
        else if (value[index] === ')' && stack.length) roundCloses.set(stack.pop()!, index);
    }
    for (let index = 0; index < value.length; index += 1) {
        const open = value[index] === '!' && value[index + 1] === '[' ? index + 1 : index;
        if (value[open] !== '[') continue;
        while (bracketClose >= 0 && bracketClose <= open) bracketClose = value.indexOf(']', bracketClose + 1);
        if (bracketClose < 0) break;
        let end = 0;
        if (value[open + 1] === '[' && bracketClose > open + 2 && value[bracketClose + 1] === ']') {
            end = bracketClose + 2;
        } else if (value[bracketClose + 1] === '(') {
            const close = roundCloses.get(bracketClose + 1);
            if (close !== undefined) end = close + 1;
        }
        if (end) {
            ranges.push({start: index, end});
            index = end - 1;
        }
    }
    return ranges;
}

function addMarkdownProtectedText(
    parts: DocumentPart[],
    segments: DocumentSegment[],
    value: string,
    bilingualGroup: number,
): void {
    const pattern = MARKDOWN_PROTECTED_PATTERN;
    pattern.lastIndex = 0;
    let cursor = 0;
    const atPosition = (offset: number): SegmentOptions => ({bilingualGroup, markdownLineStart: offset === 0});
    const links = markdownLinkRanges(value);
    let linkIndex = 0;
    let match = pattern.exec(value);
    while (match || linkIndex < links.length) {
        const link = links[linkIndex];
        const useLink = link && (!match || link.start <= match.index);
        const start = useLink ? link.start : match!.index;
        const end = useLink ? link.end : match!.index + match![0].length;
        if (useLink) linkIndex += 1;
        else match = pattern.exec(value);
        // 链接中的 URL 或代码中的链接由更早开始的外层语法整体保护。
        if (start < cursor) continue;
        addSegment(parts, segments, value.slice(cursor, start), atPosition(cursor));
        addLiteral(parts, value.slice(start, end), bilingualGroup);
        cursor = end;
    }
    addSegment(parts, segments, value.slice(cursor), atPosition(cursor));
}

/** 只识别容器前缀，不改源行。indent 不计引用符号及其可选空格，列表续行可据此匹配。 */
export function inspectMarkdownLine(line: string): {content: string; quoteDepth: number; indent: number; listIndent: number} {
    let cursor = 0;
    let quoteDepth = 0;
    let indent = 0;
    let listIndent = 0;
    let checkedThematicBreak = false;
    while (cursor < line.length) {
        while (line[cursor] === ' ' || line[cursor] === '\t') {
            indent += line[cursor] === '\t' ? 4 - indent % 4 : 1;
            cursor += 1;
        }
        if (line[cursor] === '>') {
            quoteDepth += 1;
            cursor += 1;
            if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
            continue;
        }
        if (!checkedThematicBreak) {
            checkedThematicBreak = true;
            if (/^(?:[-*_][ \t]*){3,}$/u.test(line.slice(cursor))) break;
        }
        const marker = line.slice(cursor).match(/^(?:[-*+]|\d{1,9}[.)])[ \t]+/u)?.[0];
        if (!marker) break;
        for (const character of marker) indent += character === '\t' ? 4 - indent % 4 : 1;
        cursor += marker.length;
        listIndent = indent;
    }
    return {content: line.slice(cursor), quoteDepth, indent, listIndent};
}

function splitWithEndings(value: string): Array<{start: number; end: number; textEnd: number; text: string}> {
    const lines: Array<{start: number; end: number; textEnd: number; text: string}> = [];
    const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
    let match = pattern.exec(value);
    while (match) {
        if (match[0] === '' && match.index === value.length) break;
        const raw = match[0];
        const endingLength = raw.endsWith('\r\n') ? 2 : raw.endsWith('\n') || raw.endsWith('\r') ? 1 : 0;
        const start = match.index;
        const end = start + raw.length;
        lines.push({
            start,
            end,
            textEnd: end - endingLength,
            text: raw.slice(0, raw.length - endingLength),
        });
        match = pattern.exec(value);
    }
    return lines;
}

function stripMarkdownCodeContainer(line: string, quoteDepth: number, indent: number): string {
    let cursor = 0;
    let quotes = 0;
    let columns = 0;
    while (cursor < line.length && (quotes < quoteDepth || columns < indent)) {
        if (line[cursor] === ' ' || line[cursor] === '\t') {
            const width = line[cursor] === '\t' ? 4 - columns % 4 : 1;
            if (quotes >= quoteDepth && columns + width > indent) {
                // 部分 tab 被围栏缩进消耗，剩余列仍属于代码自身的缩进。
                return ' '.repeat(columns + width - indent) + line.slice(cursor + 1);
            }
            columns += width;
            cursor += 1;
        } else if (line[cursor] === '>' && quotes < quoteDepth) {
            quotes += 1;
            cursor += 1;
            if (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
        } else break;
    }
    return line.slice(cursor);
}

function parseTextDocument(content: string, format: 'txt' | 'markdown'): Pick<ParsedDocument, 'parts' | 'segments' | 'markdownCodeBlocks'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);
    type CodeBlock = MarkdownCodeBlock & {contentLines: string[]};
    const markdownCodeBlocks: CodeBlock[] = [];
    type Container = {quoteDepth: number; listIndent: number};
    let fence: (Container & {marker: string; length: number; indent: number; block: CodeBlock}) | null = null;
    let math: Container | null = null;
    let list: Container | null = null;
    let inFrontmatter = format === 'markdown' && /^\uFEFF?---\s*$/u.test(lines[0]?.text ?? '');

    lines.forEach((line, lineIndex) => {
        if (inFrontmatter) {
            addLiteral(parts, content.slice(line.start, line.end));
            if (lineIndex > 0 && /^(?:---|\.\.\.)\s*$/u.test(line.text)) inFrontmatter = false;
            return;
        }
        if (format === 'markdown') {
            const info = inspectMarkdownLine(line.text);
            const leaves = (container: Container) => info.quoteDepth < container.quoteDepth || (
                !!info.content && (info.indent < container.listIndent || (
                    container.listIndent > 0 && info.listIndent > 0 && info.listIndent <= container.listIndent
                ))
            );
            if (fence && leaves(fence)) {
                fence.block.endLine = lineIndex;
                fence = null;
            }
            if (math && leaves(math)) math = null;
            if (fence || math) {
                const container = fence ?? math!;
                const atContainer = info.quoteDepth === container.quoteDepth && info.listIndent === 0;
                if (fence && atContainer && info.indent <= fence.listIndent + 3) {
                    const close = info.content.match(/^(`{3,}|~{3,})\s*$/u)?.[1];
                    if (close && close[0] === fence.marker && close.length >= fence.length) {
                        fence.block.closed = true;
                        fence.block.endLine = lineIndex + 1;
                        fence = null;
                    } else {
                        fence.block.contentLines.push(stripMarkdownCodeContainer(line.text, fence.quoteDepth, fence.indent));
                    }
                } else if (fence) {
                    fence.block.contentLines.push(stripMarkdownCodeContainer(line.text, fence.quoteDepth, fence.indent));
                } else if (math && atContainer && /^\$\$\s*$/u.test(info.content)) math = null;
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            if (list && info.content && (info.quoteDepth !== list.quoteDepth || info.indent < list.listIndent)) list = null;
            if (info.listIndent) list = {quoteDepth: info.quoteDepth, listIndent: info.listIndent};
            const container = {quoteDepth: info.quoteDepth, listIndent: list?.listIndent ?? 0};
            const marker = info.indent <= container.listIndent + 3
                ? info.content.match(/^(`{3,}|~{3,})(.*)$/u)?.[1] : undefined;
            const isMathLine = /^\$\$\s*$/u.test(info.content);
            const horizontalRule = /^(?:[-*_]\s*){3,}$/u.test(info.content);
            const calloutHeader = info.quoteDepth > 0 && /^\[![^\]]+\]/u.test(info.content);
            if (marker || isMathLine || horizontalRule || calloutHeader) {
                if (marker) {
                    const block: CodeBlock = {
                        startLine: lineIndex, endLine: lines.length, info: info.content.slice(marker.length),
                        closed: false, contentLines: [],
                    };
                    markdownCodeBlocks.push(block);
                    fence = {...container, marker: marker[0], length: marker.length, indent: info.indent, block};
                }
                else if (isMathLine) math = container;
                addLiteral(parts, content.slice(line.start, line.end));
                return;
            }
            addMarkdownProtectedText(parts, segments, line.text, lineIndex);
        } else {
            addSegment(parts, segments, line.text);
        }
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments, ...(format === 'markdown' ? {markdownCodeBlocks} : {})};
}

const HTML_ENTITY_FALLBACKS: Record<string, string> = {
    amp: '&',
    apos: "'",
    bull: '•',
    cent: '¢',
    copy: '©',
    emsp: ' ',
    ensp: ' ',
    euro: '€',
    gt: '>',
    hellip: '…',
    laquo: '«',
    ldquo: '“',
    lsquo: '‘',
    lt: '<',
    mdash: '—',
    middot: '·',
    ndash: '–',
    nbsp: ' ',
    pound: '£',
    quot: '"',
    raquo: '»',
    rdquo: '”',
    reg: '®',
    rsquo: '’',
    thinsp: ' ',
    trade: '™',
    yen: '¥',
};

function decodeHtmlEntities(value: string): string {
    if (!value.includes('&')) return value;
    if (typeof globalThis.document !== 'undefined') {
        const textarea = globalThis.document.createElement('textarea');
        textarea.innerHTML = value;
        return textarea.value;
    }

    return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));/giu, (entity, hex, decimal, name) => {
        if (name) return HTML_ENTITY_FALLBACKS[String(name).toLowerCase()] ?? entity;
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : '�';
    });
}

interface HtmlToken {
    index: number;
    value: string;
}

/** 查找下一个 HTML token，带引号属性中的 `>` 不应被误判为标签边界。 */
function findNextHtmlToken(content: string, from: number): HtmlToken | null {
    let index = content.indexOf('<', from);
    while (index >= 0) {
        const next = content[index + 1];
        if (next && (next === '!' || next === '?' || next === '/' || /[a-z]/iu.test(next))) {
            if (content.startsWith('<!--', index)) {
                const commentEnd = content.indexOf('-->', index + 4);
                const end = commentEnd >= 0 ? commentEnd + 3 : content.length;
                return {index, value: content.slice(index, end)};
            }

            let quote = '';
            for (let cursor = index + 1; cursor < content.length; cursor += 1) {
                const character = content[cursor];
                if (quote) {
                    if (character === quote) quote = '';
                    continue;
                }
                if (character === '"' || character === "'") {
                    quote = character;
                    continue;
                }
                if (character === '>') {
                    return {index, value: content.slice(index, cursor + 1)};
                }
            }
            return null;
        }
        index = content.indexOf('<', index + 1);
    }
    return null;
}

function parseHtmlDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    let cursor = 0;
    let protectedTag = '';

    let match = findNextHtmlToken(content, 0);
    while (match) {
        const tag = match.value;
        if (!protectedTag) addSegment(parts, segments, content.slice(cursor, match.index), {}, decodeHtmlEntities);
        else addLiteral(parts, content.slice(cursor, match.index));
        addLiteral(parts, tag);

        const closing = tag.match(/^<\s*\/\s*([a-z0-9-]+)/iu)?.[1]?.toLowerCase();
        if (closing && closing === protectedTag) {
            protectedTag = '';
        } else if (!closing && !protectedTag) {
            const opening = tag.match(/^<\s*([a-z0-9-]+)/iu)?.[1]?.toLowerCase();
            if (opening && PROTECTED_HTML_TAGS.has(opening) && !/\/\s*>$/u.test(tag)) {
                protectedTag = opening;
            }
        }

        cursor = match.index + tag.length;
        match = findNextHtmlToken(content, cursor);
    }

    if (cursor < content.length) {
        if (protectedTag) addLiteral(parts, content.slice(cursor));
        else addSegment(parts, segments, content.slice(cursor), {}, decodeHtmlEntities);
    }
    return {parts, segments};
}

function parseTimedSubtitleDocument(content: string, format: 'srt' | 'vtt'): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);
    let cursorLine = 0;

    while (cursorLine < lines.length) {
        const timestampLine = lines[cursorLine];
        if (format === 'vtt' && /^NOTE(?:[ \t].*)?$/u.test(timestampLine.text)) {
            const start = timestampLine.start;
            while (cursorLine < lines.length && lines[cursorLine].text.trim()) cursorLine += 1;
            addLiteral(parts, content.slice(start, lines[cursorLine - 1].end));
            continue;
        }
        if (!timestampLine || !TIMED_SUBTITLE_PATTERN.test(timestampLine.text)) {
            addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
            cursorLine += 1;
            continue;
        }

        const timeMatch = timestampLine.text.match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})/u);
        addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
        cursorLine += 1;
        const textStartLine = cursorLine;
        while (cursorLine < lines.length && lines[cursorLine].text.trim() && !TIMED_SUBTITLE_PATTERN.test(lines[cursorLine].text)) {
            const nextLineStartsCue = format === 'srt'
                && /^\s*\d+\s*$/u.test(lines[cursorLine].text)
                && TIMED_SUBTITLE_PATTERN.test(lines[cursorLine + 1]?.text || '');
            if (nextLineStartsCue) break;
            cursorLine += 1;
        }

        if (cursorLine === textStartLine) continue;
        const textStart = lines[textStartLine].start;
        const textEnd = lines[cursorLine - 1].textEnd;
        const source = content.slice(textStart, textEnd);
        // 将完整字幕提示作为一个翻译单元，使服务能保留 `<i>...</i>` 等行内标签或 ASS
        // 覆盖代码，同时不把时间戳和提示边界发送给翻译请求。
        addSegment(parts, segments, source, {
            timeStart: timeMatch?.[1],
            timeEnd: timeMatch?.[2],
        });

        if (cursorLine < lines.length) {
            addLiteral(parts, content.slice(textEnd, lines[cursorLine].start));
        } else {
            addLiteral(parts, content.slice(textEnd));
        }
    }

    return {parts, segments};
}

function parseAssDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        if (!/^\s*Dialogue\s*:/iu.test(line.text)) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const colon = line.text.indexOf(':');
        const prefix = line.text.slice(0, colon + 1);
        const dialogue = line.text.slice(colon + 1);
        let commaCount = 0;
        let textStart = -1;
        for (let index = 0; index < dialogue.length; index += 1) {
            if (dialogue[index] !== ',') continue;
            commaCount += 1;
            if (commaCount === 9) {
                textStart = index + 1;
                break;
            }
        }

        if (textStart < 0) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const fields = dialogue.slice(0, textStart - 1).split(',');
        addLiteral(parts, prefix + dialogue.slice(0, textStart));
        addSegment(parts, segments, dialogue.slice(textStart), {
            timeStart: fields[1]?.trim(),
            timeEnd: fields[2]?.trim(),
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

function parseLrcDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        const match = line.text.match(LRC_TIME_PATTERN);
        if (!match) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const prefix = match[1];
        addLiteral(parts, prefix);
        const firstTimestamp = prefix.match(/\[((?:\d{1,3}:)?\d{2}(?:\.\d{1,3})?)\]/u)?.[1];
        addSegment(parts, segments, line.text.slice(prefix.length), {
            bilingualPrefix: prefix,
            timeStart: firstTimestamp,
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

const MAX_JSON_DEPTH = 1_000;

function cloneJsonValue(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : {};
    const copies = new WeakMap<object, Record<string, unknown> | unknown[]>([[value, output]]);
    const stack = [{source: value, target: output, depth: 0}];
    while (stack.length) {
        const {source, target, depth} = stack.pop()!;
        if (depth > MAX_JSON_DEPTH) throw new Error('JSON 文件嵌套过深，请拆分后重试');
        for (const [key, item] of Object.entries(source)) {
            let copy = item;
            if (item && typeof item === 'object') {
                copy = copies.get(item);
                if (!copy) {
                    copy = Array.isArray(item) ? new Array(item.length) : {};
                    copies.set(item, copy);
                    stack.push({source: item, target: copy, depth: depth + 1});
                }
            }
            // JSON 的 __proto__ 是普通键；不能通过赋值触发对象原型 setter。
            Object.defineProperty(target, key, {value: copy, enumerable: true, writable: true, configurable: true});
        }
    }
    return output;
}

function parseJsonDocument(content: string): Pick<ParsedDocument, 'segments' | 'jsonValue' | 'jsonEntries'> {
    let jsonValue: unknown;
    try {
        jsonValue = JSON.parse(content);
    } catch (error) {
        // JSON.parse 按规范只会抛 SyntaxError；统一字符串化后移除类型前缀，避免不可达的错误类型分支。
        const message = String(error).replace(/^SyntaxError:\s*/u, '');
        throw new Error(`JSON 文件格式无效：${message}`);
    }

    const segments: DocumentSegment[] = [];
    const jsonEntries: JsonSegmentEntry[] = [];
    // 只把字符串叶节点送去翻译，并记录路径与首尾空白；渲染时在深拷贝上回填，原对象始终不变。
    const stack: Array<{value: unknown; path: Array<string | number>}> = [{value: jsonValue, path: []}];
    while (stack.length) {
        const {value, path} = stack.pop()!;
        if (path.length > MAX_JSON_DEPTH) throw new Error('JSON 文件嵌套过深，请拆分后重试');
        if (typeof value === 'string') {
            const trimmed = trimSource(value);
            if (!trimmed) continue;
            const segmentIndex = segments.length;
            const pathLabel = formatJsonPath(path);
            segments.push({id: segmentIndex, source: trimmed.source, pathLabel});
            jsonEntries.push({path: [...path], segmentIndex, prefix: trimmed.prefix, suffix: trimmed.suffix});
            continue;
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const [key, item] = entries[index];
                stack.push({value: item, path: [...path, Array.isArray(value) ? Number(key) : key]});
            }
        }
    }
    return {segments, jsonValue, jsonEntries};
}

export function formatJsonPath(path: Array<string | number>): string {
    return path.reduce<string>((value, part) => {
        if (typeof part === 'number') return `${value}[${part}]`;
        return /^[A-Za-z_$][\w$]*$/u.test(part)
            ? `${value}.${part}`
            : `${value}[${JSON.stringify(part)}]`;
    }, '$');
}

export function parseDocument(fileName: string, content: string): ParsedDocument {
    const format = getDocumentFormat(fileName);
    if (!format) {
        throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件');
    }
    if (format === 'pdf' || format === 'epub' || format === 'docx') {
        throw new Error(`${getDocumentFormatLabel(format)}需要按二进制文件解析，请重新打开该文件`);
    }

    if (format === 'json') {
        return {
            fileName,
            format,
            label: getDocumentFormatLabel(format),
            parts: [],
            ...parseJsonDocument(content),
        };
    }

    const parsed = format === 'html'
        ? parseHtmlDocument(content)
        : format === 'txt' || format === 'markdown'
            ? parseTextDocument(content, format)
            : format === 'ass'
                ? parseAssDocument(content)
                : format === 'lrc'
                    ? parseLrcDocument(content)
                    : parseTimedSubtitleDocument(content, format);

    return {fileName, format, label: getDocumentFormatLabel(format), ...parsed};
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function preserveSubtitleMarkup(source: string, translation: string): string {
    const assPrefix = source.match(/^(?:\{[^}]*\})+/u)?.[0];
    if (assPrefix && !translation.startsWith(assPrefix)) return `${assPrefix}${translation}`;

    const htmlOpen = source.match(/^(?:<([a-z][a-z0-9-]*)\b[^>]*>)+/iu)?.[0];
    const htmlClose = source.match(/(?:<\/([a-z][a-z0-9-]*)>)+(?=\s|$)/iu)?.[0];
    if (htmlOpen && htmlClose && !translation.includes(htmlOpen)) {
        return `${htmlOpen}${translation}${htmlClose}`;
    }
    return translation;
}

function originalPartSource(part: SegmentPart): string {
    return part.rawSource ?? part.source;
}

/** 字幕样式标记不属于可见正文，服务省略标记时仍按相同文字处理。 */
function hasDistinctPartTranslation(document: ParsedDocument, source: string, translation: string): boolean {
    if (['srt', 'vtt', 'ass'].includes(document.format)) {
        const text = (value: string) => value.replace(/<[^>]+>/gu, '').replace(/\{\\[^}]+\}/gu, '');
        return hasDistinctTranslation(text(source), text(translation));
    }
    return hasDistinctTranslation(source, translation);
}

/** 空白、相同结果与尚未翻译均保留原文，避免部分导出吞字或重复显示。 */
export function resolveDocumentTranslation(source: string, translation: string | undefined): string {
    return hasDistinctTranslation(source, translation) ? translation! : source;
}

function formatBilingualTranslation(document: ParsedDocument, part: SegmentPart, translation: string): string {
    const source = originalPartSource(part);
    if (!hasDistinctPartTranslation(document, part.source, translation)) return `${part.prefix}${source}${part.suffix}`;
    const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
        ? preserveSubtitleMarkup(part.source, translation)
        : translation;
    if (document.format === 'html') {
        return `${part.prefix}${source}${part.suffix}<br><span data-fluent-read-document-translation="true">${escapeHtml(translation)}</span>`;
    }
    if (document.format === 'markdown') {
        return `${part.prefix}${source}${part.suffix}\n> ${translation}`;
    }
    if (document.format === 'ass') {
        return `${part.prefix}${source}${part.suffix}\\N${formattedTranslation.replace(/\r?\n/gu, '\\N')}`;
    }
    if (part.bilingualPrefix) {
        return `${part.prefix}${source}${part.suffix}\n${part.bilingualPrefix}${formattedTranslation}`;
    }
    return `${part.prefix}${source}${part.suffix}\n${formattedTranslation}`;
}

function renderParts(document: ParsedDocument, translations: readonly string[], mode: DocumentRenderMode, maxLength: number): string {
    const output: string[] = [];
    let length = 0;
    const append = (value: string) => {
        const text = value.slice(0, maxLength - length);
        output.push(text);
        length += text.length;
    };
    for (let index = 0; index < document.parts.length && length < maxLength; index += 1) {
        const part = document.parts[index];
        if (mode === 'bilingual' && document.format === 'markdown' && part.bilingualGroup !== undefined) {
            // 行内链接或代码会被切成多个 part；双语模式按源行重组，避免把一行引用拆成多段。
            const group = part.bilingualGroup;
            const groupParts: DocumentPart[] = [];
            let hasSegment = false;
            while (index < document.parts.length && document.parts[index].bilingualGroup === group) {
                if (document.parts[index].kind === 'segment') hasSegment = true;
                groupParts.push(document.parts[index]);
                index += 1;
            }
            index -= 1;
            // 有界摘录先逐片写原文，达到上限后不再构造整行或读取无用译文。
            for (const entry of groupParts) {
                append(entry.kind === 'literal' ? entry.value : `${entry.prefix}${originalPartSource(entry)}${entry.suffix}`);
                if (length >= maxLength) break;
            }
            if (length >= maxLength) break;
            if (!hasSegment || !groupParts.some(entry => entry.kind === 'segment' &&
                hasDistinctTranslation(entry.source, translations[entry.segmentIndex]))) continue;
            append('\n> ');
            let trailingCR = false;
            for (const entry of groupParts) {
                if (length >= maxLength) break;
                const text = entry.kind === 'literal' ? entry.value
                    : `${entry.prefix}${resolveDocumentTranslation(entry.source, translations[entry.segmentIndex])}${entry.suffix}`;
                if (!text) continue;
                const value = trailingCR && text.startsWith('\n') ? text.slice(1) : text;
                trailingCR = text.endsWith('\r');
                append(value.slice(0, maxLength - length).replace(/\r\n?|\n/gu, '\n> '));
            }
            continue;
        }
        if (part.kind === 'literal') {
            append(part.value);
            continue;
        }
        const translation = resolveDocumentTranslation(part.source, translations[part.segmentIndex]);
        if (!hasDistinctPartTranslation(document, part.source, translation)) {
            append(`${part.prefix}${originalPartSource(part)}${part.suffix}`);
            continue;
        }
        if (mode === 'bilingual') {
            append(formatBilingualTranslation(document, part, translation));
            continue;
        }
        if (document.format === 'html') {
            append(`${part.prefix}${escapeHtml(translation)}${part.suffix}`);
            continue;
        }
        const formattedTranslation = ['srt', 'vtt', 'ass'].includes(document.format)
            ? preserveSubtitleMarkup(part.source, translation)
            : translation;
        append(`${part.prefix}${formattedTranslation}${part.suffix}`);
    }
    return output.join('');
}

function getAtPath(value: unknown, path: Array<string | number>): unknown {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

function setAtPath(root: unknown, path: Array<string | number>, value: unknown): unknown {
    if (path.length === 0) return value;
    let current = root as Record<string | number, unknown>;
    path.slice(0, -1).forEach((key) => {
        current = current[key] as Record<string | number, unknown>;
    });
    current[path[path.length - 1]] = value;
    return root;
}

export function renderDocument(
    document: ParsedDocument,
    translations: readonly string[],
    mode: DocumentRenderMode = 'bilingual',
    maxLength = Infinity,
): string {
    maxLength = Number.isNaN(maxLength) ? 0 : Math.max(0, Math.trunc(maxLength));
    if (maxLength === 0) return '';
    if (document.format !== 'json') return renderParts(document, translations, mode, maxLength);

    let output = cloneJsonValue(document.jsonValue);
    document.jsonEntries?.forEach((entry) => {
        const original = getAtPath(output, entry.path);
        if (typeof original !== 'string') return;
        const translation = resolveDocumentTranslation(original.trim(), translations[entry.segmentIndex]);
        if (!hasDistinctTranslation(original, translation)) return;
        const value = mode === 'bilingual'
            ? `${entry.prefix}${original.trim()}\n${translation}${entry.suffix}`
            : `${entry.prefix}${translation}${entry.suffix}`;
        output = setAtPath(output, entry.path, value);
    });
    return JSON.stringify(output, null, 2).slice(0, maxLength);
}

export function createDocumentDownloadName(fileName: string, mode: DocumentRenderMode): string {
    const suffix = mode === 'bilingual' ? '.bilingual' : '.translated';
    // 正则始终匹配完整字符串；用非空断言表达该不变量，避免把不可达分支伪装成容错。
    const match = fileName.match(/^([\s\S]*?)(\.[^.]+)?$/u)!;
    return `${match[1] || fileName}${suffix}${match[2] || ''}`;
}
