/**
 * @file src/features/selection-translation/services/edgeTtsPolicy.ts
 * 文件职责：提供 Edge TTS 不依赖网络的语言、声音、SSML、文本分段、音频拼接和 token 过期计算策略。
 * 主要内容：定义字符与分段上限、语言到候选 voice 的映射，兼容普通话统计语言码，导出声音选择、XML 转义 SSML 构建、智能断句、ArrayBuffer 拼接及 JWT expiry 解析。
 * 模块边界：该模块保持纯策略，不请求 endpoint、不缓存 token 也不播放音频；edgeTts.ts 消费这些规则完成网络合成，调用方决定超时、路由和用户反馈。
 */
import {
    normalizeSelectionTtsVoiceOrder,
    selectionTtsVoiceLocale,
} from '@/src/core/config/selectionTts';
import {getChineseScript} from '@/src/core/language/chinese';

export const edgeTtsLimits = Object.freeze({
    chunkBytes: 1_800,
    chunks: 8,
    fallbackTokenLifetimeMs: 8 * 60 * 1_000,
});

const VOICE_CANDIDATES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
    'en-US': ['en-US-AvaMultilingualNeural', 'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural'],
    'en-GB': ['en-GB-SoniaNeural', 'en-GB-RyanNeural'],
    'zh-CN': ['zh-CN-XiaoxiaoMultilingualNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'],
    'zh-TW': ['zh-TW-YunJheMultilingualNeural', 'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'],
    'ja-JP': ['ja-JP-MasaruMultilingualNeural', 'ja-JP-NanamiNeural'],
    'ko-KR': ['ko-KR-HyunsuMultilingualNeural', 'ko-KR-SunHiNeural'],
    'fr-FR': ['fr-FR-RemyMultilingualNeural'],
    'de-DE': ['de-DE-FlorianMultilingualNeural'],
    'es-ES': ['es-ES-TristanMultilingualNeural'],
    'it-IT': ['it-IT-AlessioMultilingualNeural'],
    'pt-BR': ['pt-BR-MacerioMultilingualNeural'],
};

export function normalizeEdgeTtsLanguage(language: string): string {
    const normalized = String(language || '').replace(/_/gu, '-').trim();
    if (!normalized || normalized === 'auto' || normalized === 'detect') return 'en-US';
    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';
    // 未确定字形的普通话仍能朗读；这一别名不参与翻译语言检测。
    if (['cmn', 'zho', 'chi'].includes(normalized.toLowerCase())) return 'zh-CN';
    if (normalized.toLowerCase() === 'en') return 'en-US';
    return normalized;
}

/** 用户音色优先，同语言的内置候选随后兜底，并保持稳定顺序与去重。 */
export function edgeTtsVoiceCandidatesForLanguage(
    language: string,
    preferredVoices: unknown = [],
): string[] {
    const normalized = normalizeEdgeTtsLanguage(language);
    const base = normalized.split('-')[0];
    const automatic = (Object.hasOwn(VOICE_CANDIDATES_BY_LANGUAGE, normalized) ? VOICE_CANDIDATES_BY_LANGUAGE[normalized] : undefined)
        || Object.entries(VOICE_CANDIDATES_BY_LANGUAGE)
            .find(([locale]) => locale.startsWith(`${base}-`))?.[1]
        || [];
    const preferred = normalizeSelectionTtsVoiceOrder(preferredVoices)
        .filter((voice) => selectionTtsVoiceLocale(voice) === normalized);
    return [...new Set([...preferred, ...automatic])];
}

function escapeXml(text: string): string {
    return text
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}

export function buildEdgeTtsSsml(
    text: string,
    voice: string,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
): string {
    const locale = voice.split('-').slice(0, 2).join('-') || 'en-US';
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}"><voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="${escapeXml(volume)}">${escapeXml(text.trim())}</prosody></voice></speak>`;
}

/** 按 UTF-8 字节预算切分，优先在句号或空格处断开。 */
export function splitEdgeTtsText(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();
    while (remaining) {
        if (chunks.length >= edgeTtsLimits.chunks) throw new Error('Edge TTS text is too long');
        // 只扫描本段预算内的码点，避免反复编码整段余文和逐字符缩短前缀；
        // 码点长度也保证不会把代理对拆到两个 SSML 请求里。
        let end = 0;
        let bytes = 0;
        for (const point of remaining) {
            const code = point.codePointAt(0)!;
            const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (bytes + size > edgeTtsLimits.chunkBytes) break;
            bytes += size;
            end += point.length;
        }
        if (end < remaining.length) {
            const boundary = Math.max(
                remaining.lastIndexOf(' ', end - 1),
                remaining.lastIndexOf('。', end - 1),
                remaining.lastIndexOf('.', end - 1),
            );
            if (boundary > Math.floor(end * 0.6)) end = boundary + 1;
        }
        chunks.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    return chunks;
}

export function concatEdgeTtsAudio(buffers: readonly ArrayBuffer[]): ArrayBuffer {
    const total = buffers.reduce((size, buffer) => size + buffer.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
        output.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return output.buffer;
}

/** JWT 无法解析或缺少 exp 时使用短生命周期，避免长期复用未知 token。 */
export function edgeTtsTokenExpiry(token: string, now = Date.now()): number {
    const fallback = now + edgeTtsLimits.fallbackTokenLifetimeMs;
    try {
        const payload = token.split('.')[1];
        if (!payload) return fallback;
        const padded = payload
            .replace(/-/gu, '+')
            .replace(/_/gu, '/')
            .padEnd(Math.ceil(payload.length / 4) * 4, '=');
        const decoded = JSON.parse(atob(padded)) as {exp?: unknown};
        const expiresAt = typeof decoded.exp === 'number' ? decoded.exp * 1_000 : NaN;
        return Number.isFinite(expiresAt) ? expiresAt : fallback;
    } catch {
        return fallback;
    }
}
