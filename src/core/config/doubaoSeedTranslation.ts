/**
 * @file src/core/config/doubaoSeedTranslation.ts
 *
 * 文件职责：描述火山方舟 Doubao-Seed-Translation 翻译专用模型的识别规则与语言码映射，供目录、能力判定和 provider 共用同一份事实。
 * 主要内容：声明官方模型编号与前缀匹配函数，维护 FluentRead 语言码到方舟翻译语言码的白名单，并提供源语言（可自动检测）与目标语言（必须受支持）的解析函数；白名单只读取自身语言条目，继承属性不得作为协议语言码。 可核对的公开符号包括 DOUBAO_SEED_TRANSLATION_MODEL_ID、isDoubaoSeedTranslationModel、DOUBAO_SEED_TRANSLATION_LANGUAGES、resolveDoubaoSeedTranslationLanguage。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';

/** 官方目录当前发布的翻译专用模型编号。 */
export const DOUBAO_SEED_TRANSLATION_MODEL_ID = 'doubao-seed-translation-250915';

// 官方按日期滚动发布版本号（250915、后续快照……），因此以系列前缀判断，
// 让用户填写的“自定义模型”同样走翻译专用协议。
const MODEL_ID_PREFIX = 'doubao-seed-translation';

/**
 * 翻译专用模型只接受 Responses API 的 translation_options 协议，
 * 在 chat/completions 上会被方舟直接拒绝（model does not support this api）。
 */
export function isDoubaoSeedTranslationModel(model?: string): boolean {
    return (model || '').trim().toLowerCase().startsWith(MODEL_ID_PREFIX);
}

/**
 * FluentRead 语言码到方舟翻译语言码的白名单，对应官方公布的 28 个互译语种。
 * 未列出的语言由调用方明确拒绝，不能退回英文或简体中文等默认值。
 */
export const DOUBAO_SEED_TRANSLATION_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
    'zh-Hans': 'zh',
    'zh-Hant': 'zh-Hant',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    de: 'de',
    fr: 'fr',
    es: 'es',
    it: 'it',
    pt: 'pt',
    ru: 'ru',
    th: 'th',
    vi: 'vi',
    ar: 'ar',
    cs: 'cs',
    da: 'da',
    fi: 'fi',
    hr: 'hr',
    hu: 'hu',
    id: 'id',
    ms: 'ms',
    nb: 'nb',
    nl: 'nl',
    pl: 'pl',
    ro: 'ro',
    sv: 'sv',
    tr: 'tr',
    uk: 'uk',
});

/** 解析单个语言码；'auto'、空值和不支持的语言都返回 undefined，由调用方区分处理。 */
export function resolveDoubaoSeedTranslationLanguage(value?: string): string | undefined {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed === 'auto') return undefined;
    const language = normalizeChineseLanguageCode(trimmed);
    return Object.hasOwn(DOUBAO_SEED_TRANSLATION_LANGUAGES, language)
        ? DOUBAO_SEED_TRANSLATION_LANGUAGES[language] : undefined;
}
