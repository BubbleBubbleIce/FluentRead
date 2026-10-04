/**
 * @file src/features/full-page-translation/content/layout.ts
 * 文件职责：提供全文译文显示时解除宿主页面截断的兼容入口，使 line-clamp、固定高度或 overflow 限制不会遮住已经插入的双语内容。
 * 主要内容：直接重导出逐项与同批布局复核入口；覆盖所有权及写入后的测量失效由 state 模块统一管理。
 * 模块边界：这里不持有翻译文本和 DOM 生命周期，只是布局策略门面；覆盖所有权、MutationObserver 与恢复逻辑集中在 state.ts，译文节点创建由 renderer.ts 负责。
 */
export {
    ensureTranslationTruncationLayout,
    createTranslationTruncationLayoutBatch,
} from "@/src/features/full-page-translation/content/state";
