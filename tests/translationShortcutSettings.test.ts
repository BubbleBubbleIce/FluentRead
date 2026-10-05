import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {effectScope, nextTick, ref, type EffectScope} from 'vue';
import type {Config} from '@/src/core/config/model';

const notices = vi.hoisted(() => ({message: Object.assign(vi.fn(), {warning: vi.fn()})}));
vi.mock('element-plus', () => ({ElMessage: notices.message}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`,
    translateLegacy: (value: string) => value,
})}));
import {useTranslationShortcutSettings} from '@/src/features/settings/ui/useTranslationShortcutSettings';

type Settings = ReturnType<typeof useTranslationShortcutSettings>;
const groups = [
    {name: 'page', mode: 'floatingBallHotkey', custom: 'customFloatingBallHotkey', change: 'handleHotkeyChange',
        open: 'openCustomHotkeyDialog', cancel: 'handleCustomHotkeyCancel', confirm: 'handleCustomHotkeyConfirm',
        visible: 'showCustomHotkeyDialog', initial: 'Alt+Q', replacement: 'none'},
    {name: 'hover', mode: 'hotkey', custom: 'customHotkey', change: 'handleMouseHotkeyChange',
        open: 'openCustomMouseHotkeyDialog', cancel: 'handleCustomMouseHotkeyCancel', confirm: 'handleCustomMouseHotkeyConfirm',
        visible: 'showCustomMouseHotkeyDialog', initial: 'Shift', replacement: 'none'},
    {name: 'selection', mode: 'selectionTranslatorTrigger', custom: 'customSelectionTranslatorHotkey', change: 'handleSelectionTriggerChange',
        open: 'openCustomSelectionHotkeyDialog', cancel: 'handleCustomSelectionHotkeyCancel', confirm: 'handleCustomSelectionHotkeyConfirm',
        visible: 'showCustomSelectionHotkeyDialog', initial: 'hover', replacement: 'contextMenu'},
] as const;
let scopes: EffectScope[];
function mount() {
    const config = ref({floatingBallHotkey: 'Alt+Q', customFloatingBallHotkey: '', hotkey: 'Shift', customHotkey: '',
        selectionTranslatorTrigger: 'hover', selectionTranslatorHotkey: 'none', customSelectionTranslatorHotkey: '',
        inputBoxTranslationTrigger: 'ctrl_enter', quickTranslationProfiles: []} as unknown as Config);
    const active = ref(true);
    const scope = effectScope(); scopes.push(scope);
    // 可选的分区可见性约束必须保留旧单参数调用；旧实现忽略第二参数，因而能直接复现换页问题。
    const useWithActivity = useTranslationShortcutSettings as unknown as (configuration: typeof config, active: () => boolean) => Settings;
    const state = scope.run(() => useWithActivity(config, () => active.value))!;
    return {config, active, scope, state};
}
beforeEach(() => {vi.useFakeTimers(); vi.clearAllMocks(); scopes = [];});
afterEach(() => {for (const scope of scopes) scope.stop(); vi.clearAllTimers(); vi.useRealTimers();});

describe('快捷键设置草稿生命周期', () => {
    it.each(groups)('$name 快速改选不会让迟到弹窗重新打开或取消覆盖新选择', async group => {
        const {state, config} = mount();
        state[group.change]('custom'); state[group.change](group.replacement);
        await nextTick(); vi.advanceTimersByTime(100);
        expect(state[group.visible].value).toBe(false);
        state[group.cancel](); expect(config.value[group.mode]).toBe(group.replacement);
    });
    it.each(groups)('$name 重复选择自定义只保留一个定时器和最初的恢复点', group => {
        const {state, config} = mount();
        for (let i = 0; i < 100; i++) state[group.change]('custom');
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100); state[group.cancel]();
        expect(config.value[group.mode]).toBe(group.initial);
    });
    it.each(groups)('$name 卸载立即清理等待并恢复尚未确认的模式', group => {
        const {state, config, scope} = mount();
        state[group.change]('custom'); scope.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(config.value[group.mode]).toBe(group.initial);
        vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false);
    });
    it.each(groups)('$name 离开分区取消待开弹窗及未确认的临时配置', async group => {
        const {state, config, active} = mount();
        state[group.change]('custom'); active.value = false; await nextTick();
        vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false);
        expect(config.value[group.mode]).toBe(group.initial);
    });
    it.each(groups)('$name 替换配置后旧草稿不能打开弹窗或回写新配置', async group => {
        const {state, config} = mount();
        state[group.change]('custom');
        config.value = {...config.value, [group.mode]: 'custom', [group.custom]: '', to: 'fr'};
        const replacement = JSON.stringify(config.value); await nextTick(); vi.advanceTimersByTime(100);
        expect(state[group.visible].value).toBe(false);
        state[group.cancel](); expect(JSON.stringify(config.value)).toBe(replacement);
    });
    it('划词自定义快捷键确认和选择旧自定义值都拒绝已启用快捷方案冲突', () => {
        const {state, config} = mount();
        config.value.quickTranslationProfiles = [{id: 'section-ja', enabled: true, action: 'section', hotkey: 'F9',
            service: '', model: '', targetLanguage: 'ja', displayMode: 'inherit', fullPageMode: 'inherit'}];
        state.handleSelectionTriggerChange('custom'); vi.advanceTimersByTime(100);
        state.handleCustomSelectionHotkeyConfirm('F9');
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        state.handleCustomSelectionHotkeyCancel(); config.value.customSelectionTranslatorHotkey = 'F9';
        state.handleSelectionTriggerChange('custom'); expect(config.value.selectionTranslatorTrigger).toBe('hover');
        expect(notices.message.warning).toHaveBeenCalled();
    });
});

it.each(groups)('$name 正常编辑、取消、确认与清除保留独立配置和展示', group => {
    const {state, config} = mount(); config.value[group.mode] = 'custom'; config.value[group.custom] = 'F10';
    const getter = group.name === 'page' ? state.getCustomHotkeyDisplayName : group.name === 'hover' ? state.getCustomMouseHotkeyDisplayName : state.getCustomSelectionHotkeyDisplayName;
    expect(getter()).toBe('F10'); state[group.open](); state[group.cancel]();
    expect(config.value[group.custom]).toBe('F10'); state[group.open](); state[group.confirm]('Alt+D');
    expect(config.value[group.custom]).toBe('Alt+D'); expect(getter()).toBe('Alt+D'); expect(state[group.visible].value).toBe(false);
    state[group.open](); state[group.confirm]('none');
    expect(config.value[group.custom]).toBe(''); expect(config.value[group.mode]).toBe(group.name === 'selection' ? 'icon' : 'none');
    expect(getter()).toBe(''); config.value[group.custom] = 'none'; expect(getter()).toBe('已禁用');
    config.value[group.custom] = 'broken shortcut'; expect(getter()).toBe('broken shortcut');
    if (group.name === 'selection') expect(config.value.selectionTranslatorHotkey).toBe('none');
});
it.each(groups)('$name 缺失历史原模式的自定义项取消回到有效默认', group => {
    const {state, config} = mount(); config.value[group.mode] = 'custom'; state[group.change]('custom');
    vi.advanceTimersByTime(100); state[group.cancel]();
    expect(config.value[group.mode]).toBe(group.name === 'page' ? 'Alt+T' : group.name === 'hover' ? 'Control' : 'icon');
});
it.each(groups)('$name 等待时外部已经保存快捷键则不再弹窗或覆盖', group => {
    const {state, config} = mount(); state[group.change]('custom'); config.value[group.custom] = 'F8';
    vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false); expect(vi.getTimerCount()).toBe(0);
    state[group.cancel](); expect(config.value[group.custom]).toBe('F8'); expect(config.value[group.mode]).toBe('custom');
});
it.each(groups)('$name 关闭分区或卸载后的过期确认与打开入口不改变配置', group => {
    const {state, config, active, scope} = mount(); state[group.open](); active.value = false;
    const saved = JSON.stringify(config.value); state[group.open](); state[group.change]('custom'); state[group.confirm]('F10');
    expect(JSON.stringify(config.value)).toBe(saved); expect(state[group.visible].value).toBe(false);
    active.value = true; scope.stop(); state[group.open](); state[group.change]('custom'); state[group.confirm]('F10');
    expect(JSON.stringify(config.value)).toBe(saved); expect(state[group.visible].value).toBe(false);
});
it('三类录制校验和输入框触发检查都读取快捷方案动作，未占用的触发可直接设置', () => {
    const {state, config, active} = mount();
    for (const action of ['hover', 'full-page', 'section'] as const) {
        config.value.quickTranslationProfiles = [{id: 'occupied', enabled: true, action, hotkey: 'Ctrl+Enter', service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}];
        for (const validate of [state.validateCustomFullPageHotkey, state.validateCustomMouseHotkey, state.validateCustomSelectionHotkey]) expect(validate('Ctrl+Enter')).toContain('quickTranslation.conflictProfile');
        state.handleHotkeyChange('Ctrl+Enter'); expect(config.value.floatingBallHotkey).toBe('Alt+Q');
        state.handleMouseHotkeyChange('Ctrl+Enter'); expect(config.value.hotkey).toBe('Shift');
        state.handleInputBoxTranslationTriggerChange('ctrl_enter'); expect(notices.message.warning).toHaveBeenCalled();
    }
    state.handleInputBoxTranslationTriggerChange('triple_space'); expect(config.value.inputBoxTranslationTrigger).toBe('triple_space');
    state.handleInputBoxTranslationTriggerChange('none'); expect(config.value.inputBoxTranslationTrigger).toBe('none');
    active.value = false; state.handleInputBoxTranslationTriggerChange('triple_equal'); expect(config.value.inputBoxTranslationTrigger).toBe('none');
});
it('单参数旧调用仍可正常设置与取消，手动打开未保存的自定义模式也恢复默认', () => {
    const config = ref({floatingBallHotkey: 'custom', customFloatingBallHotkey: '', hotkey: 'custom', customHotkey: '',
        selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: '', quickTranslationProfiles: []} as unknown as Config);
    const scope = effectScope(); scopes.push(scope); const state = scope.run(() => useTranslationShortcutSettings(config))!;
    state.openCustomHotkeyDialog(); state.handleCustomHotkeyCancel(); expect(config.value.floatingBallHotkey).toBe('Alt+T');
    state.openCustomMouseHotkeyDialog(); state.handleCustomMouseHotkeyCancel(); expect(config.value.hotkey).toBe('Control');
    state.openCustomSelectionHotkeyDialog(); state.handleCustomSelectionHotkeyCancel(); expect(config.value.selectionTranslatorTrigger).toBe('icon');
});
