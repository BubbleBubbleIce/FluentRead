/**
 * @file src/features/video-subtitle/offscreen/timestampParser.ts
 * 文件职责：把 Transformers.js Whisper chunks 的相对时间戳规范化为单调字幕片段。
 * 主要内容：填补缺失起止点、限制音频边界、拆分连续未知区间，避免 chunk 全部堆在尾部。
 * 模块边界：这是无浏览器副作用的纯算法，Worker 负责推理和结果传输，content 负责窗口时间轴叠加。
 */
export interface WhisperChunkLike {timestamp?: unknown; text?: unknown}
export interface ParsedWhisperSegment {startMs: number; endMs: number; text: string}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value * 1000) : null;
}

export function parseWhisperChunkTimestamps(chunks: readonly WhisperChunkLike[], audioDurationMs: number): ParsedWhisperSegment[] {
    const duration = Math.max(0, Number.isFinite(audioDurationMs) ? audioDurationMs : 0);
    const raw = chunks.map((chunk) => {
        const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
        return {start: finite(timestamp[0]), end: finite(timestamp[1]), text: typeof chunk.text === 'string' ? chunk.text.trim() : ''};
    });
    // 一次倒序扫描保留原来的后缀语义：空文本也能提供时间锚点，
    // 但只有非空文本参与未知尾部的均分，避免逐 chunk 复制和扫描后缀。
    const nextKnownStarts: (number | null)[] = new Array(raw.length);
    const remainingTextCounts: number[] = new Array(raw.length);
    let nextKnownStart: number | null = null;
    let remainingTextCount = 0;
    for (let index = raw.length - 1; index >= 0; index -= 1) {
        nextKnownStarts[index] = nextKnownStart;
        if (raw[index].text) remainingTextCount += 1;
        remainingTextCounts[index] = remainingTextCount;
        if (raw[index].start !== null) nextKnownStart = raw[index].start;
    }
    const output: ParsedWhisperSegment[] = [];
    let cursor = 0;
    for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index];
        if (!item.text) continue;
        const start = Math.min(duration, Math.max(cursor, item.start ?? cursor));
        let end = item.end === null ? null : Math.min(duration, Math.max(start, item.end));
        if (end === null) {
            const nextStart = nextKnownStarts[index];
            if (nextStart !== null) {
                end = Math.min(duration, Math.max(start, nextStart));
            } else {
                end = Math.min(duration, start + Math.max(1, (duration - start) / remainingTextCounts[index]));
            }
        }
        if (end <= start) {
            end = Math.min(duration, start + Math.min(400, Math.max(1, duration - start)));
        }
        if (end > start) {
            output.push({startMs: start, endMs: end, text: item.text});
            cursor = Math.max(cursor, end);
        }
    }
    return output;
}
