import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import ts from 'typescript';
import {normalizeConfig} from '@/src/core/config/model';
import {resolveConfiguredHotkey} from '@/src/core/hotkey';
import {buildConfigDiff} from '@/src/core/config/diff';

// 编译真实 Popup action，注入浏览器边界，验证恢复与配置更新不会走错误的副作用路径。
function loadAction(name: string, ports: Record<string, unknown>) {
    const source = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8');
    const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
    const ast = ts.createSourceFile('popup.ts', script, ts.ScriptTarget.Latest, true);
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
    const code = ts.transpileModule(declaration.getText(ast), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
    return new Function(...Object.keys(ports), `${code}\nreturn ${name};`)(...Object.values(ports));
}

describe('Popup actions across configuration and page state', () => {
    it('悬停开关关闭并重开后恢复预设、手势与自定义快捷键，不改变额外方案', () => {
        for (const hotkey of ['Control', 'Alt', 'Shift', 'Escape', '`', 'DoubleClick', 'LongPress', 'MiddleClick', 'TwoFinger', 'ThreeFinger', 'FourFinger', 'DoubleClickScree', 'TripleClickScree', 'custom']) {
            const config = {value: normalizeConfig({hotkey, customHotkey: 'Alt+J'})};
            const extra = config.value.quickTranslationProfiles;
            const action = loadAction('toggleDefaultHoverShortcut', {config, resolveConfiguredHotkey,
                defaultHoverEnabled: {get value() {return config.value.hotkey !== 'none';}},
                quickTranslationConflictMessage: () => '', showNotice: vi.fn()});
            action();
            expect(config.value.hotkey).toBe('none');
            config.value = normalizeConfig(JSON.parse(JSON.stringify(config.value)));
            expect(config.value.hoverShortcutBeforeDisable).toBe(hotkey);
            action();
            expect(config.value.hotkey).toBe(hotkey);
            expect(config.value.customHotkey).toBe('Alt+J');
            expect(config.value.quickTranslationProfiles).toEqual(extra);
        }
    });

    it('旧版关闭状态和损坏恢复字段安全迁移；空自定义键回退，冲突时不覆盖独立方案', () => {
        expect(normalizeConfig({hotkey: 'none'}).hotkey).toBe('none');
        expect(normalizeConfig({hotkey: 'none', hoverShortcutBeforeDisable: 'Computer'}).hoverShortcutBeforeDisable).toBe('Control');
        const config = {value: normalizeConfig({hotkey: 'none', hoverShortcutBeforeDisable: 'custom', customHotkey: ''})};
        const showNotice = vi.fn();
        let conflict = '';
        const action = loadAction('toggleDefaultHoverShortcut', {config, resolveConfiguredHotkey,
            defaultHoverEnabled: {value: false}, quickTranslationConflictMessage: () => conflict, showNotice});
        action(); expect(config.value.hotkey).toBe('Control');
        config.value.hotkey = 'none'; conflict = '快捷键已被独立方案使用'; action();
        expect(config.value.hotkey).toBe('none');
        expect(showNotice).toHaveBeenCalledWith(conflict, 'error');
    });

    it('划词开关恢复关闭前的译文显示偏好且保留触发、卡片与收藏设置', () => {
        const config = {value: normalizeConfig({selectionTranslatorMode: 'translation-only', selectionTranslatorTrigger: 'contextMenu', selectionTranslatorPresentation: 'card', vocabularyBookEnabled: true})};
        const setSelectionMode = loadAction('setSelectionMode', {config});
        const action = loadAction('toggleSelectionTranslation', {config, setSelectionMode});
        action();
        expect(config.value.selectionTranslatorMode).toBe('disabled');
        expect(config.value.disableSelectionTranslator).toBe(true);
        config.value = normalizeConfig(JSON.parse(JSON.stringify(config.value)));
        action();
        expect(config.value.selectionTranslatorMode).toBe('translation-only');
        expect(config.value.disableSelectionTranslator).toBe(false);
        expect(config.value.selectionTranslatorTrigger).toBe('contextMenu');
        expect(config.value.selectionTranslatorPresentation).toBe('card');
        expect(config.value.vocabularyBookEnabled).toBe(true);
        setSelectionMode('bilingual'); action(); action();
        expect(config.value.selectionTranslatorMode).toBe('bilingual');
        expect(normalizeConfig({selectionTranslatorMode: 'disabled'}).selectionTranslatorModeBeforeDisable).toBe('bilingual');
        expect(normalizeConfig({selectionTranslatorMode: 'disabled', selectionTranslatorModeBeforeDisable: 'invalid' as never}).selectionTranslatorModeBeforeDisable).toBe('bilingual');
    });

    it('关闭前的记忆字段保存在配置中但不重复进入用户差异预览', () => {
        expect(buildConfigDiff({hoverShortcutBeforeDisable: 'Control', selectionTranslatorModeBeforeDisable: 'bilingual'},
            {hoverShortcutBeforeDisable: 'Alt', selectionTranslatorModeBeforeDisable: 'translation-only'}).changeCount).toBe(0);
    });

    it('总开关保留在设置页，Popup 只展示暂停状态', () => {
        const popup = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8');
        const settings = readFileSync(resolve(__dirname, '../src/features/settings/ui/SettingsSections.vue'), 'utf8');
        expect(popup).not.toContain('setPluginEnabled');
        expect(popup).toContain('v-if="!config.on"');
        expect(settings).toContain('v-model="config.on"');
    });
});
