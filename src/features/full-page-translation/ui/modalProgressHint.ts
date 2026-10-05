/**
 * @file src/features/full-page-translation/ui/modalProgressHint.ts
 * 文件职责：在原生 dialog:modal 的 top layer 内提供全文翻译进度的最小提示，避免页面外层面板被宿主弹窗遮挡。
 * 主要内容：按翻译阶段创建或更新 FluentRead 自有 closed shadow 提示节点，并在宿主删除节点后暂停修复；弹窗关闭后重置该阻塞状态，允许下一次 showModal 重新创建。
 * 模块边界：这里只管理提示节点的 DOM 所有权和文案，不改变弹窗焦点、关闭行为或宿主属性，也不启动翻译和观察器；翻译进度面板仍由 TranslationProgressPanel.vue 负责。
 */
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {config} from '@/src/services/config/store';

const HINT_ATTRIBUTE = 'data-fr-translation-modal-hint';
const OWNED_ATTRIBUTE = 'data-fr-translation-owned';

interface ModalHintState {
  host: HTMLElement | null;
  label: HTMLSpanElement | null;
  blocked: boolean;
}

let currentModal: HTMLElement | null = null;
let currentState: ModalHintState | null = null;

function isNativeModal(modal: HTMLElement | null): modal is HTMLDialogElement {
  if (!modal || modal.localName !== 'dialog' || !modal.isConnected || !(modal as HTMLDialogElement).open) return false;
  try {
    return modal.matches(':modal');
  } catch {
    return false;
  }
}

function removeHint(state: ModalHintState): void {
  state.host?.remove();
  state.host = null;
  state.label = null;
}

function createHint(modal: HTMLDialogElement, phase: 'translating' | 'waiting'): {host: HTMLElement; label: HTMLSpanElement} {
  const host = modal.ownerDocument.createElement('div');
  host.setAttribute(HINT_ATTRIBUTE, '');
  host.setAttribute(OWNED_ATTRIBUTE, 'true');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  const label = phase === 'translating'
    ? translate('fullPage.progress.modalTranslating', normalizeUiLanguage(config.uiLanguage))
    : translate('fullPage.progress.modalWaiting', normalizeUiLanguage(config.uiLanguage));
  host.setAttribute('aria-label', label);
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = '<style>:host{all:initial;display:block;max-width:calc(100% - 20px);margin:8px auto 0;padding:6px 9px;border:1px solid rgba(229,88,139,.24);border-radius:8px;background:rgba(255,252,253,.92);box-shadow:0 4px 12px rgba(68,38,52,.12);color:#3f3540;font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;box-sizing:border-box}span{display:block;white-space:normal;overflow-wrap:anywhere}</style><span></span>';
  const labelElement = shadow.querySelector('span')!;
  labelElement.textContent = label;
  modal.appendChild(host);
  return {host, label: labelElement};
}

/** 同步原生 modal 内的提示；宿主删除提示时保持静默，直到 dialog 关闭并再次打开。 */
export function syncModalTranslationHint(
  modal: HTMLElement | null,
  phase: 'none' | 'translating' | 'waiting',
  enabled: boolean,
): void {
  if (currentModal !== modal) {
    if (currentState) removeHint(currentState);
    currentModal = modal;
    currentState = modal ? {host: null, label: null, blocked: false} : null;
  }
  if (!modal || !currentState) return;
  const state = currentState;
  if (!isNativeModal(modal)) {
    removeHint(state);
    currentModal = null;
    currentState = null;
    return;
  }
  if (phase === 'none' || !enabled) {
    removeHint(state);
    state.blocked = false;
    return;
  }
  if (state.host && !state.host.isConnected) {
    state.host = null;
    state.label = null;
    state.blocked = true;
  }
  if (state.host && state.label) {
    const label = phase === 'translating'
      ? translate('fullPage.progress.modalTranslating', normalizeUiLanguage(config.uiLanguage))
      : translate('fullPage.progress.modalWaiting', normalizeUiLanguage(config.uiLanguage));
    state.label.textContent = label;
    state.host.setAttribute('aria-label', label);
  }
  if (state.blocked || state.host) {
    return;
  }
  const hint = createHint(modal, phase);
  state.host = hint.host;
  state.label = hint.label;
}
