/**
 * @file src/features/input-translation/content/editableHost.ts
 * 文件职责：为输入框翻译提供 contenteditable 编辑宿主（含 Lexical、ProseMirror、Draft.js、Slate、Quill 等富文本编辑器）的光标度量与原生编辑写回。
 * 主要内容：按 textContent 口径读取编辑宿主文本与折叠光标偏移，推算一次触发键插入后的期望状态；写回时按替换、首尾插入或清理触发符选择范围并等待编辑器同步模型选区，
 * 再派发只含纯文本的合成粘贴交给编辑器自身处理，未被接管或被页面拦截时退回浏览器原生 insertText，保留编辑器模型、撤销历史与宿主事件链。
 * 模块边界：不注册长期监听、不发送翻译请求，也不直接改写 innerText/innerHTML；资格判定与文本归一化来自 inputBox.ts，
 * 请求所有权、快照校验和提示 UI 由 content/index.ts 通过 isCurrent 回调提供。
 */
import {normalizeEditableText} from './inputBox';

export interface EditableCaretState {
    /** 归一化后的 textContent，只用于连续性比较，不作为翻译原文。 */
    text: string;
    /** 折叠光标之前的归一化字符数。 */
    caret: number;
}

export type EditableReplacementResult = 'replaced' | 'stale' | 'unsupported';

/** 选中全文后最多等待 selectionchange 的时间；未触发时仍继续校验选区。 */
export const EDITABLE_SELECTION_SYNC_TIMEOUT_MS = 120;
/** selectionchange 之后留给编辑器防抖同步模型选区的时间（Slate 使用 0ms 防抖）。 */
export const EDITABLE_SELECTION_SETTLE_MS = 16;
/** 合成粘贴被接管后轮询 DOM 更新的间隔与上限。 */
export const EDITABLE_PASTE_POLL_MS = 20;
export const EDITABLE_PASTE_SETTLE_LIMIT_MS = 300;

type SelectionRoot = Node & {getSelection?: () => Selection | null};

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readEditableText(element: HTMLElement): string {
    return normalizeEditableText(element.textContent || '');
}

/** 读取编辑宿主所在树的选区；Chromium 的开放 Shadow DOM 通过 shadowRoot.getSelection 暴露真实光标。 */
function getEditableSelection(element: HTMLElement): Selection | null {
    const root = element.getRootNode() as SelectionRoot;
    if (root !== element.ownerDocument && typeof root.getSelection === 'function') {
        const rootSelection = root.getSelection();
        if (rootSelection) return rootSelection;
    }
    return element.ownerDocument.getSelection();
}

/** 读取编辑宿主文本与折叠光标位置；选区不在宿主内或不是折叠光标时返回 null。 */
export function readEditableCaretState(element: HTMLElement): EditableCaretState | null {
    const selection = getEditableSelection(element);
    const focusNode = selection?.focusNode;
    if (!selection || !selection.isCollapsed || !focusNode || !element.contains(focusNode)) return null;

    const prefix = element.ownerDocument.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(focusNode, selection.focusOffset);
    return {
        text: readEditableText(element),
        caret: normalizeEditableText(prefix.toString()).length,
    };
}

/** 推算宿主按默认行为在光标处插入一个触发符号后的状态。 */
export function insertIntoEditableCaretState(state: EditableCaretState, symbol: string): EditableCaretState {
    return {
        text: `${state.text.slice(0, state.caret)}${symbol}${state.text.slice(state.caret)}`,
        caret: state.caret + symbol.length,
    };
}

export function isSameEditableCaretState(
    current: EditableCaretState | null,
    expected: EditableCaretState,
): boolean {
    return current !== null && current.text === expected.text && current.caret === expected.caret;
}

/** 确认选区仍完整覆盖编辑宿主；编辑器同步后可能把边界改写到内部文本节点，因此按文本比较。 */
function selectionCoversEditable(element: HTMLElement, selection: Selection): boolean {
    if (selection.rangeCount < 1) return false;
    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer)
        && element.contains(range.endContainer)
        && normalizeEditableText(range.toString()) === readEditableText(element);
}

/** 等待编辑器处理本次选区变化；Draft.js、Lexical、Slate 等在 selectionchange 后才同步模型选区。 */
function waitForSelectionSync(document: Document): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            document.removeEventListener('selectionchange', finish);
            setTimeout(resolve, EDITABLE_SELECTION_SETTLE_MS);
        };
        const timer = setTimeout(finish, EDITABLE_SELECTION_SYNC_TIMEOUT_MS);
        document.addEventListener('selectionchange', finish);
    });
}

/** 派发只含纯文本的合成粘贴；返回编辑器或页面是否接管了这次粘贴。 */
function dispatchPlainTextPaste(element: HTMLElement, text: string): boolean {
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.DataTransfer !== 'function' || typeof view.ClipboardEvent !== 'function') return false;
    const clipboardData = new view.DataTransfer();
    clipboardData.setData('text/plain', text);
    const event = new view.ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
        composed: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
}

/** 等待被接管的粘贴落到 DOM；编辑器通常在微任务或下一帧内完成渲染。 */
async function waitForEditableChange(element: HTMLElement, before: string): Promise<boolean> {
    for (let waited = 0; waited < EDITABLE_PASTE_SETTLE_LIMIT_MS; waited += EDITABLE_PASTE_POLL_MS) {
        await sleep(EDITABLE_PASTE_POLL_MS);
        if (readEditableText(element) !== before) return true;
    }
    return false;
}

/**
 * 用编辑器自己的编辑路径把选定范围替换为 text；首尾的空选区实现双语插入并保留原文结构。
 * 步骤：聚焦并选定范围 → 等待编辑器同步选区 → 合成纯文本粘贴 → 未被接管时退回原生 insertText。
 * isCurrent 在任何写入前都会重新校验，请求失效或选区被用户改动时返回 stale 且不写入。
 */
export async function replaceEditableText(
    element: HTMLElement,
    text: string,
    isCurrent: () => boolean,
    selectionMode: 'all' | 'start' | 'end' | 'trigger' = 'all',
    triggerSymbol = '',
): Promise<EditableReplacementResult> {
    const document = element.ownerDocument;
    const selection = getEditableSelection(element);
    if (!selection) return 'unsupported';

    const range = document.createRange();
    range.selectNodeContents(element);
    if (selectionMode === 'end') range.collapse(false);
    if (selectionMode === 'start') range.collapse(true);
    if (selectionMode === 'trigger') {
        // 连按的前两次已经进入宿主，只删除本次光标前的两个符号，不重写原文格式。
        const node = selection.focusNode;
        const offset = selection.focusOffset;
        if (!selection.isCollapsed || !node || node.nodeType !== 3 || !element.contains(node)
            || !triggerSymbol || normalizeEditableText((node.textContent || '').slice(offset - 2, offset)) !== triggerSymbol.repeat(2)) {
            return 'unsupported';
        }
        range.setStart(node, offset - 2);
        range.setEnd(node, offset);
    }
    const selectedText = normalizeEditableText(range.toString());
    const selectionMatches = () => {
        if (selectionMode === 'all') return selectionCoversEditable(element, selection);
        if (selectionMode === 'end' || selectionMode === 'start') {
            const caret = readEditableCaretState(element);
            return caret !== null && caret.caret === (selectionMode === 'start' ? 0 : caret.text.length);
        }
        return selection.rangeCount > 0
            && element.contains(selection.getRangeAt(0).startContainer)
            && element.contains(selection.getRangeAt(0).endContainer)
            && normalizeEditableText(selection.toString()) === selectedText;
    };

    // 步骤 1：先注册等待再改选区，确保捕获本次 selectionchange。
    element.focus({preventScroll: true});
    const synced = waitForSelectionSync(document);
    selection.removeAllRanges();
    selection.addRange(range);
    await synced;
    if (!isCurrent() || !selectionMatches()) return 'stale';

    // 步骤 2：富文本编辑器通常在 paste 中 preventDefault 并按自身模型插入多段文本。
    const before = readEditableText(element);
    if (dispatchPlainTextPaste(element, text)) {
        if (await waitForEditableChange(element, before)) return 'replaced';
    }

    // paste 的同步宿主回调即使未 preventDefault，也可能取消请求或移动选区。
    // 两种粘贴结果都须在原生写入前重新核对，不能让 fallback 覆盖新编辑。
    if (!isCurrent() || !selectionMatches()) return 'stale';

    // 步骤 3：普通 contenteditable 不处理合成粘贴，原生 insertText 会触发 beforeinput/input 并进入撤销栈。
    return document.execCommand('insertText', false, text) ? 'replaced' : 'unsupported';
}
