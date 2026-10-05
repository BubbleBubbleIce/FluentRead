import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {waitForSettingsTask} from '@/src/features/settings/model/taskWait';
function pending<T>() {let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('设置操作的所属取消和等待预算', () => {
    it('成功返回原结果并释放超时与取消监听', async () => {
        const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');const result = {id: 1};
        await expect(waitForSettingsTask(Promise.resolve(result), controller.signal, 10, 'timed out')).resolves.toBe(result);
        expect(remove).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);controller.abort();
    });
    it('底层错误原样传播，后续取消不替换已确定的错误', async () => {
        const controller = new AbortController(), error = new Error('save failed');
        await expect(waitForSettingsTask(Promise.reject(error), controller.signal, 10, 'timed out')).rejects.toBe(error);
        controller.abort();expect(vi.getTimerCount()).toBe(0);
    });
    it('超时结束不合作的底层等待，迟到拒绝不会成为未处理错误', async () => {
        const controller = new AbortController(), source = pending<void>();
        const job = waitForSettingsTask(source.promise, controller.signal, 10, 'response timeout');const failure = expect(job).rejects.toThrow('response timeout');
        await vi.advanceTimersByTimeAsync(10);await failure;expect(vi.getTimerCount()).toBe(0);source.reject(new Error('late'));await Promise.resolve();
    });
    it.each(['resolve', 'reject'])('取消结束不合作的底层等待，迟到%s保持取消结果', async outcome => {
        const controller = new AbortController(), source = pending<string>();const job = waitForSettingsTask(source.promise, controller.signal, 10, 'timeout');
        const failure = expect(job).rejects.toMatchObject({name: 'AbortError'});controller.abort();await failure;expect(vi.getTimerCount()).toBe(0);
        if (outcome === 'resolve') source.resolve('late');else source.reject(new Error('late'));await Promise.resolve();
    });
    it('传入已取消信号立即退出，消费底层拒绝且不创建计时器或监听', async () => {
        const controller = new AbortController();controller.abort();const listen = vi.spyOn(controller.signal, 'addEventListener');
        await expect(waitForSettingsTask(Promise.reject(new Error('late port')), controller.signal, 10, 'timeout')).rejects.toMatchObject({name: 'AbortError'});
        expect(listen).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('同信号两个等待独立释放监听，完成一个不影响另一个取消', async () => {
        const controller = new AbortController(), source = pending<void>();const still = waitForSettingsTask(source.promise, controller.signal, 100, 'timeout');
        const failure = expect(still).rejects.toMatchObject({name: 'AbortError'});
        await waitForSettingsTask(Promise.resolve(), controller.signal, 10, 'timeout');expect(vi.getTimerCount()).toBe(1);
        controller.abort();await failure;expect(vi.getTimerCount()).toBe(0);
    });
    it('最先确定的取消保持原因，后续超时不执行；超时后取消也不改写原因', async () => {
        const first = new AbortController();const cancelled = waitForSettingsTask(new Promise<void>(() => {}), first.signal, 10, 'timeout');
        const cancelCheck = expect(cancelled).rejects.toMatchObject({name: 'AbortError'});first.abort();await cancelCheck;await vi.advanceTimersByTimeAsync(10);
        const second = new AbortController();const timeout = waitForSettingsTask(new Promise<void>(() => {}), second.signal, 10, 'first timeout');
        const timeoutCheck = expect(timeout).rejects.toThrow('first timeout');await vi.advanceTimersByTimeAsync(10);second.abort();await timeoutCheck;
        expect(vi.getTimerCount()).toBe(0);
    });
});
