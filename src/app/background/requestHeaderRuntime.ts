/**
 * @file src/app/background/requestHeaderRuntime.ts
 * 文件职责：在扩展后台装配按域名移除请求头的配置与网络同步屏障。
 * 主要内容：启动及配置变化时更新动态规则，每个 provider 的真实 HTTP 请求等待最新名单落地，安装失败会明确阻止该请求并允许后续重试。
 * 模块边界：仅在后台启动时调用；沿用 runtimeFetch 端口，不改变 userscript transport，不在 JS 层伪造 forbidden headers。
 */
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {createRequestHeaderRulesSynchronizer} from '@/src/platform/browser/requestHeaderRules';
import {setRuntimeFetch} from '@/src/platform/http/runtime';

export function installRequestHeaderRuntime(): void {
    const sync = createRequestHeaderRulesSynchronizer(browser.declarativeNetRequest, new URL(browser.runtime.getURL('')).hostname);
    const refresh = () => sync.sync(config.requestHeaderRules);
    void configReady.then(() => {
        subscribeConfig(() => { void refresh().catch(() => console.warn('[FluentRead] 请求头规则更新失败；下次请求将重试。')); });
        return refresh();
    }).catch(() => console.warn('[FluentRead] 请求头规则更新失败；下次请求将重试。'));
    setRuntimeFetch(async (input, init) => {
        await configReady;
        await refresh();
        return globalThis.fetch(input, init);
    });
}
