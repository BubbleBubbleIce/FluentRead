import {describe, expect, it} from 'vitest';
import {
    DEFAULT_PARAGRAPH_COPY_CONTENT_MODE,
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    PARAGRAPH_COPY_CONTENT_MODES,
    PARAGRAPH_COPY_HOTKEY_OPTIONS,
    matchesParagraphCopyHotkey,
    normalizeCustomParagraphCopyHotkey,
    normalizeParagraphCopyContentMode,
    normalizeParagraphCopyHotkey,
    paragraphCopyHotkeyDisplayName,
    resolveParagraphCopyHotkey,
} from '@/src/core/config/paragraphCopy';

function keyboardEvent(overrides: Record<string, unknown> = {}): KeyboardEvent {
    return {
        key: 'c',
        code: 'KeyC',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    } as unknown as KeyboardEvent;
}

describe('段落复制快捷键配置', () => {
    it('默认组合键避开浏览器的 Ctrl+C，并全部带修饰键', () => {
        expect(DEFAULT_PARAGRAPH_COPY_HOTKEY).toBe('Alt+C');
        expect(PARAGRAPH_COPY_HOTKEY_OPTIONS.map((option) => option.value)).toContain(DEFAULT_PARAGRAPH_COPY_HOTKEY);
        for (const option of PARAGRAPH_COPY_HOTKEY_OPTIONS) {
            expect(option.value).toMatch(/^(?:Alt|Shift|Ctrl)\+/u);
            expect(option.label.length).toBeGreaterThan(0);
        }
        expect(PARAGRAPH_COPY_HOTKEY_OPTIONS.some((option) => option.value.toLowerCase() === 'ctrl+c')).toBe(false);
    });

    it('预设只接受列表内的组合键，其余取值回到默认值', () => {
        expect(normalizeParagraphCopyHotkey('custom')).toBe('custom');
        expect(normalizeParagraphCopyHotkey('alt+d')).toBe('Alt+D');
        expect(normalizeParagraphCopyHotkey('Shift+C')).toBe('Shift+C');
        for (const invalid of [undefined, 42, 'none', 'Ctrl+C', 'q']) {
            expect(normalizeParagraphCopyHotkey(invalid)).toBe(DEFAULT_PARAGRAPH_COPY_HOTKEY);
        }
    });

    it('自定义组合键保存为规范写法，无法解析时留空', () => {
        expect(normalizeCustomParagraphCopyHotkey('alt+k')).toBe('Alt+K');
        expect(normalizeCustomParagraphCopyHotkey('')).toBe('');
        expect(normalizeCustomParagraphCopyHotkey(undefined)).toBe('');
        expect(normalizeCustomParagraphCopyHotkey(7)).toBe('');
        expect(normalizeCustomParagraphCopyHotkey('none')).toBe('');
    });

    it('选择自定义却没有录制成功时回到默认值，功能不会失去入口', () => {
        expect(resolveParagraphCopyHotkey('Shift+D', 'Alt+K')).toBe('Shift+D');
        expect(resolveParagraphCopyHotkey('custom', 'alt+k')).toBe('Alt+K');
        expect(resolveParagraphCopyHotkey('custom', '')).toBe(DEFAULT_PARAGRAPH_COPY_HOTKEY);
        expect(resolveParagraphCopyHotkey('custom', 'none')).toBe(DEFAULT_PARAGRAPH_COPY_HOTKEY);
        // Mac 上 Alt 显示为 Option；展示名称跟随平台，组合结构保持一致。
        expect(paragraphCopyHotkeyDisplayName('custom', 'alt+k')).toMatch(/^(?:Alt|Option)\+K$/u);
        expect(paragraphCopyHotkeyDisplayName('Alt+C', '')).toMatch(/^(?:Alt|Option)\+C$/u);
    });

    it('按键匹配要求修饰键完全一致', () => {
        expect(matchesParagraphCopyHotkey(keyboardEvent({altKey: true}), 'Alt+C', '')).toBe(true);
        expect(matchesParagraphCopyHotkey(keyboardEvent({altKey: true, shiftKey: true}), 'Alt+C', '')).toBe(false);
        expect(matchesParagraphCopyHotkey(keyboardEvent({ctrlKey: true}), 'Alt+C', '')).toBe(false);
        expect(matchesParagraphCopyHotkey(keyboardEvent({altKey: true, key: 'k', code: 'KeyK'}), 'custom', 'Alt+K')).toBe(true);
    });

    it('复制内容口径只接受既定取值，异常输入回到跟随显示', () => {
        expect(DEFAULT_PARAGRAPH_COPY_CONTENT_MODE).toBe('auto');
        expect(PARAGRAPH_COPY_CONTENT_MODES).toEqual(['auto', 'original', 'translation', 'bilingual']);
        for (const mode of PARAGRAPH_COPY_CONTENT_MODES) {
            expect(normalizeParagraphCopyContentMode(mode)).toBe(mode);
        }
        for (const invalid of [undefined, null, '', 'both', 5]) {
            expect(normalizeParagraphCopyContentMode(invalid)).toBe('auto');
        }
    });
});
