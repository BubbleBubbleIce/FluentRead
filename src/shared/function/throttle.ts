/**
 * @file src/shared/function/throttle.ts
 *
 * 文件职责：提供保留 this 与参数类型的节流函数，限制高频事件处理器在指定时间窗口内的执行次数。
 * 主要内容：throttle 首次立即执行，后续在时间差达到 intervalMs 时以前缘方式调用目标函数；系统时钟回退时重建窗口，窗口内事件直接丢弃，并保留原始 this 与参数类型。 可核对的公开符号包括 throttle。
 * 模块边界：本文件属于 shared 小型公共层，仅提供无状态或低语义耦合的类型与工具；不读取 FluentRead 配置、不调用 provider、不注册入口或持有 feature 生命周期，使用者需自行处理业务政策。
 */

/** 创建保留调用方 `this` 与参数类型的前缘节流函数。 */
export function throttle<TThis, TArgs extends unknown[]>(
    fn: (this: TThis, ...args: TArgs) => void,
    intervalMs: number,
): (this: TThis, ...args: TArgs) => void {
    let lastRunAt: number | undefined;

    return function throttled(this: TThis, ...args: TArgs): void {
        const now = Date.now();
        if (lastRunAt !== undefined && now >= lastRunAt && now - lastRunAt < intervalMs) return;

        // 步骤 1：先更新窗口，再调用目标函数，避免目标函数同步重入绕过节流。
        lastRunAt = now;
        fn.apply(this, args);
    };
}
