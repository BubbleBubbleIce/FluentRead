/**
 * @file src/features/local-translation/offscreen/downloads.ts
 *
 * 文件职责：持有独立于设置页和后台 Service Worker 生命周期的模型下载任务。
 * 主要内容：串行排队、即时任务回执、限频进度、磁盘恢复、暂停和删除互斥；重开页面仅订阅已有状态。
 * 模块边界：模型文件读写交给 artifactStore，旧缓存交给 modelCache，推理释放和状态通知由应用组合根注入。
 */
import {
    LOCAL_TRANSLATION_MODELS, getLocalTranslationModel, isLocalTranslationModel,
    type LocalTranslationDownloadSnapshot, type LocalTranslationDownloadState, type LocalTranslationModelId,
} from '@/src/core/config/localTranslation';
import {
    LOCAL_MODEL_CACHE, artifactComplete, artifactDownloadedBytes, downloadTranslationArtifact,
    getTranslationArtifacts, removeTranslationArtifact,
} from './artifactStore';
import {isLocalTranslationModelCached, removeLocalTranslationModelFiles} from './modelCache';
import {supportsHunyuanTranslation} from '@/src/platform/browser/localTranslationSupport';

const STATE_URL = 'https://fluentread.invalid/local-translation-downloads-v2';
export interface LocalTranslationDownloadDependencies {
    onChange?(state: LocalTranslationDownloadSnapshot): Promise<void>;
    beforeRemove?(model: LocalTranslationModelId): void;
}

export function createLocalTranslationDownloadManager(dependencies: LocalTranslationDownloadDependencies = {}) {
    const states = new Map<LocalTranslationModelId, LocalTranslationDownloadState>();
    const jobs = new Map<LocalTranslationModelId, {controller: AbortController; done: Promise<void>; started: boolean}>();
    const removals = new Set<LocalTranslationModelId>();
    let initialized: Promise<void> | undefined;
    let queue = Promise.resolve();
    let writes = Promise.resolve();
    let lastProgress = 0;

    const snapshot = (): LocalTranslationDownloadSnapshot => ({version: 2, tasks: [...states.values()].map((task) => ({...task}))});
    const persist = (): Promise<void> => {
        const state = snapshot();
        const write = writes.then(async () => {
            const cache = await caches.open(LOCAL_MODEL_CACHE);
            await cache.put(STATE_URL, new Response(JSON.stringify(state)));
            await dependencies.onChange?.(state).catch(() => undefined);
        });
        writes = write.catch(() => undefined);
        return write;
    };
    const update = (model: LocalTranslationModelId, patch: Partial<LocalTranslationDownloadState>) => {
        Object.assign(states.get(model)!, patch, {updatedAt: Math.max(Date.now(), states.get(model)!.updatedAt + 1)});
    };
    const initialize = (): Promise<void> => {
        if (initialized) return initialized;
        initialized = (async () => {
            const cache = await caches.open(LOCAL_MODEL_CACHE);
            const response = await cache.match(STATE_URL);
            const saved = await response?.json().catch(() => undefined) as LocalTranslationDownloadSnapshot | undefined;
            for (const model of LOCAL_TRANSLATION_MODELS) {
                const artifacts = getTranslationArtifacts(model.value);
                let downloadedBytes = 0;
                let complete = artifacts.length > 0;
                for (const file of artifacts) {
                    const verified = await artifactComplete(file);
                    downloadedBytes += verified ? file.size : await artifactDownloadedBytes(file);
                    complete &&= verified;
                }
                if (model.legacy) {
                    complete = await isLocalTranslationModelCached(model.value);
                    downloadedBytes = complete ? model.downloadSizeMb * 1_000_000 : 0;
                }
                const previous = saved?.version === 2 && Array.isArray(saved.tasks)
                    ? saved.tasks.find((state) => state.model === model.value) : undefined;
                states.set(model.value, {
                    model: model.value,
                    phase: complete ? 'ready' : downloadedBytes || previous && previous.phase !== 'idle' ? 'paused' : 'idle',
                    downloadedBytes,
                    totalBytes: artifacts.reduce((sum, file) => sum + file.size, 0) || model.downloadSizeMb * 1_000_000,
                    bytesPerSecond: 0,
                    updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1),
                });
            }
            await persist();
        })().catch((error) => { initialized = undefined; throw error; });
        return initialized;
    };
    const requireModel = (value: unknown): LocalTranslationModelId => {
        if (!isLocalTranslationModel(value)) throw new Error('LOCAL_TRANSLATION_INVALID_MODEL');
        return value;
    };

    const run = async (model: LocalTranslationModelId, controller: AbortController): Promise<void> => {
        try {
            if (controller.signal.aborted) return;
            const files = getTranslationArtifacts(model);
            const remaining = states.get(model)!.totalBytes - states.get(model)!.downloadedBytes;
            const quota = await navigator.storage?.estimate?.();
            if (quota?.quota && quota.quota - (quota.usage || 0) < remaining + 32 * 1024 * 1024) {
                throw new DOMException('Insufficient storage', 'QuotaExceededError');
            }
            update(model, {phase: 'downloading', error: undefined});
            await persist();
            const progressByFile = new Map<string, number>();
            for (const file of files) progressByFile.set(`${file.repo}/${file.path}`, await artifactDownloadedBytes(file));
            let lastBytes = states.get(model)!.downloadedBytes;
            let lastAt = Date.now();
            for (const file of files) {
                if (controller.signal.aborted) throw new DOMException('Paused', 'AbortError');
                await downloadTranslationArtifact(file, controller.signal, (bytes, verifying) => {
                    const now = Date.now();
                    progressByFile.set(`${file.repo}/${file.path}`, bytes);
                    const total = [...progressByFile.values()].reduce((sum, value) => sum + value, 0);
                    const elapsed = now - lastAt;
                    if (elapsed >= 500) {
                        update(model, {bytesPerSecond: Math.max(0, (total - lastBytes) * 1000 / elapsed)});
                        lastBytes = total;
                        lastAt = now;
                    }
                    update(model, {phase: verifying ? 'verifying' : 'downloading', downloadedBytes: total});
                    if (now - lastProgress >= 500) {
                        lastProgress = now;
                        void persist().catch(() => controller.abort());
                    }
                });
                if (controller.signal.aborted) throw new DOMException('Paused', 'AbortError');
            }
            update(model, {phase: 'ready', downloadedBytes: states.get(model)!.totalBytes, bytesPerSecond: 0});
        } catch (error) {
            const code = error instanceof Error && error.name === 'QuotaExceededError' ? 'storage'
                : error instanceof Error && error.message === 'LOCAL_TRANSLATION_INTEGRITY' ? 'integrity' : 'network';
            update(model, {phase: controller.signal.aborted ? 'paused' : 'error', bytesPerSecond: 0, error: controller.signal.aborted ? undefined : code});
        } finally {
            if (jobs.get(model)?.controller === controller) jobs.delete(model);
            if (removals.has(model)) update(model, {phase: 'removing'});
            await persist();
        }
    };

    const manager = {
        async status(): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            return snapshot();
        },
        async start(value: unknown): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            if (getLocalTranslationModel(model).legacy) throw new Error('LOCAL_TRANSLATION_LEGACY_MODEL');
            if (getLocalTranslationModel(model).engine === 'hunyuan' && !supportsHunyuanTranslation()) {
                throw new Error('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED');
            }
            if (removals.has(model)) throw new Error('LOCAL_TRANSLATION_REMOVING');
            const existing = jobs.get(model);
            if (existing?.controller.signal.aborted) {
                await existing.done;
                return manager.start(model);
            }
            if (existing || states.get(model)!.phase === 'ready') return snapshot();
            const controller = new AbortController();
            update(model, {phase: 'queued', error: undefined, bytesPerSecond: 0});
            const saved = persist();
            const job = {controller, done: Promise.resolve(), started: false};
            const done = queue.then(() => saved).then(() => {
                if (jobs.get(model) !== job) return;
                job.started = true;
                return run(model, controller);
            }).catch(async () => {
                if (jobs.get(model) !== job) return;
                jobs.delete(model);
                update(model, {phase: 'error', error: 'storage', bytesPerSecond: 0});
                await persist().catch(() => undefined);
            });
            job.done = done;
            jobs.set(model, job);
            queue = done.catch(() => undefined);
            await saved;
            return snapshot();
        },
        async pause(value: unknown): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            const job = jobs.get(model);
            job?.controller.abort();
            if (job) {
                update(model, {phase: 'paused', bytesPerSecond: 0});
                if (!job.started) jobs.delete(model);
            }
            await persist();
            return snapshot();
        },
        async remove(value: unknown): Promise<LocalTranslationDownloadSnapshot> {
            await initialize();
            const model = requireModel(value);
            if (removals.has(model)) return snapshot();
            removals.add(model);
            const job = jobs.get(model);
            job?.controller.abort();
            update(model, {phase: 'removing', bytesPerSecond: 0});
            try {
                // 状态写入也是删除操作的一部分；写入失败仍须释放互斥并允许重试。
                await persist();
                if (job?.started) await job.done;
                else if (job) jobs.delete(model);
                dependencies.beforeRemove?.(model);
                if (getLocalTranslationModel(model).legacy) await removeLocalTranslationModelFiles(model);
                else for (const file of getTranslationArtifacts(model)) await removeTranslationArtifact(file);
                update(model, {phase: 'idle', downloadedBytes: 0, error: undefined});
            } catch (error) {
                update(model, {phase: 'error', error: 'storage'});
                throw error;
            } finally {
                removals.delete(model);
                await persist();
            }
            return snapshot();
        },
    };
    return manager;
}
