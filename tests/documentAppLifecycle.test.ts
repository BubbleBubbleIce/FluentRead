import {afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {createRenderer, h, nextTick, ref} from 'vue';
import {Config} from '@/src/core/config/model';
import {parseDocument} from '@/src/features/document-translation/core/document';
import DocumentApp from '@/src/app/document-translation/DocumentApp.vue';
import DocumentSegmentEditor from '@/src/app/document-translation/DocumentSegmentEditor.vue';

const ports = vi.hoisted(() => ({tasks: [] as any[], renderPending: undefined as any, pagePending: undefined as any, sendMessage: vi.fn(), translate: vi.fn(), unsubscribe: vi.fn(), observer: undefined as any, config: undefined as any}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.sendMessage, getURL: (path: string) => `chrome-extension://fixture/${path}`}, tabs: {create: vi.fn()}}}));
vi.mock('@/src/services/config/store', async () => {
    const {Config} = await import('@/src/core/config/model');
    const config = new Config(); ports.config = config;
    return {config, configReady: Promise.resolve(), subscribeConfig: (observer: any) => {ports.observer = observer; return ports.unsubscribe;}, requestConfigPatch: (patch: any, send: any) => send({patch})};
});
vi.mock('@/src/app/translation/client', () => ({translateText: ports.translate, translateTextBatch: vi.fn()}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: (options: unknown) => options, useUiI18n: () => ({language: ref('zh-CN'), t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {props: ['modelValue'], setup: (_props: any, {slots}: any) => () => h('select', slots.default?.())}}));
vi.mock('@/src/ui/components/GlossaryLibrarySelect.vue', () => ({default: {setup: () => () => h('div')}}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', () => ({ElOption: {props: ['label', 'value'], setup: (props: any) => () => h('option', {value: props.value}, props.label)}}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({GlobalWorkerOptions: {}, getDocument: (options: any) => {
    const task = {role: options.disableFontFace ? 'parse' : 'preview', destroy: vi.fn(async () => {}), page: {
        getViewport: ({scale}: {scale: number}) => ({width: 100 * scale, height: 100 * scale, transform: [1, 0, 0, 1, 0, 0]}),
        getTextContent: async () => ({items: [{str: 'Original', transform: [1, 0, 0, 12, 5, 20], width: 50, height: 12, fontName: 'body'}], styles: {}}), cleanup: vi.fn(),
        render: vi.fn(() => {const pending = ports.renderPending; return {promise: pending?.promise ?? Promise.resolve(), cancel: vi.fn(() => pending?.reject(new Error('render canceled')))};}),
    }};
    const getPage = vi.fn(() => ports.pagePending?.promise ?? Promise.resolve(task.page));
    ports.tasks.push({...task, getPage});
    return {promise: Promise.resolve({numPages: 1, getPage}), destroy: task.destroy};
}}));

type HostNode = EventTarget & {type: string; props: Record<string, any>; children: HostNode[]; parent?: HostNode; text?: string; showModal: () => void; close: () => void; style: Record<string, string>};
const node = (type: string): HostNode => Object.assign(new EventTarget(), {type, tagName: type.toUpperCase(), props: {}, children: [] as HostNode[], style: {}, showModal: vi.fn(), close: vi.fn(), getAttribute: (_name: string) => undefined});
const renderer = createRenderer<HostNode, HostNode>({
    createElement: node, createText: value => Object.assign(node('#text'), {text: value}), createComment: value => Object.assign(node('#comment'), {text: value}),
    setText: (element, text) => {element.text = text;}, setElementText: (element, text) => {element.text = text; element.children = [];},
    parentNode: element => element.parent ?? null, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert: (child, parent, anchor) => {if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, child);},
    remove: child => {if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);},
    patchProp: (element, key, _previous, value) => {element.props[key] = value;},
});
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const file = (name: string, text = 'Original') => ({name, size: text.length, text: async () => text, arrayBuffer: async () => new TextEncoder().encode('%PDF-fixture').buffer}) as File;
const flush = async () => {for (let i = 0; i < 6; i += 1) {await nextTick(); await Promise.resolve();}};
let app: any;
let state: any;
let root: HostNode;
let canvasPort: any[];
let createUrl: MockInstance<typeof URL.createObjectURL>;
let revokeUrl: MockInstance<typeof URL.revokeObjectURL>;
let win: any;
const windowTimers = new Set<ReturnType<typeof setTimeout>>();

beforeEach(async () => {
    ports.tasks = []; ports.renderPending = undefined; ports.pagePending = undefined;
    ports.sendMessage.mockReset().mockResolvedValue(undefined); ports.translate.mockReset().mockResolvedValue('translated'); ports.unsubscribe.mockReset();
    Object.assign(ports.config, new Config());
    win = Object.assign(new EventTarget(), {matchMedia: () => Object.assign(new EventTarget(), {matches: false}), document: {createElement: () => ({click: vi.fn()})}, location: {origin: 'chrome-extension://fixture'}, setTimeout: (callback: () => void, delay: number) => {
        const timer = setTimeout(() => {windowTimers.delete(timer); callback();}, delay); windowTimers.add(timer); return timer;
    }, clearTimeout});
    vi.stubGlobal('window', win);
    canvasPort = [];
    vi.stubGlobal('document', {createElement: () => {const canvas = {width: 0, height: 0, getContext: () => ({fillRect: vi.fn()}), toBlob: (done: any) => done(new Blob([new Uint8Array([1])]))}; canvasPort.push(canvas); return canvas;}});
    createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${createUrl.mock.calls.length}`);
    revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    root = node('root');
    app = renderer.createApp(DocumentApp);
    app.mount(root); state = root.children[0].parent ? (app._instance as any).setupState : undefined;
    await flush();
});
afterEach(async () => {ports.pagePending?.resolve(ports.tasks.find(value => value.role === 'preview')?.page); ports.renderPending?.resolve(); app?.unmount(); await flush(); await vi.dynamicImportSettled(); windowTimers.forEach(timer => clearTimeout(timer)); windowTimers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('documentbinaryAudit actual DocumentApp SFC ownership', () => {
    it('aborts a pending preview when switching files, cleans the late page, and never creates stale URLs', async () => {
        await state.loadFiles([file('first.pdf'), file('second.txt')]);
        await vi.waitFor(() => expect(createUrl).toHaveBeenCalled());
        const first = ports.tasks.find(task => task.role === 'preview');
        const late = deferred<any>(); ports.pagePending = late;
        const work = state.refreshPdfPreviews();
        await vi.waitFor(() => expect(first.getPage.mock.calls.length).toBeGreaterThan(1));
        const count = createUrl.mock.calls.length;
        const second = state.documentQueue[1]; state.selectDocument(second);
        await work;
        expect(first.destroy).toHaveBeenCalledOnce();
        const cleanup = vi.fn(); late.resolve({cleanup});
        await flush();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(createUrl).toHaveBeenCalledTimes(count);
        expect(state.parsedDocument.fileName).toBe('second.txt');
        expect(state.pdfPreviewPageStates).toHaveLength(0);
        expect(revokeUrl).toHaveBeenCalled();
    });

    it('cancels current render on reset and releases every queued file resource on unmount', async () => {
        await state.loadFiles([file('first.pdf'), file('second.pdf')]);
        await vi.waitFor(() => expect(createUrl).toHaveBeenCalled());
        const pending = deferred<void>(); ports.renderPending = pending;
        const work = state.refreshPdfPreviews();
        await vi.waitFor(() => expect(ports.tasks.find(task => task.role === 'preview').page.render.mock.calls.length).toBeGreaterThan(1));
        state.resetDocument();
        await work;
        expect(state.documentQueue).toHaveLength(0);
        expect(state.pdfPreviewLoading).toBe(false);
        expect(canvasPort.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(ports.tasks.filter(task => task.role === 'preview').every(task => task.destroy.mock.calls.length === 1)).toBe(true);
        expect(createUrl.mock.calls.length).toBe(revokeUrl.mock.calls.length);
        ports.renderPending = undefined;
        await state.loadFiles([file('again.pdf')]);
        await vi.waitFor(() => expect(state.pdfPreviewPageStates[0]?.originalUrl).toBeTruthy());
        app.unmount(); app = null;
        expect(ports.unsubscribe).toHaveBeenCalledOnce();
        expect(ports.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
        expect(createUrl.mock.calls.length).toBe(revokeUrl.mock.calls.length);
    });

    it('removes the last PDF and cancels the queued preview timer without reviving a loading task', async () => {
        await state.loadFiles([file('only.pdf')]);
        await vi.waitFor(() => expect(createUrl).toHaveBeenCalled());
        state.schedulePdfPreview();
        const before = ports.tasks.length;
        state.removeDocument(state.documentQueue[0], true);
        await new Promise(resolve => setTimeout(resolve, 380));
        expect(ports.tasks).toHaveLength(before);
        expect(state.parsedDocument).toBeNull();
        expect(state.pdfPreviewPageStates).toHaveLength(0);
        expect(ports.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
    });

    it('passes the import signal to actual parsing and rejects a late read after unmount', async () => {
        const pending = deferred<ArrayBuffer>();
        const input = {...file('pending.pdf'), arrayBuffer: () => pending.promise};
        const work = state.loadFiles([input]);
        expect(state.openingFile).toBe(true);
        const before = ports.tasks.length;
        app.unmount(); app = null;
        pending.resolve(new TextEncoder().encode('%PDF-late').buffer as ArrayBuffer);
        await work;
        expect(state.documentQueue).toHaveLength(0);
        expect(ports.tasks).toHaveLength(before);
        expect(state.openingFile).toBe(false);
    });

    it('ignores late config save responses and releases pending download URLs and timer on pagehide', async () => {
        await state.loadFiles([file('first.txt')]);
        const save = deferred<void>(); ports.sendMessage.mockReturnValueOnce(save.promise);
        state.config.to = 'en'; await flush();
        expect(ports.sendMessage).toHaveBeenCalledOnce();
        state.editSegment(0, '校订');
        await state.downloadDocument();
        expect(state.downloadedRevision).toBe(1);
        const url = createUrl.mock.results[0].value;
        win.dispatchEvent(new Event('pagehide'));
        expect(revokeUrl).toHaveBeenCalledWith(url);
        expect(state.pendingAction).toBeNull();
        save.reject(new Error('late save failed'));
        await flush();
        expect(state.configSaveError).toBe('');
        expect(state.documentQueue).toHaveLength(0);
    });

    it('clears canceled confirmation metadata and renders the real editor update consumer', async () => {
        await state.loadFiles([file('first.txt')]);
        state.editSegment(0, '校订');
        state.removeDocument(state.documentQueue[0]);
        expect(state.pendingAction).toBe('remove');
        await flush();
        const walk = (entry: HostNode): HostNode[] => [entry, ...entry.children.flatMap(walk)];
        const confirmation = walk(root).find(entry => entry.props['aria-labelledby'] === 'confirm-document-heading')!;
        confirmation.props.onClose(new Event('close'));
        expect(state.pendingAction).toBeNull();
        expect(state.pendingRemoval).toBeNull();
        state.confirmAction();
        expect(state.documentQueue).toHaveLength(1);
        state.readerTab = 'edit'; await flush();
        const textarea = walk(root).find(entry => entry.type === 'textarea')!;
        expect(textarea.props.value).toBe('校订');
        textarea.props.onInput({target: {value: 'Updated from editor'}});
        expect(state.translatedSegments).toEqual(['Updated from editor']);
        expect(state.editRevision).toBe(2);
    });
});

it('documentbinaryAudit resets editor focus identity when the document changes', async () => {
    app.unmount(); app = null;
    const current = ref(parseDocument('one.txt', 'Match\nOther'));
    const child = renderer.createApp({setup: () => () => h(DocumentSegmentEditor, {document: current.value, translations: [], disabled: false})});
    child.mount(root);
    const editor = (child._instance as any).subTree.component.setupState;
    editor.query = 'Match'; editor.editingId = 1; await flush();
    expect(editor.filteredSegments).toHaveLength(2);
    current.value = parseDocument('two.txt', 'Match\nDifferent'); await flush();
    expect(editor.editingId).toBeNull();
    expect(editor.filteredSegments).toHaveLength(1);
    child.unmount();
});

it('documentbinaryAudit keeps page config editing isolated from shared runtime config until persistence and ignores late hydration', async () => {
    const previous = ports.config.documentModel.test;
    state.config.documentModel.test = 'local edit';
    await flush();
    expect(ports.config.documentModel.test).toBe(previous);
    expect(ports.sendMessage).toHaveBeenCalled();
    const outside = {...ports.config, documentModel: {test: 'external'}};
    ports.observer(outside); await flush();
    state.config.documentModel.test = 'second local edit';
    expect(outside.documentModel.test).toBe('external');
    app.unmount(); app = null;
    const next = renderer.createApp(DocumentApp); next.mount(node('second-root'));
    const nextState = (next._instance as any).setupState;
    next.unmount(); await flush();
    expect(nextState.hydrated).toBe(false);
});

it('documentbinaryAudit selecting the active PDF preserves its task and URLs', async () => {
    await state.loadFiles([file('same.pdf')]);
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledOnce());
    const task = ports.tasks.find(value => value.role === 'preview');
    state.selectDocument(state.documentQueue[0]); await flush();
    expect(task.destroy).not.toHaveBeenCalled();
    expect(createUrl).toHaveBeenCalledOnce();
    expect(state.pdfPreviewPageStates[0].originalUrl).toBeTruthy();
});

it('documentbinaryAudit mounts the actual page assembly with its app, document theme and i18n plugin', async () => {
    const mount = vi.fn(); const use = vi.fn();
    const create = vi.fn(() => ({mount, use}));
    vi.doMock('vue', async () => ({...await vi.importActual<typeof import('vue')>('vue'), createApp: create}));
    const {mountDocumentTranslationApp} = await import('@/src/app/document-translation/page');
    mountDocumentTranslationApp('#document-root');
    expect(create).toHaveBeenCalledWith(DocumentApp);
    expect(use).toHaveBeenCalledWith({documentRoot: (document as any).body, documentTitleKey: 'metadata.documentTitle'});
    expect(mount).toHaveBeenCalledWith('#document-root');
    vi.doUnmock('vue');
});
