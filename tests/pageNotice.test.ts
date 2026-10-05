import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';

import {sendErrorMessage, showPageNotice} from '@/src/features/page-notice/public';
import {config} from '@/src/services/config/store';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalBrowser = (globalThis as typeof globalThis & {browser?: unknown}).browser;

const sendMessage = vi.fn(async () => ({success: true}));
const noticeCss = readFileSync(new URL('../src/features/page-notice/content/notice.css', import.meta.url), 'utf8');

describe('page error notice', () => {
    it('已显示且文案相同的通知不重写角色、关闭标签或内容', async () => {
        const notice = showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'credential'});await Promise.resolve();
        const attribute = vi.spyOn(notice, 'setAttribute');const close = vi.spyOn(notice.querySelector('.notice-close')!, 'setAttribute');
        const action = notice.querySelector('.notice-action');
        for (let i = 0; i < 100; i++) expect(showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'credential'})).toBe(notice);
        expect(attribute).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(notice.querySelector('.notice-action')).toBe(action);
        expect(vi.getTimerCount()).toBe(1);
    });
    it('错误节流仍在一个时间窗显示首条，下一时间窗可以继续提示', () => {
        vi.setSystemTime(1000);sendErrorMessage('第一条');sendErrorMessage('窗口内另一条');
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(stack.querySelectorAll('.page-notice')).toHaveLength(1);expect(stack.querySelector('.notice-detail')?.textContent).toContain('第一条');
        vi.setSystemTime(2000);sendErrorMessage('第二条');expect(stack.querySelectorAll('.page-notice')).toHaveLength(2);
    });
    it('脱离旧 signal 或已释放条目的迟到 abort 回调不会移除新反馈', () => {
        const old = new AbortController();const add = vi.spyOn(old.signal, 'addEventListener');
        const first = showPageNotice('旧提示', 'success', {key: 'copy', signal: old.signal});
        const callback = add.mock.calls[0][1] as EventListener;
        showPageNotice('新提示', 'success', {key: 'copy'});callback(new Event('abort'));
        expect(first.isConnected).toBe(true);
        const current = new AbortController();const addCurrent = vi.spyOn(current.signal, 'addEventListener');
        showPageNotice('当前提示', 'success', {key: 'copy', signal: current.signal});current.abort();
        (addCurrent.mock.calls[0][1] as EventListener)(new Event('abort'));expect(first.isConnected).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('已结束的功能不会挂载通知、宿主或计时器', () => {
        const controller = new AbortController();controller.abort();
        expect(showPageNotice('过期复制', 'success', {signal: controller.signal}).isConnected).toBe(false);
        expect(document.getElementById('fluent-read-page-notice-host')).toBeNull();expect(vi.getTimerCount()).toBe(0);
    });
    it('关闭动画期间再次反馈复用节点并撤销旧移除，不重复进入或过早关闭', async () => {
        const notice = showPageNotice('复制一', 'success', {key: 'copy'});await Promise.resolve();
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();expect(vi.getTimerCount()).toBe(1);
        const revived = showPageNotice('复制二', 'success', {key: 'copy'});await Promise.resolve();
        expect(revived).toBe(notice);expect(notice.classList.contains('is-leaving')).toBe(false);
        await vi.advanceTimersByTimeAsync(180);expect(notice.isConnected).toBe(true);
        await vi.advanceTimersByTimeAsync(3500);expect(notice.isConnected).toBe(false);
        notice.querySelector<HTMLButtonElement>('.notice-close')!.click();expect(vi.getTimerCount()).toBe(0);
    });
    it('同组普通反馈和凭据提示互换时更新角色与 CTA，旧按钮失效', async () => {
        const notice = showPageNotice('已复制', 'success', {key: 'copy'});await Promise.resolve();
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'copy'});
        const action = notice.querySelector<HTMLButtonElement>('.notice-action')!;
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error', {key: 'copy'});
        expect(notice.querySelector('.notice-action')).toBe(action);expect(notice.getAttribute('role')).toBe('alert');
        const focus = vi.spyOn(notice.querySelector<HTMLButtonElement>('.notice-close')!, 'focus');
        Object.defineProperty(document, 'activeElement', {value: action, configurable: true});
        showPageNotice('已复制', 'success', {key: 'copy'});action.click();
        expect(notice.querySelector('.notice-action')).toBeNull();expect(sendMessage).not.toHaveBeenCalled();
        expect(focus).toHaveBeenCalledWith({preventScroll: true});expect(notice.getAttribute('role')).toBe('status');
    });
    it('队列满时保留用户正在操作的提示，移除未聚焦的最旧通知', () => {
        const first = showPageNotice('正在处理', 'error');const second = showPageNotice('未聚焦旧提示', 'error');
        const third = showPageNotice('第三条', 'success');
        Object.defineProperty(document, 'activeElement', {value: first.querySelector('.notice-close'), configurable: true});
        const fourth = showPageNotice('第四条', 'error');
        expect(first.isConnected).toBe(true);expect(second.isConnected).toBe(false);
        expect(third.isConnected).toBe(true);expect(fourth.isConnected).toBe(true);expect(vi.getTimerCount()).toBe(3);
    });
    it('宿主移走条目或内部堆栈后重建会取消旧帧与信号处理器，保留非通知节点', () => {
        const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
        window.requestAnimationFrame = fn => {frames.set(++nextFrame, fn);return nextFrame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        const controller = new AbortController();const old = showPageNotice('旧条目', 'error', {signal: controller.signal});
        const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
        const unrelated = document.createElement('p');document.body.appendChild(unrelated);unrelated.appendChild(old);
        const current = showPageNotice('新条目', 'error');
        expect(old.isConnected).toBe(false);expect(unrelated.isConnected).toBe(true);expect(removeAbort).toHaveBeenCalledOnce();
        current.parentElement!.remove();showPageNotice('重建堆栈', 'error');expect(frames.size).toBe(1);expect(vi.getTimerCount()).toBe(1);
    });
    it('同文案不同类型或不同功能保留独立反馈，同 key 更新采用当前语言', async () => {
        registerAllUiLanguageBundles();const previous = config.uiLanguage;
        try {
            const first = showPageNotice('完成', 'success');const error = showPageNotice('完成', 'error');
            const keyed = showPageNotice('完成', 'success', {key: 'copy'});
            expect(first).not.toBe(error);expect(keyed).not.toBe(first);
            config.uiLanguage = 'en-US';showPageNotice('完成', 'success', {key: 'copy'});
            expect(keyed.querySelector('.notice-title')?.textContent).toBe('Done');
        } finally {config.uiLanguage = previous;}
    });
    it('同步发送错误也能隔离；脱离通知的凭据按钮不再发送', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            sendMessage.mockImplementationOnce(() => {throw new Error('invalid runtime');});
            const notice = showPageNotice('需要 API Key，请先配置', 'error');
            const action = notice.querySelector<HTMLButtonElement>('.notice-action')!;action.click();
            expect(error).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error));
            action.remove();action.click();expect(sendMessage).toHaveBeenCalledOnce();
        } finally {error.mockRestore();}
    });
    it.each([undefined, {}, {runtime: {}}, {runtime: {getURL: () => ''}}, {runtime: {getURL: () => 3}}])('不可用图标端口仍显示品牌与原文 %j', runtime => {
        Object.defineProperty(globalThis, 'browser', {value: runtime, configurable: true});
        const notice = showPageNotice('服务需要其他字段，当前尚未配置', 'error');
        expect(notice.querySelector('.notice-mark-fallback')?.textContent).toBe('流');
        expect(notice.querySelector('.notice-detail')?.textContent).toBe('服务需要其他字段，当前尚未配置');
        expect(notice.querySelector('.notice-action')).toBeNull();
    });
    it('连续复制只更新同一条通知，并保持一个待进入回调与一个关闭计时器', async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        const request = vi.fn((callback: FrameRequestCallback) => {frames.set(++nextFrame, callback); return nextFrame;});
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = (id) => {frames.delete(id);};
        const first = showPageNotice('已复制第一段', 'success', {key: 'paragraph-copy'});
        for (let index = 0; index < 500; index++) showPageNotice(`已复制第 ${index} 段`, 'success', {key: 'paragraph-copy'});
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(stack.querySelectorAll('.page-notice')).toHaveLength(1);
        expect(stack.querySelector('.page-notice') === first).toBe(true);
        expect(first.textContent).toContain('已复制第 499 段');
        expect(request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(first.getAttribute('role')).toBe('status');
    });

    it('独立通知突发时最多保留三条最新反馈，替换即清理旧回调和定时器', () => {
        const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0;
        window.requestAnimationFrame = callback => {frames.set(++nextFrame, callback); return nextFrame;};
        window.cancelAnimationFrame = id => {frames.delete(id);};
        for (let index = 0; index < 500; index++) showPageNotice(`错误 ${index}`, 'error');
        const stack = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect([...stack.querySelectorAll('.notice-detail')].map(node => node.textContent)).toEqual(['错误 497', '错误 498', '错误 499']);
        expect(frames.size).toBe(3);expect(vi.getTimerCount()).toBe(3);
    });

    it('相同文案和类型自动复用，重置停留时长而非过早移除', async () => {
        const first = showPageNotice('同一错误', 'error');
        await vi.advanceTimersByTimeAsync(3000);
        const second = showPageNotice('同一错误', 'error');
        expect(second === first).toBe(true);
        await vi.advanceTimersByTimeAsync(600);expect(first.isConnected).toBe(true);
        await vi.advanceTimersByTimeAsync(3080);expect(first.isConnected).toBe(false);
    });

    it('复制功能停止立即清理它的通知，保留独立错误；旧 signal 不清理新实例', () => {
        const old = new AbortController(), current = new AbortController();
        const first = showPageNotice('已复制', 'success', {key: 'paragraph-copy', signal: old.signal});
        const next = showPageNotice('新实例已复制', 'success', {key: 'paragraph-copy', signal: current.signal});
        const error = showPageNotice('独立错误', 'error');
        old.abort();expect(next === first).toBe(true);expect(next.isConnected).toBe(true);
        current.abort();expect(next.isConnected).toBe(false);expect(error.isConnected).toBe(true);
    });

    it('宿主已拆掉通知 host 后重建时，不保留旧计时器或处理器', () => {
        const old = showPageNotice('旧错误', 'error');
        document.getElementById('fluent-read-page-notice-host')!.remove();
        showPageNotice('新错误', 'error');
        expect(vi.getTimerCount()).toBe(1);
        expect(old.isConnected).toBe(false);
    });

    beforeEach(() => {
        vi.useFakeTimers();
        sendMessage.mockClear();
        const {document, window} = parseHTML(`
            <html>
                <body>
                    <p>Translation target</p>
                    <div style="height: 6000px">Long page spacer</div>
                </body>
            </html>
        `);
        Object.defineProperty(globalThis, 'document', {value: document, configurable: true});
        Object.defineProperty(globalThis, 'window', {value: window, configurable: true});
        // linkedom 的 window 代理共享全局属性，逐例重置可控 RAF 端口。
        window.requestAnimationFrame = undefined as unknown as typeof window.requestAnimationFrame;
        window.cancelAnimationFrame = vi.fn();
        Object.defineProperty(globalThis, 'browser', {
            value: {
                runtime: {
                    getURL: (path: string) => `chrome-extension://fixture${path}`,
                    sendMessage,
                },
            },
            configurable: true,
        });
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        Object.defineProperty(globalThis, 'document', {value: originalDocument, configurable: true});
        Object.defineProperty(globalThis, 'window', {value: originalWindow, configurable: true});
        Object.defineProperty(globalThis, 'browser', {value: originalBrowser, configurable: true});
    });

    it('keeps error details fixed to the viewport on a long page', async () => {
        const notice = showPageNotice('Failed to fetch', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        expect(host.parentElement).toBe(document.documentElement);
        expect(host.hasAttribute('data-fluent-read-ui')).toBe(true);
        expect(host.getAttribute('translate')).toBe('no');
        expect(host.style.getPropertyValue('position')).toBe('fixed');
        expect(host.style.getPropertyValue('z-index')).toBe('2147483647');
        expect(host.style.getPropertyValue('pointer-events')).toBe('none');

        const shadow = host.shadowRoot!;
        expect(shadow.querySelector('.notice-stack')).not.toBeNull();
        expect(noticeCss).toMatch(/\.notice-stack\s*\{[^}]*position:\s*fixed/s);
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.textContent).toContain('Failed to fetch');
        expect(notice.classList.contains('is-visible')).toBe(true);
    });

    it('扩展上下文失效时仍显示错误详情，并使用本地品牌占位', async () => {
        Object.defineProperty(globalThis, 'browser', {
            value: {
                runtime: {
                    getURL: () => {
                        throw new Error('Extension context invalidated.');
                    },
                    sendMessage,
                },
            },
            configurable: true,
        });

        expect(() => showPageNotice('扩展已更新，请刷新当前页面后重试。', 'error')).not.toThrow();
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('请刷新当前页面');
        expect(shadow.querySelector('.notice-mark-fallback')?.textContent).toBe('流');
    });

    it('keeps credential guidance interactive inside the isolated notice', async () => {
        showPageNotice('DeepSeek 需要 API Key（访问令牌），当前尚未配置', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        const shadow = host.shadowRoot!;
        const action = shadow.querySelector<HTMLButtonElement>('.notice-action')!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('为 DeepSeek 填写 API Key');

        action.click();
        expect(sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
    });

    it('隔离设置页打开失败，不产生未处理拒绝', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        sendMessage.mockRejectedValueOnce(new Error('runtime disconnected'));
        showPageNotice('DeepSeek 需要 API Key，当前尚未配置', 'error');
        await Promise.resolve();

        const action = document.getElementById('fluent-read-page-notice-host')!
            .shadowRoot!.querySelector<HTMLButtonElement>('.notice-action')!;
        action.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(consoleError).toHaveBeenCalledWith('[FluentRead] 打开设置页失败', expect.any(Error));
        consoleError.mockRestore();
    });

    it.each([
        ['有道翻译 需要 App Key 和 App Secret，当前尚未完整配置；请先在设置中填写，再开始翻译。', 'App Key 和 App Secret'],
        ['腾讯翻译 需要 SecretId 和 SecretKey，当前尚未完整配置；请先在设置中填写，再开始翻译。', 'SecretId 和 SecretKey'],
    ])('offers settings for every supported missing credential type', async (message, credentialLabel) => {
        showPageNotice(message, 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain(credentialLabel);
        const action = shadow.querySelector<HTMLButtonElement>('.notice-action')!;
        action.click();
        expect(sendMessage).toHaveBeenCalledWith({type: 'openOptionsPage'});
    });

    it.each([
        ['ja-JP' as const, 'あと一歩です：DeepSeek の API キー（アクセストークン） を入力すると翻訳を始められます。', '画像翻訳に失敗しました：オフスクリーンドキュメントの準備がタイムアウトしました'],
        ['fr-FR' as const, 'Plus qu’une étape : ajoutez App Key et App Secret pour le service de traduction actuel afin de commencer à traduire.', 'Échec de la traduction de l’image : La préparation du document hors écran a expiré'],
    ])('localizes missing credential guidance and runtime feedback in %s', async (language, detail, imageFailure) => {
        registerAllUiLanguageBundles();
        const previousLanguage = config.uiLanguage;
        config.uiLanguage = language;
        try {
            showPageNotice(language === 'ja-JP'
                ? 'DeepSeek 需要 API Key（访问令牌），当前尚未配置；请先在设置中填写，再开始翻译。'
                : '当前翻译服务还没有配置 App Key 和 App Secret', 'error');
            showPageNotice('图片翻译失败：Offscreen 文档准备超时', 'error');
            await Promise.resolve();

            const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
            const details = [...shadow.querySelectorAll('.notice-detail')].map((node) => node.textContent);
            expect(details[0]).toBe(detail);
            expect(details[1]).toBe(imageFailure);
            expect(shadow.querySelector<HTMLImageElement>('img.notice-mark')?.alt).toBe('FluentRead');
        } finally {
            config.uiLanguage = previousLanguage;
        }
    });

    it('keeps invalid credential diagnostics instead of treating them as missing setup', async () => {
        const message = '当前翻译服务的 API Key 无效、已过期或没有模型访问权限（HTTP 401）。';
        showPageNotice(message, 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toBe(message);
        expect(shadow.querySelector('.notice-action')).toBeNull();
    });

    it('keeps the settings action for a legacy generic missing-key error', async () => {
        showPageNotice('当前翻译服务还没有配置 API Key，请前往设置页面填写后再试。', 'error');
        await Promise.resolve();

        const shadow = document.getElementById('fluent-read-page-notice-host')!.shadowRoot!;
        expect(shadow.querySelector('.notice-detail')?.textContent).toContain('API Key');
        expect(shadow.querySelector('.notice-action')).not.toBeNull();
    });

    it('removes the isolated host after the last notice is closed', async () => {
        showPageNotice('Provider unavailable', 'error');
        await Promise.resolve();

        const host = document.getElementById('fluent-read-page-notice-host')!;
        host.shadowRoot!.querySelector<HTMLButtonElement>('.notice-close')!.click();
        await vi.advanceTimersByTimeAsync(180);

        expect(document.getElementById('fluent-read-page-notice-host')).toBeNull();
    });
});
