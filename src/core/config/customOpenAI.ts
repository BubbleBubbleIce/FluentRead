/**
 * @file src/core/config/customOpenAI.ts
 *
 * 文件职责：定义用户自建 OpenAI-compatible 翻译服务的轻量配置契约和纯转换函数，供配置迁移、动态服务目录与设置界面共同复用。
 * 主要内容：校验完整稳定 ID，规范化任意数量的名称、端点和模型列表，提供动态服务选项、标签、模型查询、高熵 ID 生成及不可变删除 helpers；身份不得通过截断变成另一服务。
 * 模块边界：本文件属于 core 领域层，只处理不含凭据的公开 profile 数据；API Key 继续由 Config.token[serviceId] 和专用凭据存储持有，本文件只使用运行时随机源生成身份，不读写存储、不访问扩展 API，也不发起网络请求。
 */

export const MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER = 50 as const;
export const MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH = 80 as const;
export const MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH = 2_048 as const;
export const MAX_CUSTOM_OPENAI_MODEL_LENGTH = 256 as const;
export const CUSTOM_OPENAI_PROVIDER_ID_PREFIX = 'custom:' as const;
export const LEGACY_CUSTOM_OPENAI_PROVIDER_ID = 'custom' as const;
export const CUSTOM_OPENAI_RESERVED_MODEL_ID = '自定义模型' as const;

const CUSTOM_OPENAI_PROVIDER_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const CUSTOM_OPENAI_PROVIDER_ID_ATTEMPTS = 32;
let fallbackIdSequence = 0;

export interface CustomOpenAIProvider {
    id: string;
    name: string;
    endpoint: string;
    models: string[];
}

export interface CustomOpenAIServiceOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string {
    return typeof value === 'string' ? value.trim().slice(0, maximumLength).trim() : '';
}

function ownProviderValue(provider: Record<string, unknown>, field: string): unknown {
    return Object.prototype.hasOwnProperty.call(provider, field) ? provider[field] : undefined;
}

export function normalizeCustomOpenAIModels(
    value: unknown,
    excludedModels: ReadonlySet<string> = new Set(),
): string[] {
    if (!Array.isArray(value)) return [];
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const model = boundedString(item, MAX_CUSTOM_OPENAI_MODEL_LENGTH);
        if (!model
            || model === CUSTOM_OPENAI_RESERVED_MODEL_ID
            || excludedModels.has(model)
            || seen.has(model)) continue;
        seen.add(model);
        models.push(model);
        if (models.length >= MAX_CUSTOM_OPENAI_MODELS_PER_PROVIDER) break;
    }
    return models;
}

/** 只接受保留的旧 ID 或带 custom: 前缀的稳定新 ID。 */
export function isCustomOpenAIProviderId(value: unknown): value is string {
    if (value === LEGACY_CUSTOM_OPENAI_PROVIDER_ID) return true;
    if (typeof value !== 'string' || !value.startsWith(CUSTOM_OPENAI_PROVIDER_ID_PREFIX)) return false;
    return CUSTOM_OPENAI_PROVIDER_SUFFIX.test(value.slice(CUSTOM_OPENAI_PROVIDER_ID_PREFIX.length));
}

/**
 * 将导入或存储中的 profile 列表收敛为可持久化结构。无效项被忽略，重复 ID
 * 保留第一项；函数不生成随机 ID，因此可以安全地在每次配置读取时重复执行。
 */
export function normalizeCustomOpenAIProviders(value: unknown): CustomOpenAIProvider[] {
    if (!Array.isArray(value)) return [];
    const providers: CustomOpenAIProvider[] = [];
    const seenIds = new Set<string>();
    for (const item of value) {
        if (!isRecord(item)) continue;
        const rawId = ownProviderValue(item, 'id');
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (!isCustomOpenAIProviderId(id) || seenIds.has(id)) continue;
        seenIds.add(id);
        const fallbackIndex = providers.length + 1;
        const name = boundedString(ownProviderValue(item, 'name'), MAX_CUSTOM_OPENAI_PROVIDER_NAME_LENGTH)
            || (id === LEGACY_CUSTOM_OPENAI_PROVIDER_ID ? '自定义接口' : `自定义接口 ${fallbackIndex}`);
        providers.push({
            id,
            name,
            endpoint: boundedString(ownProviderValue(item, 'endpoint'), MAX_CUSTOM_OPENAI_PROVIDER_ENDPOINT_LENGTH),
            models: normalizeCustomOpenAIModels(ownProviderValue(item, 'models')),
        });
    }
    return providers;
}

export function getCustomOpenAIProvider(
    providers: readonly CustomOpenAIProvider[] | undefined,
    serviceId: string,
): CustomOpenAIProvider | undefined {
    return providers?.find((provider) => provider.id === serviceId);
}

export function isConfiguredCustomOpenAIProvider(
    providers: readonly CustomOpenAIProvider[] | undefined,
    serviceId: string,
): boolean {
    return getCustomOpenAIProvider(providers, serviceId) !== undefined;
}

export function getCustomOpenAIProviderLabel(
    providers: readonly CustomOpenAIProvider[] | undefined,
    serviceId: string,
): string {
    return getCustomOpenAIProvider(providers, serviceId)?.name || serviceId;
}

export function getCustomOpenAIProviderModels(
    providers: readonly CustomOpenAIProvider[] | undefined,
    serviceId: string,
): string[] {
    return [...(getCustomOpenAIProvider(providers, serviceId)?.models || [])];
}

export function getCustomOpenAIServiceOptions(
    providers: readonly CustomOpenAIProvider[] | undefined,
): CustomOpenAIServiceOption[] {
    return (providers || []).map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.endpoint || 'OpenAI-compatible 自定义接口',
    }));
}

/** 用动态 profile 替换旧静态 custom 目录项；没有 profile 时不显示一个不可用的空服务。 */
export function withCustomOpenAIServiceOptions<T extends CustomOpenAIServiceOption>(
    options: readonly T[],
    providers: readonly CustomOpenAIProvider[] | undefined,
): Array<T | CustomOpenAIServiceOption> {
    return [
        ...options.filter((option) => option.value !== LEGACY_CUSTOM_OPENAI_PROVIDER_ID),
        ...getCustomOpenAIServiceOptions(providers),
    ];
}

function createCustomOpenAIProviderIdSuffix(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    fallbackIdSequence = (fallbackIdSequence + 1) % Number.MAX_SAFE_INTEGER;
    return [
        Date.now().toString(36),
        fallbackIdSequence.toString(36),
        Math.random().toString(36).slice(2, 14),
    ].join('-');
}

/**
 * 生成高熵且未被当前列表占用的稳定 ID。ID 不再从最小空位递增，避免删除服务后
 * 复用旧身份，继而把按 serviceId 保存的历史用量、凭据或缓存误归属给新服务。
 */
export function createNextCustomOpenAIProviderId(
    providers: readonly CustomOpenAIProvider[] | undefined,
    createSuffix: () => string = createCustomOpenAIProviderIdSuffix,
): string {
    const used = new Set((providers || []).map((provider) => provider.id));
    for (let attempt = 0; attempt < CUSTOM_OPENAI_PROVIDER_ID_ATTEMPTS; attempt += 1) {
        const rawSuffix = createSuffix();
        const suffix = typeof rawSuffix === 'string' ? rawSuffix.trim() : '';
        const candidate = `${CUSTOM_OPENAI_PROVIDER_ID_PREFIX}${suffix}`;
        if (isCustomOpenAIProviderId(candidate) && !used.has(candidate)) return candidate;
    }
    throw new Error('无法生成唯一的自定义服务 ID');
}

export function removeCustomOpenAIProvider(
    providers: readonly CustomOpenAIProvider[] | undefined,
    serviceId: string,
): CustomOpenAIProvider[] {
    return (providers || []).filter((provider) => provider.id !== serviceId).map((provider) => ({
        ...provider,
        models: [...provider.models],
    }));
}
