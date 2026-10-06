/**
 * @file src/app/background/imageContextMenu.ts
 * 文件职责：判定图片右键入口是否应当出现，把能力探测与图片翻译相关的配置门禁收敛到一处。
 * 主要内容：同时校验浏览器图片翻译能力、扩展总开关、图片翻译功能开关和图片右键入口偏好。
 * 模块边界：本文件只回答“能不能显示图片入口”，不创建菜单、不转发点击、不确认图片身份；菜单结构归 core/context-menu，点击转发归 contextMenuActions，图片识别归内容脚本。
 */
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {config} from '@/src/services/config/store';

export const imageMenuEnabled = (source: Pick<typeof config, 'on' | 'disableImageTranslator' | 'imageTranslationContextMenuEnabled'> = config): boolean => browserCapabilities.imageTranslation && source.on !== false
    && !source.disableImageTranslator && source.imageTranslationContextMenuEnabled !== false;
