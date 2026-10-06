/**
 * @file src/services/translation/languages.ts
 *
 * 文件职责：将请求级语言覆盖与冻结配置连接起来，为 provider 统一解析本次调用使用的源语言和目标语言。
 * 主要内容：复用 core 的 resolveTranslationLanguages，优先采用消息携带的 sourceLanguage/targetLanguage，缺省时读取附带配置快照的 from/to；未附带快照的直接调用仍读取当前配置，并转出 TranslationLanguageOverride 类型供各适配器声明输入。 可核对的公开符号包括 getTranslationLanguages、聚合导出。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import type {TranslationLanguageOverride} from '@/src/core/translation/languages';
import {config} from '@/src/services/config/store';
import {getTranslationProviderConfig} from './requestSnapshot';

export type {TranslationLanguageOverride} from '@/src/core/translation/languages';

/**
 * 在不修改扩展共享配置的前提下，解析翻译请求携带的语言对，使多个服务同时翻译时的
 * 对比请求彼此隔离。
 */
export function getTranslationLanguages(message?: TranslationLanguageOverride | null): {
    sourceLanguage: string;
    targetLanguage: string;
} {
    const current = getTranslationProviderConfig(message, config);
    return resolveTranslationLanguages(message, {
        sourceLanguage: current.from,
        targetLanguage: current.to,
    });
}
