/**
 * @file src/features/input-translation/content/index.ts
 * 文件职责：实现网页输入框翻译 feature 的可注入生命周期，根据配置识别三连触发符、冻结请求所有权、调用后台并把译文安全提交回原控件或富文本编辑器。
 * 主要内容：相同译文保留原文且不重复展示；定义配置、依赖和 feature 契约，提供启用判断、配置键与替换/双语输出顺序写回，原生控件用原生 setter 与 input/change 事件写回，编辑宿主按光标文本度量推进三连序列并经 editableHost.ts 的原生编辑路径保留原文、清理触发符并写回；
 * 创建 closed Shadow tooltip 展示翻译中/成功/失败与恢复原文，并防止元素或配置变化后的迟到提交。
 * 模块边界：本文件拥有内容页事件与临时 UI，不直接调用 provider 或全局 browser API；sendMessage、Shadow UI、站点禁用和 generation 均由 composition root 注入，输入纯算法来自 inputBox.ts，编辑宿主度量与写回来自 editableHost.ts。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import {services as translationServices} from '@/src/core/config/catalog';
import {parseApiKeyRequirementKey} from '@/src/core/config/validation';
import {normalizeUiLanguage, translateLegacyText} from '@/src/core/i18n';
import {normalizeInputBoxTranslationOutputMode, type InputBoxTranslationOutputMode} from '@/src/core/config/inputTranslation';
import {
    canCommitInputBoxTranslation,
    getDeepActiveElement,
    getInputBoxSelection,
    getInputBoxText,
    getInputBoxValueAfterInsertion,
    getInputBoxValueSnapshot,
    isFormControl,
    isInputElement,
    matchesInputBoxTrigger,
    normalizeInputBoxTranslationInterval,
    removeInsertedTriggerSymbols,
    type InputBoxSelection,
    type InputBoxTrigger,
} from './inputBox';
import {
    insertIntoEditableCaretState,
    isSameEditableCaretState,
    readEditableCaretState,
    replaceEditableText,
    type EditableCaretState,
} from './editableHost';

export interface InputTranslationContentConfig {
    on?: boolean;
    uiLanguage?: string;
    service?: string;
    inputBoxTranslationTrigger: string;
    inputBoxTranslationTarget: string;
    inputBoxTranslationOutputMode?: string;
    inputBoxTranslationInterval?: number;
    inputBoxTranslationService?: string;
    inputBoxTranslationModel?: string;
    inputBoxTranslationPrompt?: string;
    inputBoxTranslationSystemPrompt?: string;
    animations?: boolean;
}

export interface InputTranslationContentDependencies {
    context: ContentScriptContext;
    config: InputTranslationContentConfig;
    isSiteDisabled: () => boolean;
    readConfigGeneration: () => number;
    sendMessage: (message: unknown) => Promise<unknown>;
    document: Document;
    createUi: <T extends HTMLElement>(
        context: ContentScriptContext,
        options: {
            name: string;
            position: 'overlay';
            alignment: 'top-left';
            zIndex: number;
            mode: 'closed';
            inheritStyles: false;
            css: string;
            onMount: (container: HTMLElement) => T;
        },
    ) => Promise<ShadowRootContentScriptUi<T>>;
    logger: Pick<Console, 'error'>;
}

export interface InputTranslationContentFeature {
    mount: (signal: AbortSignal) => void;
    invalidate: () => void;
}

function hashConfigValue(value: unknown): string {
    const serialized = JSON.stringify(value)!;
    let hash = 2166136261;
    for (let index = 0; index < serialized.length; index += 1) {
        hash ^= serialized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

/** 仅提取输入翻译实际服务（独立或继承）会读取的连接/模型配置，避免无关网页翻译设置作废请求。 */
function inputBoxTranslationConnectionKey(value: InputTranslationContentConfig): string {
    const source = value as unknown as Record<string, unknown>;
    const service = value.inputBoxTranslationService || value.service || translationServices.freeTranslation;
    const serviceValue = (key: string): unknown => {
        const candidate = source[key];
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            return (candidate as Record<string, unknown>)[service];
        }
        return candidate;
    };
    const customProvider = Array.isArray(source.customOpenAIProviders)
        ? source.customOpenAIProviders.find((item) => (
            item && typeof item === 'object' && (item as {id?: unknown}).id === service
        ))
        : undefined;
    const selectedRequireApiKey = Object.fromEntries(
        Object.entries((source.requireApiKey && typeof source.requireApiKey === 'object')
            ? source.requireApiKey as Record<string, unknown>
            : {}).filter(([key]) => key === service
                || key.startsWith(`${service}:`)
                || parseApiKeyRequirementKey(key)?.[0] === service),
    );
    const selected = {
        service,
        model: serviceValue('model'),
        customModel: serviceValue('customModel'),
        serviceRegion: serviceValue('serviceRegion'),
        modelThinking: serviceValue('modelThinking'),
        requireApiKey: Object.keys(selectedRequireApiKey).length ? selectedRequireApiKey : undefined,
        proxy: serviceValue('proxy'),
        token: serviceValue('token'),
        customHeaders: serviceValue('customHeaders'),
        customBody: serviceValue('customBody'),
        customProvider,
        endpoint: service === translationServices.custom ? source.custom : undefined,
        newApiUrl: service === translationServices.newapi ? source.newApiUrl : undefined,
        azureOpenaiEndpoint: service === translationServices.azureOpenai ? source.azureOpenaiEndpoint : undefined,
        deeplx: service === translationServices.deeplx ? source.deeplx : undefined,
        myMemoryEmail: service === translationServices.myMemory ? source.myMemoryEmail : undefined,
        youdaoCredentials: service === translationServices.youdao
            ? [source.youdaoAppKey, source.youdaoAppSecret]
            : undefined,
        tencentCredentials: [
            translationServices.tencent,
            translationServices.huanYuan,
            translationServices.huanYuanTranslation,
        ].includes(service)
            ? [source.tencentSecretId, source.tencentSecretKey]
            : undefined,
        deeplPlan: service === translationServices.deepL ? source.deeplApiPlan : undefined,
        freeTranslationOrder: service === translationServices.freeTranslation ? source.freeTranslationOrder : undefined,
        minimaxPlan: service === translationServices.minimax ? source.minimaxBillingPlan : undefined,
        minimaxRegion: service === translationServices.minimax ? source.minimaxRegion : undefined,
        mimoPlan: service === translationServices.mimo ? source.mimoBillingPlan : undefined,
        mimoRegion: service === translationServices.mimo ? source.mimoRegion : undefined,
        deepseekApiType: service === translationServices.deepseek ? source.deepseekApiType : undefined,
    };
    const hasSelectedValue = Object.entries(selected).some(([key, item]) => key !== 'service' && item !== undefined);
    return hasSelectedValue ? hashConfigValue(selected) : '';
}

export function inputBoxTranslationConfigKey(value: InputTranslationContentConfig): string {
    const key = [
        value.on,
        value.inputBoxTranslationTrigger,
        value.inputBoxTranslationTarget,
        normalizeInputBoxTranslationOutputMode(value.inputBoxTranslationOutputMode),
        value.inputBoxTranslationInterval ?? 1000,
        value.inputBoxTranslationService || value.service || translationServices.freeTranslation,
        value.inputBoxTranslationModel ?? '',
        value.inputBoxTranslationPrompt ?? '',
        value.inputBoxTranslationSystemPrompt ?? '',
    ];
    const connectionKey = inputBoxTranslationConnectionKey(value);
    if (connectionKey) key.push(connectionKey);
    return JSON.stringify(key);
}

export function isInputBoxTranslationEnabled(
    config: Pick<InputTranslationContentConfig, 'on' | 'inputBoxTranslationTrigger'>,
    isSiteDisabled = false,
): boolean {
    return !isSiteDisabled
        && config.on !== false
        && config.inputBoxTranslationTrigger !== 'disabled';
}

/**
 * 把文本写回输入目标，返回是否已写入。
 * 原生控件同步写入；编辑宿主经 editableHost.ts 的原生编辑路径异步写入，isCurrent 在真正写入前再次校验请求所有权。
 */
export async function setInputBoxText(
    element: HTMLElement,
    text: string,
    isCurrent: () => boolean = () => true,
    outputMode: InputBoxTranslationOutputMode = 'replace',
): Promise<boolean> {
    // 写回本身也是安全边界：异步期间页面可能把普通输入框改成 password 或只读，
    // 直接调用者也不能绕过资格判定。
    if (!isInputElement(element)) return false;

    if (isFormControl(element)) {
        if (!isCurrent()) return false;
        // React/Vue 等受控输入框通过自身 tracker 观察原生 setter；直接赋值可能被宿主回滚。
        const valueSetter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            'value',
        )?.set;
        const value = outputMode === 'append' ? `${element.value}\n${text}`
            : outputMode === 'prepend' ? `${text}\n${element.value}` : text;
        if (outputMode !== 'replace' && element.tagName.toLowerCase() === 'input') return false;
        if (valueSetter) valueSetter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // 富文本编辑器由自身模型渲染 DOM；直接改写 innerText 会被回滚或删除链接、mention 等结构。
    const value = outputMode === 'append' ? `\n${text}` : outputMode === 'prepend' ? `${text}\n` : text;
    const selectionMode = outputMode === 'append' ? 'end' : outputMode === 'prepend' ? 'start' : 'all';
    return await replaceEditableText(element, value, isCurrent, selectionMode) === 'replaced';
}

function getTooltipIcon(type: 'translating' | 'success' | 'error'): string {
    const icons = {
        translating: '•',
        success: '✓',
        error: '!',
    };
    return icons[type];
}

async function translateInputBox(
    sendMessage: (message: unknown) => Promise<unknown>,
    text: string,
    targetLang: string,
): Promise<string> {
    const result = await sendMessage({
        type: 'inputBoxTranslation',
        text,
        targetLang,
    }) as { success?: boolean; translatedText?: string; error?: string } | undefined;

    if (result?.success === true && typeof result.translatedText === 'string' && result.translatedText.trim()) {
        return result.translatedText;
    }
    throw new Error(result?.error || '翻译失败');
}

export function createInputTranslationContentFeature(
    deps: InputTranslationContentDependencies,
): InputTranslationContentFeature {
    const rootDocument = deps.document;
    const createUi = deps.createUi;
    const logger = deps.logger;
    let inputTooltipUi: ShadowRootContentScriptUi<HTMLElement> | null = null;
    let inputTooltipOwnerRequestId: number | null = null;
    let activeInputTranslationRequestId = 0;
    let activeInputTranslationElement: HTMLElement | null = null;
    let activeRequestController: AbortController | null = null;
    let internalWriteElement: HTMLElement | null = null;
    const editGenerations = new WeakMap<HTMLElement, number>();
    const observedInputValues = new WeakMap<HTMLElement, string>();
    const bilingualOutputs = new WeakMap<HTMLElement, string>();

    const isEnabled = () => isInputBoxTranslationEnabled(deps.config, deps.isSiteDisabled());

    const removeExistingTooltip = (ownerRequestId?: number): void => {
        if (ownerRequestId !== undefined && inputTooltipOwnerRequestId !== ownerRequestId) return;

        const ui = inputTooltipUi;
        const existing = ui?.mounted;
        inputTooltipUi = null;
        inputTooltipOwnerRequestId = null;
        if (!ui) return;

        if (!existing || !deps.config.animations) {
            ui.remove();
            return;
        }

        existing.classList.add('hide');
        setTimeout(() => ui.remove(), 300);
    };

    const invalidate = (): void => {
        activeRequestController?.abort();
        activeRequestController = null;
        activeInputTranslationRequestId += 1;
        activeInputTranslationElement?.classList.remove('fluent-input-translating');
        activeInputTranslationElement?.classList.remove('fluent-input-success', 'fluent-input-error');
        activeInputTranslationElement = null;
        removeExistingTooltip();
    };

    const readEditGeneration = (element: HTMLElement): number => editGenerations.get(element) || 0;
    const recordEdit = (element: HTMLElement): void => {
        editGenerations.set(element, readEditGeneration(element) + 1);
    };

    /** 写回期间把宿主事件标记为扩展自身编辑，避免把自己的 input 当作用户编辑而取消请求。 */
    const writeOwnedText = async (
        element: HTMLElement,
        text: string,
        isCurrent: () => boolean,
        outputMode: InputBoxTranslationOutputMode = 'replace',
    ): Promise<boolean> => {
        internalWriteElement = element;
        try {
            return await setInputBoxText(element, text, isCurrent, outputMode);
        } finally {
            internalWriteElement = null;
        }
    };

    const addInputBoxAnimation = (
        element: HTMLElement,
        animationType: 'translating' | 'success' | 'error',
        ownerRequestId: number,
    ): void => {
        if (!deps.config.animations) return;

        element.classList.remove('fluent-input-translating', 'fluent-input-success', 'fluent-input-error');
        element.classList.add(`fluent-input-${animationType}`);

        if (animationType !== 'translating') {
            setTimeout(() => {
                if (ownerRequestId !== activeInputTranslationRequestId) return;
                element.classList.remove(`fluent-input-${animationType}`);
            }, animationType === 'success' ? 1000 : 600);
        }
    };

    const createTranslationTooltip = async (
        element: HTMLElement,
        message: string,
        type: 'translating' | 'success' | 'error',
        requestId: number,
        signal: AbortSignal,
        restore?: {label: string; onRestore: () => Promise<void>},
    ): Promise<HTMLElement | null> => {
        removeExistingTooltip();
        inputTooltipOwnerRequestId = requestId;
        const rect = element.getBoundingClientRect();

        const ui = await createUi<HTMLElement>(deps.context, {
            name: 'fluent-read-input-tooltip-ui',
            position: 'overlay',
            alignment: 'top-left',
            zIndex: 2_147_483_647,
            mode: 'closed',
            inheritStyles: false,
            css: `
                :host {
                    all: initial !important;
                    display: block !important;
                    position: relative !important;
                    width: 0 !important;
                    height: 0 !important;
                    overflow: visible !important;
                }
                html, body {
                    width: 0 !important;
                    height: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow: visible !important;
                }
                .fluent-input-tooltip {
                    position: fixed;
                    opacity: 0;
                    transform: translateX(-50%) translateY(3px);
                    box-sizing: border-box;
                    background: rgba(17, 24, 39, 0.88);
                    color: #fff;
                    padding: 8px 12px;
                    border: 0;
                    border-radius: 8px;
                    font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    white-space: normal;
                    max-width: min(360px, calc(100vw - 24px));
                    z-index: 2147483647;
                    pointer-events: ${restore ? 'auto' : 'none'};
                    transition: opacity 0.2s ease, transform 0.2s ease;
                    backdrop-filter: blur(8px);
                    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.2);
                }
                .fluent-input-tooltip.show { opacity: 1; transform: translateX(-50%) translateY(0); }
                .fluent-input-tooltip.hide { opacity: 0; transform: translateX(-50%) translateY(-5px); }
                .fluent-input-tooltip.translating { background: rgba(59, 130, 246, 0.9); }
                .fluent-input-tooltip.success { background: rgba(34, 197, 94, 0.9); }
                .fluent-input-tooltip.error { background: rgba(239, 68, 68, 0.9); }
            `,
            onMount(container) {
                const tooltip = rootDocument.createElement('div');
                tooltip.className = `fluent-input-tooltip ${type}`;
                tooltip.id = 'fluent-input-translation-tooltip';
                tooltip.textContent = `${getTooltipIcon(type)} ${translateLegacyText(
                    message,
                    normalizeUiLanguage(deps.config.uiLanguage),
                )}`;
                const viewportWidth = rootDocument.defaultView?.innerWidth || 1024;
                const viewportHeight = rootDocument.defaultView?.innerHeight || 768;
                const center = Math.max(12, Math.min(viewportWidth - 12, rect.left + (rect.width / 2)));
                const below = rect.bottom + 12;
                const top = below + 56 <= viewportHeight
                    ? below
                    : Math.max(12, (rect.top || 0) - 56);
                tooltip.style.top = `${top}px`;
                tooltip.style.left = `${center}px`;
                tooltip.style.transform = 'translateX(-50%) translateY(3px)';
                tooltip.style.opacity = deps.config.animations ? '0' : '1';
                container.appendChild(tooltip);
                if (restore) {
                    const restoreButton = rootDocument.createElement('button');
                    restoreButton.type = 'button';
                    restoreButton.textContent = translateLegacyText(
                        restore.label,
                        normalizeUiLanguage(deps.config.uiLanguage),
                    );
                    restoreButton.style.cssText = 'margin-left:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;';
                    restoreButton.addEventListener?.('click', (event: Event) => {
                        if (!(event as Event & {isTrusted?: boolean}).isTrusted) return;
                        event.preventDefault();
                        event.stopPropagation();
                        void restore.onRestore();
                    });
                    tooltip.appendChild(restoreButton);
                }
                return tooltip;
            },
        });

        if (
            signal.aborted
            || requestId !== activeInputTranslationRequestId
            || inputTooltipOwnerRequestId !== requestId
            || !isEnabled()
        ) {
            ui.remove();
            return null;
        }

        inputTooltipUi = ui;
        ui.shadowHost.id = 'fluent-input-translation-tooltip-host';
        ui.shadowHost.setAttribute('data-fluent-read-ui', 'input-tooltip');
        ui.mount();

        const tooltip = ui.mounted!;
        if (!deps.config.animations) {
            tooltip.style.opacity = '1';
            tooltip.style.transform = 'translateX(-50%) translateY(0)';
        } else {
            // 动画由 show/hide 类控制，清除初始行内值，避免行内 opacity:0 永久压住成功提示。
            tooltip.style.opacity = '';
            tooltip.style.transform = '';
            setTimeout(() => tooltip.classList.add('show'), 10);
        }

        return tooltip;
    };

    const handleInputBoxTranslation = async (
        element: HTMLElement,
        signal: AbortSignal,
        sourceTextOverride?: string,
    ): Promise<void> => {
        const originalText = sourceTextOverride ?? getInputBoxText(element);
        const outputMode = normalizeInputBoxTranslationOutputMode(deps.config.inputBoxTranslationOutputMode);
        const bilingual = outputMode !== 'replace';
        if (bilingual && bilingualOutputs.get(element) === originalText) return;
        invalidate();
        const requestId = activeInputTranslationRequestId;
        const requestController = new AbortController();
        activeRequestController = requestController;
        const requestSignal = requestController.signal;
        activeInputTranslationElement = element;
        const configGeneration = deps.readConfigGeneration();
        const inputSnapshot = getInputBoxValueSnapshot(element);
        const editGeneration = readEditGeneration(element);
        observedInputValues.set(element, inputSnapshot);
        const targetLanguage = deps.config.inputBoxTranslationTarget;

        const isCurrentAndUnchanged = () => requestId === activeInputTranslationRequestId
            && isInputElement(element)
            && element.isConnected !== false
            && canCommitInputBoxTranslation({
                signal: {aborted: signal.aborted || requestSignal.aborted} as AbortSignal,
                expectedValue: inputSnapshot,
                currentValue: getInputBoxValueSnapshot(element),
                expectedConfigGeneration: configGeneration,
                currentConfigGeneration: deps.readConfigGeneration(),
                isEnabled: isEnabled(),
                isSiteDisabled: deps.isSiteDisabled(),
                expectedEditGeneration: editGeneration,
                currentEditGeneration: readEditGeneration(element),
            });
        const clearOwnedVisuals = () => {
            if (requestId !== activeInputTranslationRequestId) return;
            element.classList.remove('fluent-input-translating');
            if (activeInputTranslationElement === element) activeInputTranslationElement = null;
            removeExistingTooltip(requestId);
        };
        const handleAbort = () => clearOwnedVisuals();
        signal.addEventListener('abort', handleAbort, { once: true });
        requestSignal.addEventListener('abort', handleAbort, { once: true });

        try {
            // 步骤 1：固定输入快照和配置 generation；任何用户编辑、关闭或站点禁用都会阻止写回。
            if (!isCurrentAndUnchanged() || !originalText) return;
            if (!originalText.trim()) return;
            if (bilingual && element.tagName.toLowerCase() === 'input') {
                await createTranslationTooltip(element, '双语追加需要支持换行的输入框', 'error', requestId, requestSignal);
                setTimeout(() => removeExistingTooltip(requestId), 8000);
                return;
            }

            // 步骤 2：只让当前请求拥有输入框动画和 tooltip，旧请求不能清理新提示。
            removeExistingTooltip();
            addInputBoxAnimation(element, 'translating', requestId);
            const loadingTooltip = await createTranslationTooltip(
                element,
                '翻译中',
                'translating',
                requestId,
                requestSignal,
            );
            if (!loadingTooltip || !isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }

            try {
                // 步骤 3：background 消息不能中断，结果落地前再次校验快照和 feature signal。
                const translatedText = await translateInputBox(deps.sendMessage, originalText, targetLanguage);
                if (!isCurrentAndUnchanged()) {
                    clearOwnedVisuals();
                    return;
                }

                if (hasDistinctTranslation(originalText, translatedText)) {
                    // 步骤 4：编辑宿主写回需要等待编辑器同步选区，期间继续由当前请求持有提示和动画。
                    // 原生控件一次写入原文和译文；富文本只在首尾插入，保留原文 DOM 与格式。
                    const output = isFormControl(element) && bilingual
                        ? outputMode === 'prepend' ? `${translatedText}\n${originalText}` : `${originalText}\n${translatedText}`
                        : translatedText;
                    const written = await writeOwnedText(element, output, isCurrentAndUnchanged, isFormControl(element) ? 'replace' : outputMode);
                    if (!written && !isCurrentAndUnchanged()) {
                        clearOwnedVisuals();
                        return;
                    }
                    element.classList.remove('fluent-input-translating');
                    removeExistingTooltip(requestId);
                    if (!written) {
                        addInputBoxAnimation(element, 'error', requestId);
                        await createTranslationTooltip(element, '无法把译文写入当前编辑器', 'error', requestId, requestSignal);
                        setTimeout(() => removeExistingTooltip(requestId), 8000);
                        return;
                    }
                    const translatedSnapshot = getInputBoxValueSnapshot(element);
                    if (bilingual) bilingualOutputs.set(element, getInputBoxText(element));
                    observedInputValues.set(element, translatedSnapshot);
                    const translatedEditGeneration = readEditGeneration(element);
                    const canRestore = () => !signal.aborted
                        && !requestSignal.aborted
                        && requestId === activeInputTranslationRequestId
                        && isInputElement(element)
                        && element.isConnected !== false
                        && deps.readConfigGeneration() === configGeneration
                        && readEditGeneration(element) === translatedEditGeneration
                        && getInputBoxValueSnapshot(element) === translatedSnapshot
                        && isEnabled()
                        && !deps.isSiteDisabled();
                    addInputBoxAnimation(element, 'success', requestId);
                    await createTranslationTooltip(element, '翻译成功', 'success', requestId, requestSignal, {
                        label: '恢复原文',
                        onRestore: async () => {
                            if (!canRestore()) return;
                            if (!await writeOwnedText(element, originalText, canRestore)) return;
                            bilingualOutputs.delete(element);
                            observedInputValues.set(element, getInputBoxValueSnapshot(element));
                            removeExistingTooltip(requestId);
                        },
                    });
                } else {
                    element.classList.remove('fluent-input-translating');
                    removeExistingTooltip(requestId);
                    addInputBoxAnimation(element, 'error', requestId);
                    await createTranslationTooltip(element, '内容无需翻译', 'error', requestId, requestSignal);
                }
            } catch (translationError) {
                if (!isCurrentAndUnchanged()) {
                    clearOwnedVisuals();
                    return;
                }
                element.classList.remove('fluent-input-translating');
                addInputBoxAnimation(element, 'error', requestId);
                removeExistingTooltip(requestId);
                await createTranslationTooltip(element, '翻译失败', 'error', requestId, requestSignal);
                logger.error('输入框翻译失败:', translationError);
            }

            setTimeout(() => removeExistingTooltip(requestId), 8000);
        } catch (error) {
            if (!isCurrentAndUnchanged()) {
                clearOwnedVisuals();
                return;
            }
            logger.error('输入框翻译失败:', error);
            element.classList.remove('fluent-input-translating');
            addInputBoxAnimation(element, 'error', requestId);
            removeExistingTooltip(requestId);
            await createTranslationTooltip(element, '翻译服务暂时不可用', 'error', requestId, requestSignal);
            setTimeout(() => removeExistingTooltip(requestId), 8000);
        } finally {
            signal.removeEventListener('abort', handleAbort);
            requestSignal.removeEventListener('abort', handleAbort);
            if (activeRequestController === requestController) activeRequestController = null;
        }
    };

    const mount = (signal: AbortSignal): void => {
        let keyPressCount = 0;
        let keyPressTimer: ReturnType<typeof setTimeout> | null = null;
        // 原生控件按 value/选区区间校验连续插入；编辑宿主的块级 DOM 无法映射为 value 区间，
        // 改用 textContent 口径的文本与折叠光标偏移校验，并在第一次插入前冻结可见原文。
        type TriggerSequence = {
            element: HTMLElement;
            trigger: InputBoxTrigger;
        } & ({
            kind: 'control';
            insertedStart: number;
            expectedValue: string;
            expectedSelection: InputBoxSelection;
        } | {
            kind: 'editable';
            sourceText: string;
            expectedCaret: EditableCaretState;
        });
        let triggerSequence: TriggerSequence | null = null;

        const resetKeyPresses = () => {
            keyPressCount = 0;
            triggerSequence = null;
            if (keyPressTimer) {
                clearTimeout(keyPressTimer);
                keyPressTimer = null;
            }
        };

        const activeEventElement = (event: Event): HTMLElement | null => {
            const composedPath = event.composedPath?.();
            const pathInput = composedPath?.find((item): item is HTMLElement =>
                typeof (item as Element)?.tagName === 'string' && isInputElement(item as Element));
            if (pathInput) return pathInput;
            const target = event.target;
            if (target && typeof (target as Element).tagName === 'string' && isInputElement(target as Element)) {
                return target as HTMLElement;
            }
            const active = getDeepActiveElement(rootDocument);
            return isInputElement(active) ? active : null;
        };

        const selectionMatches = (element: HTMLElement, expected: InputBoxSelection): boolean => {
            const current = getInputBoxSelection(element);
            return current !== null
                && current.start === expected.start
                && current.end === expected.end;
        };

        const sequenceStillMatches = (sequence: TriggerSequence): boolean => (sequence.kind === 'control'
            ? getInputBoxValueSnapshot(sequence.element) === sequence.expectedValue
                && selectionMatches(sequence.element, sequence.expectedSelection)
            : isSameEditableCaretState(readEditableCaretState(sequence.element), sequence.expectedCaret));

        const handleMutation = (event: Event) => {
            const element = activeEventElement(event);
            if (!element || !isInputElement(element)) return;
            const currentValue = getInputBoxValueSnapshot(element);
            const valueChanged = observedInputValues.get(element) !== currentValue;
            if (valueChanged) {
                recordEdit(element);
                observedInputValues.set(element, currentValue);
            }
            if (valueChanged
                && internalWriteElement !== element
                && activeInputTranslationElement === element
                && activeRequestController) {
                invalidate();
            }
            if (!triggerSequence || triggerSequence.element !== element) return;
            if (!sequenceStillMatches(triggerSequence)) resetKeyPresses();
        };

        const handleSelectionChange = () => {
            if (triggerSequence && !sequenceStillMatches(triggerSequence)) resetKeyPresses();
        };

        const handleCompositionStart = (event: Event) => {
            const activeRequestElement = activeInputTranslationElement;
            resetKeyPresses();
            handleMutation(event);
            if (activeRequestElement
                && internalWriteElement !== activeRequestElement
                && activeRequestController) invalidate();
        };

        /** 推进原生控件的三连序列，返回清理本次插入符号后的原文；选区不可用时返回 null。 */
        const advanceControlSequence = (
            element: HTMLInputElement | HTMLTextAreaElement,
            trigger: InputBoxTrigger,
            symbol: string,
        ): string | null => {
            const currentValue = getInputBoxValueSnapshot(element);
            const currentSelection = getInputBoxSelection(element);
            if (!currentSelection) return null;
            const afterInsertion = getInputBoxValueAfterInsertion(currentValue, currentSelection, symbol);
            if (triggerSequence?.kind === 'control'
                && triggerSequence.element === element
                && triggerSequence.trigger === trigger
                && sequenceStillMatches(triggerSequence)) {
                keyPressCount += 1;
                triggerSequence.expectedValue = afterInsertion.value;
                triggerSequence.expectedSelection = afterInsertion.selection;
                return removeInsertedTriggerSymbols(currentValue, trigger, triggerSequence.insertedStart, 2);
            }
            keyPressCount = 1;
            triggerSequence = {
                kind: 'control',
                element,
                trigger,
                insertedStart: currentSelection.start,
                expectedValue: afterInsertion.value,
                expectedSelection: afterInsertion.selection,
            };
            return currentValue;
        };

        /** 推进编辑宿主的三连序列，返回第一次插入前冻结的可见原文；光标不可用时返回 null。 */
        const advanceEditableSequence = (
            element: HTMLElement,
            trigger: InputBoxTrigger,
            symbol: string,
        ): string | null => {
            const caret = readEditableCaretState(element);
            if (!caret) return null;
            const expectedCaret = insertIntoEditableCaretState(caret, symbol);
            if (triggerSequence?.kind === 'editable'
                && triggerSequence.element === element
                && triggerSequence.trigger === trigger
                && isSameEditableCaretState(caret, triggerSequence.expectedCaret)) {
                keyPressCount += 1;
                triggerSequence.expectedCaret = expectedCaret;
                return triggerSequence.sourceText;
            }
            keyPressCount = 1;
            // 块级换行只能从渲染后的可见文本读取，而插入后的触发符无法精确映射回 innerText，
            // 因此在第一次插入前冻结原文。
            const sourceText = getInputBoxText(element);
            triggerSequence = {kind: 'editable', element, trigger, sourceText, expectedCaret};
            return sourceText;
        };

        const handleKeyDown = async (event: KeyboardEvent) => {
            if (!event.isTrusted) return;
            if (deps.isSiteDisabled()) return;
            if (!isEnabled()) {
                resetKeyPresses();
                return;
            }
            if (event.key === 'Escape') {
                if (activeRequestController) {
                    event.preventDefault();
                    event.stopPropagation();
                    invalidate();
                }
                resetKeyPresses();
                return;
            }
            // IME 的选词/确认和长按属于宿主编辑会话；不能吞键或把此前的三连计数
            // 带到组合输入结束后。229 兼容部分浏览器的首尾组合事件。
            if (event.isComposing || event.keyCode === 229 || event.repeat
                || event.altKey || event.metaKey || event.shiftKey) {
                resetKeyPresses();
                return;
            }

            const activeElement = getDeepActiveElement(rootDocument);
            if (!isInputElement(activeElement)) {
                resetKeyPresses();
                return;
            }

            const triggerType = deps.config.inputBoxTranslationTrigger;
            // 步骤 1：保留 Ctrl+Enter 兼容触发；三连击把 Ctrl 视为中断修饰键。
            // 已消费的触发键不再传给页面，避免聊天和评论编辑器把 Ctrl+Enter 当作发送。
            if (triggerType === 'ctrl_enter') {
                if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    await handleInputBoxTranslation(activeElement, signal);
                }
                return;
            }

            if (triggerType === 'triple_space' || triggerType === 'triple_equal' || triggerType === 'triple_dash') {
                if (event.ctrlKey || !matchesInputBoxTrigger(event, triggerType as InputBoxTrigger)) {
                    resetKeyPresses();
                    return;
                }

                const trigger = triggerType as InputBoxTrigger;
                const symbol = trigger === 'triple_space' ? ' ' : trigger === 'triple_equal' ? '=' : '-';
                // 步骤 2：按控件类型推进连续序列；无法可靠读取选区或光标时保留宿主输入。
                const sourceText = isFormControl(activeElement)
                    ? advanceControlSequence(activeElement, trigger, symbol)
                    : advanceEditableSequence(activeElement, trigger, symbol);
                if (sourceText === null) {
                    resetKeyPresses();
                    return;
                }

                // 步骤 3：第三次按键先阻止触发符号继续进入页面，再启动异步翻译。
                if (keyPressCount === 3) {
                    event.preventDefault();
                    event.stopPropagation();
                    resetKeyPresses();
                    if (normalizeInputBoxTranslationOutputMode(deps.config.inputBoxTranslationOutputMode) !== 'replace') {
                        invalidate();
                        if (isFormControl(activeElement)) {
                            await writeOwnedText(activeElement, sourceText, () => true);
                            await handleInputBoxTranslation(activeElement, signal, sourceText);
                            return;
                        }
                        const snapshot = getInputBoxValueSnapshot(activeElement);
                        const generation = deps.readConfigGeneration();
                        const cleanupRequestId = activeInputTranslationRequestId;
                        const editGeneration = readEditGeneration(activeElement);
                        const cleanupController = new AbortController();
                        activeRequestController = cleanupController;
                        activeInputTranslationElement = activeElement;
                        internalWriteElement = activeElement;
                        try {
                            const cleaned = await replaceEditableText(activeElement, '', () => !signal.aborted && !cleanupController.signal.aborted
                                && cleanupRequestId === activeInputTranslationRequestId
                                && isEnabled() && !deps.isSiteDisabled() && isInputElement(activeElement) && activeElement.isConnected !== false
                                && readEditGeneration(activeElement) === editGeneration
                                && deps.readConfigGeneration() === generation
                                && getInputBoxValueSnapshot(activeElement) === snapshot, 'trigger', symbol);
                            if (cleaned !== 'replaced') return;
                        } finally {
                            internalWriteElement = null;
                            if (activeRequestController === cleanupController) activeRequestController = null;
                        }
                    }
                    await handleInputBoxTranslation(activeElement, signal, sourceText);
                    return;
                }

                if (keyPressTimer) clearTimeout(keyPressTimer);
                keyPressTimer = setTimeout(
                    resetKeyPresses,
                    normalizeInputBoxTranslationInterval(deps.config.inputBoxTranslationInterval),
                );
            }
        };

        rootDocument.addEventListener('keydown', handleKeyDown, { capture: true, signal });
        rootDocument.addEventListener('input', handleMutation, { capture: true, signal });
        rootDocument.addEventListener('change', handleMutation, { capture: true, signal });
        rootDocument.addEventListener('compositionstart', handleCompositionStart, { capture: true, signal });
        rootDocument.addEventListener('compositionend', resetKeyPresses, { capture: true, signal });
        rootDocument.addEventListener('focusin', resetKeyPresses, { capture: true, signal });
        rootDocument.addEventListener('focusout', resetKeyPresses, { capture: true, signal });
        rootDocument.addEventListener('selectionchange', handleSelectionChange, { capture: true, signal });
        signal.addEventListener('abort', () => {
            resetKeyPresses();
            invalidate();
        }, { once: true });
    };

    return { mount, invalidate };
}
