/**
 * @file src/app/background/configAutoBackupRuntime.ts
 * 文件职责：管理 MV2 与 MV3 后台中的配置自动备份周期，让六小时检查在 service worker 重启后仍能按剩余时间恢复。
 * 主要内容：定义 alarm 端口、周期常量和到期判断，串行执行补偿备份，并安装只响应 FluentRead 专用名称的浏览器 alarm 监听器。
 * 模块边界：本文件只编排时间与 alarm 生命周期，不读写配置存储、不生成快照内容；备份状态和持久化由 services/config 层通过依赖注入提供。
 */
import type {ConfigAutoBackupState} from '@/src/services/config/autoBackup';

export const CONFIG_AUTO_BACKUP_ALARM = 'fluentread-config-auto-backup' as const;
export const CONFIG_AUTO_BACKUP_INTERVAL_MINUTES = 6 * 60;
export const CONFIG_AUTO_BACKUP_INTERVAL_MS = CONFIG_AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000;

export interface ConfigAutoBackupAlarm {
    name: string;
}

export interface ConfigAutoBackupAlarmApi {
    onAlarm: {
        addListener(listener: (alarm: ConfigAutoBackupAlarm) => void): void;
    };
    get(name: string): Promise<ConfigAutoBackupAlarm | undefined>;
    create(name: string, alarmInfo: {delayInMinutes: number; periodInMinutes: number}): void | Promise<void>;
}

export interface ConfigAutoBackupRuntimeDependencies {
    alarms: ConfigAutoBackupAlarmApi;
    ready: Promise<void>;
    getSnapshot(): ConfigAutoBackupState;
    capture(options: {savedAt: string}): Promise<ConfigAutoBackupState>;
    now(): number;
    warn(message: string, error: unknown): void;
}

export interface InstalledConfigAutoBackupRuntime {
    ready: Promise<void>;
}

export function isConfigAutoBackupDue(state: ConfigAutoBackupState, now: number): boolean {
    const lastSavedAt = state.entries.at(-1)?.savedAt;
    if (!lastSavedAt) return true;
    const lastSavedTime = new Date(lastSavedAt).getTime();
    return !Number.isFinite(lastSavedTime)
        || lastSavedTime > now
        || now - lastSavedTime >= CONFIG_AUTO_BACKUP_INTERVAL_MS;
}

function getConfigAutoBackupInitialDelayMinutes(state: ConfigAutoBackupState, now: number): number {
    // alarm 查询期间存储订阅可能更新快照；捕获失败或时间失效时尽快重试。
    if (isConfigAutoBackupDue(state, now)) return 1;
    const lastSavedTime = new Date(state.entries.at(-1)!.savedAt).getTime();
    const remainingMinutes = (
        lastSavedTime + CONFIG_AUTO_BACKUP_INTERVAL_MS - now
    ) / (60 * 1000);
    return Math.max(1, Math.min(CONFIG_AUTO_BACKUP_INTERVAL_MINUTES, remainingMinutes));
}

/**
 * 安装 MV2/MV3 共用的六小时自动备份任务。
 *
 * store 初始化负责“无备份时立即建立基线”；这里在后台重启时只检查一次是否
 * 已错过周期并最多补一份，再复用或创建持久化 alarm。
 */
export function installConfigAutoBackupRuntime(
    dependencies: ConfigAutoBackupRuntimeDependencies,
): InstalledConfigAutoBackupRuntime {
    let captureQueue: Promise<boolean> = Promise.resolve(false);
    const captureIfDue = (): Promise<boolean> => {
        const capture = captureQueue
            .catch(() => false)
            .then(async () => {
                await dependencies.ready;
                const now = dependencies.now();
                if (!isConfigAutoBackupDue(dependencies.getSnapshot(), now)) return false;
                await dependencies.capture({savedAt: new Date(now).toISOString()});
                return true;
            });
        captureQueue = capture;
        return capture;
    };

    dependencies.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== CONFIG_AUTO_BACKUP_ALARM) return;
        void captureIfDue().catch((error) => {
            dependencies.warn('[FluentRead] 自动配置备份执行失败', error);
        });
    });

    const ready = (async () => {
        await dependencies.ready;
        // 一次存储失败不能让缺失的持久 alarm 永久无法建立。
        const captured = await captureIfDue().catch((error) => {
            dependencies.warn('[FluentRead] 自动配置备份执行失败', error);
            return false;
        });
        const alarm = await dependencies.alarms.get(CONFIG_AUTO_BACKUP_ALARM);
        if (!alarm) {
            await dependencies.alarms.create(CONFIG_AUTO_BACKUP_ALARM, {
                delayInMinutes: captured
                    ? CONFIG_AUTO_BACKUP_INTERVAL_MINUTES
                    : getConfigAutoBackupInitialDelayMinutes(
                        dependencies.getSnapshot(),
                        dependencies.now(),
                    ),
                periodInMinutes: CONFIG_AUTO_BACKUP_INTERVAL_MINUTES,
            });
        }
    })().catch((error) => {
        dependencies.warn('[FluentRead] 自动配置备份任务安装失败', error);
    });

    return {ready};
}
