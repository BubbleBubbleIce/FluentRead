/**
 * @file src/core/config/modelThinking.ts
 *
 * 文件职责：定义模型级 Thinking 偏好的持久化形状与纯读取规则，让设置页、配置迁移和翻译请求使用同一组“服务 + 实际模型”语义。
 * 主要内容：严格规范化嵌套布尔映射、只读取自身服务条目的缺省关闭状态，并提供不可变写入与删除 helper，避免继承服务属性产生虚假偏好，以及模型标识中的斜杠或冒号造成扁平键碰撞。
 * 模块边界：本文件只处理公开配置数据，不判断供应商协议、不构造网络请求也不读写存储；协议字段映射由翻译模板层负责。
 */

export type ModelThinkingMapping = Record<string, Record<string, boolean>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeModelThinkingMapping(value: unknown): ModelThinkingMapping {
    if (!isRecord(value)) return {};
    const normalized: Array<[string, Record<string, boolean>]> = [];
    for (const [service, models] of Object.entries(value)) {
        if (!service || !isRecord(models)) continue;
        const modelEntries = Object.entries(models)
            .filter((entry): entry is [string, boolean] => (
                Boolean(entry[0].trim()) && typeof entry[1] === 'boolean'
            ));
        if (modelEntries.length > 0) normalized.push([service, Object.fromEntries(modelEntries)]);
    }
    return Object.fromEntries(normalized);
}

export function isModelThinkingEnabled(
    mapping: ModelThinkingMapping | undefined,
    service: string,
    model: string,
): boolean {
    return hasModelThinkingPreference(mapping, service, model) && mapping![service][model] === true;
}

export function hasModelThinkingPreference(
    mapping: ModelThinkingMapping | undefined,
    service: string,
    model: string,
): boolean {
    return !!mapping && Object.hasOwn(mapping, service)
        && Object.prototype.hasOwnProperty.call(mapping[service] || {}, model);
}

export function withModelThinkingPreference(
    mapping: ModelThinkingMapping | undefined,
    service: string,
    model: string,
    enabled: boolean,
): ModelThinkingMapping {
    const normalized = normalizeModelThinkingMapping(mapping);
    if (!service || !model.trim()) return normalized;
    return {
        ...normalized,
        [service]: {
            ...(normalized[service] || {}),
            [model]: enabled,
        },
    };
}

export function withoutModelThinkingPreference(
    mapping: ModelThinkingMapping | undefined,
    service: string,
    model?: string,
): ModelThinkingMapping {
    const normalized = normalizeModelThinkingMapping(mapping);
    if (!model) {
        delete normalized[service];
        return normalized;
    }
    const models = Object.hasOwn(normalized, service) ? normalized[service] : undefined;
    if (!models) return normalized;
    delete models[model];
    if (Object.keys(models).length === 0) delete normalized[service];
    return normalized;
}
