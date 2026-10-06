/**
 * @file src/providers/translation/google-cloud-translation.ts
 *
 * 文件职责：适配 Google Cloud Translation API v2（Basic），使用 API Key 调用官方付费接口，与免费网页端点 google.ts 互不依赖。
 * 主要内容：从请求快照读取 token[googleCloudTranslation]，把语言映射为 zh-CN/zh-TW 等 v2 代码，通过 x-goog-api-key 请求头发送密钥（不进入 URL），解析 data.translations[0].translatedText 并回显安全错误码。 可核对的公开符号包括 GOOGLE_CLOUD_TRANSLATION_URL、default:googleCloudTranslation。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {services} from '@/src/core/config/catalog';
import {method, urls} from '@/src/core/config/constants';
import {config} from '@/src/services/config/store';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError, createProviderCodeError, readJsonResponse} from '@/src/platform/http/errors';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {getTranslationProviderConfig, type TranslationProviderRequest} from '@/src/services/translation/requestSnapshot';
import {resolveCloudLanguages} from './cloud/languages';

export const GOOGLE_CLOUD_TRANSLATION_URL: string = urls[services.googleCloudTranslation];

type GoogleCloudResponse = {
    data?: {translations?: Array<{translatedText?: string}>};
    error?: {code?: unknown; message?: unknown};
};

async function googleCloudTranslation(message: TranslationProviderRequest<string>) {
    const current = getTranslationProviderConfig(message, config);
    const apiKey = current.token[services.googleCloudTranslation]?.trim();
    if (!apiKey) {
        throw new Error('谷歌云翻译尚未配置 API Key，请先在设置中填写');
    }

    const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
    const {source, target} = resolveCloudLanguages('googleCloudTranslation', sourceLanguage, targetLanguage);

    const response = await runtimeFetch(GOOGLE_CLOUD_TRANSLATION_URL, {
        method: method.POST,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            // 密钥走请求头而不是查询串，避免出现在代理日志、历史记录或错误回显里。
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            q: message.origin,
            target,
            format: 'text',
            ...(source ? {source} : {}),
        }),
        signal: message.abortSignal,
    });

    if (!response.ok) {
        throw createHttpStatusError(response, '谷歌云翻译请求失败');
    }

    const result = await readJsonResponse<GoogleCloudResponse>(response, '谷歌云翻译返回的不是有效 JSON');
    if (result?.error) {
        throw createProviderCodeError('谷歌云翻译错误', result.error.code);
    }
    const translated = result?.data?.translations?.[0]?.translatedText;
    if (typeof translated === 'string') return translated;
    throw new Error('谷歌云翻译返回格式异常');
}

export default googleCloudTranslation;
