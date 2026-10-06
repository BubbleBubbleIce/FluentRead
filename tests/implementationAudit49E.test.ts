import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event', 'CustomEvent']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    // Complete linkedom's missing browser select setter; Vue still executes its real DOM patch.
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true, get() {return [...this.querySelectorAll('option')].find(o => o.selected)?.value || '';}, set(value) {for (const option of this.querySelectorAll('option')) option.selected = option.value === String(value);}});
    Object.defineProperty(document, 'visibilityState', {configurable: true, writable: true, value: 'visible'});
    return {window, document};
});
const ports = vi.hoisted(() => ({message: vi.fn(), watch: vi.fn(), stopWatch: vi.fn(), imageOcr: true}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.message}}}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {get imageOcr() {return ports.imageOcr;}}}));
vi.mock('@/src/platform/storage/configStorageRuntime', () => ({configStorage: {watch: ports.watch}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({translateLegacy: (s: string) => s, t: (s: string) => s})}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', async () => {
    const {defineComponent, h} = await import('vue');
    return {ElSelect: defineComponent({props: ['modelValue', 'disabled'], setup: (p, {slots}) => () => h('div', {'data-select': '', 'aria-disabled': p.disabled}, slots.default?.())})};
});
import {createApp, h, nextTick, reactive, type App, type Component} from 'vue';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createRequire} from 'node:module';
const {buildSync} = createRequire(createRequire(import.meta.url).resolve('vite'))('esbuild');
import {createDocumentSegmentTranslator, createDocumentFileLoadGuard, type DocumentTranslationGateway} from '@/src/features/document-translation/services/translation';
import type {DocumentSegment} from '@/src/features/document-translation/core/document';
import {splitLocalTranslationText, assertLocalTranslationOutput, hunyuanTranslationPrompt} from '@/src/core/translation/localInference';
import {isLikelyPageContextLeak, isDefinitePageContextLeak} from '@/src/core/translation/prompts';
import {createLocalTranslationBackgroundRuntime} from '@/src/features/local-translation/background/runtime';
import {createLocalTranslationDownloadManager} from '@/src/features/local-translation/offscreen/downloads';
import {artifactUrl, getTranslationArtifacts, downloadTranslationArtifact, artifactComplete, translationArtifactBlob, type TranslationArtifact} from '@/src/features/local-translation/offscreen/artifactStore';
import {LOCAL_TRANSLATION_MODEL_IDS as ids} from '@/src/core/config/localTranslation';
import {createImageOcrLanguageRepository} from '@/src/features/image-translation/background/ocrLanguageRepository';
import {IMAGE_OCR_LANGUAGE_STATE_KEY} from '@/src/features/image-translation/ocrLanguages';
import ImageOcrSettings from '@/src/features/image-translation/ui/ImageOcrSettings.vue';
import MangaModelSettings from '@/src/features/image-translation/ui/MangaModelSettings.vue';
import MangaSettings from '@/src/features/image-translation/ui/MangaSettings.vue';
import {Config} from '@/src/core/config/model';

const explicitEvidence = process.env.AUDIT_E_EVIDENCE;
const evidence = explicitEvidence || mkdtempSync(resolve(tmpdir(), 'fluentread-audit49-e-'));
mkdirSync(evidence, {recursive: true});
afterAll(() => {if (!explicitEvidence) rmSync(evidence, {recursive: true, force: true});});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.env.AUDIT_E_BASELINE === '1';
const entries = new Map<string, Response>();
const apps = new Set<App>();
let failStateWrite = false;
let onPut: ((key: string) => void | Promise<void>) | undefined;
let preferenceMatch: (() => Promise<Response>) | undefined;
let onMatch: ((key: string) => void | Promise<void>) | undefined;
const keyOf = (key: RequestInfo | URL) => typeof key === 'string' ? key : key instanceof URL ? key.href : key.url;
const cachePort = {
    async match(input: RequestInfo | URL) {const key = keyOf(input); if (key.endsWith('/manga-model-source') && preferenceMatch) return preferenceMatch(); await onMatch?.(key); return entries.get(key)?.clone();},
    async put(input: RequestInfo | URL, value: Response) {
        const key = keyOf(input);
        if (failStateWrite && key.endsWith('/local-translation-downloads-v2')) {failStateWrite = false; throw new Error('controlled state disk failure');}
        await onPut?.(key); entries.set(key, value.clone());
    },
    async delete(input: RequestInfo | URL) {return entries.delete(keyOf(input));},
};
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function settle() {for (let i = 0; i < 20; i++) {await Promise.resolve(); await nextTick();}}
async function mount(component: Component, props: Record<string, unknown> = {}) {
    const container = document.createElement('div'); document.body.append(container);
    const input = reactive(props); const app = createApp({render: () => h(component, input)});
    app.component('el-option', {props: ['value', 'label'], render() {return h('span', String((this as any).label));}});
    app.component('el-switch', {props: ['modelValue', 'disabled'], render() {return h('button', {'aria-disabled': (this as any).disabled});}});
    apps.add(app); app.mount(container); await settle(); return {container, app, props: input};
}
function segments(): DocumentSegment[] {return [{id: 0, source: 'one', role: 'paragraph'}, {id: 1, source: 'two', role: 'paragraph'}, {id: 2, source: 'three', role: 'paragraph'}] as DocumentSegment[];}
function gateway(batch = true): DocumentTranslationGateway {return {waitUntilReady() {}, getDefaultService: () => 'fixture', supportsBatch: () => batch, translateText: async text => 'translated ' + text, translateTextBatch: async texts => texts.map(s => 'translated ' + s)};}
function fileFor(body: Uint8Array): TranslationArtifact {return {repo: 'fixture/model', revision: 'immutable', path: 'model.bin', size: body.length, sha256: createHash('sha256').update(body).digest('hex')};}
beforeEach(() => {
    entries.clear(); preferenceMatch = undefined; onPut = undefined; onMatch = undefined; failStateWrite = false;
    ports.message.mockReset().mockImplementation(async ({type}) => type === 'fluentReadImageOcrStatus' ? {success: true, languages: [], states: {}} : {success: true, ready: false, bytes: 0, source: 'auto'});
    ports.stopWatch.mockReset(); ports.watch.mockReset().mockReturnValue(ports.stopWatch); ports.imageOcr = true;
    document.body.replaceChildren(); (document as any).visibilityState = 'visible';
    vi.stubGlobal('caches', {open: async () => cachePort, delete: async () => {entries.clear(); return true;}});
    vi.stubGlobal('navigator', {language: 'en', storage: {estimate: async () => ({quota: 10_000_000_000, usage: 0})}});
    vi.stubGlobal('fetch', vi.fn(async () => {throw new Error('unconfigured external port');}));
});
afterEach(async () => {
    for (const app of apps) app.unmount(); apps.clear(); await settle();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('audit 49 E actual translation and cache entries', () => {
    it('rejects sparse document batch responses before committing any segment', async () => {
        const port = gateway(); port.translateTextBatch = async () => {const result = new Array<string>(3); result[0] = 'first'; result[2] = 'third'; return result;};
        const commit = vi.fn();
        await expect(createDocumentSegmentTranslator(port)(segments(), {fileName: 'fixture', onSegment: commit})).rejects.toThrow('片段不完整');
        expect(commit).not.toHaveBeenCalled();
    });
    it('stops document batch commits when a segment subscriber cancels the task', async () => {
        const controller = new AbortController(), commit = vi.fn(() => controller.abort());
        await expect(createDocumentSegmentTranslator(gateway())(segments(), {fileName: 'fixture', signal: controller.signal, onSegment: commit})).rejects.toMatchObject({name: 'AbortError'});
        expect(commit).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledWith({id: 0, translation: 'translated one'});
    });
    it('preserves resume, glossary exclusion, frozen language pair and file request ownership', async () => {
        const port = gateway(false), request = vi.fn(port.translateText); port.translateText = request;
        port.getGlossaryOptions = () => ({glossaryIds: ['default']});
        const result = await createDocumentSegmentTranslator(port)(segments(), {fileName: 'fixture', initialTranslations: ['edited'], glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'});
        expect(result).toEqual(['edited', 'translated two', 'translated three']);
        expect(request.mock.calls.map(c => c[2])).toEqual([expect.objectContaining({glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'}), expect.objectContaining({glossaryIds: [], sourceLanguage: 'en', targetLanguage: 'zh'})]);
        const guard = createDocumentFileLoadGuard(), first = guard.begin(), second = guard.begin();
        expect(first.isCurrent()).toBe(false); expect(second.isCurrent()).toBe(true); guard.invalidate(); expect(second.isCurrent()).toBe(false);
    });
    it('accepts only extension-owned offscreen progress through the real background runtime composition', async () => {
        const values: Record<string, unknown> = {}, writes = vi.fn(async (value: Record<string, unknown>) => {Object.assign(values, value);});
        vi.stubGlobal('browser', {runtime: {id: 'fixture', getURL: (path: string) => 'moz-extension://fixture/' + path.replace(/^\//u, '')}, storage: {local: {get: async () => values, set: writes}}});
        const handler = createLocalTranslationBackgroundRuntime().find(h => h.type === 'fluentReadLocalTranslationDownloadProgress')!;
        const message = {type: 'fluentReadLocalTranslationDownloadProgress', snapshot: {version: 2, tasks: [{model: ids.opusZhEn, phase: 'idle', downloadedBytes: 0, totalBytes: 100, bytesPerSecond: 0, updatedAt: 1}]}};
        expect(await handler.handle(message, {sender: {id: 'other', url: 'moz-extension://fixture/offscreen.html'}})).toEqual({success: false});
        expect(await handler.handle(message, {sender: {id: 'fixture', url: 'https://fixture.example/offscreen.html'}})).toEqual({success: false});
        expect(writes).not.toHaveBeenCalled();
        expect(await handler.handle(message, {sender: {id: 'fixture', url: 'moz-extension://fixture/offscreen.html'}})).toEqual({success: true});
        expect(writes).toHaveBeenCalledOnce();
    });
    it('releases the model removal lock after the initial state write fails and allows retry', async () => {
        const manager = createLocalTranslationDownloadManager(); await manager.status(); failStateWrite = true;
        await expect(manager.remove(ids.opusZhEn)).rejects.toThrow('controlled state disk failure');
        expect((await manager.status()).tasks.find(t => t.model === ids.opusZhEn)).toMatchObject({phase: 'error', error: 'storage'});
        const deleted = await manager.remove(ids.opusZhEn);
        expect(deleted.tasks.find(t => t.model === ids.opusZhEn)).toMatchObject({phase: 'idle', downloadedBytes: 0});
    });
    it('keeps a model paused when cancellation occurs during the final cached artifact lookup', async () => {
        const terminal = deferred<void>(); let terminalWrites = 0;
        const manager = createLocalTranslationDownloadManager({onChange: async snapshot => {
            const phase = snapshot.tasks.find(t => t.model === ids.opusZhEn)?.phase;
            if (phase === 'paused' || phase === 'ready') {if (++terminalWrites === 2) terminal.resolve();}
        }});
        await manager.status(); const files = getTranslationArtifacts(ids.opusZhEn);
        for (const file of files) entries.set(artifactUrl(file) + '?fluent-read-verified=' + file.sha256, new Response('verified fixture receipt'));
        const last = files[files.length - 1]!; let paused = false;
        onMatch = async key => {if (!paused && key === artifactUrl(last) + '?fluent-read-verified=' + last.sha256) {paused = true; await manager.pause(ids.opusZhEn);}};
        await manager.start(ids.opusZhEn); await terminal.promise;
        expect((await manager.status()).tasks.find(t => t.model === ids.opusZhEn)?.phase).toBe('paused'); expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects a cancelled verified artifact lookup without reporting completion or fetching', async () => {
        const file = fileFor(new Uint8Array([1, 2, 3])), controller = new AbortController(), progress = vi.fn();
        entries.set(artifactUrl(file) + '?fluent-read-verified=' + file.sha256, new Response('verified'));
        onMatch = async key => {if (key.includes('verified=')) controller.abort();};
        await expect(downloadTranslationArtifact(file, controller.signal, progress)).rejects.toMatchObject({name: 'AbortError'});
        expect(progress).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects cancellation while a verified receipt write is pending and keeps valid cached bytes', async () => {
        const bytes = new Uint8Array([1, 2, 3]), file = fileFor(bytes), controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
        onPut = key => {if (key.includes('verified=')) controller.abort();};
        await expect(downloadTranslationArtifact(file, controller.signal, () => {})).rejects.toMatchObject({name: 'AbortError'});
        expect(await artifactComplete(file)).toBe(true); expect(new Uint8Array(await (await translationArtifactBlob(file)).arrayBuffer())).toEqual(bytes);
    });
    it('unlocks the actual response stream reader after a successful verified download', async () => {
        const bytes = new Uint8Array([9, 8, 7]), file = fileFor(bytes), response = new Response(bytes), reader = response.body!.getReader();
        const release = vi.spyOn(reader, 'releaseLock'); vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
        vi.stubGlobal('fetch', vi.fn(async () => response));
        await downloadTranslationArtifact(file, new AbortController().signal, () => {});
        expect(release).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false);
    });
    it('preserves sequential OCR language writes after a failed storage write', async () => {
        let saved: unknown = []; let failure = true;
        const repo = createImageOcrLanguageRepository({get: async () => ({[IMAGE_OCR_LANGUAGE_STATE_KEY]: saved}), set: async values => {if (failure) {failure = false; throw new Error('disk');} saved = values[IMAGE_OCR_LANGUAGE_STATE_KEY];}});
        const first = repo.markDownloaded(['eng']); const second = repo.markDownloaded(['jpn']);
        await expect(first).rejects.toThrow('disk'); expect(await second).toEqual(['jpn']);
        expect(await repo.markDownloaded(['eng'])).toEqual(['jpn', 'eng']); await repo.assertDownloaded('ja');
        expect(await repo.markRemoved(['eng'])).toEqual(['jpn']); await expect(repo.assertDownloaded('en')).rejects.toThrow('下载');
    });
    it('preserves exact local split output, whitespace, prompts and source-owned repetitions', () => {
        const input = 'A short sentence.\n\n' + '材料😀'.repeat(250) + ' End.';
        const output = splitLocalTranslationText(input);
        expect(output.join('')).toBe(input); expect(output.every(s => s.length <= 480 && !/[\uD800-\uDBFF]$/u.test(s))).toBe(true);
        expect(hunyuanTranslationPrompt('text', 'en', 'ja')).toContain('Japanese');
        expect(() => assertLocalTranslationOutput('abc'.repeat(20), 'abc'.repeat(20))).not.toThrow();
        expect(() => assertLocalTranslationOutput('abc'.repeat(20), 'different')).toThrow('REPETITION');
    });
    it('bounds invalid local split limits in an isolated loaded production-module process', async () => {
        let invalidBudgetError: unknown;
        try {splitLocalTranslationText('bounded text', NaN);} catch (error) {invalidBudgetError = error;}
        const variant = baseline ? 'baseline' : 'current', bundled = evidence + '/inference-' + variant + '.mjs';
        buildSync({entryPoints: [(baseline ? process.env.AUDIT_E_BASELINE_SOURCE_ROOT! : root) + '/src/core/translation/localInference.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundled, alias: {'@': root}, logLevel: 'silent'});
        const probe = evidence + '/probe-' + variant + '.mjs';
        writeFileSync(probe, `import {splitLocalTranslationText} from ${JSON.stringify(bundled)};\nimport assert from 'node:assert/strict';\nprocess.stdout.write('PRODUCTION_MODULE_LOADED\\n');\nfor (const limit of [1, 0, -1, 1.5, NaN, Infinity]) assert.throws(()=>splitLocalTranslationText('😀end', limit), RangeError);\nassert.deepEqual(splitLocalTranslationText('😀end',2),['😀','en','d']);\nprocess.stdout.write('PROBE_FINISHED\\n');\n`);
        const result = await new Promise<{exit: number | null; signal: string | null; loaded: boolean; timeout: boolean; output: string}>((resolve, reject) => {
            const child = spawn(process.execPath, [probe], {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
            let output = '', timeout = false, timer: ReturnType<typeof setTimeout>;
            child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {output += data;});
            timer = setTimeout(() => {timeout = true; try {process.kill(-child.pid!, 'SIGKILL');} catch {}}, 1500);
            child.once('error', error => {clearTimeout(timer); reject(error);});
            child.once('close', (exit, signal) => {clearTimeout(timer); resolve({exit, signal, loaded: output.includes('PRODUCTION_MODULE_LOADED'), timeout, output});});
        });
        writeFileSync(evidence + '/inference-probe-' + variant + '.json', JSON.stringify({...result, directNonFiniteBudgetError: invalidBudgetError instanceof Error ? invalidBudgetError.name : null}, null, 2));
        expect(result.loaded, 'module load must succeed before runtime classification').toBe(true);
        expect(result.timeout, result.output).toBe(false); expect(result.exit, result.output).toBe(0); expect(invalidBudgetError).toBeInstanceOf(RangeError);
    });
    it('allows source-owned CJK fragments even when the result expands by repeating them', () => {
        const source = '甲乙丙丁戊己庚辛';
        expect(isLikelyPageContextLeak(source, source.repeat(4), source)).toBe(false);
    });
    it('keeps CJK leak decisions identical while bounding repeated whole-string searches', () => {
        const context = Array.from({length: 3000}, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
        const result = Array.from({length: 1000}, (_, i) => String.fromCharCode(0x7000 + i)).join('');
        const originals = [
            [String.prototype, 'includes', Object.getOwnPropertyDescriptor(String.prototype, 'includes')!],
            [Set.prototype, 'add', Object.getOwnPropertyDescriptor(Set.prototype, 'add')!],
            [Set.prototype, 'has', Object.getOwnPropertyDescriptor(Set.prototype, 'has')!],
            [Set.prototype, 'delete', Object.getOwnPropertyDescriptor(Set.prototype, 'delete')!],
        ] as const;
        const includes = String.prototype.includes, add = Set.prototype.add, has = Set.prototype.has, remove = Set.prototype.delete;
        let searches = 0, receiverCharacterBudget = 0, additions = 0, lookups = 0, deletions = 0;
        // Plain native wrappers avoid counting Vitest mock bookkeeping as production Set operations.
        Object.defineProperty(String.prototype, 'includes', {...originals[0][2], value: function (this: string, ...args: Parameters<typeof includes>) {searches++; receiverCharacterBudget += this.length; return includes.apply(this, args);}});
        Object.defineProperty(Set.prototype, 'add', {...originals[1][2], value: function (this: Set<unknown>, value: unknown) {additions++; return add.call(this, value);}});
        Object.defineProperty(Set.prototype, 'has', {...originals[2][2], value: function (this: Set<unknown>, value: unknown) {lookups++; return has.call(this, value);}});
        Object.defineProperty(Set.prototype, 'delete', {...originals[3][2], value: function (this: Set<unknown>, value: unknown) {deletions++; return remove.call(this, value);}});
        let output: boolean, elapsedMs: number;
        try {
            const start = performance.now(); output = isLikelyPageContextLeak('source', result, context); elapsedMs = performance.now() - start;
        } finally {
            for (const [prototype, key, descriptor] of originals) Object.defineProperty(prototype, key, descriptor);
        }
        const operations = {searches, receiverCharacterBudget, additions, lookups, deletions};
        const modulePath = (baseline ? process.env.AUDIT_E_BASELINE_SOURCE_ROOT! : root) + '/src/core/translation/prompts.ts';
        const proof = {function: 'isLikelyPageContextLeak', modulePath, productionSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'), inputSha256: createHash('sha256').update(context + '\0source\0' + result).digest('hex'), characters: {context: context.length, origin: 6, result: result.length}, ...operations, elapsedMs, output, sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex')};
        writeFileSync(evidence + (baseline ? '/performance-baseline.json' : '/performance-current.json'), JSON.stringify(proof, null, 2));
        expect(output).toBe(false); expect(searches).toBeLessThanOrEqual(20);
        expect(isLikelyPageContextLeak('original', '甲乙丙丁戊己庚辛'.repeat(3), '甲乙丙丁戊己庚辛'.repeat(5))).toBe(true);
        expect(isDefinitePageContextLeak('literal <webpage_context>', 'literal <webpage_context>', 'reference')).toBe(false);
    });
});

describe('audit 49 E real Vue client model settings', () => {
    it('retains a user-selected model source when initial cache hydration resolves late', async () => {
        vi.useFakeTimers(); const hydration = deferred<string>();
        preferenceMatch = async () => ({text: () => hydration.promise} as Response);
        const {container} = await mount(MangaModelSettings);
        const select = container.querySelector<HTMLSelectElement>('select')!;
        select.value = 'mirror';
        select.dispatchEvent(new Event('change', {bubbles: true})); await settle();
        expect(await entries.get('https://fluent-read.invalid/manga-model-source')!.text()).toBe('mirror');
        hydration.resolve('auto'); await settle();
        // Inspect the actual option-selection patch written by the client render.
        expect(container.querySelector('option[value="mirror"]')!.hasAttribute('selected')).toBe(true);
    });
    it('hydrates model source from external status updates and cleans polling on repeated unmount', async () => {
        vi.useFakeTimers(); ports.message.mockResolvedValue({success: true, ready: true, bytes: 30, source: 'mirror'});
        for (let i = 0; i < 3; i++) {
            const {container, app} = await mount(MangaModelSettings, {showInpainting: false});
            expect(container.querySelector('option[value="mirror"]')!.hasAttribute('selected')).toBe(true);
            expect(container.textContent).not.toContain('背景文字清除'); expect(container.querySelectorAll('li')).toHaveLength(3);
            app.unmount(); apps.delete(app); await settle(); expect(vi.getTimerCount()).toBe(0);
        }
    });
    it('recovers model status failures and removes resources using the actual controls', async () => {
        vi.useFakeTimers(); ports.message.mockRejectedValueOnce(new Error('unavailable'));
        const {container} = await mount(MangaModelSettings);
        expect(container.querySelector('[role="alert"]')!.textContent).toContain('状态读取失败');
        ports.message.mockResolvedValue({success: true, ready: true, inpaintingReady: true, bytes: 1024, source: 'official'});
        await vi.advanceTimersByTimeAsync(1500); await settle(); expect(container.querySelector('[role="alert"]')).toBeNull();
        const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '清除已下载资源')!;
        remove.click(); await settle(); expect(ports.message).toHaveBeenCalledWith({type: 'fluentReadMangaModelRemove'});
    });
    it('prevents a stale status response from replacing a newly selected model source', async () => {
        vi.useFakeTimers(); const pending = deferred<unknown>(); ports.message.mockReturnValueOnce(pending.promise);
        const {container} = await mount(MangaModelSettings);
        const select = container.querySelector<HTMLSelectElement>('select')!; select.value = 'mirror';
        select.dispatchEvent(new Event('change', {bubbles: true})); await settle();
        pending.resolve({success: true, ready: false, bytes: 0, source: 'auto'}); await settle();
        expect(container.querySelector('option[value="mirror"]')!.hasAttribute('selected')).toBe(true);
    });
    it('does not subscribe or send OCR requests when the capability is unavailable', async () => {
        ports.imageOcr = false; const {container} = await mount(ImageOcrSettings);
        expect(container.textContent).toContain('当前浏览器暂不支持'); expect(ports.message).not.toHaveBeenCalled(); expect(ports.watch).not.toHaveBeenCalled();
    });
    it('downloads, removes and refreshes OCR language packs through real client buttons and stops watchers', async () => {
        vi.useFakeTimers(); const languages: string[] = [];
        ports.message.mockImplementation(async message => {
            if (message.type === 'fluentReadImageOcrDownload') languages.push(...message.languages);
            if (message.type === 'fluentReadImageOcrRemove') languages.splice(languages.indexOf(message.languages[0]), 1);
            return {success: true, languages: [...languages], states: {}};
        });
        const {container, app} = await mount(ImageOcrSettings, {sourceLanguage: 'en'});
        container.querySelector<HTMLButtonElement>('.image-ocr-primary-action')!.click(); await settle();
        expect(ports.message).toHaveBeenCalledWith({type: 'fluentReadImageOcrDownload', languages: ['eng']});
        expect(container.querySelector('[data-language="eng"]')!.getAttribute('data-state')).toBe('ready');
        container.querySelector<HTMLButtonElement>('.image-ocr-remove')!.click(); await settle(); expect(languages).toEqual([]);
        app.unmount(); apps.delete(app); expect(ports.stopWatch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });
    it('ignores an OCR response after the client is unmounted', async () => {
        vi.useFakeTimers(); const pending = deferred<unknown>(); ports.message.mockReturnValueOnce(pending.promise);
        const {app} = await mount(ImageOcrSettings); app.unmount(); apps.delete(app);
        pending.resolve({success: true, languages: ['eng'], states: {}}); await settle(); expect(vi.getTimerCount()).toBe(0); expect(ports.stopWatch).toHaveBeenCalledOnce();
    });
    it('adds and deletes validated manga rules via the actual rendered form and parent configuration', async () => {
        const settings = new Config(); settings.imageTranslationMangaSites = [];
        const {container, props} = await mount(MangaSettings, {settings, imageEnabled: false, available: true, serviceOptions: []});
        const address = container.querySelector<HTMLInputElement>('input[type="url"]')!, selector = container.querySelectorAll<HTMLInputElement>('input')[1];
        address.value = 'https://fixture.example/chapter/'; address.dispatchEvent(new Event('input', {bubbles: true}));
        selector.value = 'main img'; selector.dispatchEvent(new Event('input', {bubbles: true}));
        container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await settle();
        expect((props.settings as typeof settings).imageTranslationMangaSites).toEqual([{hostname: 'fixture.example', pathPrefix: '/chapter/', selector: 'main img'}]);
        container.querySelector<HTMLButtonElement>('.manga-custom-site button')!.click(); await settle(); expect((props.settings as typeof settings).imageTranslationMangaSites).toEqual([]);
    });
});
