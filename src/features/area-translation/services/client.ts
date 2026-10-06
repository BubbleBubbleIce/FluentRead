/**
 * @file src/features/area-translation/services/client.ts
 * 文件职责：封装圈选翻译内容页到扩展后台的两段式消息调用，先获取当前可见标签页截图，再提交选区、语言和标题获得独立原文与译文。
 * 主要内容：定义 AreaTranslationResult，提供 captureVisibleAreaInExtension 与 translateCapturedAreaInExtension，并严格检查截图、OCR 行、服务模型及文本结果协议后生成面向 UI 的错误。
 * 模块边界：客户端只处理 webextension runtime 协议，不直接使用 tabs.captureVisibleTab、Offscreen 或 Canvas；消息实现归 background handlers，拖拽状态与结果展示归 AreaTranslator.vue。
 */
import browser from 'webextension-polyfill';
import type {AreaTranslationResult} from '../protocol';
export type {AreaTranslationResult} from '../protocol';
import type { AreaTranslationSelection } from '@/src/features/area-translation/core';
import {
    sendCancellableImageOperation,
    type ImageExtensionOperationOptions,
} from '@/src/features/image-translation/protocol';

interface AreaTranslationResponse extends Partial<AreaTranslationResult> {
    success: boolean;
    error?: string;
}

export async function captureVisibleAreaInExtension(): Promise<string> {
    const response = await browser.runtime.sendMessage({ type: 'fluentReadAreaCapture' }) as { success?: boolean; image?: string; error?: string } | undefined;
    if (response?.success !== true || typeof response.image !== 'string' || !response.image.startsWith('data:image/')) {
        throw new Error(response?.error || '无法读取当前页面区域');
    }
    return response.image;
}

export async function translateCapturedAreaInExtension(
    image: string,
    selection: AreaTranslationSelection,
    sourceLanguage: string,
    title: string,
    options: ImageExtensionOperationOptions = {},
): Promise<AreaTranslationResult> {
    const response = await sendCancellableImageOperation<AreaTranslationResponse>({
        type: 'fluentReadAreaTranslateCapture',
        image,
        selection,
        sourceLanguage,
        title,
    }, options, '圈选翻译超时', 'fluentReadAreaCancel');

    if (response?.success !== true || typeof response.image !== 'string' || !response.image
        || typeof response.service !== 'string' || !response.service.trim()
        || typeof response.serviceName !== 'string' || !response.serviceName.trim()
        || typeof response.model !== 'string'
        || !Array.isArray(response.lines) || typeof response.sourceText !== 'string'
        || typeof response.translatedText !== 'string' || !response.translatedText.trim()
        || (response.mode !== 'standard' && response.mode !== 'ai')
        || !Array.isArray(response.warnings)
        || !response.warnings.every(value => value === 'standard-quality' || value === 'ai-text-only')
        || (response.correctedText !== undefined && typeof response.correctedText !== 'string')) {
        throw new Error(response?.error || '圈选翻译服务不可用');
    }

    return {service: response.service, serviceName: response.serviceName, model: response.model, image: response.image, lines: response.lines, sourceText: response.sourceText,
        translatedText: response.translatedText, mode: response.mode, warnings: response.warnings,
        ...(response.recognitionMethod === 'vision' || response.recognitionMethod === 'ocr' ? {recognitionMethod: response.recognitionMethod} : {}),
        ...(response.recognitionFallback === 'unsupported' || response.recognitionFallback === 'unknown' ? {recognitionFallback: response.recognitionFallback} : {}),
        ...(response.correctedText !== undefined ? {correctedText: response.correctedText} : {})};
}
