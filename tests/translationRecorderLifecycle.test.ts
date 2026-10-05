import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 运行真实 SFC setup/watch/KeepAlive；模板入口和录制按键另在生产扩展验证。
const key = '__fluentReadTranslationRecorderLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const specifications = [
    {label: '局部翻译', file: 'SectionTranslationSettings.vue', mode: 'sectionTranslationHotkey', custom: 'customSectionTranslationHotkey',
        enabled: 'sectionTranslationHotkeyEnabled', fallback: 'Alt+R', conflict: 'sectionTranslation.settings.hotkeyConflict'},
    {label: '圈选翻译', file: 'AreaTranslationSettings.vue', mode: 'selectionAreaHotkey', custom: 'customSelectionAreaHotkey',
        enabled: 'selectionAreaEnabled', fallback: 'Shift+Z', conflict: 'area.settings.hotkeyConflict'},
];
describe.each(specifications)('$label 实际录制组件', spec => {
    let server: ViteDevServer, app: import('vue').App, state: Record<string, any>;
    let props: {active: boolean; enabled: boolean; config: Record<string, any>}, visible: import('vue').Ref<boolean>;
    const feedback = vi.fn();
    function mocks(): Plugin {
        return {name: 'translation-recorder-mocks', enforce: 'pre', resolveId(id) {
            if (id === 'element-plus') return '\0recorder-element';
            if (id === '@element-plus/icons-vue') return '\0recorder-icons';
            if (id.endsWith('.vue') && !id.endsWith(spec.file)) return '\0recorder-child';
            if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0recorder-i18n';
            if (id.includes('platform/browser/capabilities')) return '\0recorder-capabilities';
            if (id.includes('services/translation/capabilities')) return '\0recorder-services';
            if (id.includes('image-translation/public')) return '\0recorder-image';
            if (id.includes('useVisionProbeStatus')) return '\0recorder-probe';
            return null;
        }, load(id) {
            if (id === '\0recorder-element') return `export const ElMessage = globalThis.${key}.feedback;`;
            if (id === '\0recorder-icons') return 'export const Edit = {};';
            if (id === '\0recorder-child') return 'export default {}';
            if (id === '\0recorder-i18n') return 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text});';
            if (id === '\0recorder-capabilities') return `export const browserCapabilities = globalThis.${key}.capabilities;`;
            if (id === '\0recorder-services') return 'export const getTranslationServiceUnavailableMessage = () => "";';
            if (id === '\0recorder-image') return 'export const ImageOcrSettings = {};';
            if (id === '\0recorder-probe') return 'export const useVisionProbeStatus = () => ({result: {value: {capability: "unknown"}}});';
            return null;
        }};
    }
    async function settle() {await runtime.nextTick(); await runtime.nextTick();}
    function openEditor() {
        // 两个实际版本的编辑按钮入口；不以旧版本缺少新增 API 作为失败证据。
        if (state.openCustomHotkeyDialog) state.openCustomHotkeyDialog(); else state.showCustomHotkeyDialog = true;
    }
    beforeEach(async () => {
        feedback.mockClear(); Object.assign(feedback, {warning: feedback});
        Object.assign(globalThis, {[key]: {feedback, capabilities: runtime.reactive({areaTranslation: true})}});
        server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', plugins: [mocks(), vue()],
            root: process.cwd(), resolve: {alias: {'@': resolve(process.cwd(), '.')}}, ssr: {noExternal: ['element-plus', '@element-plus/icons-vue']},
            server: {hmr: false, middlewareMode: true}});
        const component = (await server.ssrLoadModule(`/src/features/settings/ui/${spec.file}`)).default;
        component.ssrRender = undefined; component.render = () => null;
        const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
            remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
            setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
            setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
        props = runtime.reactive({active: true, enabled: true, config: {[spec.mode]: 'Shift+D', [spec.custom]: '', [spec.enabled]: true,
            hotkey: 'Control', floatingBallHotkey: 'Alt+T', selectionTranslatorMode: 'disabled', inputBoxTranslationTrigger: 'none',
            selectionAreaEnabled: spec.file.startsWith('Area'), sectionTranslationHotkeyEnabled: spec.file.startsWith('Section'),
            paragraphCopyEnabled: false, paragraphCopyHotkey: 'Alt+C', quickTranslationProfiles: [],
            service: 'openai', model: {openai: 'mystery-model'}, customModel: {}, areaTranslationService: '', areaVisionPrompt: 'original'}});
        visible = runtime.ref(true);
        app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
            ? runtime.h(component, {...props, serviceOptions: [], ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
            : runtime.h({render: () => null}, {key: 'other'})})});
        app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};app.mount({});await settle();
    });
    afterEach(async () => {app?.unmount();await server?.close();delete (globalThis as any)[key];});

    it('进入录制直到确认前不改变保存的快捷键', () => {
        state.handleHotkeyChange('custom');expect(props.config[spec.mode]).toBe('Shift+D');
        expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('重复选择自定义再取消保留入口并关闭弹窗', () => {
        state.handleHotkeyChange('custom');state.handleHotkeyChange('custom');state.handleCustomHotkeyCancel();
        expect(props.config[spec.mode]).toBe('Shift+D');expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it.each(['cancel', 'confirm'])('切换预设后的迟到 %s 不能覆盖当前选择', async action => {
        state.handleHotkeyChange('custom');state.handleHotkeyChange('Alt+D');await settle();
        if (action === 'cancel') state.handleCustomHotkeyCancel(); else state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[spec.mode]).toBe('Alt+D');expect(props.config[spec.custom]).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('外部即时改预设，未等待 watch 的确认也无效', () => {
        state.handleHotkeyChange('custom');props.config[spec.mode] = 'Alt+D';state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[spec.mode]).toBe('Alt+D');expect(props.config[spec.custom]).toBe('');expect(feedback).not.toHaveBeenCalled();
    });
    it('整个配置替换，旧录制不写入新配置并关闭', async () => {
        state.handleHotkeyChange('custom');props.config = {...props.config};await settle();state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[spec.mode]).toBe('Shift+D');expect(props.config[spec.custom]).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('自定义内容被外部修改后不被旧确认覆盖', async () => {
        state.handleHotkeyChange('custom');props.config[spec.custom] = 'Alt+J';await settle();state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[spec.custom]).toBe('Alt+J');expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('分区隐藏关闭草稿并拒绝迟到确认、编辑与预设，返回可重新打开', async () => {
        state.handleHotkeyChange('custom');props.active = false;await settle();state.handleCustomHotkeyConfirm('Alt+K');
        openEditor();state.handleHotkeyChange('Alt+D');expect(state.showCustomHotkeyDialog).toBe(false);
        expect(props.config[spec.mode]).toBe('Shift+D');props.active = true;await settle();state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('KeepAlive 缓存关闭草稿并拒绝迟到动作，激活后可新建草稿', async () => {
        state.handleHotkeyChange('custom');visible.value = false;await settle();state.handleCustomHotkeyConfirm('Alt+K');
        openEditor();state.handleHotkeyChange('Alt+D');expect(state.showCustomHotkeyDialog).toBe(false);
        expect(props.config[spec.mode]).toBe('Shift+D');visible.value = true;await settle();state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('卸载后原有组件方法不能重新录制或写入配置', () => {
        state.handleHotkeyChange('custom');app.unmount();state.handleCustomHotkeyConfirm('Alt+K');openEditor();state.handleHotkeyChange('Alt+D');
        expect(state.showCustomHotkeyDialog).toBe(false);expect(props.config[spec.mode]).toBe('Shift+D');
    });
    it('功能开关变化终止旧录制，迟到确认不提交', async () => {
        state.handleHotkeyChange('custom');props.config[spec.enabled] = false;props.enabled = false;await settle();
        state.handleCustomHotkeyConfirm('Alt+K');expect(state.showCustomHotkeyDialog).toBe(false);expect(props.config[spec.mode]).toBe('Shift+D');
    });
    it('确认规范组合键，编辑和清除恢复默认入口', () => {
        state.handleHotkeyChange('custom');state.handleCustomHotkeyConfirm('alt+k');expect(props.config[spec.custom]).toBe('Alt+K');
        expect(props.config[spec.mode]).toBe('custom');openEditor();state.handleCustomHotkeyConfirm('none');
        expect(props.config[spec.mode]).toBe(spec.fallback);expect(props.config[spec.custom]).toBe('');
    });
    it('清除录制不能绕过默认组合的功能冲突', () => {
        state.handleHotkeyChange('custom');props.config.floatingBallHotkey = spec.fallback;
        expect(state.findHotkeyConflict('none')).toBe(spec.conflict);state.handleCustomHotkeyConfirm('none');
        expect(props.config[spec.mode]).toBe('Shift+D');expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('清除录制不能绕过默认组合的快捷方案冲突', () => {
        state.handleHotkeyChange('custom');props.config.quickTranslationProfiles = [{id: 'conflict', enabled: true, action: 'full-page',
            hotkey: spec.fallback, service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}];
        expect(state.findHotkeyConflict('none')).toBe('quickTranslation.conflictProfile');state.handleCustomHotkeyConfirm('none');
        expect(props.config[spec.mode]).toBe('Shift+D');expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('恢复已有自定义入口也检查现在新增的冲突', () => {
        props.config[spec.custom] = 'Alt+K';props.config.floatingBallHotkey = 'Alt+K';state.handleHotkeyChange('custom');
        expect(props.config[spec.mode]).toBe('Shift+D');expect(feedback).toHaveBeenCalled();
    });
    it('段落复制启用时占用按键，停用后可录制', () => {
        props.config.paragraphCopyEnabled = true;props.config.paragraphCopyHotkey = 'custom';props.config.customParagraphCopyHotkey = 'Alt+K';
        expect(state.findHotkeyConflict('Alt+K')).toBe(spec.conflict);props.config.paragraphCopyEnabled = false;
        state.handleHotkeyChange('custom');state.handleCustomHotkeyConfirm('Alt+K');expect(props.config[spec.custom]).toBe('Alt+K');
    });
    it('已保存组合的冲突不提交，也不关闭当前草稿', () => {
        state.handleHotkeyChange('custom');props.config.floatingBallHotkey = 'Alt+K';state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config[spec.mode]).toBe('Shift+D');expect(state.showCustomHotkeyDialog).toBe(true);
    });
    if (spec.file.startsWith('Area')) {
        function openPrompt() {if (state.openVisionPromptEditor) state.openVisionPromptEditor();else state.promptEditorOpen = true;}
        function writePrompt(value: string) {
            // 旧模板直接 v-model 配置；当前模板验证所属编辑器后才更新。
            if (state.updateVisionPrompt) state.updateVisionPrompt(value);else props.config.areaVisionPrompt = value;
        }
        it('识图提示词在激活编辑器中仍即时保存，关闭后拒绝迟到输入', () => {
            openPrompt();writePrompt('edited');expect(props.config.areaVisionPrompt).toBe('edited');
            state.promptEditorOpen = false;writePrompt('late');expect(props.config.areaVisionPrompt).toBe('edited');
        });
        it('识图提示词隐藏时关闭，旧输入和重新打开无效', async () => {
            openPrompt();props.active = false;await settle();writePrompt('late');openPrompt();
            expect(state.promptEditorOpen).toBe(false);expect(props.config.areaVisionPrompt).toBe('original');
        });
        it.each(['cached', 'unmount'])('识图提示词在 %s 后关闭且不保存迟到输入', async mode => {
            openPrompt();if (mode === 'cached') {visible.value = false;await settle();}else app.unmount();
            writePrompt('late');openPrompt();expect(state.promptEditorOpen).toBe(false);expect(props.config.areaVisionPrompt).toBe('original');
        });
        it('识图提示词配置替换时即时拒绝旧编辑器写入，随后关闭', async () => {
            openPrompt();const previous = props.config;props.config = {...props.config};await settle();writePrompt('late');
            expect(state.promptEditorOpen).toBe(false);expect(previous.areaVisionPrompt).toBe('original');expect(props.config.areaVisionPrompt).toBe('original');
        });
        it('识图提示词功能开关变化关闭旧编辑器，停用时仍可重新配置', async () => {
            openPrompt();props.enabled = false;await settle();writePrompt('late');expect(state.promptEditorOpen).toBe(false);
            expect(props.config.areaVisionPrompt).toBe('original');openPrompt();writePrompt('off-preference');expect(props.config.areaVisionPrompt).toBe('off-preference');
            state.handleHotkeyChange('custom');state.handleCustomHotkeyConfirm('Alt+K');expect(props.config[spec.custom]).toBe('Alt+K');
        });
        it('浏览器圈选能力不可用时关闭录制和识图提示词，不再接收旧动作', async () => {
            openPrompt();state.handleHotkeyChange('custom');(globalThis as any)[key].capabilities.areaTranslation = false;await settle();
            writePrompt('late');state.handleCustomHotkeyConfirm('Alt+K');openEditor();
            expect(state.promptEditorOpen).toBe(false);expect(state.showCustomHotkeyDialog).toBe(false);
            expect(props.config[spec.mode]).toBe('Shift+D');expect(props.config.areaVisionPrompt).toBe('original');
        });
    }
});
