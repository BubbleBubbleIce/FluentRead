/**
 * @file src/services/config/schema.ts
 *
 * 文件职责：定义浏览器存储中配置记录的修订字段与安全解析、序列化规则，作为配置服务的持久化 wire format。
 * 主要内容：提供对象解析与 JSON 序列化，拒绝缺少自有基础字段的记录，仅消费自有且合法的内部 revision；不可序列化值保持 JSON.stringify 的异常契约。公开符号包括 CONFIG_REVISION_FIELD、isConfigRecord、getStoredConfigRevision、parseStoredConfig、serializeConfig。
 * 模块边界：本文件位于配置 application service 层，可协调 core 规则与浏览器存储端口；不包含设置页面组件，也不实现具体翻译供应商协议，调用方应通过公开服务 API 订阅或提交配置。
 */

export const CONFIG_REVISION_FIELD = '__fluentConfigRevision' as const;

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getStoredConfigRevision(value: unknown): number {
    if (!isConfigRecord(value)) return 0;
    const revision = Object.hasOwn(value, CONFIG_REVISION_FIELD) ? value[CONFIG_REVISION_FIELD] : undefined;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : 0;
}

export function parseStoredConfig(value: unknown): Record<string, unknown> | null {
    let parsed = value;

    if (typeof parsed === 'string') {
        if (!parsed.trim()) return null;
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }

    if (!isConfigRecord(parsed)) return null;
    if (!['on', 'service', 'from', 'to'].every((key) => Object.hasOwn(parsed, key))) return null;
    return parsed;
}

export function serializeConfig(value: unknown): string {
    return JSON.stringify(value);
}
