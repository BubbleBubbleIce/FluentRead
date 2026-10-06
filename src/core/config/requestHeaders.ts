/**
 * @file src/core/config/requestHeaders.ts
 * 文件职责：定义用户主动指定的 Origin/Referer 移除名单，校验并归一化精确域名。
 * 主要内容：默认空名单、最多一百项、独立请求头开关和确定性去重；拒绝 URL、通配符、端口、路径及凭据，国际化域名转 ASCII 后仍遵守总长度上限。
 * 模块边界：只处理纯配置，不访问浏览器或网络；网络规则的安装由 platform 和后台组合根负责。
 */
export const MAX_REQUEST_HEADER_RULES = 100;
export interface RequestHeaderRule {
    domain: string;
    removeOrigin: boolean;
    removeReferer: boolean;
}

/** 域名精确匹配，不隐式包含子域；也支持 localhost、IPv4 和括号包围的 IPv6。 */
export function normalizeRequestHeaderDomain(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const domain = value.trim().toLowerCase();
    if (!domain || domain.length > 253 || /[\s/@?#%*\\]/u.test(domain)) return null;
    if (domain.includes(':') && !/^\[[a-f0-9:]+\]$/u.test(domain)) return null;
    try {
        const url = new URL(`https://${domain}/`);
        if (url.hostname !== domain && !/[^\x00-\x7f]/u.test(domain)) return null;
        const host = url.hostname;
        if (host.length > 253) return null;
        if (host.startsWith('[')) return host;
        if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
        return host;
    } catch {
        return null;
    }
}

export function normalizeRequestHeaderRules(value: unknown): RequestHeaderRule[] {
    if (!Array.isArray(value)) return [];
    const rules = new Map<string, RequestHeaderRule>();
    for (const item of value.slice(0, MAX_REQUEST_HEADER_RULES)) {
        if (!item || typeof item !== 'object') continue;
        const domain = normalizeRequestHeaderDomain(item.domain);
        if (!domain) continue;
        const previous = rules.get(domain);
        rules.set(domain, {domain,
            removeOrigin: item.removeOrigin === true || previous?.removeOrigin === true,
            removeReferer: item.removeReferer === true || previous?.removeReferer === true});
    }
    return [...rules.values()];
}
