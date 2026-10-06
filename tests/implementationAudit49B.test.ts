import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Real Vue runtime-dom and client templates; only browser, config and rendering environment ports are controlled.
const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value: (window as any)[name]});
    }
    const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {configurable: true, value: (fn: FrameRequestCallback) => {frames.set(++nextFrame, fn); return nextFrame;}});
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {configurable: true, value: (id: number) => frames.delete(id)});
    Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: class {observe() {} unobserve() {} disconnect() {}}});
    Object.defineProperty(globalThis, 'matchMedia', {configurable: true, value: () => ({matches: false})});
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {platform: 'Mac', clipboard: {writeText: async () => undefined}}});
    return {document, frames};
});
const external = vi.hoisted(() => ({
    ports: [] as any[], config: {} as any, subscribers: new Set<(value: any) => void>(),
    connect: vi.fn(), sendMessage: vi.fn(), onConnect: new Set<(port: any) => void>(),
    removed: new Set<Function>(), updated: new Set<Function>(), alarms: new Set<Function>(),
    requests: [] as Array<{url: string; headers: Headers; body: any; signal: AbortSignal; settle: () => void; complete: () => void}>,
}));
vi.mock('webextension-polyfill', () => ({default: {extension: {inIncognitoContext: false}, runtime: {
    id: 'fixture', onConnect: {addListener: (fn: (port: any) => void) => external.onConnect.add(fn)},
    connect: external.connect, sendMessage: external.sendMessage, getURL: (path: string) => `chrome-extension://fixture/${path}`,
}, tabs: {onRemoved: {addListener: (fn: Function) => external.removed.add(fn)}, onUpdated: {addListener: (fn: Function) => external.updated.add(fn)}},
alarms: {create: async () => undefined, onAlarm: {addListener: (fn: Function) => external.alarms.add(fn)}}}}));
vi.mock('@/src/services/config/store', () => ({
    config: external.config, configReady: Promise.resolve(),
    subscribeConfig: (listener: (value: any) => void) => {external.subscribers.add(listener); return () => external.subscribers.delete(listener);},
    requestConfigPatch: async (patch: any) => {Object.assign(external.config, patch); external.subscribers.forEach(listener => listener({...external.config}));},
}));
vi.mock('@/src/ui/i18n', async () => {
    const {ref} = await import('vue');
    return {useUiI18n: () => ({t: (key: string) => key, translateLegacy: (value: string) => value, language: ref('zh-CN'), bundleRevision: ref(0)})};
});
vi.mock('element-plus', () => ({ElMessageBox: {confirm: async () => undefined}}));
vi.mock('element-plus/es/components/message-box/style/css', () => ({}));
vi.mock('@/src/platform/storage/harnessSessionRepository', () => ({harnessSessionRepository: {
    recoverInterrupted: async () => undefined, prune: async () => 0, captureGeneration: (sessionId: string) => ({epoch: 0, generation: 0, sessionId}),
    upsertTurn: async () => true, get: async () => null, list: async () => ({sessions: [], hasMore: false}), delete: async () => undefined, clear: async () => undefined,
}}));
vi.mock('@/src/platform/storage/learningMemoryRepository', () => ({learningMemoryRepository: {list: async () => []}}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({modelUsageRepository: {captureGeneration: () => 0, recordMany: async () => undefined}}));

import {createApp, h, nextTick, reactive, type App, type Component} from 'vue';
import {Config} from '@/src/core/config/model';
import {DEFAULT_HARNESS_PREFERENCES} from '@/src/core/config/harness';
import {runHarnessLoop, type HarnessGenerateInput} from '@/src/core/harness/loop';
import {rankRecords, explainRecord, type MemoryRecord} from '@/src/core/harness/memorySearch';
import {readMemory} from '@/src/services/harness/memoryRecall';
import {createHarnessConversationRuntime} from '@/src/services/harness/conversation';
import {streamReading} from '@/src/features/reading-assistant/client';
import {streamWriting} from '@/src/features/writing-assistant/client';
import {createWritingHandler} from '@/src/features/writing-assistant/background';
import type {ReadingRequest, ReadingProgress} from '@/src/features/reading-assistant/types';
import type {WritingRequest} from '@/src/features/writing-assistant/types';
import type {HarnessSessionStore} from '@/src/services/harness/sessionTypes';
import ReadingPanel from '@/src/features/reading-assistant/ui/ReadingPanel.vue';
import ReadingAnswer from '@/src/features/reading-assistant/ui/ReadingAnswer.vue';
import WritingPanel from '@/src/features/writing-assistant/ui/WritingPanel.vue';
import {installHarnessBackgroundRuntime} from '@/src/app/background/harnessRuntime';
import {installWritingBackgroundRuntime} from '@/src/app/background/writingRuntime';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

function event<T extends (...args: any[]) => void>() {
    const listeners = new Set<T>();
    return {addListener: (fn: T) => listeners.add(fn), removeListener: (fn: T) => listeners.delete(fn), fire: (...args: Parameters<T>) => [...listeners].forEach(fn => fn(...args)), listeners};
}
function makePort(name = 'fluentReadHarnessStream', sender?: any) {
    const onMessage = event<(value: any) => void>(), onDisconnect = event<() => void>();
    return {name, sender, onMessage, onDisconnect, postMessage: vi.fn(), disconnect: vi.fn(() => onDisconnect.fire())};
}
const apps = new Set<App>();
function mount(component: Component, values: any) {
    const props = reactive(values); const host = dom.document.createElement('div'); dom.document.body.append(host);
    const app = createApp({render: () => h(component, props)}); app.config.warnHandler = () => undefined; app.mount(host); apps.add(app);
    return {host, props, app};
}
async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick();}
function button(host: Element, label: string) {
    const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
    if (!result) throw new Error(`Missing actual client button: ${label}`);
    return result;
}
function readingRequest(requestId = 'reading-fixture'): ReadingRequest {
    return {type: 'fluentReadHarness', action: 'run', requestId, intent: 'meaning', selection: {text: 'First source.', context: '', sentence: 'First source.'}, question: ''};
}
const writingRequest: WritingRequest = {type: 'fluentReadWriting', action: 'run', requestId: 'writing-fixture', intent: 'draft', draft: '', context: '', instruction: 'Write a reply', language: 'en', tone: 'natural', history: []};
const result = {success: true as const, text: 'Finished', service: 'deepseek', model: 'fixture-model'};
const generated = {assistant: {role: 'assistant' as const, content: [{type: 'text', text: 'Finished'}]}, text: 'Finished', toolCalls: []};

beforeEach(() => {
    Object.assign(external.config, new Config(), {on: true});
    external.config.service = 'deepseek'; external.config.writing = {...external.config.writing, enabled: true, referenceLanguage: 'off'};
    external.ports = []; external.sendMessage.mockReset().mockResolvedValue({success: true});
    external.connect.mockReset().mockImplementation(({name}) => {const port = makePort(name); external.ports.push(port); return port;});
    external.requests = [];
    setRuntimeFetch((input, init) => new Promise((resolve, reject) => {
        const signal = init!.signal as AbortSignal;
        const abort = () => {signal.removeEventListener('abort', abort); reject(new DOMException('fixture request cancelled', 'AbortError'));};
        const complete = () => {
            signal.removeEventListener('abort', abort);
            const chunk = {id: 'fixture', created: 0, model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: 'Finished'}, finish_reason: 'stop'}]};
            resolve(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {headers: {'Content-Type': 'text/event-stream'}}));
        };
        external.requests.push({url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal, settle: abort, complete});
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
    }));
});
afterEach(async () => {
    apps.forEach(app => app.unmount()); apps.clear(); await flush();
    external.config.on = false; external.subscribers.forEach(listener => listener(external.config));
    external.requests.forEach(request => request.settle());
    external.ports.forEach(port => port.disconnect()); dom.document.body.replaceChildren(); dom.frames.clear();
    external.subscribers.clear(); external.onConnect.clear(); external.removed.clear(); external.updated.clear(); external.alarms.clear();
    setRuntimeFetch();
    vi.useRealTimers(); vi.restoreAllMocks();
});

describe('audit49B production cancellation and ownership', () => {
    it('closes the model progress lease after a successful loop', async () => {
        let captured!: HarnessGenerateInput; const progress = vi.fn();
        await expect(runHarnessLoop({generate: async input => {captured = input; input.onText?.('Finished'); return generated;}, executeTool: async () => '', system: '', user: 'source', tools: [], signal: new AbortController().signal, onText: progress})).resolves.toMatchObject({text: 'Finished'});
        captured.onText?.('late');
        expect(progress.mock.calls).toEqual([['Finished']]);
    });
    it('aborts pending model work and suppresses late progress after the bounded timeout', async () => {
        vi.useFakeTimers(); let captured!: HarnessGenerateInput; const progress = vi.fn();
        const work = runHarnessLoop({generate: async input => {captured = input; return new Promise(() => {});}, executeTool: async () => '', system: '', user: 'source', tools: [], timeoutMs: 1000, signal: new AbortController().signal, onText: progress});
        const outcome = expect(work).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(1000); await outcome;
        expect(captured.signal.aborted).toBe(true); captured.onText?.('late'); expect(progress).not.toHaveBeenCalled();
    });
    it('rejects a pre-cancelled memory read before touching the repository port', async () => {
        const controller = new AbortController(); controller.abort(); const recall = vi.fn(async () => []);
        await expect(readMemory({recall}, 'grammar', controller.signal)).rejects.toThrow('取消'); expect(recall).not.toHaveBeenCalled();
    });
    it('removes a live memory read abort listener after cancellation and ignores late storage settlement', async () => {
        const controller = new AbortController(); let settle!: (value: []) => void;
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const work = readMemory({recall: () => new Promise(resolve => {settle = resolve;})}, 'grammar', controller.signal);
        const outcome = expect(work).rejects.toThrow('取消'); controller.abort(); await outcome; settle([]);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
    it('replaces same-document writing work when all four slots are occupied', async () => {
        const pending: Array<{signal: AbortSignal; settle: (value: typeof result) => void}> = [];
        const handler = createWritingHandler({extensionId: 'fixture', optionsUrl: 'chrome-extension://fixture/options.html', ready: Promise.resolve(), eligibility: () => undefined,
            run: (_request, signal) => new Promise(resolve => pending.push({signal, settle: resolve})),
        });
        const ports = [1, 2, 3, 4].map(id => makePort('fluentReadWritingStream', {id: 'fixture', url: 'https://github.com/a/b/issues/1', tab: {id}, frameId: 0, documentId: `doc-${id}`}));
        ports.forEach((port, index) => {handler.connect(port); port.onMessage.fire({...writingRequest, requestId: `first-${index}`});}); await flush();
        const replacement = makePort('fluentReadWritingStream', ports[0].sender); handler.connect(replacement); replacement.onMessage.fire({...writingRequest, requestId: 'replacement'}); await flush();
        try {
            expect(pending).toHaveLength(5); expect(pending[0].signal.aborted).toBe(true);
            expect(pending.slice(1, 4).every(work => !work.signal.aborted)).toBe(true);
            expect(ports[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({response: expect.objectContaining({cancelled: true})}));
        } finally {handler.cancelAll(); pending.forEach(work => work.settle(result)); await flush();}
    });
    it('uses stable sender identity despite object property order and tab title metadata', async () => {
        const pending: Array<{signal: AbortSignal; settle: (value: typeof result) => void}> = [];
        const handler = createWritingHandler({extensionId: 'fixture', optionsUrl: 'chrome-extension://fixture/options.html', ready: Promise.resolve(), eligibility: () => undefined,
            run: (_request, signal) => new Promise(resolve => pending.push({signal, settle: resolve})),
        });
        const first = makePort('fluentReadWritingStream', {id: 'fixture', url: 'https://github.com/a/b/issues/1', tab: {id: 1, title: 'old'}, documentId: 'doc'});
        const second = makePort('fluentReadWritingStream', {documentId: 'doc', tab: {title: 'new', id: 1}, url: 'https://github.com/a/b/issues/1', id: 'fixture'});
        handler.connect(first); first.onMessage.fire(writingRequest); await flush(); handler.connect(second); second.onMessage.fire({...writingRequest, requestId: 'second'}); await flush();
        try {expect(pending[0].signal.aborted).toBe(true); expect(pending[1].signal.aborted).toBe(false);}
        finally {handler.cancelAll(); pending.forEach(work => work.settle(result)); await flush();}
    });
    it('does not reschedule persistence or alter a completed answer from a late runtime callback', async () => {
        vi.useFakeTimers(); let publish!: (value: ReadingProgress) => void;
        const writes: any[] = []; const store: HarnessSessionStore = {
            captureGeneration: sessionId => ({epoch: 0, generation: 0, sessionId}),
            upsertTurn: async (_session, turn) => {writes.push({...turn}); return true;},
            get: async () => null, list: async () => ({sessions: [], hasMore: false}), delete: async () => undefined, clear: async () => undefined, prune: async () => 0,
        };
        const progress = vi.fn(); const runtime = createHarnessConversationRuntime({store, preferences: () => ({contextMode: 'selection', maxContextChars: 1500}), id: () => crypto.randomUUID(), runtime: {run: async (_request, _signal, callback) => {publish = callback!; publish({kind: 'text', text: 'Partial'}); return result;}}});
        await expect(runtime.run(readingRequest(), new AbortController().signal, progress)).resolves.toMatchObject(result);
        const count = writes.length, progressCount = progress.mock.calls.length;
        publish({kind: 'text', text: 'late'}); await vi.advanceTimersByTimeAsync(501);
        expect(writes).toHaveLength(count); expect(writes.at(-1)).toMatchObject({status: 'completed', answer: 'Finished'}); expect(progress).toHaveBeenCalledTimes(progressCount);
    });
});

describe('audit49B real browser-stream clients', () => {
    it('reading releases listeners on completion before invoking a throwing consumer', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            start({progress: vi.fn(), result: () => {throw new Error('consumer');}}); const port = external.ports.at(-1);
            expect(() => port.onMessage.fire({type: 'result', requestId: request.requestId, response: result})).toThrow('consumer');
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce();
        });
    it('reading releases listeners on explicit cancellation and ignores late delivery', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            const progress = vi.fn(), done = vi.fn(); const cancel = start({progress, result: done}); const port = external.ports.at(-1);
            cancel(); cancel(); port.onMessage.fire({type: 'progress', requestId: request.requestId, progress: {kind: 'text', text: 'late'}});
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
        });
    it('reading ignores malformed or unknown envelopes and remains able to receive the real result', () => {
            const request = readingRequest(); const start = (callbacks: any) => streamReading(request, callbacks).cancel;
            const done = vi.fn(); start({progress: vi.fn(), result: done}); const port = external.ports.at(-1);
            for (const value of [null, false, {}, {type: 'unknown', requestId: request.requestId}]) expect(() => port.onMessage.fire(value)).not.toThrow();
            expect(done).not.toHaveBeenCalled(); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); expect(done).toHaveBeenCalledWith(result);
        });
    it('writing releases listeners on completion before invoking a throwing consumer', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            start({progress: vi.fn(), result: () => {throw new Error('consumer');}}); const port = external.ports.at(-1);
            expect(() => port.onMessage.fire({type: 'result', requestId: request.requestId, response: result})).toThrow('consumer');
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce();
        });
    it('writing releases listeners on explicit cancellation and ignores late delivery', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            const progress = vi.fn(), done = vi.fn(); const cancel = start({progress, result: done}); const port = external.ports.at(-1);
            cancel(); cancel(); port.onMessage.fire({type: 'progress', requestId: request.requestId, progress: {kind: 'text', text: 'late'}});
            expect(port.onMessage.listeners.size).toBe(0); expect(port.onDisconnect.listeners.size).toBe(0); expect(port.disconnect).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
        });
    it('writing ignores malformed or unknown envelopes and remains able to receive the real result', () => {
            const request = writingRequest; const start = (callbacks: any) => streamWriting(request, callbacks);
            const done = vi.fn(); start({progress: vi.fn(), result: done}); const port = external.ports.at(-1);
            for (const value of [null, false, {}, {type: 'unknown', requestId: request.requestId}]) expect(() => port.onMessage.fire(value)).not.toThrow();
            expect(done).not.toHaveBeenCalled(); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); expect(done).toHaveBeenCalledWith(result);
        });
});

describe('audit49B actual client SFC interactions', () => {
    const panelProps = () => ({selection: {text: 'First source.', context: '', sentence: 'First source.'}, preferences: {...DEFAULT_HARNESS_PREFERENCES, enabled: true}, active: true, targetLanguage: 'zh-Hans', sourceLanguage: 'en', vocabularyEnabled: false, privateContext: false, animations: false});
    it('starts the same learning action for a new selection without reusing the old turn or draft question', async () => {
        const {host, props} = mount(ReadingPanel, panelProps()); await flush(); const first = external.ports[0];
        const old = first.postMessage.mock.calls[0][0]; first.onMessage.fire({type: 'result', requestId: old.requestId, response: {...result, turnId: 'old-turn', sessionId: 'old-session'}}); await flush();
        const input = host.querySelector<HTMLInputElement>('input[aria-label="继续追问"]')!; input.value = 'Question about old source'; input.dispatchEvent(new Event('input'));
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        expect(external.ports).toHaveLength(2); const next = external.ports[1].postMessage.mock.calls[0][0];
        expect(next.selection.text).toBe('Second source.'); expect(next.question).toBe(''); expect(next.history).toEqual([]); expect(next.sessionId).toBeUndefined(); expect(next.anchorTurnId).toBeUndefined();
    });
    it('cancels an old selection stream and leaves a new selection free of stopped state and late output', async () => {
        const {host, props} = mount(ReadingPanel, panelProps()); await flush(); const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush();
        expect(first.disconnect).toHaveBeenCalledOnce(); first.onMessage.fire({type: 'progress', requestId: old.requestId, progress: {kind: 'text', text: 'stale answer'}});
        button(host, '读懂').click(); await flush(); expect(external.ports).toHaveLength(2); expect(host.textContent).not.toContain('stale answer');
    });
    it('keeps a keyboard entry point when streamed sentence annotations shrink for the same source', async () => {
        const source = 'Cats chase mice.';
        const table = (rows: string) => `| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n${rows}`;
        const {host, props} = mount(ReadingAnswer, {sourceText: source, text: table('| Cats | noun | subject | Cats |\n| chase | verb | predicate | chase |\n| mice | noun | object | mice |')}); await flush();
        host.querySelectorAll<HTMLButtonElement>('.fr-sentence-tokens button')[2].click(); await flush();
        props.text = table('| Cats | noun | subject | Cats |'); await flush();
        const active = host.querySelector<HTMLButtonElement>('.fr-sentence-tokens button[tabindex="0"]'); expect(active?.textContent).toContain('Cats'); expect(active?.getAttribute('aria-pressed')).toBe('true');
    });
    it('initializes optional-session writing drafts through the actual client and sends the provided source', async () => {
        const {host} = mount(WritingPanel, {active: true, initialDraft: 'Existing source draft', initialContext: '', initialIntent: 'polish'}); await flush();
        expect(external.ports).toHaveLength(1); const port = external.ports[0], request = port.postMessage.mock.calls[0][0];
        expect(request.draft).toBe('Existing source draft'); expect(request.intent).toBe('polish'); port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); await flush(); expect(host.textContent).toContain('Finished');
    });
    it('preserves completed reading results when the same action is clicked twice', async () => {
        const {host} = mount(ReadingPanel, panelProps()); await flush(); const port = external.ports[0], request = port.postMessage.mock.calls[0][0];
        port.onMessage.fire({type: 'result', requestId: request.requestId, response: result}); await flush(); button(host, '读懂').click(); await flush();
        expect(external.ports).toHaveLength(1); expect(host.textContent).toContain('Finished');
    });
    it('keeps a late clipboard success from marking a new selection answer as copied', async () => {
        let finish!: () => void;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise(resolve => {finish = resolve;}));
        const {host, props} = mount(ReadingPanel, panelProps()); await flush();
        const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        first.onMessage.fire({type: 'result', requestId: old.requestId, response: result}); await flush(); button(host, '复制').click();
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        const next = external.ports[1], request = next.postMessage.mock.calls[0][0];
        next.onMessage.fire({type: 'result', requestId: request.requestId, response: {...result, text: 'New answer'}}); await flush();
        finish(); await flush(); expect(button(host, '复制').textContent).toBe('复制'); expect(host.textContent).not.toContain('已复制');
        expect(host.textContent).toContain('New answer');
    });
    it('keeps a late clipboard failure from displaying an old selection error on the new answer', async () => {
        let fail!: (error: Error) => void;
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise((_resolve, reject) => {fail = reject;}));
        const {host, props} = mount(ReadingPanel, panelProps()); await flush();
        const first = external.ports[0], old = first.postMessage.mock.calls[0][0];
        first.onMessage.fire({type: 'result', requestId: old.requestId, response: result}); await flush(); button(host, '复制').click();
        props.selection = {text: 'Second source.', context: '', sentence: 'Second source.'}; await flush(); button(host, '读懂').click(); await flush();
        const next = external.ports[1], request = next.postMessage.mock.calls[0][0];
        next.onMessage.fire({type: 'result', requestId: request.requestId, response: {...result, text: 'New answer'}}); await flush();
        fail(new Error('fixture clipboard denied')); await flush(); expect(host.textContent).not.toContain('复制失败');
        expect(host.textContent).toContain('New answer');
    });
});

describe('audit49B real lexical ranking contracts', () => {
    it('keeps standalone explanation identical to ranked scores and reasons, including expiry and stable ties', () => {
        const now = Date.parse('2026-10-06T00:00:00Z');
        const records: MemoryRecord[] = ['a', 'b', 'expired', 'other'].map(id => ({id, content: id === 'other' ? 'unrelated shopping' : 'Grammar 苹果 helps grammar practice', kind: 'lesson', tags: ['grammar'], scope: 'user', project: null, importance: 2, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), accessedAt: null, accessCount: 2, expiresAt: id === 'expired' ? new Date(now).toISOString() : null}));
        const ranked = rankRecords(records, 'Grammar 苹果', 3, {now}); expect(ranked.map(hit => hit.record.id)).toEqual(['a', 'b']);
        expect(ranked.map(hit => ({score: hit.score, reasons: hit.reasons}))).toEqual(records.slice(0, 2).map(record => explainRecord(record, 'Grammar 苹果', {now})));
        expect(rankRecords(records, '   ', 3, {now})).toEqual([]); expect(rankRecords(records, 'Grammar 苹果', 0, {now})).toEqual([]);
    });
});

type BackgroundKind = 'reading' | 'writing';
function configureBackground(service = 'deepseek') {
    external.config.service = service;
    external.config.model[service] = 'fixture-model'; external.config.token[service] = 'fixture-secret-first';
    external.config.harness = {...external.config.harness, enabled: true, service: '', model: '', memoryEnabled: false};
    external.config.writing = {...external.config.writing, enabled: true, service: '', model: '', referenceLanguage: 'off'};
    if (service.startsWith('custom:')) external.config.customOpenAIProviders = [{id: service, name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: []}];
}
function notifyConfiguration() { external.subscribers.forEach(listener => listener(external.config)); }
async function untilFixture(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0));}
    throw new Error('Controlled HTTP/client fixture did not reach its expected loading/settlement marker');
}
async function openBackgroundPort(kind: BackgroundKind) {
    const index = external.requests.length;
    const port = makePort(kind === 'reading' ? 'fluentReadHarnessStream' : 'fluentReadWritingStream', {id: 'fixture', tab: {id: 92}, frameId: 0, documentId: 'fixture-document', url: 'https://github.com/fixture/repository/issues/1'});
    external.ports.push(port); external.onConnect.forEach(listener => listener(port));
    port.onMessage.fire(kind === 'reading' ? readingRequest(`background-reading-${index}`) : {...writingRequest, requestId: `background-writing-${index}`});
    await untilFixture(() => external.requests.length > index);
    return {port, request: external.requests[index]};
}
function installBackground(kind: BackgroundKind) { if (kind === 'reading') installHarnessBackgroundRuntime(); else installWritingBackgroundRuntime(); }
async function proveEffectiveChange(kind: BackgroundKind, setup: () => void, change: () => void, verifyOld: (request: typeof external.requests[number]) => void, verifyNew: (request: typeof external.requests[number]) => void) {
    configureBackground(); setup(); installBackground(kind);
    const first = await openBackgroundPort(kind); verifyOld(first.request);
    change(); notifyConfiguration();
    expect(first.request.signal.aborted).toBe(true);
    await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({cancelled: true})}));
    const next = await openBackgroundPort(kind); verifyNew(next.request); next.request.complete();
    await untilFixture(() => next.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(next.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true, text: 'Finished'})}));
    const notifications = JSON.stringify(external.ports.flatMap(port => port.postMessage.mock.calls));
    for (const secret of ['fixture-secret-first', 'fixture-secret-next', 'fixture-secret-second', 'fixture-header-first', 'fixture-header-next']) expect(notifications).not.toContain(secret);
}
async function proveInactiveProfiles(kind: BackgroundKind) {
    configureBackground('custom:fixture');
    external.config.harness.service = 'custom:fixture'; external.config.harness.model = 'fixture-model';
    external.config.writing.service = 'custom:fixture'; external.config.writing.model = 'fixture-model';
    external.config.proxy['custom:fixture'] = 'https://fixture.invalid/v1/chat/completions';
    installBackground(kind); const first = await openBackgroundPort(kind);
    external.config.theme = 'dark'; external.config.service = 'openai'; external.config.token.openai = 'unused-fixture-secret';
    external.config.apiKeys.openai = ['unused-fixture-key']; external.config.apiKeyRotationEnabled.openai = true;
    external.config.customHeaders.openai = '{"X-Unused":"unused-fixture-header"}'; external.config.modelThinking.deepseek = {'unused-model': true};
    external.config.model['custom:fixture'] = 'inactive-default-model'; external.config.customModel['custom:fixture'] = 'inactive-custom-model';
    external.config.customOpenAIProviders[0] = {...external.config.customOpenAIProviders[0], name: 'Renamed', endpoint: 'https://unused.invalid/v1', models: ['unselected']};
    external.config.customOpenAIProviders.push({id: 'custom:unused', name: 'Unused', endpoint: 'https://unused.invalid/v1', models: []});
    external.config.writing.referenceLanguage = 'es'; external.config.harness.hoverDelay = 900;
    notifyConfiguration(); expect(first.request.signal.aborted).toBe(false); expect(first.port.postMessage.mock.calls.some(([value]) => value.type === 'result')).toBe(false);
    first.request.complete(); await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true, text: 'Finished'})}));
}
async function proveEquivalentInputs(kind: BackgroundKind) {
    configureBackground('custom:fixture');
    external.config.apiKeys['custom:fixture'] = ['fixture-secret-first', 'fixture-secret-second'];
    external.config.apiKeyRotationEnabled['custom:fixture'] = false;
    external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-first","X-Other":"one"}';
    installBackground(kind); const first = await openBackgroundPort(kind);
    external.config.apiKeys['custom:fixture'] = [' fixture-secret-first ', 'unused-disabled-key', 'fixture-secret-first'];
    external.config.customHeaders['custom:fixture'] = '{ "x-other": "one", "x-fixture": " fixture-header-first " }';
    notifyConfiguration(); expect(first.request.signal.aborted).toBe(false);
    first.request.complete(); await untilFixture(() => first.port.postMessage.mock.calls.some(([value]) => value.type === 'result'));
    expect(first.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'result', response: expect.objectContaining({success: true})}));
}
const headerSetup = () => {configureBackground('custom:fixture'); external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-first"}';};
const headerChange = () => {external.config.customHeaders['custom:fixture'] = '{"X-Fixture":"fixture-header-next"}';};
const keySetup = () => {external.config.apiKeys.deepseek = ['fixture-secret-first', 'fixture-secret-second']; external.config.apiKeyRotationEnabled.deepseek = false;};
const keyChange = () => {external.config.apiKeys.deepseek[0] = 'fixture-secret-next';};
const rotationSetup = () => {keySetup(); external.config.apiKeyRotationEnabled.deepseek = true;};
const rotationChange = () => {external.config.apiKeyRotationEnabled.deepseek = false;};
const thinkingSetup = () => {external.config.modelThinking.deepseek = {'fixture-model': false};};
const thinkingChange = () => {external.config.modelThinking.deepseek['fixture-model'] = true;};
describe('audit49B real installed background generation ownership', () => {
    it('reading cancels changed active custom headers and the next real HTTP request uses the new header', () => proveEffectiveChange('reading', headerSetup, headerChange, request => expect(request.headers.get('x-fixture')).toBe('fixture-header-first'), request => expect(request.headers.get('x-fixture')).toBe('fixture-header-next')));
    it('writing cancels changed active custom headers and the next real HTTP request uses the new header', () => proveEffectiveChange('writing', headerSetup, headerChange, request => expect(request.headers.get('x-fixture')).toBe('fixture-header-first'), request => expect(request.headers.get('x-fixture')).toBe('fixture-header-next')));
    it('reading cancels a changed effective apiKeys row and the next request uses that key', () => proveEffectiveChange('reading', keySetup, keyChange, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('writing cancels a changed effective apiKeys row and the next request uses that key', () => proveEffectiveChange('writing', keySetup, keyChange, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('reading cancels a changed effective multi-key rotation policy', () => proveEffectiveChange('reading', rotationSetup, rotationChange, request => expect(request.headers.get('authorization')).toMatch(/^Bearer fixture-secret-/), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first')));
    it('writing cancels a changed effective multi-key rotation policy', () => proveEffectiveChange('writing', rotationSetup, rotationChange, request => expect(request.headers.get('authorization')).toMatch(/^Bearer fixture-secret-/), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first')));
    it('reading cancels changed thinking for the effective model and the next request carries the new body', () => proveEffectiveChange('reading', thinkingSetup, thinkingChange, request => expect(request.body.thinking).toEqual({type: 'disabled'}), request => expect(request.body.thinking).toEqual({type: 'enabled'})));
    it('writing cancels changed thinking for the effective model and the next request carries the new body', () => proveEffectiveChange('writing', thinkingSetup, thinkingChange, request => expect(request.body.thinking).toEqual({type: 'disabled'}), request => expect(request.body.thinking).toEqual({type: 'enabled'})));
    it('reading cancels a changed inherited token and the next request uses the new credential', () => proveEffectiveChange('reading', () => undefined, () => {external.config.token.deepseek = 'fixture-secret-next';}, request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-first'), request => expect(request.headers.get('authorization')).toBe('Bearer fixture-secret-next')));
    it('reading keeps active work through unrelated UI and inactive or overridden profiles', () => proveInactiveProfiles('reading'));
    it('writing keeps active work through unrelated UI and inactive or overridden profiles', () => proveInactiveProfiles('writing'));
    it('reading keeps active work for equivalent headers and disabled secondary credentials', () => proveEquivalentInputs('reading'));
    it('writing keeps active work for equivalent headers and disabled secondary credentials', () => proveEquivalentInputs('writing'));
});
