import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/platform/browser/runtimeMessages', () => ({sendRuntimeMessage: vi.fn()}));

vi.mock('@/src/services/config/store', () => ({
    config: {on: true, from: 'auto'},
}));
// 保留真实 runtime 消息封装，浏览器 API 由每个用例提供；Node 无扩展上下文。
vi.mock('webextension-polyfill', () => ({
    default: new Proxy({}, {get: (_target, key) => Reflect.get((globalThis as any).browser ?? {}, key)}),
}));

import {getImageData} from '@/src/features/image-translation/content/runtime';
import {fetchRemoteImageForOcr} from '@/src/features/image-translation/services/remoteImage';

const PROJECT_ROOT = resolve(__dirname, '..');
const SRC_ROOT = resolve(PROJECT_ROOT, 'src');

function sourceText(): string {
    const sources: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory)) {
            const path = resolve(directory, entry);
            if (statSync(path).isDirectory()) visit(path);
            else if (path.endsWith('.ts') || path.endsWith('.vue')) sources.push(readFileSync(path, 'utf8'));
        }
    };
    visit(SRC_ROOT);
    return sources.join('\n');
}

function imageElement(): HTMLImageElement {
    return {
        isConnected: true, getAttribute: () => null,
        naturalWidth: 40,
        naturalHeight: 20,
        currentSrc: 'https://images.example.com/chart.png',
        src: 'https://images.example.com/chart.png',
    } as unknown as HTMLImageElement;
}

describe('图片翻译跨域读取安全契约', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('跨域图片读取只经 content -> background -> Offscreen 链路，不在 background 直接联网', () => {
        const source = sourceText();
        expect(source).toContain('fetchImageInExtension');
        expect(source).toContain('FLUENT_READ_IMAGE_FETCH_OFFSCREEN');
        expect(source).toContain('fetchRemoteImageForOcr');
        expect(readFileSync(resolve(
            SRC_ROOT,
            'features/image-translation/background/handlers.ts',
        ), 'utf8')).not.toContain('fetch(');
        expect(existsSync(resolve(
            SRC_ROOT,
            'features/image-translation/background/remoteImageFetcher.ts',
        ))).toBe(false);
    });

    it('Offscreen 远程图片拒绝内网目标，接受公网 CDN 图片，后台另行核验图片任务', async () => {
        const request = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: {get: () => 'image/png'},
            arrayBuffer: async () => new Uint8Array([1]).buffer,
        }));

        await expect(fetchRemoteImageForOcr('https://127.0.0.1/rebinding.png', request))
            .rejects.toThrow('内网图片地址');
        expect(request).not.toHaveBeenCalled();
        await expect(fetchRemoteImageForOcr('https://pbs.twimg.com/media/demo.png', request))
            .resolves.toBe('data:image/png;base64,AQ==');
        expect(request).toHaveBeenCalledOnce();
    });

    it('Offscreen 远程图片 helper 文件位于 services，而不是 background', () => {
        expect(existsSync(resolve(
            SRC_ROOT,
            'features/image-translation/background',
            'remoteImageFetcher.ts',
        ))).toBe(false);
        expect(existsSync(resolve(
            SRC_ROOT,
            'features/image-translation/services',
            'remoteImage.ts',
        ))).toBe(true);
    });

    it('Canvas 可读时仍生成本地 data URL，不请求 runtime', async () => {
        const sendMessage = vi.fn();
        const context = {
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({})),
        };
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => context),
            toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['local']))),
        };
        vi.stubGlobal('FileReader', class {
            readyState = 2; result = 'data:image/png;base64,local';
            onload: (() => void) | null = null; onerror: (() => void) | null = null;
            readAsDataURL() {this.onload?.();}
        });
        vi.stubGlobal('browser', {runtime: {id: 'test-id', sendMessage, onMessage: {addListener: vi.fn(), removeListener: vi.fn()}}});
        vi.stubGlobal('document', {URL: 'https://page.example.com/', createElement: vi.fn(() => canvas)});

        await expect(getImageData(imageElement())).resolves.toBe('data:image/png;base64,local');
        expect(context.drawImage).toHaveBeenCalledOnce();
        expect(context.getImageData).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each(['draw', 'serialization'] as const)(
        'Canvas 跨域污染在 %s 阶段失败时把 URL 交给 Offscreen 读取',
        async (failureStage) => {
            const sendMessage = vi.fn();
            const securityError = new DOMException('The canvas has been tainted', 'SecurityError');
            const context = {
                drawImage: vi.fn(() => {if (failureStage === 'draw') throw securityError;}),
            };
            const canvas = {
                width: 0,
                height: 0,
                getContext: vi.fn(() => context),
                toBlob: vi.fn(() => {
                    if (failureStage === 'serialization') throw securityError;
                }),
            };
            vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
            vi.stubGlobal('browser', {runtime: {id: 'test-id', sendMessage, onMessage: {addListener: vi.fn(), removeListener: vi.fn()}}});
            vi.stubGlobal('document', {URL: 'https://page.example.com/', createElement: vi.fn(() => canvas)});
            sendMessage.mockResolvedValue({success: true, image: 'data:image/png;base64,remote'});

            await expect(getImageData(imageElement())).resolves.toBe('data:image/png;base64,remote');
            expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
                type: 'fluentReadImageFetch',
                url: 'https://images.example.com/chart.png',
            }));
        },
    );
});
