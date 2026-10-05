/**
 * @file src/core/i18n/numberFormat.ts
 * 文件职责：为固定数字展示规则复用原生本地化格式器，减少列表和统计面板的重复初始化。
 * 主要内容：每套规则独立保留最多八种语言的格式器，缓存满时淘汰最早加入的语言。
 * 模块边界：只缓存 Intl.NumberFormat，不缓存业务值，不决定单位或修改聚合数据。
 */

const MAX_CACHED_LANGUAGES = 8;

export function createNumberFormatter(options: Intl.NumberFormatOptions): (language: string) => Intl.NumberFormat {
    const rules = {...options};
    const formatters = new Map<string, Intl.NumberFormat>();
    return (language) => {
        const cached = formatters.get(language);
        if (cached) return cached;
        const formatter = new Intl.NumberFormat(language, rules);
        if (formatters.size === MAX_CACHED_LANGUAGES) {
            formatters.delete(formatters.keys().next().value as string);
        }
        formatters.set(language, formatter);
        return formatter;
    };
}
