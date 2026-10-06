/**
 * @file src/core/language/identify.ts
 *
 * 文件职责：对一段待翻译文本给出与目标语言无关的语言识别结论，是全文、悬浮、标题、划词和共享翻译客户端同目标跳过判断的唯一证据来源。
 * 主要内容：规范空白后生成技术标识符遮蔽副本并按文字切词；以非名称字母量确定主文字，把其他文字正文判为混合；结合汉字及中文技术角色语境辨别少量嵌入名称/术语和枚举，保护外语句子、功能词和引述文本；把缩写、内部大写名称、格式名和带版本名称限制为不能主导结论的少量权重。中日韩分别使用假名/谚文/汉字规则并以中文专用字形排除中日、中韩误判；单一语言文字直接给出结论；Latin、Cyrillic、Arabic、Devanagari 交给统计评估，并逐句检查是否夹带可信的其他语言句子；结果以文本为键做有界缓存，目标语言与排除列表不进入缓存。
 * 模块边界：本文件属于 core 纯算法，不比较目标语言、不读取配置或页面 lang、不修改原文与 DOM；配置语言匹配和各功能入口语义由 detect.ts 负责。
 */

import {classifyChineseHan, hasSimplifiedChineseEvidence, hasTraditionalChineseEvidence} from './chinese';
import {SCRIPT_UNIQUE_LANGUAGES, hasScriptUniqueVeto, segmentScriptWords, type ScriptWord, type WritingScript} from './scripts';
import {assessStatisticalLanguage} from './statistical';
import {classifyEmbeddedLatinWord, createLanguageDetectionCopy, isAcronymWord, isMixedCaseName, isNameVariantWord} from './technicalTokens';
import {FUNCTION_WORDS, type StatisticalScript} from './lexicon';

export type LanguageIdentificationStatus = 'empty' | 'identified' | 'unknown' | 'mixed';

export interface LanguageIdentification {
    status: LanguageIdentificationStatus;
    /** 可信归属的规范语言代码；简繁字形相同的中文同时属于 zh-Hans 与 zh-Hant。 */
    languages: readonly string[];
    /** 不可信时的最佳猜测，仅供选择朗读音色或模型语言等非跳过用途。 */
    bestGuess?: string;
    method?: 'script' | 'chinese' | 'japanese' | 'korean' | 'statistical' | 'lexical-only';
}

const STATISTICAL_SCRIPTS = new Set<WritingScript>(['Latin', 'Cyrillic', 'Arabic', 'Devanagari']);
const CJK_SCRIPTS = new Set<WritingScript>(['Han', 'Kana', 'Hangul']);
const IDENTIFICATION_CACHE_LIMIT = 512;
const CACHEABLE_TEXT_LENGTH = 4096;
const MIXED_SENTENCE_MIN_WORDS = 3;
const MIXED_SENTENCE_MIN_LETTERS = 12;
/** 现代韩文汉字通常是 1–6 字名词，连续 8 个及以上汉字按中文句子处理。 */
const KOREAN_MAX_HANJA_RUN = 8;
// 句末标点覆盖 Latin/CJK、阿拉伯文（؟ ؛ ۔）、印度诸文字（। ॥）、希腊文问号及亚美尼亚、缅甸、高棉、吉兹文句号。
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?。！？;；:：\u061F\u061B\u06D4\u0964\u0965\u037E\u0589\u104B\u17D4\u1362])\s*(?=\S)|\n+/u;
const identificationCache = new Map<string, LanguageIdentification>();
const LATIN_FUNCTION_WORDS = new Set(Object.values(FUNCTION_WORDS.Latin).flatMap(words => [...words]));
// 这些是中文句法中的技术角色，不是浏览器、产品或供应商名称名单。未知名称也可由使用语境确认。
const TECHNICAL_ROLE_BEFORE = /(?:降为|降為|设为|設為|设置为|設置為|切换为|切換為|级别为|級別為|提示为|提示為|生产|生產|构建|構建|运行|運行|执行|執行|安装|安裝|启用|啟用|加载|加載|导入|導入|导出|導出|兼容|适配|適配|无|無)$/u;
const TECHNICAL_ROLE_AFTER = /^(?:只|仅|僅)?(?:构建|構建|脚本|腳本|插件|扩展|擴展|浏览器|瀏覽器|模式|级别|級別|格式|版本|组件|組件|控件|缓存|緩存|配置|参数|參數|服务|服務|接口|模型|环境|環境|内核|內核|引擎|协议|協議|文件|资源|資源|平台|项目|項目|模块|模組|检测|檢測|测试|測試|校验|校驗|日志|日誌|错误|錯誤|异常|異常|提示|验证|驗證)/u;
const EXPLICIT_FOREIGN_WORD_BEFORE = /(?:翻译|翻譯|解释|解釋|英文|外语|外語|单词|單詞|词语|詞語)(?:一下|为|為|是|的)?$/u;
const FOREIGN_PROSE_MARKERS = new Set(['please', 'hello', 'welcome', 'goodbye', 'thanks', 'sorry', 'translate', 'click', 'retry']);

const EMPTY: LanguageIdentification = Object.freeze({status: 'empty', languages: Object.freeze([])});
const UNKNOWN: LanguageIdentification = Object.freeze({status: 'unknown', languages: Object.freeze([])});
const MIXED: LanguageIdentification = Object.freeze({status: 'mixed', languages: Object.freeze([])});

/** 识别只关心词和句子边界：合并行内空白，保留换行作为句子边界。 */
export function normalizeLanguageEvidenceText(value: string): string {
    return value.replace(/[^\S\n]+/gu, ' ').replace(/ ?\n[\s]*/gu, '\n').trim();
}

export function clearLanguageIdentificationCache(): void {
    identificationCache.clear();
}

function identified(languages: readonly string[], method: NonNullable<LanguageIdentification['method']>): LanguageIdentification {
    return Object.freeze({status: 'identified', languages: Object.freeze([...languages]), bestGuess: languages[0], method});
}

function unknown(bestGuess?: string): LanguageIdentification {
    return bestGuess ? Object.freeze({status: 'unknown', languages: Object.freeze([]), bestGuess}) : UNKNOWN;
}

interface EmbeddedEvidence {
    foreignProse: boolean;
    nameWeight: number;
}

/**
 * 统计主文字以外的词：其他文字的多字母词都是外语正文；Latin 词按名称/格式/单字母/正文分类；
 * 希腊字母单字常作数学或物理符号，不视为外语。
 */
function assessEmbeddedWords(words: readonly ScriptWord[], isMain: (word: ScriptWord) => boolean, versionedNames: number,
    embeddedNames: ReadonlyMap<ScriptWord, number> = new Map()): EmbeddedEvidence {
    let foreignProse = false;
    let nameWeight = versionedNames * 2;
    for (const word of words) {
        if (isMain(word)) continue;
        if (word.script === 'Latin') {
            if (embeddedNames.has(word)) { nameWeight += embeddedNames.get(word)!; continue; }
            const {role, weight} = classifyEmbeddedLatinWord(word.text);
            if (role === 'prose') foreignProse = true;
            nameWeight += weight;
            continue;
        }
        if (word.script === 'Greek' && word.letters === 1) continue;
        foreignProse = true;
    }
    return {foreignProse, nameWeight};
}

/**
 * 中文技术说明常把未带版本的名称直接嵌入正文（例如 DeepSeek Harness）。逐词拒绝所有
 * 首字母大写词会让整段重复翻译。按连续 Latin 短语判断：接纳紧邻汉字的 1–3 词名称及
 * 有中文技术角色支撑的 1–2 词术语，支持顿号/斜杠枚举；功能词、引文、明确要求翻译的词、
 * 外语句子和跨句边界不能被吞掉，术语只在可信中文语境中生效，仍受母语字数门槛约束。
 * 不依赖产品名单、页面 lang 或目标语言，也不改变送给供应商的原文。
 */
function findEmbeddedNames(copy: string, words: readonly ScriptWord[]): ReadonlyMap<ScriptWord, number> {
    const names = new Map<ScriptWord, number>();
    if (words.reduce((count, word) => count + (word.script === 'Han' ? word.letters : 0), 0) < 8) return names;
    const chineseContext = classifyChineseHan(copy) !== undefined;
    for (let index = 0; index < words.length; index += 1) {
        if (words[index]!.script !== 'Latin') continue;
        const start = index;
        while (index + 1 < words.length && words[index + 1]!.script === 'Latin' &&
            /^[ \t/、-]+$/u.test(copy.slice(words[index]!.end, words[index + 1]!.start))) index += 1;
        const run = words.slice(start, index + 1);
        if (run.length > 3 || run.at(-1)!.end - run[0]!.start > 64) continue;
        const before = copy.slice(Math.max(0, run[0]!.start - 16), run[0]!.start).trimEnd();
        const after = copy.slice(run.at(-1)!.end, run.at(-1)!.end + 16).trimStart();
        const technicalRole = chineseContext && (run.length <= 2 || copy.slice(run[0]!.start, run.at(-1)!.end).includes('/'))
            && (TECHNICAL_ROLE_BEFORE.test(before.replace(/[、,，]\s*$/u, '')) || TECHNICAL_ROLE_AFTER.test(after))
            && !EXPLICIT_FOREIGN_WORD_BEFORE.test(before);
        const hanBefore = /\p{Script=Han}$/u.test(before);
        const hanAfter = /^\p{Script=Han}/u.test(after);
        if (!hanBefore && !hanAfter && !technicalRole) continue;
        if (EXPLICIT_FOREIGN_WORD_BEFORE.test(before)) continue;
        // 纯首字母大写名称需要两侧正文支撑；被标点切断的孤立词不能靠另一侧的汉字获准。
        if (!technicalRole && (!hanBefore || !hanAfter) && !run.some(word => isMixedCaseName(word.text) || isAcronymWord(word.text))) continue;
        // 引述的外语词不是名称点缀；只借助另一侧汉字也不能越过引号。
        if (/["'“‘「『]$/u.test(before) || /^["'”’」』]/u.test(after)) continue;
        if (!run.every((word, position) => {
            const nameVariant = position > 0 && isNameVariantWord(word.text)
                && (isMixedCaseName(run[0]!.text) || isAcronymWord(run[0]!.text));
            return (!LATIN_FUNCTION_WORDS.has(word.text.toLowerCase()) || nameVariant)
            && !FOREIGN_PROSE_MARKERS.has(word.text.toLowerCase())
            && (classifyEmbeddedLatinWord(word.text).role !== 'prose' || /^[A-Z][a-z]{1,23}$/u.test(word.text)
                || nameVariant || (technicalRole && /^[A-Za-z]{2,24}$/u.test(word.text)));
        })) continue;
        // 一个连续标签按一个名称计权，词段仍逐项排除正文证据；不能按英文拼写长度压倒中文语法。
        // 顿号枚举里的名称仍分别计权，避免大量产品名借少量中文主导语言结论。
        const enumeration = copy.slice(run[0]!.start, run.at(-1)!.end).includes('、');
        for (const word of run) names.set(word, enumeration ? 2 : 2 / run.length);
    }
    return names;
}

function statisticalWords(words: readonly ScriptWord[], script: StatisticalScript): string[] {
    return words
        .filter(word => word.script === script)
        .map(word => word.text)
        .filter(word => script !== 'Latin' || (!isAcronymWord(word) && !isMixedCaseName(word)));
}

/**
 * 已可信识别整段后逐句检查。这里只需要“存在其他语言证据”，比跳过判断更敏感：
 * 句子被可信识别为其他语言，或其他语言的功能词严格领先，都视为夹带外语句子并保留翻译。
 */
function containsForeignSentence(copy: string, script: StatisticalScript, language: string): boolean {
    const sentences = copy.split(SENTENCE_BOUNDARY_PATTERN);
    if (sentences.length < 2) return false;
    return sentences.some((sentence) => {
        const words = statisticalWords(segmentScriptWords(sentence), script);
        const letters = words.reduce((total, word) => total + [...word].filter(character => /\p{L}/u.test(character)).length, 0);
        if (words.length < MIXED_SENTENCE_MIN_WORDS || letters < MIXED_SENTENCE_MIN_LETTERS) return false;
        const assessment = assessStatisticalLanguage(script, words);
        const foreign = assessment.language ?? assessment.functionWordLeader;
        return foreign !== undefined && foreign !== language;
    });
}

function identifyCjk(copy: string, words: readonly ScriptWord[], versionedNames: number,
    embeddedNames: ReadonlyMap<ScriptWord, number>): LanguageIdentification {
    const counts = {Han: 0, Kana: 0, Hangul: 0};
    for (const word of words) {
        if (word.script === 'Han' || word.script === 'Kana' || word.script === 'Hangul') counts[word.script] += word.letters;
    }
    const native = counts.Han + counts.Kana + counts.Hangul;
    const embedded = assessEmbeddedWords(words, word => CJK_SCRIPTS.has(word.script), versionedNames, embeddedNames);
    if (embedded.foreignProse || (counts.Kana > 0 && counts.Hangul > 0)) return MIXED;
    // 名称只能点缀正文：按词计权后超过母语字符一半时，无法证明整段属于目标语言。
    if (embedded.nameWeight * 2 > native) return UNKNOWN;
    const han = words.filter(word => word.script === 'Han').map(word => word.text).join('');

    if (counts.Kana > 0) {
        return hasSimplifiedChineseEvidence(han) || hasTraditionalChineseEvidence(han)
            ? MIXED
            : identified(['ja'], 'japanese');
    }
    if (counts.Hangul > 0) {
        // 韩文汉字使用传统字形且多为短名词；简体字、汉字多于谚文或出现中文句子式的长汉字串时不能证明是韩文。
        // 字段数来自任意网页文本，不能展开为函数参数；超多短汉字段会超过运行时参数上限。
        let longestHanRun = 0;
        for (const word of words) {
            if (word.script === 'Han') longestHanRun = Math.max(longestHanRun, word.letters);
        }
        return hasSimplifiedChineseEvidence(han) || counts.Han > counts.Hangul || longestHanRun >= KOREAN_MAX_HANJA_RUN
            ? MIXED
            : identified(['ko'], 'korean');
    }
    const script = classifyChineseHan(copy);
    if (script === 'shared') return identified(['zh-Hans', 'zh-Hant'], 'chinese');
    return script ? identified([`zh-${script}`], 'chinese') : unknown('zh');
}

function identifyUncached(value: string): LanguageIdentification {
    if (!/\p{L}/u.test(value)) return EMPTY;
    const detectionCopy = createLanguageDetectionCopy(value);
    const words = segmentScriptWords(detectionCopy.text);
    if (words.length === 0) return UNKNOWN;
    const embeddedNames = findEmbeddedNames(detectionCopy.text, words);

    // 主文字按“非名称字母”决定：PDF、OpenAI 这类名称不能把中文句子变成 Latin 文本。
    const weights = new Map<string, number>();
    for (const word of words) {
        const group = CJK_SCRIPTS.has(word.script) ? 'CJK' : word.script;
        const contributes = word.script !== 'Latin' || (!embeddedNames.has(word) && classifyEmbeddedLatinWord(word.text).role === 'prose');
        if (contributes) weights.set(group, (weights.get(group) ?? 0) + word.letters);
    }
    const ranked = [...weights].sort((left, right) => right[1] - left[1]);
    if (ranked.length === 0 || (ranked[1] && ranked[1][1] === ranked[0]![1])) return UNKNOWN;
    const main = ranked[0]![0];

    if (main === 'CJK') return identifyCjk(detectionCopy.text, words, detectionCopy.versionedNames, embeddedNames);

    const script = main as WritingScript;
    const embedded = assessEmbeddedWords(words, word => word.script === script, script === 'Latin' ? 0 : detectionCopy.versionedNames);
    if (embedded.foreignProse) return MIXED;
    const nativeLetters = weights.get(script)!;
    if (script !== 'Latin' && embedded.nameWeight * 2 > nativeLetters) return UNKNOWN;

    const scriptLanguage = SCRIPT_UNIQUE_LANGUAGES[script];
    if (scriptLanguage) {
        if (nativeLetters < 2 || hasScriptUniqueVeto(script, detectionCopy.text)) return UNKNOWN;
        return identified([scriptLanguage], 'script');
    }
    if (!STATISTICAL_SCRIPTS.has(script)) return UNKNOWN;

    const statisticalScript = script as StatisticalScript;
    const assessment = assessStatisticalLanguage(statisticalScript, statisticalWords(words, statisticalScript));
    if (!assessment.language) return unknown(assessment.bestGuess);
    if (containsForeignSentence(detectionCopy.text, statisticalScript, assessment.language)) return MIXED;
    return identified([assessment.language], assessment.reason === 'lexical-only' ? 'lexical-only' : 'statistical');
}

/** 识别文本语言；只以文本为缓存键，目标语言、排除语言或源语言变化都会重新比较而不会复用旧结论。 */
export function identifyTextLanguage(text: string): LanguageIdentification {
    const value = normalizeLanguageEvidenceText(text);
    if (value.length > CACHEABLE_TEXT_LENGTH) return identifyUncached(value);
    const cached = identificationCache.get(value);
    if (cached) {
        identificationCache.delete(value);
        identificationCache.set(value, cached);
        return cached;
    }
    const result = identifyUncached(value);
    identificationCache.set(value, result);
    if (identificationCache.size > IDENTIFICATION_CACHE_LIMIT) {
        identificationCache.delete(identificationCache.keys().next().value!);
    }
    return result;
}
