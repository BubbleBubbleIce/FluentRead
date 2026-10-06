/**
 * @file src/providers/translation/cloud/languages.ts
 *
 * 文件职责：把 FluentRead 统一语言代码转换为各云服务厂商机器翻译接口要求的代码，并统一处理“自动检测源语言”的边界。
 * 主要内容：维护 Google Cloud、Azure、阿里云、百度与火山引擎的语言映射表，提供 resolveCloudLanguages 按厂商映射源/目标语言，目标语言不可为 auto，源语言为 auto 时按厂商约定返回 undefined 或厂商专用占位值。 可核对的公开符号包括 CloudLanguageMap、CLOUD_LANGUAGE_MAPS、resolveCloudLanguages。
 * 模块边界：本文件位于 provider 适配层，只做纯映射，不读取配置、不发起网络请求；请求级语言解析由 services/translation/languages 负责，这里只消费其结果。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';

export interface CloudLanguageMap {
    /** 厂商名称，用于错误提示。 */
    label: string;
    /** 源语言为自动检测时发送的值；undefined 表示省略该参数。 */
    autoSource: string | undefined;
    /** FluentRead 语言代码到厂商代码的映射；未列出的代码按原样透传。 */
    codes: Record<string, string>;
}

const COMMON_CODES = {
    en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', ru: 'ru', de: 'de', es: 'es', it: 'it',
    pt: 'pt', ar: 'ar', th: 'th', vi: 'vi', id: 'id', tr: 'tr', nl: 'nl', pl: 'pl',
} as const;

export const CLOUD_LANGUAGE_MAPS = {
    googleCloudTranslation: {
        label: '谷歌云翻译',
        autoSource: undefined,
        codes: {...COMMON_CODES, 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW'},
    },
    azureTranslator: {
        label: 'Azure 翻译',
        autoSource: undefined,
        codes: {...COMMON_CODES, 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant'},
    },
    aliyunTranslation: {
        label: '阿里云机器翻译',
        autoSource: 'auto',
        codes: {...COMMON_CODES, 'zh-Hans': 'zh', 'zh-Hant': 'zh-tw'},
    },
    baiduTranslation: {
        label: '百度翻译',
        autoSource: 'auto',
        codes: {
            ...COMMON_CODES,
            'zh-Hans': 'zh', 'zh-Hant': 'cht', ja: 'jp', ko: 'kor', fr: 'fra', es: 'spa', ar: 'ara', vi: 'vie',
        },
    },
    volcTranslation: {
        label: '火山引擎翻译',
        autoSource: undefined,
        codes: {...COMMON_CODES, 'zh-Hans': 'zh', 'zh-Hant': 'zh-Hant'},
    },
} as const satisfies Record<string, CloudLanguageMap>;

export type CloudLanguageVendor = keyof typeof CLOUD_LANGUAGE_MAPS;

/** 厂商声明了 autoSource 字面量时，源语言一定是字符串；只有省略参数的厂商才可能返回 undefined。 */
export type CloudSourceLanguage<V extends CloudLanguageVendor> =
    (typeof CLOUD_LANGUAGE_MAPS)[V]['autoSource'] extends string ? string : string | undefined;

function mapCode(map: CloudLanguageMap, code: string): string {
    const normalized = normalizeChineseLanguageCode(code);
    return Object.hasOwn(map.codes, normalized) ? map.codes[normalized] : normalized;
}

/**
 * 解析一次请求的厂商语言代码。目标语言不允许自动检测，源语言为 auto 或空时
 * 按厂商约定返回 autoSource，让调用方决定是否省略参数。
 */
export function resolveCloudLanguages<V extends CloudLanguageVendor>(
    vendor: V,
    sourceLanguage: string,
    targetLanguage: string,
): {source: CloudSourceLanguage<V>; target: string} {
    const map: CloudLanguageMap = CLOUD_LANGUAGE_MAPS[vendor];
    const target = targetLanguage.trim();
    if (!target || target === 'auto') {
        throw new Error(`${map.label}不支持目标语言自动检测`);
    }
    const source = sourceLanguage.trim();
    return {
        source: (!source || source === 'auto' ? map.autoSource : mapCode(map, source)) as CloudSourceLanguage<V>,
        target: mapCode(map, target),
    };
}
