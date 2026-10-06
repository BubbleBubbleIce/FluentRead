/**
 * @file src/core/config/apiKeys.ts
 *
 * 文件职责：定义按服务保存多个 API Key 的纯配置辅助函数，并兼容旧版单 token 配置。
 * 主要内容：规范化有序 key 列表、仅按自有服务字段读取 key 以及派生旧 token 兼容镜像；保留空行与逗号，单服务查询不扫描其它服务。
 * 模块边界：本文件只处理配置值转换，不读写浏览器存储、不发起网络请求，也不负责 provider/UI 编排。
 */

export type ApiKeys = Record<string, string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKeyRows(value: readonly unknown[]): string[] {
    const rows: string[] = [];
    for (const key of value) {
        if (typeof key === 'string') rows.push(key.trim());
    }
    return rows;
}

/** 保留每个服务的完整顺序；单个字符串（包括逗号）始终作为一个 key。 */
export function normalizeApiKeys(value: unknown): ApiKeys {
    if (!isRecord(value)) return {};
    const entries: Array<[string, string[]]> = [];
    for (const [service, rawKeys] of Object.entries(value)) {
        if (!Array.isArray(rawKeys)) continue;
        entries.push([service, normalizeKeyRows(rawKeys)]);
    }
    return Object.fromEntries(entries);
}

/** 新字段优先；旧 token 仅作为未迁移服务的单 key 兼容来源。 */
export interface ApiKeyConfigSource {
    apiKeys?: unknown;
    token?: unknown;
}

export function getServiceApiKeys(source: ApiKeyConfigSource, service: string): string[] {
    return [...new Set(getServiceApiKeyRows(source, service).filter(Boolean))];
}

/** UI/调用方需要保留空行时使用；规范化仅移除非字符串项，空字符串原样保留。 */
export function getServiceApiKeyRows(source: ApiKeyConfigSource, service: string): string[] {
    if (isRecord(source.apiKeys) && Object.prototype.hasOwnProperty.call(source.apiKeys, service)) {
        const keys = source.apiKeys[service];
        if (Array.isArray(keys)) return normalizeKeyRows(keys);
    }
    if (!isRecord(source.token) || !Object.prototype.hasOwnProperty.call(source.token, service)) return [];
    const token = source.token[service];
    if (typeof token !== 'string') return [];
    const key = token.trim();
    return key ? [key] : [];
}

/** 生成旧 provider 路径仍读取的首个非空 token 镜像。 */
export function apiKeysToToken(apiKeys: unknown): Record<string, string> {
    const normalized = normalizeApiKeys(apiKeys);
    return Object.fromEntries(
        Object.entries(normalized)
            .map(([service, keys]) => [service, keys.find(Boolean)] as const)
            .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    );
}
