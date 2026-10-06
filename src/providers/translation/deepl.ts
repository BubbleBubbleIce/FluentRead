/**
 * @file src/providers/translation/deepl.ts
 *
 * 文件职责：适配 DeepL 文本翻译 API，处理 FluentRead 语言代码转换、代理选择、鉴权及响应解析。
 * 主要内容：将 zh-Hans 等目标语言映射为 DeepL 接受的代码，从配置快照构造 URL 与请求体，通过 runtimeFetch 调用并验证 translations 结果。 可核对的公开符号包括 default:deepl。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {method} from "@/src/core/config/constants";
import {getDeepLEndpoint} from '@/src/core/config/deepl';
import {config} from "@/src/services/config/store";
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {abortErrorFromSignal, runtimeFetch} from '@/src/platform/http/runtime';
import {
    getTranslationProviderConfig,
    type TranslationProviderRequest,
} from '@/src/services/translation/requestSnapshot';

async function deepl(message: TranslationProviderRequest<string>) {
    const current = getTranslationProviderConfig(message, config);
    const service = message.serviceOverride || current.service;
    if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
    // DeepL 的目标语言区分书写系统，源语言参数仅接受基础 ZH。
    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    // 2026-09-08 官方语言表：Filipino 使用 TL；KN / SI 尚未提供文本翻译。
    // 不替换成其他语言，也不修改用户保存的选择；允许切换到其他服务重试。
    const normalizeDeepLLanguage = (code: string): string => {
        const normalized = normalizeChineseLanguageCode(code);
        if (normalized === 'kn' || normalized === 'si') {
            throw new Error(`DeepL 暂不支持此语言（${normalized}），请选择其他翻译服务`);
        }
        return normalized === 'fil' ? 'TL' : normalized.toUpperCase();
    };
    const targetLang = normalizeDeepLLanguage(targetLanguage);
    const normalizedSource = normalizeChineseLanguageCode(sourceLanguage);
    const sourceLang = normalizedSource.startsWith('zh-') ? 'ZH' : normalizeDeepLLanguage(normalizedSource);

    // 判断是否使用代理
    const url = getDeepLEndpoint(current.deeplApiPlan, current.proxy[service]);

    const resp = await runtimeFetch(url, {
        method: method.POST,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'DeepL-Auth-Key ' + current.token[service]
        },
        body: JSON.stringify({
            text: [message.origin],
            target_lang: targetLang,
            ...(sourceLanguage === 'auto' ? {} : {source_lang: sourceLang}),
            tag_handling: 'html',
            context: message.context,  // 添加上下文辅助信息
            preserve_formatting: true
        }),
        signal: message.abortSignal,
    });

    if (resp.ok) {
        const result = await readJsonResponse<any>(resp, 'DeepL 返回的不是有效 JSON');
        if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
        const text = result?.translations?.[0]?.text;
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('DeepL 返回数据格式异常：缺少译文');
        }
        return text;
    } else {
        throw createHttpStatusError(resp, '翻译失败');
    }
}

export default deepl;
