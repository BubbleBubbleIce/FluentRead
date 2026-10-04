/**
 * @file src/features/area-translation/content/areaHotkey.ts
 * 文件职责：在不创建圈选 UI 的情况下判断可信快捷键是否应启动圈选翻译。
 * 主要内容：复用配置中的快捷键匹配，并排除重复、输入框、可编辑区域及无法穿透的焦点宿主。
 * 模块边界：本模块只读键盘事件和焦点，不挂载 Shadow DOM、不截屏；具体选区状态由 AreaTranslator.vue 管理。
 */
import {matchesAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {isEditingInPage} from '@/src/shared/dom/editingTarget';

interface AreaHotkeyConfig {
    on?: boolean;
    selectionAreaEnabled: boolean;
    selectionAreaHotkey: string;
    customSelectionAreaHotkey: string;
}

export function shouldStartAreaTranslationFromHotkey(
    event: KeyboardEvent,
    config: AreaHotkeyConfig,
    document: Document,
): boolean {
    if (!event.isTrusted || event.repeat || event.isComposing || config.on === false || config.selectionAreaEnabled !== true) return false;
    if (!matchesAreaTranslationHotkey(event, config.selectionAreaHotkey, config.customSelectionAreaHotkey)) return false;
    const host = document.getElementById('fluent-read-area-translator-container');
    if (host && event.target instanceof Node && host.contains(event.target)) return false;
    return !isEditingInPage(event, document);
}
