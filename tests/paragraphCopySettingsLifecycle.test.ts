import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// 执行实际 SFC setup/watch；原生录制模板与设置交互另由生产浏览器验证。
const key = '__fluentReadParagraphCopySettingsLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let server: ViteDevServer, app: import('vue').App, state: Record<string, any>, props: {config: Record<string, any>};
const feedback = vi.fn();
function mocks(): Plugin {
    return {name: 'paragraph-copy-settings-mocks', enforce: 'pre', resolveId(id) {
        if (id === 'element-plus') return '\0paragraph-element';
        if (id === '@element-plus/icons-vue') return '\0paragraph-icons';
        if (id.endsWith('.vue') && !id.endsWith('ParagraphCopySettings.vue')) return '\0paragraph-child';
        if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0paragraph-i18n';
        return null;
    }, load(id) {
        if (id === '\0paragraph-element') return `export const ElMessage = globalThis.${key}.feedback;`;
        if (id === '\0paragraph-icons') return 'export const Edit = {};';
        if (id === '\0paragraph-child') return 'export default {}';
        if (id === '\0paragraph-i18n') return 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text});';
        return null;
    }};
}
async function settle() {await runtime.nextTick(); await runtime.nextTick();}
beforeEach(async () => {
    feedback.mockClear(); Object.assign(feedback, {warning: feedback});
    Object.assign(globalThis, {[key]: {feedback}});
    server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', plugins: [mocks(), vue()],
        root: process.cwd(), resolve: {alias: {'@': resolve(process.cwd(), '.')}}, server: {hmr: false, middlewareMode: true}});
    const component = (await server.ssrLoadModule('/src/features/settings/ui/ParagraphCopySettings.vue')).default;
    component.ssrRender = undefined; component.render = () => null;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
        remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
        setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
        setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
    props = runtime.reactive({config: {paragraphCopyEnabled: true, paragraphCopyHotkey: 'Shift+D', customParagraphCopyHotkey: '',
        hotkey: 'Control', floatingBallHotkey: 'Alt+T', selectionTranslatorMode: 'disabled', inputBoxTranslationTrigger: 'none',
        selectionAreaEnabled: false, sectionTranslationHotkeyEnabled: false, quickTranslationProfiles: []}});
    app = renderer.createApp({setup: () => () => runtime.h(component, props)});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => {};
    const vm = app.mount({});
    state = (vm.$.subTree.component as unknown as {setupState: Record<string, any>}).setupState;
    await settle();
});
afterEach(async () => {app?.unmount(); await server?.close(); delete (globalThis as any)[key]; vi.unstubAllGlobals();});

describe('段落复制设置实际组件草稿归属', () => {
    it('重复选择自定义后取消，仍保留进入录制前的快捷键', () => {
        state.handleHotkeyChange('custom'); state.handleHotkeyChange('custom'); state.handleCustomHotkeyCancel();
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it.each(['cancel', 'confirm'] as const)('录制期间换预设后，迟到 %s 不覆盖当前选择', async (action) => {
        state.handleHotkeyChange('custom'); state.handleHotkeyChange('Alt+D'); await settle();
        if (action === 'cancel') state.handleCustomHotkeyCancel(); else state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D');
        expect(props.config.customParagraphCopyHotkey).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('更换整个配置对象后关闭旧录制，旧确认不写入新对象', async () => {
        state.handleHotkeyChange('custom'); props.config = {...props.config, paragraphCopyHotkey: 'Alt+D'}; await settle();
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D'); expect(props.config.customParagraphCopyHotkey).toBe('');
        expect(state.showCustomHotkeyDialog).toBe(false); expect(feedback).not.toHaveBeenCalled();
    });
    it('确认前即时检查外部修改，即使尚未运行 watch 也不覆盖', () => {
        state.handleHotkeyChange('custom'); props.config.paragraphCopyHotkey = 'Alt+D'; state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+D'); expect(props.config.customParagraphCopyHotkey).toBe('');
    });
    it('录制关闭开关后不再保存，并取消弹窗', async () => {
        state.handleHotkeyChange('custom'); props.config.paragraphCopyEnabled = false; await settle();
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(false);
    });
    it('有效确认保存规范组合键，清除录制回到默认复制入口', () => {
        state.handleHotkeyChange('custom'); state.handleCustomHotkeyConfirm('alt+k');
        expect(props.config.paragraphCopyHotkey).toBe('custom'); expect(props.config.customParagraphCopyHotkey).toBe('Alt+K');
        // 与各版本模板的编辑按钮入口一致：旧模板直接打开，当前模板建立草稿归属。
        if (state.openCustomHotkeyDialog) state.openCustomHotkeyDialog(); else state.showCustomHotkeyDialog = true;
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Alt+C'); expect(props.config.customParagraphCopyHotkey).toBe('');
    });
    it('清除后的默认复制组合键若被占用，保留录制并提示冲突', () => {
        state.handleHotkeyChange('custom'); props.config.floatingBallHotkey = 'Alt+C';
        expect(state.findHotkeyConflict('none')).toBe('paragraphCopy.settings.hotkeyConflict');
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(true);
    });
    it('快捷翻译方案占用默认组合键时，清除录制也不能绕过冲突校验', () => {
        state.handleHotkeyChange('custom');
        props.config.quickTranslationProfiles = [{id: 'copy-conflict', enabled: true, action: 'full-page', hotkey: 'Alt+C',
            service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}];
        expect(state.findHotkeyConflict('none')).toBe('quickTranslation.conflictProfile');
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.paragraphCopyHotkey).toBe('Shift+D'); expect(state.showCustomHotkeyDialog).toBe(true);
    });
});
