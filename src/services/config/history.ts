/**
 * @file src/services/config/history.ts
 *
 * 文件职责：实现脱敏配置快照的撤销、重做和恢复状态机，限制历史长度并拒绝损坏或含凭据的旧记录。
 * 主要内容：定义 history schema、entry/state/action 类型，提供可恢复字段投影、基线创建、序列化解析、追加快照、目标索引计算和安全恢复。
 * 模块边界：本文件位于配置 application service 层，可协调 core 规则与浏览器存储端口；不包含设置页面组件，也不实现具体翻译供应商协议，调用方应通过公开服务 API 订阅或提交配置。
 */

import {normalizeConfig, type Config} from '@/src/core/config/model';
import {
    extractConfigCredentials,
    mergeConfigCredentials,
    sanitizeConfigCredentials,
    type PublicConfig,
} from '@/src/core/config/credentials';
import {dropCredentialsForChangedDestinations} from '@/src/core/config/credentialBinding';
import {isConfigRecord, parseStoredConfig, serializeConfig} from './schema';

export const CONFIG_HISTORY_LIMIT = 10 as const;
export const CONFIG_HISTORY_SCHEMA_VERSION = 1 as const;

export const CONFIG_NON_RESTORABLE_FIELDS = [
    'count',
    'persistCredentials',
    'videoServiceDefaultMigrated',
    'uiLanguageSetupCompleted',
] as const;

export type ConfigNonRestorableField = typeof CONFIG_NON_RESTORABLE_FIELDS[number];
export type RestorableConfig = Omit<PublicConfig, ConfigNonRestorableField>;

export type ConfigHistoryAction = 'undo' | 'redo' | 'restore';

export interface ConfigHistoryEntry {
    version: number;
    savedAt: string;
    config: RestorableConfig;
}

export interface ConfigHistoryState {
    schemaVersion: typeof CONFIG_HISTORY_SCHEMA_VERSION;
    entries: ConfigHistoryEntry[];
    cursor: number;
    nextVersion: number;
}

export function toPublicConfig(value: unknown): PublicConfig {
    return sanitizeConfigCredentials(normalizeConfig(value)) as PublicConfig;
}

/**
 * 历史与自动备份只保存真正可恢复的用户配置。
 *
 * 翻译计数和内部迁移标记会被运行时频繁更新；旧版 persistCredentials 已废弃。
 * 它们既不应挤占用户最近修改，也不能在恢复旧快照时重新进入当前配置。
 */
export function toRestorableConfig(value: unknown): RestorableConfig {
    // 进入历史/备份的数据已经过运行时迁移。再次归一化一个不含内部标记的
    // 快照时要补回迁移上下文，否则用户主动选择的 DeepLX 会被误判为旧默认值。
    const snapshotSource = isConfigRecord(value)
        ? {...value, videoServiceDefaultMigrated: true}
        : value;
    const restorable = {...toPublicConfig(snapshotSource)} as Record<string, unknown>;
    for (const field of CONFIG_NON_RESTORABLE_FIELDS) delete restorable[field];
    return restorable as RestorableConfig;
}

/** 把可恢复快照与地址仍兼容的当前凭据、统计和内部迁移状态重新组合成完整运行时配置。 */
export function restoreRestorableConfig(value: unknown, currentValue: unknown): Config {
    const current = normalizeConfig(currentValue);
    const next = normalizeConfig({
        ...toRestorableConfig(value),
        count: current.count,
        videoServiceDefaultMigrated: current.videoServiceDefaultMigrated,
        uiLanguageSetupCompleted: current.uiLanguageSetupCompleted,
    });
    const credentials = dropCredentialsForChangedDestinations(
        extractConfigCredentials(current),
        current,
        next,
    );
    return normalizeConfig(mergeConfigCredentials(next, credentials));
}

export function serializeConfigHistory(value: ConfigHistoryState): string {
    return JSON.stringify(value);
}

export function cloneConfigHistory(value: ConfigHistoryState): ConfigHistoryState {
    return {
        schemaVersion: CONFIG_HISTORY_SCHEMA_VERSION,
        entries: value.entries.map((entry) => ({
            version: entry.version,
            savedAt: entry.savedAt,
            config: toRestorableConfig(entry.config),
        })),
        cursor: value.cursor,
        nextVersion: value.nextVersion,
    };
}

export function createBaselineConfigHistory(
    value: unknown,
    persistedRevision: number,
    savedAt = new Date().toISOString(),
): ConfigHistoryState {
    const version = Math.max(1, persistedRevision || 1);
    return {
        schemaVersion: CONFIG_HISTORY_SCHEMA_VERSION,
        entries: [{version, savedAt, config: toRestorableConfig(value)}],
        cursor: 0,
        nextVersion: version + 1,
    };
}

export function parseConfigHistory(value: unknown): ConfigHistoryState | null {
    if (!isConfigRecord(value) || !Array.isArray(value.entries)) return null;
    if (value.schemaVersion !== undefined && value.schemaVersion !== CONFIG_HISTORY_SCHEMA_VERSION) return null;

    const retained: Array<{rawIndex: number; entry: ConfigHistoryEntry}> = [];
    // 从尾部寻找最终保留的有效记录，避免投影将被十份上限丢弃的旧配置。
    // rawIndex 仍对应原始数组，保留损坏记录与裁剪前 cursor 的映射语义。
    for (let rawIndex = value.entries.length - 1; rawIndex >= 0 && retained.length < CONFIG_HISTORY_LIMIT; rawIndex -= 1) {
        const entry = value.entries[rawIndex];
        if (!isConfigRecord(entry)
            || typeof entry.version !== 'number'
            || !Number.isSafeInteger(entry.version)
            || entry.version < 1
            || typeof entry.savedAt !== 'string') continue;
        const parsedConfig = parseStoredConfig(entry.config);
        if (!parsedConfig) continue;
        retained.push({rawIndex, entry: {
            version: entry.version, savedAt: entry.savedAt, config: toRestorableConfig(parsedConfig),
        }});
    }
    if (retained.length === 0) return null;
    retained.reverse();
    const entries = retained.map((item) => item.entry);
    const rawCursor = typeof value.cursor === 'number' && Number.isSafeInteger(value.cursor)
        ? value.cursor
        : value.entries.length - 1;
    let retainedCursor = -1;
    for (const [index, item] of retained.entries()) {
        if (item.rawIndex <= rawCursor) retainedCursor = index;
    }
    const cursor = retainedCursor >= 0 ? retainedCursor : 0;
    const maxVersion = entries.reduce((max, entry) => Math.max(max, entry.version), 0);
    const rawNextVersion = typeof value.nextVersion === 'number'
        && Number.isSafeInteger(value.nextVersion)
        && value.nextVersion >= 1
        ? value.nextVersion
        : maxVersion + 1;

    return {
        schemaVersion: CONFIG_HISTORY_SCHEMA_VERSION,
        entries,
        cursor,
        nextVersion: Math.max(rawNextVersion, maxVersion + 1),
    };
}

export function appendConfigHistorySnapshot(
    state: ConfigHistoryState,
    value: unknown,
    savedAt = new Date().toISOString(),
): ConfigHistoryState | null {
    const normalized = toRestorableConfig(value);
    const currentEntries = state.entries.slice(0, state.cursor + 1).map((entry) => ({
        ...entry,
        config: toRestorableConfig(entry.config),
    }));
    const current = currentEntries[currentEntries.length - 1];
    if (current && serializeConfig(current.config) === serializeConfig(normalized)) return null;

    let entries = [...currentEntries, {
        version: state.nextVersion,
        savedAt,
        config: normalized,
    }];
    if (entries.length > CONFIG_HISTORY_LIMIT) entries = entries.slice(-CONFIG_HISTORY_LIMIT);

    return {
        schemaVersion: CONFIG_HISTORY_SCHEMA_VERSION,
        entries,
        cursor: entries.length - 1,
        nextVersion: state.nextVersion + 1,
    };
}

export function resolveConfigHistoryTargetIndex(
    state: ConfigHistoryState,
    action: ConfigHistoryAction,
    version?: number,
): number {
    if (action === 'undo') return Math.max(0, state.cursor - 1);
    if (action === 'redo') return Math.min(state.entries.length - 1, state.cursor + 1);
    if (version === undefined) return state.cursor;
    const index = state.entries.findIndex((entry) => entry.version === version);
    if (index < 0) throw new Error(`配置历史 v${version} 不存在`);
    return index;
}
