/**
 * @file src/features/selection-translation/background/selectionTtsSynthesis.ts
 * 文件职责：按照用户选择编排在线 TTS、本地 Kokoro TTS 和最终回退。
 * 主要内容：实现在线优先、本地优先、仅在线、仅本地四种策略，并保留现有 Edge 音色顺序。
 * 模块边界：只决定合成来源，不播放音频；播放和停止仍由 selectionTts handler 与 Offscreen 负责。
 */

import type {SelectionTtsAudio} from './ttsHandler';
import {normalizeLocalTtsMode} from '@/src/core/config/localTts';
import {
    LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE,
    LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE,
    LocalTtsModelNotDownloadedError,
    localTtsErrorCode,
    type LocalTtsAudio,
} from '@/src/features/local-tts/protocol';

export interface SelectionTtsSynthesisDependencies {
    readonly getMode: () => unknown;
    readonly getLocalVoice: () => unknown;
    readonly getOnlineVoices: () => unknown;
    readonly synthesizeOnline: (
        text: string,
        language: string,
        preferredVoices: unknown,
        signal?: AbortSignal,
    ) => Promise<SelectionTtsAudio>;
    readonly synthesizeLocal: (
        text: string,
        language: string,
        voice: string,
        signal?: AbortSignal,
    ) => Promise<LocalTtsAudio>;
}

export interface SelectionTtsSynthesisError extends Error {
    readonly code?: string;
}

/** 模型未下载或语言不支持表示本地来源不可用，而不是一次真正的合成失败。 */
function isLocalTtsUnavailable(error: unknown): boolean {
    const code = localTtsErrorCode(error);
    return code === LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE || code === LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE;
}

function localAudio(audio: LocalTtsAudio): SelectionTtsAudio {
    return {
        audio: audio.audio,
        ...(audio.timings === undefined ? {} : {timings: audio.timings}),
        contentType: audio.contentType,
        voice: audio.voice,
    };
}

/** 模型未下载与语言不支持在各分支中已先行处理，这里只需给出真实失败原因。 */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** 创建可注入的策略合成器，便于单元测试所有来源和回退顺序。 */
export function createSelectionTtsSynthesizer(
    dependencies: SelectionTtsSynthesisDependencies,
) {
    return async function synthesizeSelectionTts(
        text: string,
        language: string,
        _preferredVoices: unknown,
        signal?: AbortSignal,
    ): Promise<SelectionTtsAudio> {
        signal?.throwIfAborted();
        const mode = normalizeLocalTtsMode(dependencies.getMode());
        const online = () => dependencies.synthesizeOnline(text, language, dependencies.getOnlineVoices(), signal);
        const local = async () => localAudio(await dependencies.synthesizeLocal(
            text,
            language,
            String(dependencies.getLocalVoice() || 'auto'),
            signal,
        ));

        if (mode === 'online-only') return online();
        if (mode === 'local-only') return local();

        if (mode === 'local-first') {
            try {
                return await local();
            } catch (localError) {
                signal?.throwIfAborted();
                // 本地错误经 Offscreen 消息重建为普通 Error，只能按错误码识别“不可用”。
                if (isLocalTtsUnavailable(localError)) return online();
                try {
                    return await online();
                } catch (onlineError) {
                    throw new Error(`本地 TTS 和在线 TTS 均失败：${errorText(localError)}；${errorText(onlineError)}`);
                }
            }
        }

        // 默认在线优先。在线失败后才尝试本地，且本地没有模型时不自动下载。
        try {
            return await online();
        } catch (onlineError) {
            signal?.throwIfAborted();
            try {
                return await local();
            } catch (localError) {
                if (localTtsErrorCode(localError) === LOCAL_TTS_MODEL_NOT_DOWNLOADED_CODE) {
                    const error = new LocalTtsModelNotDownloadedError();
                    error.message = `在线 TTS 失败；${error.message}`;
                    throw error;
                }
                if (localTtsErrorCode(localError) === LOCAL_TTS_LANGUAGE_UNSUPPORTED_CODE) throw onlineError;
                throw new Error(`在线 TTS 和本地 TTS 均失败：${errorText(onlineError)}；${errorText(localError)}`);
            }
        }
    };
}
