import {afterEach, describe, expect, it, vi} from 'vitest';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local audio hardware WebGPU probe', () => {
    it('uses a high-performance hardware adapter without allocating a device', async () => {
        const requestAdapter = vi.fn().mockResolvedValue({info: {vendor: 'apple', architecture: 'metal'}});
        vi.stubGlobal('navigator', {gpu: {requestAdapter}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: 'apple / metal'});
        expect(requestAdapter).toHaveBeenCalledWith({powerPreference: 'high-performance'});
    });

    it.each([
        undefined,
        {},
        {gpu: {}},
        {gpu: {requestAdapter: async () => null}},
        {gpu: {requestAdapter: () => {throw new Error('synchronous driver failure');}}},
        {gpu: {requestAdapter: async () => {throw new Error('driver unavailable');}}},
        {gpu: {requestAdapter: async () => ({isFallbackAdapter: true})}},
        ...['SwiftShader', 'software', 'llvmpipe', 'fallback'].map(description => ({gpu: {requestAdapter: async () => ({info: {description}})}})),
    ])('falls back when hardware is unavailable (%#)', async (runtimeNavigator) => {
        vi.stubGlobal('navigator', runtimeNavigator);
        await expect(probeWebGpu()).resolves.toEqual({available: false, info: ''});
    });

    it.each(['HeadlessChrome', 'HeadlessEdge'])('rejects actual software adapters in %s', async userAgent => {
        for (const adapter of [
            {isFallbackAdapter: true},
            {info: {isFallbackAdapter: true}},
            {info: {description: 'SwiftShader'}},
        ]) {
            const requestAdapter = vi.fn().mockResolvedValue(adapter);
            vi.stubGlobal('navigator', {userAgent, gpu: {requestAdapter}});
            await expect(probeWebGpu()).resolves.toEqual({available: false, info: ''});
            expect(requestAdapter).toHaveBeenCalledOnce();
            expect(requestAdapter).toHaveBeenCalledWith({powerPreference: 'high-performance'});
        }
    });

    it.each(['HeadlessChrome', 'HeadlessEdge'])('accepts actual hardware adapters in %s without allocating a device', async userAgent => {
        const requestDevice = vi.fn();
        const requestAdapter = vi.fn().mockResolvedValue({
            isFallbackAdapter: false,
            info: {isFallbackAdapter: false, vendor: 'apple', architecture: 'metal'},
            requestDevice,
        });
        vi.stubGlobal('navigator', {userAgent, gpu: {requestAdapter}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: 'apple / metal'});
        expect(requestAdapter).toHaveBeenCalledOnce();
        expect(requestAdapter).toHaveBeenCalledWith({powerPreference: 'high-performance'});
        expect(requestDevice).not.toHaveBeenCalled();
    });

    it('does not require optional adapter information', async () => {
        vi.stubGlobal('navigator', {gpu: {requestAdapter: async () => ({})}});
        await expect(probeWebGpu()).resolves.toEqual({available: true, info: ''});
    });

    it('bounds a stalled driver probe and ignores its late result', async () => {
        vi.useFakeTimers();
        let release!: (adapter: {}) => void;
        vi.stubGlobal('navigator', {gpu: {requestAdapter: () => new Promise(resolve => { release = resolve; })}});
        const probe = probeWebGpu();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(probe).resolves.toEqual({available: false, info: ''});
        release({});
        await expect(probe).resolves.toEqual({available: false, info: ''});
        expect(vi.getTimerCount()).toBe(0);
    });
});
