/**
 * @file src/core/config/sensitiveKeys.ts
 * 文件职责：通过字段命名识别未知配置对象中的密码、令牌、授权头和密钥，供导出与差异预览统一脱敏。
 * 主要内容：将 camelCase、连续大写缩写、空格和符号统一为 snake_case，再匹配明确的凭据词族，同时排除 requireApiKey、apiKeyRecoveryMs 等描述安全策略而非秘密的字段。
 * 模块边界：本文件只判断字段名且保持纯函数，不遍历对象、不修改值、不记录任何凭据；递归清理行为由 credentials 和 diff 模块各自调用。
 */
function toSnakeCase(value: string): string {
    return value
        .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

/** 识别未知字段中的常见凭据命名；requireApiKey 之类策略字段不属于秘密。 */
export function isSensitiveConfigKey(key: string): boolean {
    const normalized = toSnakeCase(key);
    if (normalized.startsWith('require_')) return false;
    if (normalized === 'api_key_recovery_ms') return false;
    if (normalized === 'api_key_rotation_enabled') return false;
    if (normalized === 'key' || normalized === 'token' || normalized === 'authorization') return true;
    return /(?:^|_)(?:password|passwd|credential|authorization|secret|api_keys?|access_key|private_key|secret_key|api_token|access_token|refresh_token|auth_token|id_token)(?:_|$)/u.test(normalized);
}
