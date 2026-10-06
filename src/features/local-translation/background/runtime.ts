/**
 * @file src/features/local-translation/background/runtime.ts
 *
 * 文件职责：装配本地翻译模型的后台消息 handler。
 * 主要内容：把扩展 Offscreen client 与浏览器本地状态存储注入 handler，保持平台依赖集中在组合根。
 * 模块边界：不执行翻译、不读取网页内容，也不决定模型目录或推理参数。
 */
import {createLocalTranslationBackgroundHandlers} from './handlers';
import {localTranslationOffscreenAdapter} from '@/src/platform/offscreen/localTranslation';

export function createLocalTranslationBackgroundRuntime() {
    return createLocalTranslationBackgroundHandlers({
        offscreen: localTranslationOffscreenAdapter,
        isTrustedProgress: (context) => {
            const sender = (context as {sender?: {id?: string; url?: string}})?.sender;
            return Boolean(sender && sender.id === browser.runtime.id && sender.url === browser.runtime.getURL('/offscreen.html'));
        },
        storage: {
            get: async (key) => browser.storage.local.get(key),
            set: async (value) => { await browser.storage.local.set(value); },
        },
    });
}
