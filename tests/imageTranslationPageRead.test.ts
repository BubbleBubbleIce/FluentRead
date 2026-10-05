import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const remote = vi.hoisted(() => vi.fn());
vi.mock('@/src/services/config/store', () => ({config: {on: true, from: 'auto'}}));
vi.mock('@/src/features/image-translation/services/client', () => ({fetchImageInExtension: remote}));
import {getImageData} from '@/src/features/image-translation/content/runtime';
import {MAX_REMOTE_IMAGE_BYTES, fetchPageImageForOcr} from '@/src/features/image-translation/services/remoteImage';

const readers: Reader[] = [];
class Reader {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    result: string | null = null;
    abort = vi.fn(() => {this.readyState = 2;});
    readAsDataURL = vi.fn(() => {
        this.readyState = 1;
        void Promise.resolve().then(() => {
            if (this.readyState !== 1) return;
            this.result = 'data:image/png;base64,local'; this.readyState = 2; this.onload?.();
        });
    });
    constructor() {readers.push(this);}
}
beforeEach(() => {readers.length = 0;});

function canvasFixture(width = 400, height = 200, readable = true) {
    const context = {drawImage: vi.fn(), getImageData: vi.fn(() => {
        if (!readable) throw new DOMException('Tainted canvas', 'SecurityError');
        return {};
    })};
    const canvas = {width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => 'data:image/png;base64,local'),
        toBlob: vi.fn((callback: BlobCallback) => {
            if (!readable) throw new DOMException('Tainted canvas', 'SecurityError');
            callback(new Blob(['fixture'], {type: 'image/png'}));
        })};
    const image = {isConnected: true, getAttribute: () => null, naturalWidth: width, naturalHeight: height, currentSrc: 'https://images.example.test/photo.png', src: 'https://images.example.test/photo.png'} as unknown as HTMLImageElement;
    vi.stubGlobal('document', {URL: 'https://page.example.com/', createElement: vi.fn(() => canvas)});
    vi.stubGlobal('browser', {runtime: {id: 'test-id', onMessage: {addListener: vi.fn(), removeListener: vi.fn()}}});
    vi.stubGlobal('FileReader', Reader);
    return {canvas, context, image};
}

afterEach(() => {remote.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('图片像素读取与网页 CORS 权限', () => {
    it('宿主页等待异步 PNG，取消即释放画布、保留原图且迟到 Blob 不再读取或联网', async () => {
        const env = canvasFixture(); const controller = new AbortController();
        let complete!: BlobCallback;
        env.canvas.toBlob.mockImplementationOnce(callback => {complete = callback;});
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        const outcome = getImageData(env.image, {signal: controller.signal}).then(result => ({result}), error => ({error}));
        expect(env.canvas.toBlob).toHaveBeenCalledOnce();
        expect(env.canvas.toDataURL).not.toHaveBeenCalled();
        expect(env.context.getImageData).not.toHaveBeenCalled();
        expect(env.canvas).toMatchObject({width: 400, height: 200});
        controller.abort();
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        expect(env.canvas).toMatchObject({width: 0, height: 0});
        complete(new Blob(['late']));
        expect(readers).toHaveLength(0); expect(fetch).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
        expect(env.image.src).toBe('https://images.example.test/photo.png');
    });

    it('独立读取的 PNG 编码遵守调用者预算，超时不交付迟到结果或启动跨域回退', async () => {
        vi.useFakeTimers(); const env = canvasFixture();
        let complete!: BlobCallback;
        env.canvas.toBlob.mockImplementationOnce(callback => {complete = callback;});
        const outcome = getImageData(env.image, {timeoutMs: 100}).then(result => ({result}), error => ({error}));
        await vi.advanceTimersByTimeAsync(100);
        expect(await outcome).toMatchObject({error: {message: '图片读取超时'}});
        expect(env.canvas).toMatchObject({width: 0, height: 0});
        complete(new Blob(['late']));
        expect(readers).toHaveLength(0); expect(remote).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    });

    it('绘制已耗尽读取预算时不再开始 PNG 压缩', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']}); const env = canvasFixture();
        env.context.drawImage.mockImplementationOnce(() => {vi.advanceTimersByTime(101);});
        await expect(getImageData(env.image, {timeoutMs: 100})).rejects.toThrow('图片读取超时');
        expect(env.canvas.toBlob).not.toHaveBeenCalled(); expect(env.canvas.toDataURL).not.toHaveBeenCalled();
        expect(env.canvas).toMatchObject({width: 0, height: 0}); expect(remote).not.toHaveBeenCalled();
    });

    it('绘制、CORS 与扩展回退共享读取预算，不为每次回退重新计时', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']}); const env = canvasFixture(400, 200, false);
        env.context.drawImage.mockImplementationOnce(() => {vi.advanceTimersByTime(40);});
        vi.stubGlobal('fetch', vi.fn(() => new Promise((_resolve, reject) => {setTimeout(() => reject(new TypeError('CORS denied')), 40);})));
        remote.mockResolvedValue('data:image/png;base64,remote');
        const outcome = getImageData(env.image, {timeoutMs: 100}).then(result => ({result}), error => ({error}));
        await vi.advanceTimersByTimeAsync(40);
        expect(await outcome).toEqual({result: 'data:image/png;base64,remote'});
        expect(remote).toHaveBeenCalledWith(env.image.src, expect.objectContaining({timeoutMs: 20}));
        expect(vi.getTimerCount()).toBe(0); expect(env.canvas).toMatchObject({width: 0, height: 0});
    });

    it('系统时钟后调也不延长扩展回退的剩余读取预算', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']}); const env = canvasFixture(400, 200, false);
        vi.stubGlobal('fetch', vi.fn(() => {
            vi.setSystemTime(Date.now() - 3_600_000);
            return new Promise((_resolve, reject) => {setTimeout(() => reject(new TypeError('CORS denied')), 40);});
        }));
        remote.mockResolvedValue('data:image/png;base64,remote');
        const outcome = getImageData(env.image, {timeoutMs: 100}).then(result => ({result}), error => ({error}));
        await vi.advanceTimersByTimeAsync(40);
        expect(await outcome).toEqual({result: 'data:image/png;base64,remote'});
        expect(remote).toHaveBeenCalledWith(env.image.src, expect.objectContaining({timeoutMs: 60}));
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([{timeoutMs: NaN, expected: 15_000}, {timeoutMs: Infinity, expected: 15_000},
        {timeoutMs: 20_000, expected: 15_000}, {timeoutMs: -1, expected: 1}])(
        '独立编码将读取预算 $timeoutMs 规范为 $expected 毫秒', async ({timeoutMs, expected}) => {
            vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']});
            const env = canvasFixture(); env.canvas.toBlob.mockImplementationOnce(() => {});
            const outcome = getImageData(env.image, {timeoutMs}).catch(error => error);
            await vi.advanceTimersByTimeAsync(expected - 1);
            expect(vi.getTimerCount()).toBe(1); expect(env.canvas.width).toBe(400);
            await vi.advanceTimersByTimeAsync(1);
            expect(await outcome).toMatchObject({message: '图片读取超时'});
            expect(env.canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['before-cors', 'before-extension'])('在 %s 耗尽预算时不启动下一次读取', async stage => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']});
        const env = canvasFixture(400, 200, false); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
        if (stage === 'before-cors') {
            // 原生编码同步抛污染异常期间，时钟可以前进，但任务队列中的超时回调尚不能执行。
            env.canvas.toBlob.mockImplementationOnce(() => {
                now = 101; throw new DOMException('Tainted canvas', 'SecurityError');
            });
        }
        else fetch.mockImplementationOnce(() => {
            now = 100; throw new TypeError('CORS denied');
        });
        await expect(getImageData(env.image, {timeoutMs: 100})).rejects.toThrow('图片读取超时');
        if (stage === 'before-cors') expect(fetch).not.toHaveBeenCalled();
        expect(remote).not.toHaveBeenCalled(); expect(env.canvas).toMatchObject({width: 0, height: 0});
        expect(vi.getTimerCount()).toBe(0);
    });

    it('编码抛非 Error 值时保留原失败，不误当作跨域权限问题', async () => {
        const env = canvasFixture(); env.canvas.toBlob.mockImplementationOnce(() => {throw 'encoding unavailable';});
        await expect(getImageData(env.image)).rejects.toBe('encoding unavailable');
        expect(env.canvas).toMatchObject({width: 0, height: 0}); expect(remote).not.toHaveBeenCalled();
    });

    it('没有 Canvas 上下文或图片地址时释放画布且不误触发扩展抓取', async () => {
        const unavailable = canvasFixture(); unavailable.canvas.getContext.mockReturnValueOnce(null as never);
        await expect(getImageData(unavailable.image)).rejects.toThrow('浏览器不支持图片读取');
        expect(unavailable.canvas).toMatchObject({width: 0, height: 0});
        const missing = canvasFixture(400, 200, false);
        await expect(getImageData({...missing.image, currentSrc: '', src: ''} as HTMLImageElement)).rejects.toThrow('图片地址不可用');
        expect(missing.canvas).toMatchObject({width: 0, height: 0}); expect(remote).not.toHaveBeenCalled();
    });
    it('大图先按 16MP / 8192 边长缩放再分配读取区域，处理后释放 Canvas', async () => {
        const env = canvasFixture(20_000, 10_000);
        await expect(getImageData(env.image)).resolves.toBe('data:image/png;base64,local');
        expect(env.context.drawImage).toHaveBeenCalledWith(env.image, 0, 0, 5656, 2828);
        expect(env.canvas.width).toBe(0); expect(env.canvas.height).toBe(0);
        const wide = canvasFixture(40_000, 100);
        await getImageData(wide.image);
        expect(wide.context.drawImage).toHaveBeenCalledWith(wide.image, 0, 0, 8192, 20);
    });

    it('可读图片不联网，已取消或未加载的图片不创建 Canvas', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        const env = canvasFixture(); await getImageData(env.image);
        expect(fetch).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
        const controller = new AbortController(); controller.abort();
        await expect(getImageData(env.image, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        await expect(getImageData({...env.image, naturalWidth: 0} as HTMLImageElement)).rejects.toThrow('尚未加载');
        expect(document.createElement).toHaveBeenCalledOnce();
    });

    it('无 crossOrigin 导致的污染先用网页 CORS 重读，成功后无需调用扩展权限', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), {headers: {'content-type': 'image/png'}}));
        vi.stubGlobal('fetch', fetch);
        const env = canvasFixture(400, 200, false); const controller = new AbortController();
        await expect(getImageData(env.image, {signal: controller.signal})).resolves.toBe('data:image/png;base64,AQI=');
        expect(fetch).toHaveBeenCalledWith(env.image.src, {mode: 'cors', credentials: 'omit', redirect: 'follow', signal: expect.any(AbortSignal)});
        expect(remote).not.toHaveBeenCalled();
    });

    it('页面 CORS 被拒绝才授权当前图片交给后台，取消后不能触发该回退', async () => {
        const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', fetch);
        remote.mockResolvedValue('data:image/png;base64,remote');
        const env = canvasFixture(400, 200, false);
        await expect(getImageData(env.image)).resolves.toBe('data:image/png;base64,remote');
        expect(remote).toHaveBeenCalledWith(env.image.src, {requestId: expect.stringMatching(/^image-source-/), timeoutMs: expect.any(Number)});
        expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
        remote.mockClear(); const controller = new AbortController();
        fetch.mockImplementationOnce(async () => {controller.abort(); throw new Error('aborted');});
        await expect(getImageData(env.image, {signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(remote).not.toHaveBeenCalled();
    });

    it('响应状态、类型、大小和流错误不会被跨域兜底覆盖，Canvas 编码失败也保留原错误', async () => {
        for (const [status, headers, message] of [
            [403, {'content-type': 'image/png'}, '403'],
            [200, {'content-type': 'text/html'}, '不是图片'],
            [200, {'content-type': 'image/png', 'content-length': String(MAX_REMOTE_IMAGE_BYTES + 1)}, '过大'],
        ] as const) {
            const env = canvasFixture(400, 200, false);
            vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status, headers})));
            await expect(getImageData(env.image)).rejects.toThrow(message);
            expect(remote).not.toHaveBeenCalled();
        }
        const env = canvasFixture();
        env.canvas.toBlob.mockImplementationOnce(() => {throw new Error('encode failed');});
        await expect(getImageData(env.image)).rejects.toThrow('encode failed');
        expect(remote).not.toHaveBeenCalled();
        const tainted = canvasFixture(400, 200, false);
        vi.stubGlobal('fetch', vi.fn(async () => ({ok: true, headers: new Headers({'content-type': 'image/png'}), body: null,
            arrayBuffer: async () => {throw new TypeError('body disconnected');}})));
        await expect(getImageData(tainted.image)).rejects.toThrow('body disconnected');
        expect(remote).not.toHaveBeenCalled();
    });

    it('CORS 请求悬挂时主动终止请求并保留超时，不再启动后台抓图', async () => {
        vi.useFakeTimers(); const env = canvasFixture(400, 200, false); let signal!: AbortSignal;
        vi.stubGlobal('fetch', vi.fn((_url, init) => {signal = init.signal; return new Promise(() => {});}));
        const pending = getImageData(env.image, {timeoutMs: 100});
        const failed = expect(pending).rejects.toMatchObject({name: 'TimeoutError', message: '图片读取超时'});
        await vi.advanceTimersByTimeAsync(100); await failed;
        expect(signal.aborted).toBe(true); expect(remote).not.toHaveBeenCalled(); vi.useRealTimers();
    });

    it('拒绝错误状态、非图片 MIME 和超限 Content-Length，并取消响应体', async () => {
        for (const [status, headers, message] of [
            [403, {'content-type': 'image/png'}, '403'],
            [200, {'content-type': 'text/html'}, '不是图片'],
            [200, {'content-type': 'image/png', 'content-length': String(MAX_REMOTE_IMAGE_BYTES + 1)}, '过大'],
        ] as const) {
            const cancel = vi.fn().mockResolvedValue(undefined);
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok: status === 200, status, headers: new Headers(headers), body: {cancel}}));
            await expect(fetchPageImageForOcr('https://images.example.test/photo.png')).rejects.toThrow(message);
            expect(cancel).toHaveBeenCalledOnce();
        }
    });

    it('无 Content-Length 的流按累计字节限额中断，读取错误清理 reader', async () => {
        const cancel = vi.fn().mockResolvedValue(undefined); const releaseLock = vi.fn();
        const read = vi.fn().mockResolvedValueOnce({done: false, value: new Uint8Array(MAX_REMOTE_IMAGE_BYTES)})
            .mockResolvedValueOnce({done: false, value: new Uint8Array([1])});
        const response = {ok: true, headers: new Headers({'content-type': 'image/png'}), body: {getReader: () => ({read, cancel, releaseLock})}};
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(fetchPageImageForOcr('https://images.example.test/photo.png')).rejects.toThrow('过大');
        expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
        read.mockReset().mockRejectedValue(new Error('network failed'));
        await expect(fetchPageImageForOcr('https://images.example.test/photo.png')).rejects.toThrow('network failed');
        expect(cancel).toHaveBeenCalledTimes(2); expect(releaseLock).toHaveBeenCalledTimes(2);
    });

    it('兼容无流响应并检查文件大小，预先取消时不发请求', async () => {
        const fetch = vi.fn().mockResolvedValue({ok: true, headers: new Headers({'content-type': 'IMAGE/PNG; charset=utf8'}), body: null, arrayBuffer: async () => new Uint8Array([3]).buffer});
        vi.stubGlobal('fetch', fetch);
        await expect(fetchPageImageForOcr('https://images.example.test/photo.png')).resolves.toBe('data:image/png;base64,Aw==');
        const controller = new AbortController(); controller.abort();
        await expect(fetchPageImageForOcr('https://images.example.test/photo.png', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(fetch).toHaveBeenCalledOnce();
    });
});
