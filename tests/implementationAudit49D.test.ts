/**
 * @file tests/implementationAudit49D.test.ts
 * 文件职责：通过生产公开入口验证字幕时间戳与校正成本、解码生命周期和播放器宿主样式归属。
 * 模块边界：Worker/Web Audio 使用受控端口；播放器执行真实 DOM 挂载、事件和销毁。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

vi.mock('@wxt-dev/storage', () => ({storage: {getItem: vi.fn(), setItem: vi.fn(), watch: vi.fn(() => () => undefined)}}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {getItem: vi.fn(), setItem: vi.fn(), watch: vi.fn(() => () => undefined)}}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn(), getURL: () => 'icon.png'}}}));

import {parseWhisperChunkTimestamps} from '@/src/features/video-subtitle/offscreen/timestampParser';
import {cancelLocalVideoTranscription, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';
import {createVideoPlayerBinding} from '@/src/features/video-subtitle/content/videoPlayerBinding';
import type {VideoPlayerLocator, VideoPlayerTarget} from '@/src/features/video-subtitle/content/videoPlayerLocator';
import {areVideoAiTranscriptCorrectionVariants, VideoAiTranscriptStabilizer} from '@/src/features/video-subtitle/content/video-ai/streamingTranscript';

const streams = new Set<string>();
const bindings: ReturnType<typeof createVideoPlayerBinding>[] = [];
const cssPorts: object[] = [];
const tick = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
class WorkerPort {
  static instances: WorkerPort[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  message?: {requestId: number; audio: Float32Array; languageSessionKey: string};
  terminated = false;
  constructor() { WorkerPort.instances.push(this); }
  postMessage(message: WorkerPort['message']) { this.message = message; }
  terminate() { this.terminated = true; }
  reply() { this.onmessage?.({data: {requestId: this.message!.requestId, success: true, text: 'decoded', segments: [], model: 'tiny'}} as MessageEvent); }
}
type Decoded = {numberOfChannels: number; sampleRate: number; getChannelData: () => Float32Array};
const decoded = (empty = false): Decoded => ({numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(empty ? [] : [0.2, -0.2])});
function installAudio(result: Promise<Decoded>) {
  const close = vi.fn(async () => undefined);
  class AudioPort {
    state = 'running';
    decodeAudioData = vi.fn(() => result);
    close = close;
  }
  vi.stubGlobal('Worker', WorkerPort);
  vi.stubGlobal('window', {location: {href: 'chrome-extension://audit/offscreen.html'}, setTimeout, clearTimeout, AudioContext: AudioPort});
  return close;
}
function transcribe(streamId: string, audioBase64 = 'AAAAAA==') {
  streams.add(streamId);
  return transcribeLocalVideoAudio({streamId, audioBase64, model: 'tiny'});
}
afterEach(async () => {
  for (const binding of bindings.splice(0)) binding.destroy();
  for (const stream of streams) await cancelLocalVideoTranscription(stream);
  streams.clear();
  vi.restoreAllMocks();
  for (const prototype of cssPorts.splice(0)) Reflect.deleteProperty(prototype, 'getPropertyPriority');
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  WorkerPort.instances = [];
});

describe('Whisper timestamp production parser', () => {
  it('bounds suffix copying for 2048 missing timestamps without changing their spacing', () => {
    const count = 2048;
    const chunks = Array.from({length: count}, (_, i) => ({timestamp: [null, null], text: `cue-${i}`}));
    const slice = Array.prototype.slice;
    let copied = 0;
    const spy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (this: unknown[], start = 0, end?: number) {
      const result = slice.call(this, start, end);
      copied += result.length;
      return result;
    });
    let output: ReturnType<typeof parseWhisperChunkTimestamps>;
    try { output = parseWhisperChunkTimestamps(chunks, 32768); } finally { spy.mockRestore(); }
    expect(output).toHaveLength(count);
    expect(output![0]).toEqual({startMs: 0, endMs: 16, text: 'cue-0'});
    expect(output!.at(-1)).toEqual({startMs: 32752, endMs: 32768, text: 'cue-2047'});
    expect(copied).toBeLessThanOrEqual(count);
  });

  it('uses empty-text known starts as anchors and counts only nonempty remaining text', () => {
    expect(parseWhisperChunkTimestamps([
      {timestamp: [null, null], text: ' first '},
      {timestamp: [0.5, null], text: ''},
      {text: 'second'}, {text: '  '}, {text: 'third'},
    ], 2000)).toEqual([
      {startMs: 0, endMs: 500, text: 'first'},
      {startMs: 500, endMs: 1250, text: 'second'},
      {startMs: 1250, endMs: 2000, text: 'third'},
    ]);
  });

  it('preserves malformed, zero-duration, and backwards endpoint behavior', () => {
    expect(parseWhisperChunkTimestamps([], 1000)).toEqual([]);
    expect(parseWhisperChunkTimestamps([{text: 'word'}], Number.NaN)).toEqual([]);
    expect(parseWhisperChunkTimestamps([{text: 'word'}], -1)).toEqual([]);
    expect(parseWhisperChunkTimestamps([{timestamp: [-1, 0], text: 'word'}, {timestamp: [Infinity, 1], text: 2}], 1000))
      .toEqual([{startMs: 0, endMs: 400, text: 'word'}]);
    expect(parseWhisperChunkTimestamps([{timestamp: [0.9, 0.2], text: 'end'}], 1000))
      .toEqual([{startMs: 900, endMs: 1000, text: 'end'}]);
  });
});

describe('streaming transcript public correction and accumulated input', () => {
  it('avoids whole-row fill and copy for a 128-token correction', () => {
    const left = Array.from({length: 128}, () => 'alpha').join(' ');
    const right = Array.from({length: 128}, (_, i) => i === 127 ? 'beta' : 'alpha').join(' ');
    const fill = vi.spyOn(Uint16Array.prototype, 'fill');
    const set = vi.spyOn(Uint16Array.prototype, 'set');
    let result: boolean;
    let fillCalls = 0;
    let setCalls = 0;
    try {
      result = areVideoAiTranscriptCorrectionVariants(left, right);
      fillCalls = fill.mock.calls.length;
      setCalls = set.mock.calls.length;
    }
    finally { fill.mockRestore(); set.mockRestore(); }
    expect(result!).toBe(true);
    expect(fillCalls).toBe(0);
    expect(setCalls).toBe(0);
  });

  it('preserves the 72 percent boundary across odd, even, and asymmetric row counts', () => {
    for (const [leftCount, rightCount, shared, expected] of [
      [25, 25, 18, true], [25, 25, 17, false],
      [24, 24, 18, true], [24, 24, 17, false],
      [5, 8, 4, true], [5, 8, 3, false],
    ] as const) {
      const left = Array.from({length: leftCount}, () => 'alpha').join(' ');
      const right = Array.from({length: rightCount}, (_, i) => i < shared ? 'alpha' : 'beta').join(' ');
      expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(expected);
      expect(areVideoAiTranscriptCorrectionVariants(right, left)).toBe(expected);
    }
  });

  it('keeps negation, numeric, short-text, and CJK correction rules intact', () => {
    const original = 'We cannot process 17 requests today and tomorrow';
    expect(areVideoAiTranscriptCorrectionVariants(original, 'We cannot process 17 requests tonight and tomorrow')).toBe(true);
    expect(areVideoAiTranscriptCorrectionVariants(original, 'We can process 17 requests today and tomorrow')).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants(original, 'We cannot process 18 requests today and tomorrow')).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants('alpha beta gamma', 'alpha beta gamma')).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants('', 'alpha beta gamma delta')).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants('机器可以处理十七次请求今天', '机器可以处理十七次请求明天')).toBe(true);
    expect(areVideoAiTranscriptCorrectionVariants('机器不可以处理十七次请求今天', '机器可以处理十七次请求今天')).toBe(false);
  });

  it('corrects one accumulated 192-word cue formed from two 96-word windows without truncation', () => {
    const firstText = ['The', ...Array(94).fill('alpha'), 'detail'].join(' ');
    const secondText = ['and', ...Array(94).fill('beta'), 'summary'].join(' ');
    const correctedText = ['This', ...Array(94).fill('alpha'), 'detail', 'and', ...Array(94).fill('beta'), 'ending.'].join(' ');
    const widths: number[] = [];
    const NativeUint16Array = Uint16Array;
    vi.stubGlobal('Uint16Array', new Proxy(NativeUint16Array, {
      construct(target, argumentsList) {
        widths.push(argumentsList[0]);
        return Reflect.construct(target, argumentsList);
      },
    }));
    const stabilizer = new VideoAiTranscriptStabilizer();
    const first = stabilizer.ingest({startMs: 0, durationMs: 1200, availableAtMs: 1200, text: firstText});
    const continuation = stabilizer.ingest({startMs: 1000, durationMs: 1400, availableAtMs: 2400, text: secondText});
    const correction = stabilizer.ingest({startMs: 0, durationMs: 2400, availableAtMs: 2600, text: correctedText});
    expect(first).toHaveLength(1);
    expect(continuation).toHaveLength(1);
    expect(continuation[0].text).toBe(`${firstText} ${secondText}`);
    expect(continuation[0].text.split(' ')).toHaveLength(192);
    expect(correction).toHaveLength(1);
    expect(correction[0]).toMatchObject({cueId: first[0].cueId, text: correctedText, partial: false});
    expect(widths).toEqual([]); // Disjoint continuation vocabulary and the proven correction need no rows.
    expect(stabilizer.flush(3000)).toEqual([]);
    stabilizer.reset();
    expect(stabilizer.ingest({startMs: 0, durationMs: 1200, availableAtMs: 1200, text: firstText})[0].cueId).toBe(first[0].cueId);
  });
});

describe('streaming correction edge lower bound through the public entry', () => {
  it.each(['first', 'last'] as const)('skips DP when only the %s token is corrected', (edge) => {
    const original = Array(128).fill('alpha');
    const corrected = original.map((word, index) => index === (edge === 'first' ? 0 : 127) ? 'beta' : word);
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(original.join(' '), corrected.join(' '))).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each([[9, true, 0], [8, false, 2]] as const)('keeps the 72 percent edge threshold with %i prefix tokens', (prefix, expected, allocations) => {
    const left = [...Array(prefix).fill('start'), ...Array(25 - prefix - 9).fill('left'), ...Array(9).fill('end')].join(' ');
    const right = [...Array(prefix).fill('start'), ...Array(25 - prefix - 9).fill('right'), ...Array(9).fill('end')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(expected);
    expect(allocate).toHaveBeenCalledTimes(allocations);
  });

  it('accepts a proven middle-only correction without DP', () => {
    const left = ['before', ...Array(18).fill('middle'), ...Array(6).fill('left')].join(' ');
    const right = ['after', ...Array(18).fill('middle'), ...Array(6).fill('right')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    const fill = vi.spyOn(Uint16Array.prototype, 'fill');
    const set = vi.spyOn(Uint16Array.prototype, 'set');
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('joins disjoint edge matches for unequal lengths in both directions', () => {
    const left = ['start', 'start', ...Array(4).fill('left'), ...Array(4).fill('end')].join(' ');
    const right = ['start', 'start', ...Array(6).fill('right'), ...Array(4).fill('end')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    // Six edge matches out of the shorter ten tokens are insufficient.
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants(right, left)).toBe(false);
    expect(allocate).toHaveBeenCalledTimes(4);
    allocate.mockClear();
    const shared = 'alpha beta gamma delta epsilon';
    expect(areVideoAiTranscriptCorrectionVariants(shared, `${shared} ${shared}`)).toBe(true);
    expect(areVideoAiTranscriptCorrectionVariants(`${shared} ${shared}`, shared)).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('keeps negation, number, and short-input guards ahead of proven edge matches', () => {
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    const tail = Array(128).fill('shared').join(' ');
    expect(areVideoAiTranscriptCorrectionVariants(`cannot ${tail}`, `can ${tail}`)).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants(`17 ${tail}`, `18 ${tail}`)).toBe(false);
    expect(areVideoAiTranscriptCorrectionVariants('alpha beta gamma', 'alpha beta gamma')).toBe(false);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('accepts a proven 65536-word correction without entering overflow-prone DP', () => {
    const text = Array(65536).fill('alpha').join(' ');
    // Never run the old four-billion-cell DP: reaching allocation is a bounded
    // operation failure, not a measured baseline boolean or a setup failure.
    const allocate = vi.fn(() => { throw new Error('bounded fixture: DP allocation forbidden for 65536-word edge match'); });
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(text, text)).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
  });
});

describe('exact correction fallback row range through the public entry', () => {
  it.each([[18, true], [17, false]] as const)('keeps exact small middle-only fallback with %i matches', (shared, expected) => {
    const left = ['before', ...Array(shared).fill('middle'), ...Array(24 - shared).fill('left')].join(' ');
    const right = ['after', ...Array(shared).fill('middle'), ...Array(24 - shared).fill('right')].join(' ');
    const narrow = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    const wide = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: narrow}));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: wide}));
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(expected);
    expect(narrow).toHaveBeenCalledTimes(expected ? 0 : 2);
    expect(wide).not.toHaveBeenCalled();
  });

  it.each([[65535, false], [65536, true]] as const)('computes the exact high-range fallback with %s shared matches', (shared, expected) => {
    const prefix = Math.floor((91022 - shared - 1) / 2);
    const suffix = 91022 - shared - 1 - prefix;
    const left = [...Array(prefix).fill('prefixleft'), 'alpha', 'beta', ...Array(shared - 2).fill('gamma'), 'alpha', ...Array(suffix).fill('suffixleft')].join(' ');
    const right = [...Array(prefix).fill('prefixright'), 'beta', ...Array(shared - 2).fill('gamma'), 'alpha', 'beta', ...Array(suffix).fill('suffixright')].join(' ');
    const widths: number[] = [];
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct(target, args) {
      // Old-module comparison stops its billions of scalar cells before work;
      // this stop is an operation difference, never an observed old boolean.
      if (args[0] > 4096) throw new Error('bounded scalar row allocation stop');
      return Reflect.construct(target, args);
    }}));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct(target, args) {
      widths.push(args[0]);
      if (args[0] > 64) throw new Error('bounded full-width row allocation stop');
      return Reflect.construct(target, args);
    }}));
    // The unequal shared cores have LCS=shared; greedy chooses only alpha,beta.
    // 65535/91022 is below72%, while65536/91022 is above it.
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(expected);
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(64);
  });
});

describe('exact adaptive LCS through the public correction entry', () => {
  it.each([95, 96, 97, 2047, 2048, 2049])('keeps exact word and block carries for a %i-token ambiguous core', count => {
    const allocate = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: allocate}));
    const padding = Math.floor((count - 1) / 0.72) - count;
    for (const [extra, expected] of [[0, true], [1, false]] as const) {
      const left = ['alpha', 'beta', ...Array(count - 3).fill('gamma'), 'alpha', ...Array(padding + extra).fill('leftpad')].join(' ');
      const right = ['beta', ...Array(count - 3).fill('gamma'), 'alpha', 'beta', ...Array(padding + extra).fill('rightpad')].join(' ');
      expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(expected);
      expect(areVideoAiTranscriptCorrectionVariants(right, left)).toBe(expected);
    }
    expect(allocate).toHaveBeenCalled();
    expect(allocate.mock.calls.every(([, args]) => Number(args[0]) <= 64)).toBe(true);
  });

  it('computes sparse reverse order without dense masks or scalar rows', () => {
    const words = Array.from({length: 1024}, (_, i) => `word${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + Math.floor(i / 676))}`);
    const narrow = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    const masks = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: narrow}));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: masks}));
    expect(areVideoAiTranscriptCorrectionVariants(words.join(' '), words.reverse().join(' '))).toBe(false);
    expect(narrow).not.toHaveBeenCalled();
    expect(masks).not.toHaveBeenCalled();
  });

  it('recovers a long sparse subsequence after an early alpha greedy trap', () => {
    const middle = Array.from({length: 1024}, (_, i) => `word${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + Math.floor(i / 676))}`);
    const narrow = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    const masks = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: narrow}));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: masks}));
    const left = ['alpha', 'beta', ...middle, 'alpha'].join(' ');
    const right = ['beta', ...middle, 'alpha', 'beta'].join(' ');
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(true);
    expect(narrow).not.toHaveBeenCalled();
    expect(masks).not.toHaveBeenCalled();
  });

  it('rejects disjoint OOV vocabulary without allocating any DP representation', () => {
    const narrow = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    const masks = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: narrow}));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: masks}));
    expect(areVideoAiTranscriptCorrectionVariants(Array(512).fill('left').join(' '), Array(512).fill('right').join(' '))).toBe(false);
    expect(narrow).not.toHaveBeenCalled();
    expect(masks).not.toHaveBeenCalled();
  });

  it('preserves repeated-token order instead of matching both reversed runs', () => {
    const allocate = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: allocate}));
    const left = [...Array(96).fill('alpha'), ...Array(96).fill('beta')].join(' ');
    const right = [...Array(96).fill('beta'), ...Array(96).fill('alpha')].join(' ');
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(false);
    expect(allocate).toHaveBeenCalled();
  });

  it.each(['乙', '𠀀'])('computes the same exact correction with CJK codepoint %s', character => {
    const allocate = vi.fn((target: typeof Uint32Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint32Array', new Proxy(Uint32Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(`甲丙${character.repeat(64)}甲`, `丙${character.repeat(64)}甲丙`)).toBe(true);
    expect(allocate).toHaveBeenCalled();
  });
});

describe('greedy common-subsequence acceptance through the public entry', () => {
  it('falls back for an early alpha trap while retaining the valid beta and gamma correction', () => {
    const left = ['alpha', 'beta', ...Array(18).fill('gamma'), 'alpha', ...Array(4).fill('leftpad')].join(' ');
    const right = ['beta', ...Array(18).fill('gamma'), 'alpha', 'beta', ...Array(4).fill('rightpad')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(true);
    expect(allocate).toHaveBeenCalledTimes(2);
  });

  it('never reuses repeated right-side tokens to assert an invalid threshold', () => {
    const left = [...Array(18).fill('alpha'), ...Array(7).fill('leftpad')].join(' ');
    const right = [...Array(7).fill('before'), ...Array(10).fill('alpha'), ...Array(8).fill('rightpad')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(false);
    expect(allocate).toHaveBeenCalledTimes(2);
  });

  it('adds valid middle matches to disjoint known edges at the same 72 percent threshold', () => {
    const left = [...Array(8).fill('start'), 'leftstart', 'bridge', ...Array(6).fill('left'), ...Array(9).fill('end')].join(' ');
    const right = [...Array(8).fill('start'), 'rightstart', 'bridge', ...Array(6).fill('right'), ...Array(9).fill('end')].join(' ');
    const allocate = vi.fn((target: typeof Uint16Array, args: unknown[]) => Reflect.construct(target, args));
    vi.stubGlobal('Uint16Array', new Proxy(Uint16Array, {construct: allocate}));
    expect(areVideoAiTranscriptCorrectionVariants(left, right)).toBe(true);
    expect(allocate).not.toHaveBeenCalled();
  });
});

describe('offscreen decoding lifecycle through public transcription', () => {
  it.each(['resolve', 'reject'] as const)('clears the decode deadline when the decoder settles: %s', async outcome => {
    vi.useFakeTimers();
    installAudio(outcome === 'resolve' ? Promise.resolve(decoded()) : Promise.reject(new Error('fixture-decode')));
    const result = transcribe('settled');
    const rejection = outcome === 'reject' ? expect(result).rejects.toThrow('fixture-decode') : undefined;
    await tick();
    if (outcome === 'resolve') {
      expect(WorkerPort.instances).toHaveLength(1);
      expect(Array.from(WorkerPort.instances[0].message!.audio)).toEqual(Array.from(decoded().getChannelData()));
      WorkerPort.instances[0].reply();
      await expect(result).resolves.toMatchObject({text: 'decoded'});
    } else { await rejection; }
    expect(vi.getTimerCount()).toBe(1); // Only the established idle-disposal timer remains.
  });

  it('retains the bounded timeout, closes the decoder, and never starts a worker after timeout', async () => {
    vi.useFakeTimers();
    const close = installAudio(new Promise(() => undefined));
    const result = transcribe('deadline');
    const rejected = expect(result).rejects.toThrow('音频解码超过 8 秒');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
    expect(WorkerPort.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['foreign-owner', 'complete'] as const)('does not cancel a pending decode for %s', async reason => {
    vi.useFakeTimers();
    let release!: (value: Decoded) => void;
    const close = installAudio(new Promise<Decoded>(resolve => { release = resolve; }));
    const result = transcribe('active-decode');
    await cancelLocalVideoTranscription(reason === 'complete' ? 'active-decode' : 'foreign', reason === 'complete' ? 'complete' : 'cancel');
    expect(close).not.toHaveBeenCalled();
    release(decoded());
    await tick();
    expect(WorkerPort.instances).toHaveLength(1);
    WorkerPort.instances[0].reply();
    await expect(result).resolves.toMatchObject({text: 'decoded'});
  });

  it.each([
    ['replacement', false], ['same-stream', false], ['replacement', true], ['same-stream', true],
  ] as const)('rejects a cancelled late decode while permitting %s restart (empty: %s)', async (restart, empty) => {
    vi.useFakeTimers();
    let release!: (value: Decoded) => void;
    const close = installAudio(new Promise<Decoded>(resolve => { release = resolve; }));
    const first = transcribe('same-stream');
    const outcome = first.then(value => ({value}), error => ({error}));
    await cancelLocalVideoTranscription('same-stream');
    expect(close).toHaveBeenCalledTimes(1);
    streams.add(restart);
    const next = transcribeLocalVideoAudio({streamId: restart, audioPcm16Base64: 'AAAAAA==', model: 'tiny'});
    release(decoded(empty));
    await tick();
    // Settle every externally posted request even on the old implementation before asserting.
    WorkerPort.instances[0]?.reply();
    await tick();
    WorkerPort.instances.at(-1)?.reply();
    await expect(next).resolves.toMatchObject({text: 'decoded'});
    const settled = await outcome;
    expect('error' in settled && settled.error).toBeInstanceOf(Error);
    if ('error' in settled) expect(settled.error.message).toContain('取消');
    expect(WorkerPort.instances[0].message!.languageSessionKey).toBe(restart);
    expect(vi.getTimerCount()).toBe(1);
  });
});

function playerFixture() {
  const {document, window} = parseHTML('<html><body><div id="player"><video></video><div class="ytp-right-controls"><button>settings</button><button class="ytp-fullscreen-button">fullscreen</button></div></div></body></html>');
  const player = document.querySelector<HTMLElement>('#player')!;
  const target: VideoPlayerTarget = {video: player.querySelector('video')!, player, key: 'fixture', fullscreen: false, interacting: false};
  const unsubscribe = vi.fn();
  const locator: VideoPlayerLocator = {getTarget: () => target, sync: () => target, subscribe: () => unsubscribe, destroy: vi.fn()};
  Object.defineProperty(document, 'defaultView', {value: {...window, getComputedStyle: () => ({position: 'static'})}});
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('MutationObserver', class {observe() {} disconnect() {}});
  const mount = () => {
    const button = document.createElement('button');
    const click = vi.fn();
    const binding = createVideoPlayerBinding({document, locator, getState: () => ({enabled: true}), createButton: () => button, onButtonClick: click});
    bindings.push(binding);
    return {binding, button, click};
  };
  return {document, window, player, mount, unsubscribe};
}

function installPriorityPort(style: CSSStyleDeclaration, priority: () => string) {
  const prototype = Object.getPrototypeOf(style);
  cssPorts.push(prototype);
  Object.defineProperty(prototype, 'getPropertyPriority', {configurable: true, value: priority});
}

describe('player style ownership through client DOM binding', () => {
  it('preserves a host position update made after FluentRead mounts', () => {
    const fixture = playerFixture();
    fixture.player.style.position = 'static';
    const {binding, button, click} = fixture.mount();
    button.dispatchEvent(new fixture.window.Event('click', {bubbles: true}));
    expect(click).toHaveBeenCalledTimes(1);
    expect(button.nextElementSibling?.className).toBe('ytp-fullscreen-button');
    fixture.player.style.position = 'absolute';
    binding.destroy();
    binding.destroy();
    expect(fixture.player.style.position).toBe('absolute');
    expect(button.isConnected).toBe(false);
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('restores the original priority through the CSS declaration port', () => {
    const fixture = playerFixture();
    fixture.player.style.position = 'static';
    // linkedom omits this CSSOM method; the controlled port represents an existing !important declaration.
    installPriorityPort(fixture.player.style, vi.fn(() => 'important'));
    const set = vi.spyOn(fixture.player.style, 'setProperty');
    const {binding} = fixture.mount();
    binding.destroy();
    expect(fixture.player.style.position).toBe('static');
    expect(set).toHaveBeenLastCalledWith('position', 'static', 'important');
  });

  it('relinquishes a host declaration with the same value but a changed priority', () => {
    const fixture = playerFixture();
    fixture.player.style.position = 'static';
    const priority = vi.fn(() => '');
    installPriorityPort(fixture.player.style, priority);
    const {binding} = fixture.mount();
    // Host replaces relative!important with relative: browser supplies empty priority.
    fixture.player.style.setProperty('position', 'relative');
    binding.destroy();
    expect(fixture.player.style.position).toBe('relative');
  });

  it('remounts and restores an initially absent position without accumulating controls', () => {
    const fixture = playerFixture();
    for (let i = 0; i < 3; i += 1) {
      const {binding, button} = fixture.mount();
      expect(fixture.player.style.position).toBe('relative');
      expect(button.isConnected).toBe(true);
      binding.destroy();
      expect(fixture.player.style.position).toBe('');
      expect(fixture.player.querySelectorAll('button')).toHaveLength(2);
    }
    expect(fixture.unsubscribe).toHaveBeenCalledTimes(3);
  });
});
