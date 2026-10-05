/**
 * @file src/features/settings/model/taskWait.ts
 * 文件职责：为设置页配置保存与服务检测提供所属取消和有界等待。
 * 主要内容：对既有异步任务、AbortSignal 和超时竞速，结束后释放计时器与监听；底层迟到的成功或失败不会变更已结束结果。
 * 模块边界：只结束调用者等待，不强制取消底层任务、不发消息或保存配置；组件负责取消后台请求及检查操作归属。
 */
export async function waitForSettingsTask<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutMessage: string): Promise<T> {
    if (signal.aborted) {
        void operation.catch(() => undefined);
        throw new DOMException('设置操作已取消', 'AbortError');
    }
    let timer!: ReturnType<typeof setTimeout>;
    let cancel!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new DOMException('设置操作已取消', 'AbortError'));
        signal.addEventListener('abort', cancel, {once: true});
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
        return await Promise.race([operation, interrupted]);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
    }
}
