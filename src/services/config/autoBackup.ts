/**
 * @file src/services/config/autoBackup.ts
 * 文件职责：定义定时配置备份的领域模型和纯状态转换，保证快照脱敏、格式可校验并始终只保留最近十份。
 * 主要内容：提供 schema、entry/state 类型以及创建基线、解析旧存储、克隆、序列化、追加、查找和与当前安全字段合并恢复的函数。
 * 模块边界：本文件不访问 browser.storage、不安装 alarm 也不发送消息；时间触发由后台 runtime 负责，持久化与跨上下文恢复由 autoBackupStore 编排。
 */
import {
    restoreRestorableConfig,
    toRestorableConfig,
    type RestorableConfig,
} from './history';
import {isConfigRecord, parseStoredConfig} from './schema';

export const CONFIG_AUTO_BACKUP_LIMIT = 10 as const;
export const CONFIG_AUTO_BACKUP_SCHEMA_VERSION = 1 as const;

export interface ConfigAutoBackupEntry {
    version: number;
    savedAt: string;
    config: RestorableConfig;
}

export interface ConfigAutoBackupState {
    schemaVersion: typeof CONFIG_AUTO_BACKUP_SCHEMA_VERSION;
    entries: ConfigAutoBackupEntry[];
    nextVersion: number;
}

export function serializeConfigAutoBackups(value: ConfigAutoBackupState): string {
    return JSON.stringify(value);
}

export function cloneConfigAutoBackups(value: ConfigAutoBackupState): ConfigAutoBackupState {
    return {
        schemaVersion: CONFIG_AUTO_BACKUP_SCHEMA_VERSION,
        entries: value.entries.map((entry) => ({
            version: entry.version,
            savedAt: entry.savedAt,
            config: toRestorableConfig(entry.config),
        })),
        nextVersion: value.nextVersion,
    };
}

export function createBaselineConfigAutoBackups(
    value: unknown,
    savedAt = new Date().toISOString(),
): ConfigAutoBackupState {
    return {
        schemaVersion: CONFIG_AUTO_BACKUP_SCHEMA_VERSION,
        entries: [{version: 1, savedAt, config: toRestorableConfig(value)}],
        nextVersion: 2,
    };
}

export function parseConfigAutoBackups(value: unknown): ConfigAutoBackupState | null {
    if (!isConfigRecord(value) || !Array.isArray(value.entries)) return null;
    if (value.schemaVersion !== undefined && value.schemaVersion !== CONFIG_AUTO_BACKUP_SCHEMA_VERSION) return null;

    const entries: ConfigAutoBackupEntry[] = [];
    // 只投影最终保留的十份有效快照；旧存储即使远超上限，也不必归一化
    // 随即被丢弃的配置。损坏尾项仍逐项跳过，并保持原有有效记录顺序。
    for (let index = value.entries.length - 1; index >= 0 && entries.length < CONFIG_AUTO_BACKUP_LIMIT; index -= 1) {
        const entry = value.entries[index];
        if (!isConfigRecord(entry)
            || typeof entry.version !== 'number'
            || !Number.isSafeInteger(entry.version)
            || entry.version < 1
            || typeof entry.savedAt !== 'string') continue;
        const parsedConfig = parseStoredConfig(entry.config);
        if (!parsedConfig) continue;
        entries.push({version: entry.version, savedAt: entry.savedAt, config: toRestorableConfig(parsedConfig)});
    }
    entries.reverse();

    if (entries.length === 0) return null;
    const maxVersion = entries.reduce((max, entry) => Math.max(max, entry.version), 0);
    const rawNextVersion = typeof value.nextVersion === 'number'
        && Number.isSafeInteger(value.nextVersion)
        && value.nextVersion >= 1
        ? value.nextVersion
        : maxVersion + 1;
    return {
        schemaVersion: CONFIG_AUTO_BACKUP_SCHEMA_VERSION,
        entries,
        nextVersion: Math.max(rawNextVersion, maxVersion + 1),
    };
}

/** 自动备份是时间检查点，即使配置未变化也会追加一份。 */
export function appendConfigAutoBackup(
    state: ConfigAutoBackupState,
    value: unknown,
    savedAt = new Date().toISOString(),
): ConfigAutoBackupState {
    const entries = [...state.entries, {
        version: state.nextVersion,
        savedAt,
        config: toRestorableConfig(value),
    }].slice(-CONFIG_AUTO_BACKUP_LIMIT);
    return {
        schemaVersion: CONFIG_AUTO_BACKUP_SCHEMA_VERSION,
        entries,
        nextVersion: state.nextVersion + 1,
    };
}

export function findConfigAutoBackup(
    state: ConfigAutoBackupState,
    version: number,
): ConfigAutoBackupEntry | null {
    return state.entries.find((entry) => entry.version === version) || null;
}

export {restoreRestorableConfig};
