/**
 * @file src/core/translation/lineBreak.ts
 *
 * 文件职责：为长段落译文按句子边界插入换行，让连续大段译文在保持原有内联结构的前提下更易阅读。
 * 主要内容：识别中英文句末标点并排除常见缩写与小数点误判，提供句子切分纯函数，以及在已渲染译文容器内以 TreeWalker 收集文本并就地插入 <br> 的 DOM 改写函数，只处理超过长度门槛且确实包含多句的段落。 可核对的公开符号包括 LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH、splitTranslationSentences、applyLongParagraphLineBreaks。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取和改写传入的译文 DOM，但不访问配置存储、不调用 provider、不注册页面监听器，也不决定译文何时渲染。
 */

/** 低于该字符数的段落不做换行，避免把短句拆得支离破碎。 */
export const LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH = 120;

// 句末标点后若紧跟引号或右括号，收尾符号仍归属上一句。
const sentenceEndPattern = /(?:[。．！？；…]|[!?;]|(?<![A-Z])(?<!\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|No|Fig|e\.g|i\.e))\.(?=\s))[”’"')\]】》»]*/gu;

/**
 * 按句末标点切分文本，返回保留原标点和尾随空白的句子片段。
 * 没有可用边界时返回单元素数组，调用方据此跳过改写。
 */
export function splitTranslationSentences(text: string): string[] {
    const sentences: string[] = [];
    let cursor = 0;
    sentenceEndPattern.lastIndex = 0;
    for (let match = sentenceEndPattern.exec(text); match; match = sentenceEndPattern.exec(text)) {
        const end = match.index + match[0].length;
        // 数字中的小数点与省略号内部不构成句子边界。
        if (end >= text.length) break;
        const tail = text.slice(end);
        const trailingSpace = /^[ \t　]*/u.exec(tail)![0].length;
        const next = tail.slice(trailingSpace);
        if (!next) break;
        sentences.push(text.slice(cursor, end + trailingSpace));
        cursor = end + trailingSpace;
        sentenceEndPattern.lastIndex = cursor;
    }
    if (cursor < text.length) sentences.push(text.slice(cursor));
    return sentences.length > 0 ? sentences : [text];
}

/**
 * 在译文容器中按句子插入换行。只改写文本节点，链接、强调等内联结构保持不变。
 * 返回是否实际插入过换行，便于调用方与测试确认行为。
 */
export function applyLongParagraphLineBreaks(
    container: HTMLElement,
    minimumLength = LONG_PARAGRAPH_LINE_BREAK_MIN_LENGTH,
): boolean {
    const text = container.textContent;
    if (!text || text.trim().length < minimumLength) return false;

    const document = container.ownerDocument;
    const textNodes: Text[] = [];
    // 先读取全部 Text 再改写，TreeWalker 不使用随 DOM 深度增长的 JS 调用栈。
    const walker = document.createTreeWalker(container, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);

    let inserted = false;
    for (const node of textNodes) {
        const value = node.data;
        if (!value.trim()) continue;
        const sentences = splitTranslationSentences(value);
        if (sentences.length < 2) continue;

        const fragment = document.createDocumentFragment();
        sentences.forEach((sentence, index) => {
            fragment.appendChild(document.createTextNode(
                index === sentences.length - 1 ? sentence : sentence.replace(/[ \t　]+$/u, ''),
            ));
            if (index < sentences.length - 1) {
                fragment.appendChild(document.createElement('br'));
                inserted = true;
            }
        });
        node.parentNode!.replaceChild(fragment, node);
    }
    return inserted;
}
