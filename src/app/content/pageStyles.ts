/**
 * @file src/app/content/pageStyles.ts
 * 文件职责：为当前顶层文档或受支持邮件子页面安装公共翻译样式，并让用户的译文外观微调随页面样式一起生效与移除。
 * 主要内容：合并双语译文、页面状态和专属范围样式，让词书绘制复用已安装规则而无需再次使整页样式失效；复用唯一样式标识，安装期间订阅配置同步外观样式节点，
 * 移除函数同时退订并删除两类样式，且绑定 WXT context 失效，供各内容组合根在停用、往返缓存暂停和卸载时清理。
 * 模块边界：仅绑定内联 CSS、配置订阅与文档生命周期，不发现候选、不挂载 UI，也不修改宿主样式表；外观 CSS 的生成与节点管理由 translationAppearance 负责。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config, subscribeConfig} from '@/src/services/config/store';
import translationDisplayStyles from '@/src/ui/styles/translation-display.css?inline';
import pageStyles from './page.css?inline';
import sentenceHighlightStyles from '@/src/ui/styles/bilingual-sentence-highlight.css?inline';
import reencounterStyles from '@/src/ui/styles/vocabulary-reencounter.css?inline';
import {syncTranslationAppearanceStyles} from './translationAppearance';

export function installPageStyles(ctx: ContentScriptContext): () => void {
    const existing = document.getElementById('fluent-read-page-styles');
    if (existing) return () => undefined;
    const style = document.createElement('style');
    style.id = 'fluent-read-page-styles';
    style.textContent = `${translationDisplayStyles}\n${pageStyles}\n${sentenceHighlightStyles}\n${reencounterStyles}`;
    (document.head ?? document.documentElement).appendChild(style);
    // 外观与页面样式同生共灭：配置变化时已显示和后续出现的译文一起更新，无需重新翻译。
    syncTranslationAppearanceStyles(document, config.translationAppearance);
    const unsubscribe = subscribeConfig((nextConfig) => syncTranslationAppearanceStyles(document, nextConfig.translationAppearance));
    const remove = () => {
        unsubscribe();
        style.remove();
        syncTranslationAppearanceStyles(document, null);
    };
    ctx.onInvalidated(remove);
    return remove;
}
