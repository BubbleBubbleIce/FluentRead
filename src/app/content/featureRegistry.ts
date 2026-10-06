/**
 * @file src/app/content/featureRegistry.ts
 * 文件职责：提供 content 功能的静态注册表和激活所有权管理，使站点启停、能力门控与异步 mount/unmount 按统一生命周期执行。
 * 主要内容：定义 feature runtime/definition/result 类型，按 isEnabled 选择挂载，以实际状态判断 UI 就绪、以注册表记录清理所有权，使用 ensureContentFeatureMounted 处理迟到挂载，并在失效或异常时精确卸载与上报阶段。
 * 模块边界：注册表只编排 feature 公共生命周期，不知道悬浮、划词、OCR 等业务细节，不直接修改配置或 DOM；具体挂载器及能力判断由 runtime 注入。
 */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { ensureContentFeatureMounted } from './featureLifecycle';
import {
    browserCapabilities,
    type BrowserCapabilities,
    type BrowserFeatureCapability,
} from '@/src/platform/browser/capabilities';

export interface ContentFeatureRuntime {
    ctx: ContentScriptContext;
    signal: AbortSignal;
    isCurrent: () => boolean;
}

export interface ContentFeatureDefinition {
    id: string;
    requiredCapability?: BrowserFeatureCapability;
    isEnabled: () => boolean;
    mount: (runtime: ContentFeatureRuntime) => unknown | PromiseLike<unknown>;
    unmount?: () => void;
    isMounted?: () => boolean;
}

export type ContentFeatureMountResult =
    | {id: string; status: 'mounted'}
    | {id: string; status: 'skipped'}
    | {id: string; status: 'failed'; error: unknown};

export type ContentFeaturePhase = 'mount' | 'unmount';

export interface ContentFeatureRegistryOptions {
    capabilities?: BrowserCapabilities;
    onError?: (featureId: string, phase: ContentFeaturePhase, error: unknown) => void;
}

export function rejectUnsupportedContentFeature(
    supported: boolean,
    unmount: () => void,
    sendResponse: (response: unknown) => void,
    error: string,
): boolean {
    if (supported) return false;
    unmount();
    sendResponse({status: 'unsupported', error});
    return true;
}

/**
 * 内容脚本功能注册表。
 *
 * 这个模块只管理功能生命周期，不读取业务配置，也不直接触碰页面 DOM。
 * 具体功能通过 isEnabled/mount/unmount 暴露能力，content 入口只负责组装。
 */
export class ContentFeatureRegistry {
    private readonly features: ContentFeatureDefinition[];
    private readonly options: ContentFeatureRegistryOptions;
    private readonly capabilities: BrowserCapabilities;
    private readonly mountedFeatureIds = new Set<string>();
    private readonly pendingMounts = new Map<string, Promise<ContentFeatureMountResult>>();
    private activeRuntime: ContentFeatureRuntime | null = null;

    constructor(features: ContentFeatureDefinition[], options: ContentFeatureRegistryOptions = {}) {
        this.features = [...features];
        this.options = options;
        this.capabilities = options.capabilities ?? browserCapabilities;
    }

    async mountEnabled(runtime: ContentFeatureRuntime): Promise<ContentFeatureMountResult[]> {
        this.activeRuntime = runtime;
        return this.reconcileEnabled();
    }

    /** 按最新配置协调已激活页面：关闭项立即卸载，开启项按 ownership 幂等挂载。 */
    async reconcileEnabled(): Promise<ContentFeatureMountResult[]> {
        const runtime = this.activeRuntime;
        if (!runtime || runtime.signal.aborted || !runtime.isCurrent()) {
            return this.features.map(({id}) => ({id, status: 'skipped'}));
        }
        const results: ContentFeatureMountResult[] = [];

        // 步骤 1：在任何异步等待前先释放已关闭或能力不支持的功能。
        for (const feature of this.features) {
            // 宿主断开不代表其监听器已经释放；关闭时仍清理注册表持有的旧实例。
            if (!this.isFeatureDesired(feature)
                && (this.mountedFeatureIds.has(feature.id) || this.isFeatureMounted(feature))) {
                this.unmountFeature(feature);
            }
        }

        for (const feature of this.features) {
            // 步骤 2：先确认 WXT 上下文和当前激活都有效，旧激活不再启动新功能。
            if (runtime.signal.aborted || !runtime.isCurrent()) {
                results.push({id: feature.id, status: 'skipped'});
                continue;
            }
            if (!this.isFeatureDesired(feature)) {
                results.push({id: feature.id, status: 'skipped'});
                continue;
            }
            results.push(await this.mountFeature(feature, runtime));
        }

        return results;
    }

    private isFeatureDesired(feature: ContentFeatureDefinition): boolean {
        return (!feature.requiredCapability || this.capabilities[feature.requiredCapability])
            && feature.isEnabled();
    }

    private isFeatureMounted(feature: ContentFeatureDefinition): boolean {
        // 有实际状态查询时，false 必须允许恢复；只有无查询的功能使用 Set 去重。
        return feature.isMounted ? feature.isMounted() : this.mountedFeatureIds.has(feature.id);
    }

    private mountFeature(
        feature: ContentFeatureDefinition,
        runtime: ContentFeatureRuntime,
    ): Promise<ContentFeatureMountResult> {
        const pending = this.pendingMounts.get(feature.id);
        if (pending) return pending;
        if (this.isFeatureMounted(feature)) {
            this.mountedFeatureIds.add(feature.id);
            return Promise.resolve({id: feature.id, status: 'mounted'});
        }

        let request!: Promise<ContentFeatureMountResult>;
        request = this.performFeatureMount(feature, runtime).finally(() => {
            if (this.pendingMounts.get(feature.id) === request) this.pendingMounts.delete(feature.id);
        });
        this.pendingMounts.set(feature.id, request);
        return request;
    }

    private async performFeatureMount(
        feature: ContentFeatureDefinition,
        runtime: ContentFeatureRuntime,
    ): Promise<ContentFeatureMountResult> {
        try {
            // 步骤 3：带 isMounted 的异步 UI 复用一次重试策略；普通功能由 registry ownership 去重。
            if (feature.isMounted) {
                await ensureContentFeatureMounted({
                    mount: () => feature.mount(runtime),
                    isMounted: feature.isMounted,
                    isStillDesired: () => !runtime.signal.aborted
                        && runtime.isCurrent()
                        && this.isFeatureDesired(feature),
                });
            } else {
                await feature.mount(runtime);
            }

            // 步骤 4：迟到挂载必须复验 activation 与最新配置，不能复活已关闭功能。
            if (runtime.signal.aborted || !runtime.isCurrent()) {
                return {id: feature.id, status: 'skipped'};
            }
            if (!this.isFeatureDesired(feature)) {
                this.unmountFeature(feature);
                return {id: feature.id, status: 'skipped'};
            }
            if (feature.isMounted && !feature.isMounted()) {
                throw new Error(`内容功能挂载后未就绪: ${feature.id}`);
            }

            this.mountedFeatureIds.add(feature.id);
            return {id: feature.id, status: 'mounted'};
        } catch (error) {
            if (runtime.signal.aborted || !runtime.isCurrent()) return {id: feature.id, status: 'skipped'};
            // 步骤 5：一个可选功能失败不能阻断其余功能，统一交给入口记录诊断。
            this.options.onError?.(feature.id, 'mount', error);
            return {id: feature.id, status: 'failed', error};
        }
    }

    private unmountFeature(feature: ContentFeatureDefinition): void {
        try {
            feature.unmount?.();
        } catch (error) {
            this.options.onError?.(feature.id, 'unmount', error);
        } finally {
            this.mountedFeatureIds.delete(feature.id);
        }
    }

    unmountAll(): void {
        this.activeRuntime = null;
        this.pendingMounts.clear();
        this.mountedFeatureIds.clear();
        // 步骤 1：反向卸载，让后挂载的覆盖层先释放自己的监听器和 DOM。
        for (const feature of [...this.features].reverse()) {
            try {
                feature.unmount?.();
            } catch (error) {
                // 步骤 2：单个清理失败不应阻止其他功能释放资源。
                this.options.onError?.(feature.id, 'unmount', error);
            }
        }
    }
}

export function createContentFeatureRegistry(
    features: ContentFeatureDefinition[],
    options?: ContentFeatureRegistryOptions,
): ContentFeatureRegistry {
    return new ContentFeatureRegistry(features, options);
}
