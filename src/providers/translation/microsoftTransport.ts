/**
 * @file src/providers/translation/microsoftTransport.ts
 * 文件职责：提供可跨浏览器扩展与 Obsidian 复用的微软免费翻译 HTTP 协议。
 * 主要内容：构造批量请求、转义纯文本、校验响应数量并还原译文。
 * 模块边界：只接收注入的 HTTP 端口，不读取扩展配置或持久化状态。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, type RuntimeFetch} from '@/src/platform/http/runtime';

const MICROSOFT_TRANSLATE_URL = 'https://edge.microsoft.com/translate/translatetext';

type MicrosoftTranslation = {translations?: Array<{text?: string}>};

function escapeHtmlText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function decodeHtmlText(text: string): string {
    return text
        .replace(/&#(?:0*39);|&#x0*27;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&gt;/gi, '>')
        .replace(/&lt;/gi, '<')
        .replace(/&amp;/gi, '&');
}

export async function translateMicrosoftTextsWithTransport(
    transport: RuntimeFetch,
    texts: string[],
    fromLang: string,
    toLang: string,
    abortSignal?: AbortSignal,
): Promise<string[]> {
    if (texts.length === 0) return [];
    if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);

    fromLang = normalizeChineseLanguageCode(fromLang);
    toLang = normalizeChineseLanguageCode(toLang);
    const url = new URL(MICROSOFT_TRANSLATE_URL);
    url.searchParams.set('from', fromLang === 'auto' ? '' : fromLang === 'sr' ? 'sr-Cyrl' : fromLang);
    url.searchParams.set('to', toLang === 'sr' ? 'sr-Cyrl' : toLang);
    url.searchParams.set('isEnterpriseClient', 'false');

    const response = await transport(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        // 端点始终运行 HTML 标签对齐器，必须先转义纯文本中的标记字符。
        body: JSON.stringify(texts.map(escapeHtmlText)),
        signal: abortSignal,
    });

    if (!response.ok) throw createHttpStatusError(response, '翻译失败');
    const result = await readJsonResponse<MicrosoftTranslation[]>(response, '微软翻译返回的不是有效 JSON');
    if (abortSignal?.aborted) throw abortErrorFromSignal(abortSignal);
    if (!Array.isArray(result) || result.length !== texts.length) {
        throw new Error(`微软翻译返回数量异常: 期望 ${texts.length} 条，实际 ${Array.isArray(result) ? result.length : 0} 条`);
    }
    return result.map((item, index) => {
        const translatedText = item?.translations?.[0]?.text;
        if (typeof translatedText !== 'string') {
            throw new Error(`微软翻译第 ${index + 1} 条结果缺少译文`);
        }
        return decodeHtmlText(translatedText);
    });
}
