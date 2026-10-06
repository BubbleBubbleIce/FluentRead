/**
 * @file src/core/language/codes.ts
 *
 * 文件职责：统一解析与比较 FluentRead 使用的语言标签，让配置目标语言、排除语言、检测器结果和旧别名落到同一套规范代码上。
 * 主要内容：按 BCP 47 结构解析主语言、扩展语言、脚本、地区、变体与扩展段，完整校验扩展/私有段和重复子标签，兼容下划线、大小写和旧式 zh-CHS/zh-CHT；把 ISO 639-2/B、ISO 639-3 个体语言码、宏语言成员及已废弃代码映射为两字母或保留的三字母代码；中文按脚本或地区确定简繁，配置中的裸 zh 沿用简体默认值，检测器给出的裸 zh/cmn 保持书写体系未知；非默认脚本（如 sr-Latn）保留在规范代码中。可核对的公开符号包括 parseLanguageTag、normalizeLanguageCode、normalizeDetectedLanguageCode、isLanguageCodeMatch、resolveChineseScriptFromSubtags。
 * 模块边界：本文件属于 core 纯算法，只处理语言标签字符串，不识别文本语言、不读取配置或浏览器语言，也不负责供应商专属语言码映射；非法、未知与 auto/und 类值一律返回空代码，由调用方按“无法确认”处理。
 */

export type ChineseScriptSubtag = 'Hans' | 'Hant';

export interface ParsedLanguageTag {
    /** 标签中实际书写的主语言（扩展语言优先），已小写但尚未做别名映射。 */
    language: string;
    script?: string;
    region?: string;
    /** 旧式 zh-CHS / zh-CHT 书写体系提示。 */
    legacyChineseScript?: ChineseScriptSubtag;
}

/** 表示“没有可比较语言”的保留子标签；auto/detect/unknown 因不符合语言子标签形状在解析阶段即被拒绝。 */
const UNKNOWN_LANGUAGE_SUBTAGS = new Set(['und', 'mul', 'mis', 'zxx']);

/** 允许扩展语言子标签（如 zh-yue、ar-arb）的宏语言前缀；其他主语言后的三字母段按非法标签处理。 */
const EXTLANG_PREFIXES = new Set(['ar', 'az', 'et', 'fa', 'lv', 'mn', 'ms', 'ne', 'ps', 'sq', 'sw', 'uz', 'yi', 'zh']);

/**
 * ISO 639-2/B、ISO 639-3、宏语言个体成员与已废弃代码到规范主语言的映射。
 * 覆盖语言目录、franc-min 可能输出的语言及常见浏览器/服务别名；未列出的合法两/三字母代码原样保留。
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    // 语言目录
    eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', por: 'pt', ita: 'it', rus: 'ru',
    jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', cmn: 'zh', ara: 'ar', arb: 'ar', hin: 'hi', ben: 'bn',
    urd: 'ur', fas: 'fa', per: 'fa', pes: 'fa', prs: 'fa', heb: 'he', iw: 'he', tur: 'tr', vie: 'vi',
    tha: 'th', ind: 'id', in: 'id', msa: 'ms', may: 'ms', zlm: 'ms', zsm: 'ms', nld: 'nl', dut: 'nl',
    pol: 'pl', ukr: 'uk', ces: 'cs', cze: 'cs', slk: 'sk', slo: 'sk', dan: 'da', swe: 'sv', nob: 'nb',
    no: 'nb', nor: 'nb', fin: 'fi', ell: 'el', gre: 'el', ron: 'ro', rum: 'ro', mo: 'ro', mol: 'ro',
    hun: 'hu', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', est: 'et', ekk: 'et', lav: 'lv', lvs: 'lv',
    lit: 'lt', tam: 'ta', tel: 'te', mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa', nep: 'ne',
    npi: 'ne', sin: 'si', swa: 'sw', swh: 'sw', tgl: 'fil', tl: 'fil',
    // 统计检测器常见输出与其他常用语言
    jav: 'jv', jw: 'jv', sun: 'su', hau: 'ha', bos: 'bs', yor: 'yo', uzb: 'uz', uzn: 'uz', ibo: 'ig',
    aze: 'az', azj: 'az', kin: 'rw', zul: 'zu', lin: 'ln', som: 'so', amh: 'am', mya: 'my', bur: 'my',
    bel: 'be', kaz: 'kk', pus: 'ps', pbu: 'ps', mlg: 'mg', plt: 'mg', nya: 'ny', run: 'rn', que: 'qu',
    qug: 'qu', ful: 'ff', fuv: 'ff', cat: 'ca', eus: 'eu', baq: 'eu', glg: 'gl', sqi: 'sq', alb: 'sq',
    als: 'sq', hye: 'hy', arm: 'hy', kat: 'ka', geo: 'ka', isl: 'is', ice: 'is', mkd: 'mk', mac: 'mk',
    gle: 'ga', cym: 'cy', wel: 'cy', lat: 'la', khm: 'km', lao: 'lo', mon: 'mn', khk: 'mn', tat: 'tt',
    kir: 'ky', tgk: 'tg', tuk: 'tk', uig: 'ug', yid: 'yi', ydd: 'yi', ji: 'yi', afr: 'af', epo: 'eo',
    nno: 'nn', ori: 'or', ory: 'or', asm: 'as', snd: 'sd', kur: 'ku', kmr: 'ku',
};

/**
 * 常见语言的默认书写体系。规范代码省略默认脚本，保留非默认脚本（sr-Latn、pa-Arab、hi-Latn），
 * 使同一语言的不同文字不会被误判为相同阅读能力；未列出的语言无法判断默认值，因此忽略脚本子标签。
 */
const DEFAULT_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
    en: ['Latn'], fr: ['Latn'], de: ['Latn'], es: ['Latn'], pt: ['Latn'], it: ['Latn'], nl: ['Latn'],
    pl: ['Latn'], cs: ['Latn'], sk: ['Latn'], da: ['Latn'], sv: ['Latn'], nb: ['Latn'], fi: ['Latn'],
    ro: ['Latn'], hu: ['Latn'], hr: ['Latn'], sl: ['Latn'], et: ['Latn'], lv: ['Latn'], lt: ['Latn'],
    tr: ['Latn'], vi: ['Latn'], id: ['Latn'], ms: ['Latn'], sw: ['Latn'], fil: ['Latn'], bs: ['Latn'],
    uz: ['Latn'], az: ['Latn'], ru: ['Cyrl'], uk: ['Cyrl'], bg: ['Cyrl'], sr: ['Cyrl'], be: ['Cyrl'],
    kk: ['Cyrl'], mk: ['Cyrl'], mn: ['Cyrl'], el: ['Grek'], he: ['Hebr'], yi: ['Hebr'], ar: ['Arab'],
    fa: ['Arab'], ur: ['Arab'], ps: ['Arab'], sd: ['Arab'], hi: ['Deva'], mr: ['Deva'], ne: ['Deva'],
    bn: ['Beng'], as: ['Beng'], pa: ['Guru'], gu: ['Gujr'], or: ['Orya'], ta: ['Taml'], te: ['Telu'],
    kn: ['Knda'], ml: ['Mlym'], si: ['Sinh'], th: ['Thai'], lo: ['Laoo'], km: ['Khmr'], my: ['Mymr'],
    ka: ['Geor'], hy: ['Armn'], am: ['Ethi'], ja: ['Jpan', 'Hrkt', 'Hira', 'Kana', 'Hani'],
    ko: ['Kore', 'Hang'], yue: ['Hant'],
};

const CHINESE_REGION_SCRIPTS: Readonly<Record<string, ChineseScriptSubtag>> = {
    CN: 'Hans', SG: 'Hans', TW: 'Hant', HK: 'Hant', MO: 'Hant',
};

function titleCase(value: string): string {
    return value[0]!.toUpperCase() + value.slice(1).toLowerCase();
}

/** 解析语言标签结构；不符合主语言、脚本、地区顺序约束或含空子标签时返回 undefined。 */
export function parseLanguageTag(value: unknown): ParsedLanguageTag | undefined {
    if (typeof value !== 'string') return undefined;
    const subtags = value.trim().replace(/_/gu, '-').split('-');
    const primary = subtags[0]!.toLowerCase();
    if (!/^[a-z]{2,3}$/u.test(primary)) return undefined;

    const tag: ParsedLanguageTag = {language: primary};
    let index = 1;
    const second = subtags[1]?.toLowerCase();
    if (second && /^[a-z]{3}$/u.test(second) && EXTLANG_PREFIXES.has(primary)
        && second !== 'chs' && second !== 'cht') {
        tag.language = second;
        index = 2;
    }
    const chinese = (LANGUAGE_ALIASES[tag.language] ?? tag.language) === 'zh';

    let variantsStarted = false;
    const variants = new Set<string>();
    const extensions = new Set<string>();
    for (; index < subtags.length; index += 1) {
        const subtag = subtags[index]!;
        const lower = subtag.toLowerCase();
        if (!subtag) return undefined;
        // 扩展与私有段不影响阅读语言，但必须校验整段，不能把 en-u 或 en-x- 当成可信 en。
        // RFC 5646 §2.1/§2.2.6：扩展至少一段 2–8 位；x 后至少一段 1–8 位且消费余下全部内容。
        if (/^[a-z\d]$/iu.test(subtag)) {
            if (extensions.has(lower)) return undefined;
            extensions.add(lower);
            const privateUse = lower === 'x';
            const start = ++index;
            while (index < subtags.length && (privateUse || !/^[a-z\d]$/iu.test(subtags[index]!))) {
                if (!(privateUse ? /^[a-z\d]{1,8}$/iu : /^[a-z\d]{2,8}$/iu).test(subtags[index]!)) return undefined;
                index += 1;
            }
            if (index === start) return undefined;
            if (index === subtags.length) return tag;
            index -= 1;
            variantsStarted = true;
            continue;
        }
        if (chinese && (lower === 'chs' || lower === 'cht') && !tag.legacyChineseScript) {
            tag.legacyChineseScript = lower === 'chs' ? 'Hans' : 'Hant';
            continue;
        }
        if (!variantsStarted && /^[a-z]{4}$/iu.test(subtag) && !tag.script && !tag.region) {
            tag.script = titleCase(subtag);
            continue;
        }
        if (!variantsStarted && /^(?:[a-z]{2}|\d{3})$/iu.test(subtag) && !tag.region) {
            tag.region = subtag.toUpperCase();
            continue;
        }
        if (/^(?:[a-z\d]{5,8}|\d[a-z\d]{3})$/iu.test(subtag)) {
            if (variants.has(lower)) return undefined;
            variants.add(lower);
            variantsStarted = true;
            continue;
        }
        return undefined;
    }
    return tag;
}

/**
 * 按脚本子标签、旧式 CHS/CHT 与地区确定中文书写体系；脚本优先于地区。
 * 标签无法说明书写体系时返回 undefined，由调用方决定是否使用简体默认值。
 */
export function resolveChineseScriptFromSubtags(tag: ParsedLanguageTag): ChineseScriptSubtag | undefined {
    if (tag.script === 'Hans' || tag.script === 'Hant') return tag.script;
    if (tag.script) return undefined;
    if (tag.legacyChineseScript) return tag.legacyChineseScript;
    return tag.region ? CHINESE_REGION_SCRIPTS[tag.region] : undefined;
}

function normalizeParsedTag(tag: ParsedLanguageTag, bareChineseDefault: ChineseScriptSubtag | undefined): string {
    const language = LANGUAGE_ALIASES[tag.language] ?? tag.language;
    if (UNKNOWN_LANGUAGE_SUBTAGS.has(language)) return '';
    if (language === 'zh') {
        const script = resolveChineseScriptFromSubtags(tag);
        if (script) return `zh-${script}`;
        const bare = !tag.script && !tag.region && !tag.legacyChineseScript;
        // cmn 是检测器给出的个体语言码，本身不携带配置默认值。
        return bare && tag.language !== 'cmn' && bareChineseDefault ? `zh-${bareChineseDefault}` : 'zh';
    }
    const defaults = DEFAULT_SCRIPTS[language];
    if (tag.script && defaults && !defaults.includes(tag.script)) return `${language}-${tag.script}`;
    return language;
}

/**
 * 规范化配置中的目标语言、排除语言或服务返回的语言标签。
 * 裸 zh 沿用历史简体默认值；返回空字符串表示非法、未知或 auto 类取值，不能参与匹配。
 */
export function normalizeLanguageCode(value: unknown): string {
    const tag = parseLanguageTag(value);
    return tag ? normalizeParsedTag(tag, 'Hans') : '';
}

/** 规范化检测器输出：裸 zh/cmn 只能证明是中文，书写体系保持未知的 zh。 */
export function normalizeDetectedLanguageCode(value: unknown): string {
    const tag = parseLanguageTag(value);
    return tag ? normalizeParsedTag(tag, undefined) : '';
}

/**
 * 判断检测结果是否属于配置语言。两侧都必须是可比较代码；书写体系未知的中文不匹配任何简繁目标，
 * 地区差异（en-US/en-GB、pt-BR/pt-PT）视为相同阅读语言，非默认脚本必须一致。
 */
export function isLanguageCodeMatch(detectedLanguage: unknown, configuredLanguage: unknown): boolean {
    const detected = normalizeDetectedLanguageCode(detectedLanguage);
    const configured = normalizeLanguageCode(configuredLanguage);
    return Boolean(detected && detected !== 'zh' && detected === configured);
}
