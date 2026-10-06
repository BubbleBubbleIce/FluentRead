/**
 * @file src/app/popup/index.ts
 * 文件职责：连接 Popup HTML 的无框架预唤醒与配置就绪后的应用组装入口。
 * 主要内容：加载尺寸和皮肤样式，利用早期后台提示并行预取候选界面，配置完成后由 mount.ts 挂载实际页面。
 * 模块边界：提示只用于预取，不缓存、不渲染、不写入；mount.ts 始终通过配置 store 新读数据后决定实际挂载界面。
 */
import './popup.css';
import 'element-plus/es/components/base/style/css';
import '@/src/ui/styles/interface-skins.css';
import {mountPreparedPopupApp} from './mount';
type PopupRuntime = {
  sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
  lastError?: unknown;
};

function prepareRoute(response: unknown): void {
  const result = response as {success?: boolean; uiLanguageSetupCompleted?: boolean} | null;
  if (result?.success !== true) return;
  // 提示过期最多多加载一个模块；配置 store 的新快照仍决定最终路由和页面内容。
  if (result.uiLanguageSetupCompleted === true) void import('./PopupApp.vue').catch(() => {});
  else if (result.uiLanguageSetupCompleted === false) void import('./PopupOnboarding.vue').catch(() => {});
}

function wakePopupWorker(): void {
  const globals = globalThis as typeof globalThis & {
    browser?: {runtime?: PopupRuntime};
    chrome?: {runtime?: PopupRuntime};
    __fluentReadPopupWarmup?: Promise<unknown>;
  };
  const message = {type: 'popupStartup'};
  try {
    if (globals.__fluentReadPopupWarmup) {
      void globals.__fluentReadPopupWarmup.then(prepareRoute).catch(() => {});
    } else if (globals.browser?.runtime) {
      void Promise.resolve(globals.browser.runtime.sendMessage(message)).then(prepareRoute).catch(() => {});
    } else if (globals.chrome?.runtime) {
      const runtime = globals.chrome.runtime;
      runtime.sendMessage(message, (response: unknown) => { if (!runtime.lastError) prepareRoute(response); });
    }
  } catch {
    // 正常配置读取负责失败与回退；预唤醒失败不能阻断挂载。
  }
}

export async function mountPopupApp(selector: string): Promise<void> {
  wakePopupWorker();
  await mountPreparedPopupApp(selector);
}
