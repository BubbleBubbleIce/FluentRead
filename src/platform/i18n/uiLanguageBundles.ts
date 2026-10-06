/**
 * @file src/platform/i18n/uiLanguageBundles.ts
 *
 * 文件职责：在扩展运行时按当前界面语言加载构建期生成的非中文资源包，并注册到 core i18n。
 * 主要内容：createUiLanguageBundleLoader 对同一语言的并发请求去重，校验资源包形状，失败时回退中文且允许下次重试；
 * ensureUiLanguageBundle 使用扩展自身资源 URL 与 fetch 作为默认实现；renderWithUiLanguageBundle 让非响应式 UI 在资源到达后补一次渲染。
 * 模块边界：这里只负责资源读取和注册，不决定当前语言、不订阅配置，也不修改 DOM；
 * userscript 构建用静态注册全部语言的实现替换本模块，扩展 bundle 不得回退到静态 import 全部语言。
 */

import {
    getUiLanguageBundlePath,
    hasUiLanguageBundle,
    normalizeUiLanguage,
    registerUiLanguageBundle,
    type RegisteredUiLanguage,
    type UiLanguageBundle,
} from '@/src/core/i18n';

interface BundleResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface UiLanguageBundleLoaderDependencies {
    readonly resolveUrl: (path: string) => string;
    readonly fetch: (url: string) => Promise<BundleResponse>;
    readonly warn: (message: string, error: unknown) => void;
}

export type EnsureUiLanguageBundle = (language: unknown) => Promise<boolean>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyPatternList(value: unknown): boolean {
    return Array.isArray(value) && value.every((entry) => Array.isArray(entry)
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && (entry[2] === undefined || (Array.isArray(entry[2]) && entry[2].every(Number.isSafeInteger))));
}

export function isUiLanguageBundle(value: unknown): value is UiLanguageBundle {
    return isPlainRecord(value) && isPlainRecord(value.messages) && isPlainRecord(value.legacyText)
        && Object.values(value.messages).every((message) => typeof message === 'string')
        && Object.values(value.legacyText).every((message) => typeof message === 'string')
        && isPlainRecord(value.legacyPatterns)
        && isLegacyPatternList(value.legacyPatterns.early)
        && isLegacyPatternList(value.legacyPatterns.late);
}

/** 返回的函数只在资源包可用时解析为 true；任何失败都降级为中文界面，而不是阻断页面功能。 */
export function createUiLanguageBundleLoader(dependencies: UiLanguageBundleLoaderDependencies): EnsureUiLanguageBundle {
    const pending = new Map<RegisteredUiLanguage, Promise<boolean>>();

    async function load(language: RegisteredUiLanguage): Promise<boolean> {
        const response = await dependencies.fetch(dependencies.resolveUrl(getUiLanguageBundlePath(language)));
        if (!response.ok) throw new Error(`界面语言资源加载失败：HTTP ${response.status}`);
        const bundle = await response.json();
        if (!isUiLanguageBundle(bundle)) throw new TypeError('界面语言资源格式无效');
        registerUiLanguageBundle(language, bundle);
        return true;
    }

    return (value) => {
        const language = normalizeUiLanguage(value);
        if (hasUiLanguageBundle(language)) return Promise.resolve(true);
        const registered = language as RegisteredUiLanguage;
        const existing = pending.get(registered);
        if (existing) return existing;
        const request = Promise.resolve()
            .then(() => load(registered))
            .catch((error: unknown) => {
                dependencies.warn('[FluentRead] UI language bundle unavailable; falling back to Chinese:', error);
                return false;
            })
            .finally(() => pending.delete(registered));
        pending.set(registered, request);
        return request;
    };
}

type ExtensionRuntimeGlobal = typeof globalThis & {
    browser?: {runtime?: {getURL?: (path: string) => string}};
    chrome?: {runtime?: {getURL?: (path: string) => string}};
};

function resolveExtensionUrl(path: string): string {
    const extensionGlobal = globalThis as ExtensionRuntimeGlobal;
    const runtime = extensionGlobal.browser?.runtime ?? extensionGlobal.chrome?.runtime;
    if (typeof runtime?.getURL !== 'function') throw new Error('扩展运行时不可用，无法加载界面语言资源');
    return runtime.getURL(path);
}

export const ensureUiLanguageBundle: EnsureUiLanguageBundle = createUiLanguageBundleLoader({
    resolveUrl: resolveExtensionUrl,
    fetch: (url) => fetch(url),
    warn: (message, error) => console.warn(message, error),
});

/**
 * 立即按当前已可用的资源渲染一次；目标语言资源尚未注册时，加载成功后再渲染一次。
 * 供切换语言时同步重绘的非 Vue 浮层使用，避免在资源到达前停留在中文回退文案。
 */
export function renderWithUiLanguageBundle(
    language: unknown,
    render: () => void,
    ensure: EnsureUiLanguageBundle = ensureUiLanguageBundle,
): void {
    render();
    if (hasUiLanguageBundle(normalizeUiLanguage(language))) return;
    void ensure(language).then((loaded) => { if (loaded) render(); });
}
