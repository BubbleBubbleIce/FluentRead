/**
 * Obsidian 的 HTTP 端口：复用 FluentRead 的文档拆批与微软协议，使用 requestUrl 绕开 CORS。
 */
import type {RequestUrlParam, RequestUrlResponse} from 'obsidian';
import {createDocumentSegmentTranslator} from '../../src/features/document-translation/services/translation';
import {translateMicrosoftTextsWithTransport} from '../../src/providers/translation/microsoftTransport';
import type {RuntimeFetch} from '../../src/platform/http/runtime';

const REQUEST_TIMEOUT_MS = 20_000;

export type ObsidianRequestUrl = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

function abortError(): Error {
    return new DOMException('文档翻译已取消', 'AbortError');
}

function awaitRequest(
    request: Promise<RequestUrlResponse>,
    signal?: AbortSignal,
): Promise<RequestUrlResponse> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(() => reject(new Error('翻译请求超时，请稍后重试'))), REQUEST_TIMEOUT_MS);
        const onAbort = () => finish(() => reject(abortError()));
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            callback();
        };
        signal?.addEventListener('abort', onAbort, {once: true});
        request.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
        // requestUrl 已启动后仍需接管它的拒绝；同步取消也不能留下未处理的晚到错误。
        if (signal?.aborted) onAbort();
    });
}

export function createObsidianTranslator(request: ObsidianRequestUrl) {
    const transport: RuntimeFetch = async (input, init) => {
        if (init?.signal?.aborted) throw abortError();
        const result = await awaitRequest(request({
            url: String(input),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? init.body : undefined,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            throw: false,
        }), init?.signal ?? undefined);
        return new Response(result.text, {status: result.status, headers: result.headers});
    };
    const translate = (sources: string[], sourceLanguage: string, targetLanguage: string, signal?: AbortSignal) =>
        translateMicrosoftTextsWithTransport(transport, sources, sourceLanguage, targetLanguage, signal);

    return createDocumentSegmentTranslator({
        waitUntilReady: () => undefined,
        getDefaultService: () => 'microsoft',
        supportsBatch: (service) => service === 'microsoft',
        translateText: async (source, _context, options) =>
            (await translate([source], options.sourceLanguage ?? 'auto', options.targetLanguage ?? 'zh-Hans', options.signal))[0],
        translateTextBatch: (sources, _context, options) =>
            translate(sources, options.sourceLanguage ?? 'auto', options.targetLanguage ?? 'zh-Hans', options.signal),
    });
}
