/**
 * @file src/app/offscreen/translation.ts
 * 文件职责：封装 Chrome 内置 Translation API 在 Offscreen 环境中的能力检查、模型准备、语言检测、规范化、翻译执行和错误解释，并兼容新旧实验接口形态。
 * 主要内容：定义最小环境与请求契约，验证 from/to 语言码并映射 Chrome 151 中文别名，优先使用不含结构哨兵的检测样本和现代 API；处理 availability、下载进度、低置信度、取消、资源清理及友好错误，仅在脚本明确时执行保守兜底。
 * 模块边界：这里不读取扩展配置、不选择第三方 provider，也不监听 runtime 消息；调用协议由 offscreen/messageRouter 管理，宿主能力是否开放由 browser capability 层决定。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {detectChineseScript, MIN_CHROME_LANGUAGE_CONFIDENCE} from '@/src/core/language/detect';

// 保留既有导出，同时让设置页与 offscreen 共用单一阈值。
export {MIN_CHROME_LANGUAGE_CONFIDENCE} from '@/src/core/language/detect';

/** Chrome Translation API 在 Offscreen Document 中暴露的最小能力。 */
export interface ChromeTranslationEnvironment {
    readonly translation?: {
        createDetector?: () => Promise<ChromeLanguageDetector>;
        createTranslator?: (options: ChromeTranslatorOptions) => Promise<ChromeTranslator>;
    };
    readonly LanguageDetector?: {
        availability?: () => Promise<unknown>;
        create: (options?: ChromeModelCreateOptions) => Promise<ChromeLanguageDetector>;
    };
    readonly Translator?: {
        availability?: (options: ChromeTranslatorOptions) => Promise<unknown>;
        create: (options: ChromeTranslatorOptions & ChromeModelCreateOptions) => Promise<ChromeTranslator>;
    };
}

interface ChromeLanguageDetector {
    detect(text: string, options?: ChromeOperationOptions): Promise<unknown>;
    destroy?: () => void;
}

interface ChromeTranslatorOptions {
    sourceLanguage: string;
    targetLanguage: string;
}

interface ChromeTranslator {
    translate?: (text: string, options?: ChromeOperationOptions) => Promise<unknown>;
    translateStreaming?: (text: string, options?: ChromeOperationOptions) => AsyncIterable<unknown>;
    destroy?: () => void;
}

interface ChromeOperationOptions {
    signal?: AbortSignal;
}

interface ChromeDownloadProgressEvent {
    loaded?: unknown;
}

interface ChromeModelMonitor {
    addEventListener(type: 'downloadprogress', listener: (event: ChromeDownloadProgressEvent) => void): void;
}

interface ChromeModelCreateOptions extends ChromeOperationOptions {
    monitor?: (monitor: ChromeModelMonitor) => void;
}

export type ChromeModelAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
export type ChromeModelKind = 'language-detector' | 'translator';
export type ChromeModelPhase = 'checking' | 'downloading' | 'initializing' | 'ready';

export interface ChromeModelStatus {
    readonly model: ChromeModelKind;
    readonly phase: ChromeModelPhase;
    readonly availability?: ChromeModelAvailability;
    readonly loaded?: number;
}

export type ChromeModelStatusReporter = (status: ChromeModelStatus) => void;

export interface ChromeTranslationRequest {
    text: string;
    from: string;
    to: string;
    sourceLanguageDetectionText?: string;
}

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;
const CHROME_MODEL_AVAILABILITIES = new Set<ChromeModelAvailability>([
    'unavailable',
    'downloadable',
    'downloading',
    'available',
]);
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析跨进程翻译请求。协议错误在进入浏览器实验 API 前即失败，避免把
 * `null`、对象或 `to=auto` 交给底层后得到难以定位的 DOMException。
 */
export function parseChromeTranslationRequest(value: unknown): ChromeTranslationRequest {
    if (!isRecord(value)) throw new TypeError('Chrome 翻译请求 data 必须是对象');
    const text = value.text;
    if (typeof text !== 'string') throw new TypeError('Chrome 翻译文本必须是字符串');
    const from = parseLanguageCode(value.from, 'from', true);
    const to = parseLanguageCode(value.to, 'to', false);
    const sourceLanguageDetectionText = value.sourceLanguageDetectionText;
    if (sourceLanguageDetectionText !== undefined && typeof sourceLanguageDetectionText !== 'string') {
        throw new TypeError('Chrome 源语言检测文本必须是字符串');
    }
    return {
        text,
        from,
        to,
        ...(sourceLanguageDetectionText?.trim() ? {sourceLanguageDetectionText} : {}),
    };
}

export function parseLanguageCode(value: unknown, field: string, allowAuto: boolean): string {
    if (typeof value !== 'string') throw new TypeError(`Chrome 翻译 ${field} 必须是语言代码`);
    const language = value.trim();
    if (allowAuto && language === 'auto') return language;
    if (!language || !LANGUAGE_CODE_PATTERN.test(language)) {
        throw new TypeError(`Chrome 翻译 ${field} 语言代码无效`);
    }
    return language;
}

export function mapChromeLanguageCode(language: string): string {
    const normalized = normalizeChineseLanguageCode(language);
    return normalized === 'zh-Hans' ? 'zh' : normalized;
}

export function isChromeTranslationSupported(environment: ChromeTranslationEnvironment): boolean {
    return typeof environment.translation?.createTranslator === 'function'
        || typeof environment.Translator?.create === 'function';
}

/** 无检测器或检测器不确定时只接受高置信专属脚本；共享脚本、Latin 与纯 Han 保持未知。 */
export function detectLanguageByScript(text: string): string | null {
    const hasKana = /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text);
    const hasHangul = /\p{Script=Hangul}/u.test(text);
    if (hasKana && hasHangul) return null;
    if (hasKana) return 'ja';
    if (hasHangul) return 'ko';
    // Cyrillic、Arabic、Devanagari 与 Thai 都可能承载多种语言，失败时宁可让用户显式选择。
    return null;
}

export function detectedLanguageFrom(value: unknown, requireConfidence = true): string | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const first = value[0];
    if (!isRecord(first) || typeof first.detectedLanguage !== 'string') return null;
    const detected = first.detectedLanguage.trim();
    if (!detected || detected.toLowerCase() === 'und' || !LANGUAGE_CODE_PATTERN.test(detected)) return null;
    const confidence = first.confidence;
    if (confidence === undefined && !requireConfidence) return detected;
    if (typeof confidence !== 'number'
        || !Number.isFinite(confidence)
        || confidence < MIN_CHROME_LANGUAGE_CONFIDENCE
        || confidence > 1) return null;
    return detected;
}

function createNamedError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

export interface ChromePreparationRequiredError extends Error {
    readonly code: 'preparation-required';
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
}

export function createChromePreparationRequiredError(
    sourceLanguage: string,
    targetLanguage: string,
    cause?: unknown,
): ChromePreparationRequiredError {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    const error = createNamedError(
        'ChromePreparationRequiredError',
        `Chrome 本地翻译模型需要用户激活，已记录 ${sourceLanguage} → ${targetLanguage} 待准备请求。`
            + `请在设置中点击“准备 Chrome 本地翻译”${detail}`,
    ) as ChromePreparationRequiredError;
    Object.assign(error, {code: 'preparation-required', sourceLanguage, targetLanguage});
    return error;
}

export function isChromePreparationRequiredError(error: unknown): error is ChromePreparationRequiredError {
    return error instanceof Error
        && error.name === 'ChromePreparationRequiredError'
        && (error as Partial<ChromePreparationRequiredError>).code === 'preparation-required'
        && typeof (error as Partial<ChromePreparationRequiredError>).sourceLanguage === 'string'
        && typeof (error as Partial<ChromePreparationRequiredError>).targetLanguage === 'string';
}

function reportModelStatus(
    reporter: ChromeModelStatusReporter | undefined,
    status: ChromeModelStatus,
    signal?: AbortSignal,
): void {
    if (!reporter || signal?.aborted) return;
    try {
        reporter({...status});
    } catch {
        // 模型状态属于旁路观察；UI/测试 reporter 失败不能中断本地翻译。
    }
}

function parseModelAvailability(value: unknown): ChromeModelAvailability | undefined {
    return typeof value === 'string' && CHROME_MODEL_AVAILABILITIES.has(value as ChromeModelAvailability)
        ? value as ChromeModelAvailability
        : undefined;
}

async function checkModelAvailability(
    model: ChromeModelKind,
    operation: (() => Promise<unknown>) | undefined,
    reporter: ChromeModelStatusReporter | undefined,
    signal?: AbortSignal,
): Promise<ChromeModelAvailability | undefined> {
    reportModelStatus(reporter, {model, phase: 'checking'}, signal);
    throwIfAborted(signal);
    if (!operation) {
        reportModelStatus(reporter, {model, phase: 'initializing'}, signal);
        return undefined;
    }
    let availability: ChromeModelAvailability | undefined;
    try {
        availability = parseModelAvailability(await awaitWithAbort(
            Promise.resolve().then(operation),
            signal,
        ));
    } catch (error) {
        if (isAbortError(error)) throw error;
        // availability 是兼容性提示；未知实现抛错时仍让 create() 给出权威结果。
    }
    if (availability === 'unavailable') {
        throw createNamedError(
            'ChromeModelUnavailableError',
            model === 'language-detector' ? 'Chrome 语言检测模型不可用' : 'Chrome 翻译语言包不可用',
        );
    }
    reportModelStatus(reporter, {
        model,
        phase: availability === 'downloadable' || availability === 'downloading'
            ? 'downloading'
            : 'initializing',
        ...(availability ? {availability} : {}),
    }, signal);
    return availability;
}

function createModelOptions(
    model: ChromeModelKind,
    availability: ChromeModelAvailability | undefined,
    reporter: ChromeModelStatusReporter | undefined,
    signal?: AbortSignal,
): ChromeModelCreateOptions {
    return {
        ...(signal ? {signal} : {}),
        monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
                const loaded = event.loaded;
                if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded < 0 || loaded > 1) return;
                reportModelStatus(reporter, {
                    model,
                    phase: availability === 'available' || loaded >= 1
                        ? 'initializing'
                        : 'downloading',
                    ...(availability ? {availability} : {}),
                    loaded,
                }, signal);
            });
        },
    };
}

function safelyDestroy(resource: {destroy?: () => void}): void {
    try {
        resource.destroy?.();
    } catch {
        // 实验 API 的清理失败不能覆盖已经完成的检测或翻译结果。
    }
}

function createAbortError(): Error {
    const error = new Error('Chrome 翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): error is Error {
    return error instanceof Error && error.name === 'AbortError';
}

const PRESERVED_CHROME_API_ERROR_NAMES = new Set([
    'ChromeModelUnavailableError',
    'InvalidStateError',
    'NetworkError',
    'NotAllowedError',
    'NotSupportedError',
    'OperationError',
    'QuotaExceededError',
    'UnknownError',
]);

function isKnownChromeApiError(error: unknown): boolean {
    return error instanceof Error && PRESERVED_CHROME_API_ERROR_NAMES.has(error.name);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(createAbortError());
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', handleAbort);
            callback();
        };
        const handleAbort = () => finish(() => reject(createAbortError()));
        signal.addEventListener('abort', handleAbort, {once: true});
        void promise.then(
            (value) => finish(() => resolve(value)),
            (error) => finish(() => reject(error)),
        );
    });
}

async function acquireAbortableResource<T extends {destroy?: () => void}>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    try {
        return await awaitWithAbort(promise, signal);
    } catch (error) {
        // create() 本身不可取消；若资源迟到，必须在它可用的第一刻释放。
        if (signal?.aborted) void promise.then(safelyDestroy, () => undefined);
        throw error;
    }
}

function closeStream(iterator: AsyncIterator<unknown>): void {
    try {
        if (typeof iterator.return === 'function') void Promise.resolve(iterator.return()).catch(() => undefined);
    } catch {
        // stream.return() 属于尽力清理，translator.destroy() 仍会在 finally 执行。
    }
}

/** 检测器确认中文后才用字形精化；通用 zh 和共用汉字不能自行推定为简体。 */
function refineDetectedChineseLanguage(language: string, text: string): string {
    if (language.toLowerCase() !== 'zh') return normalizeChineseLanguageCode(language);
    const script = detectChineseScript(text);
    return script ? `zh-${script}` : 'zh';
}

export async function detectChromeLanguage(
    text: string,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    let detector: ChromeLanguageDetector | undefined;
    let detectionError: unknown;
    try {
        throwIfAborted(signal);
        const modernDetector = environment.LanguageDetector;
        if (typeof modernDetector?.create === 'function') {
            const availability = await checkModelAvailability(
                'language-detector',
                typeof modernDetector.availability === 'function'
                    ? () => modernDetector.availability!()
                    : undefined,
                reporter,
                signal,
            );
            throwIfAborted(signal);
            detector = await acquireAbortableResource(
                modernDetector.create(createModelOptions(
                    'language-detector',
                    availability,
                    reporter,
                    signal,
                )),
                signal,
            );
            reportModelStatus(reporter, {
                model: 'language-detector',
                phase: 'ready',
                ...(availability ? {availability} : {}),
                loaded: 1,
            }, signal);
            throwIfAborted(signal);
            const detected = detectedLanguageFrom(await awaitWithAbort(
                detector.detect(text, signal ? {signal} : undefined),
                signal,
            ));
            if (detected) return refineDetectedChineseLanguage(detected, text);
        } else if (typeof environment.translation?.createDetector === 'function') {
            detector = await acquireAbortableResource(environment.translation.createDetector(), signal);
            throwIfAborted(signal);
            const detected = detectedLanguageFrom(
                await awaitWithAbort(detector.detect(text), signal),
                false,
            );
            if (detected) return refineDetectedChineseLanguage(detected, text);
        }
    } catch (error) {
        if (isAbortError(error)) throw error;
        detectionError = error;
    } finally {
        if (detector) safelyDestroy(detector);
    }
    const scriptLanguage = detectLanguageByScript(text);
    if (scriptLanguage) return scriptLanguage;
    if (detectionError instanceof Error && (
        isKnownChromeApiError(detectionError)
        || /model|download|not ready|not available/iu.test(detectionError.message)
    )) throw detectionError;
    throw createNamedError(
        'ChromeLanguageUndeterminedError',
        '无法可靠识别源语言，请增加文本长度或手动选择源语言',
    );
}

async function acquireChromeTranslator(
    environment: ChromeTranslationEnvironment,
    options: ChromeTranslatorOptions,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<{translator: ChromeTranslator; modern: boolean}> {
    const modernTranslator = environment.Translator;
    if (typeof modernTranslator?.create === 'function') {
        const availability = await checkModelAvailability(
            'translator',
            typeof modernTranslator.availability === 'function'
                ? () => modernTranslator.availability!(options)
                : undefined,
            reporter,
            signal,
        );
        throwIfAborted(signal);
        const translator = await acquireAbortableResource(
            modernTranslator.create({
                ...options,
                ...createModelOptions('translator', availability, reporter, signal),
            }),
            signal,
        );
        reportModelStatus(reporter, {
            model: 'translator',
            phase: 'ready',
            ...(availability ? {availability} : {}),
            loaded: 1,
        }, signal);
        return {translator, modern: true};
    }
    if (typeof environment.translation?.createTranslator === 'function') {
        return {
            translator: await acquireAbortableResource(
                environment.translation.createTranslator(options),
                signal,
            ),
            modern: false,
        };
    }
    throw new Error('没有可用的翻译 API');
}

export async function performChromeTranslation(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    throwIfAborted(signal);
    const {translator, modern} = await acquireChromeTranslator(
        environment,
        {sourceLanguage, targetLanguage},
        signal,
        reporter,
    );
    try {
        throwIfAborted(signal);
        if (typeof translator.translateStreaming === 'function') {
            let translated = '';
            const stream = modern && signal
                ? translator.translateStreaming(text, {signal})
                : translator.translateStreaming(text);
            const iterator = stream[Symbol.asyncIterator]();
            let completed = false;
            try {
                while (true) {
                    const next = await awaitWithAbort(Promise.resolve(iterator.next()), signal);
                    if (next.done) {
                        completed = true;
                        break;
                    }
                    const chunk = next.value;
                    if (typeof chunk !== 'string') throw new Error('翻译器返回了无效的流式结果');
                    translated += chunk;
                }
            } finally {
                if (!completed) closeStream(iterator);
            }
            return translated;
        }
        if (typeof translator.translate === 'function') {
            const translated = await awaitWithAbort(
                modern && signal ? translator.translate(text, {signal}) : translator.translate(text),
                signal,
            );
            if (typeof translated !== 'string') throw new Error('翻译器返回了无效结果');
            return translated;
        }
        throw new Error('翻译器不支持翻译方法');
    } finally {
        safelyDestroy(translator);
    }
}

export function friendlyChromeTranslationError(
    error: unknown,
    sourceLanguage: string,
    targetLanguage: string,
): Error {
    if (isAbortError(error)) return error;
    if (isChromePreparationRequiredError(error)) return error;
    const message = error instanceof Error ? error.message : String(error || '未知错误');
    const lowerMessage = message.toLowerCase();
    const errorName = error instanceof Error ? error.name : '';
    if (errorName === 'ChromeLanguageUndeterminedError') {
        return new Error(message);
    }
    if (errorName === 'NotAllowedError') {
        if (sourceLanguage === 'auto') {
            return new Error(
                `Chrome 无法在自动识别源语言时激活本地模型（目标语言 ${targetLanguage}）。`
                + '请在设置中选择网页实际源语言并点击“准备 Chrome 本地翻译”后重试。',
            );
        }
        return createChromePreparationRequiredError(sourceLanguage, targetLanguage, error);
    }
    if (errorName === 'NotSupportedError') {
        return Object.assign(new Error(
            `Chrome 本地翻译当前不可用（${sourceLanguage} -> ${targetLanguage}）。这可能由设备、浏览器策略或模型下载环境导致，请检查 Chrome 更新、网络和管理策略。`,
        ), {name: 'ChromeModelUnavailableError', code: 'model-unavailable'});
    }
    if (errorName === 'QuotaExceededError') {
        return new Error('待翻译文本超过 Chrome Translation API 的单次长度限制，请缩短文本后重试。');
    }
    if (errorName === 'OperationError'
        || errorName === 'UnknownError'
        || errorName === 'NetworkError'
        || errorName === 'InvalidStateError') {
        return new Error('翻译模型未就绪，请稍后重试或检查网络连接。');
    }
    if (errorName === 'ChromeModelUnavailableError'
        || lowerMessage.includes('not available')
        || lowerMessage.includes('not ready')) {
        return Object.assign(new Error('Chrome Translation API 暂时不可用。可能是设备、浏览器策略或模型下载环境问题，请检查 Chrome 更新、网络和管理策略后重试。'), {
            name: 'ChromeModelUnavailableError',
            code: 'model-unavailable',
        });
    }
    if (lowerMessage.includes('language') || lowerMessage.includes('not supported')) {
        return Object.assign(new Error(
            `Chrome 本地翻译当前不可用（${sourceLanguage} -> ${targetLanguage}）。这可能由设备、浏览器策略或模型下载环境导致，请检查 Chrome 更新、网络和管理策略。`,
        ), {name: 'ChromeModelUnavailableError', code: 'model-unavailable'});
    }
    if (lowerMessage.includes('model')) {
        return new Error('翻译模型未就绪，请稍后重试或检查网络连接。');
    }
    return new Error(`翻译失败：${message}`);
}

export async function translateWithChromeApi(
    requestValue: unknown,
    environment: ChromeTranslationEnvironment,
    signal?: AbortSignal,
    reporter?: ChromeModelStatusReporter,
): Promise<string> {
    throwIfAborted(signal);
    const request = parseChromeTranslationRequest(requestValue);
    if (!request.text.trim()) return '';
    if (!isChromeTranslationSupported(environment)) {
        throw new Error('当前浏览器不支持 Chrome Translation API，请确保使用 Google Chrome 浏览器 v138 stable 或更高版本。');
    }

    let sourceLanguage = request.from;
    let targetLanguage = request.to;
    let detectedGenericChinese = false;
    try {
        // 步骤 1：auto 只在源语言有效；检测文本与带哨兵的翻译正文严格分离。
        if (sourceLanguage === 'auto') {
            sourceLanguage = await detectChromeLanguage(
                request.sourceLanguageDetectionText ?? request.text,
                environment,
                signal,
                reporter,
            );
            detectedGenericChinese = sourceLanguage === 'zh';
        }
        sourceLanguage = mapChromeLanguageCode(sourceLanguage);
        targetLanguage = mapChromeLanguageCode(targetLanguage);

        // 步骤 2：同语言直接返回原文，不创建昂贵的语言模型。
        if (!detectedGenericChinese && sourceLanguage === targetLanguage) return request.text;
        return await performChromeTranslation(
            request.text,
            sourceLanguage,
            targetLanguage,
            environment,
            signal,
            reporter,
        );
    } catch (error) {
        throw friendlyChromeTranslationError(error, sourceLanguage, targetLanguage);
    }
}
