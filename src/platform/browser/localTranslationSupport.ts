/**
 * @file src/platform/browser/localTranslationSupport.ts
 *
 * 文件职责：在下载混元模型前检查当前浏览器的必要运行能力。
 * 主要内容：验证最小 memory64 模块，不分配模型内存，也不依赖易过期的浏览器版本判断。
 * 模块边界：仅探测 WebAssembly 能力，不下载文件、不启动 Worker、不修改浏览器设置。
 */
export function supportsHunyuanTranslation(): boolean {
    try {
        // 与内置 runtime 匹配的零页 memory64 模块，不分配模型内存。
        return typeof WebAssembly !== 'undefined'
            && typeof WebAssembly.validate === 'function'
            && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]));
    } catch {
        // 受限或残缺的运行环境按不支持处理，不能中断设置和下载入口。
        return false;
    }
}
