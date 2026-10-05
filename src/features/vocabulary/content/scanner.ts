/**
 * @file src/features/vocabulary/content/scanner.ts
 * 文件职责：在阅读期间绘制收藏表达并协调动态网页、滚动、点击与失效清理。
 * 主要内容：按约 4ms 或节点预算分帧执行只读扫描，变动时关闭过期工作，结果完成才替换绘制；及时观察新 Shadow 根，隔离 UI 通知并在关闭前完整释放资源，保留宿主点击。
 * 模块边界：不访问数据库、配置或模型，不截获链接、输入或选区，不记录掌握状态；生命周期和卡片展示由内容挂载器注入。
 */
import {createExpressionIndex, type ReencounterEntry} from '../domain/reencounter';
import {scanReadingExpressionsWork, type ReadingScan, type ReencounterOccurrence} from './readingText';

export const REENCOUNTER_HIGHLIGHT = 'fluentread-vocabulary-reencounter';
const css = `::highlight(${REENCOUNTER_HIGHLIGHT}) { text-decoration: underline dotted #c58a37; text-decoration-thickness: 1px; text-underline-offset: 3px; }
@media (prefers-color-scheme: dark) { ::highlight(${REENCOUNTER_HIGHLIGHT}) { text-decoration-color: #e9b766; } }`;
type PaintWindow = Window & typeof globalThis & {Highlight?: new (...ranges: Range[]) => Set<Range>; CSS?: {highlights?: Map<string, Set<Range>>}};
export interface ReencounterScanner {
  setEntries: (entries: readonly ReencounterEntry[]) => void;
  refresh: () => void;
  dispose: () => void;
}

export function installReencounterScanner(document: Document, callbacks: {
  changed: (occurrences: ReencounterOccurrence[]) => void;
  open: (occurrence: ReencounterOccurrence) => void;
}): ReencounterScanner {
  const view = document.defaultView as PaintWindow;
  const registry = view.CSS?.highlights;
  const paint = view.Highlight && registry ? new view.Highlight() : undefined;
  const styles = new Map<Document | ShadowRoot, HTMLStyleElement>();
  const observers = new Map<Document | ShadowRoot, MutationObserver>();
  let entries: readonly ReencounterEntry[] = [];
  let index = createExpressionIndex([]);
  const empty: ReencounterOccurrence[] = [];
  let occurrences = empty;
  let notifying = false;
  let timer: number | undefined;
  let frame: number | undefined;
  let work: Generator<undefined, ReadingScan> | undefined;
  let generation = 0;
  let disposed = false;
  const owned = (node: Node): boolean => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(element?.closest('[data-fr-reencounter-style],[data-fluent-read-ui],[id^="fluent-read-"]'));
  };
  const irrelevant = (node: Node): boolean => owned(node) || (node.nodeType === 1 && (node as Element).matches('script,style,link,meta'));
  function notify(): void {
    if (notifying) return;
    notifying = true;
    const delivered = new Set<ReencounterOccurrence[]>();
    try {
      // 重入只交付新状态；同一个空状态不会向写入者反复回声。
      while (!delivered.has(occurrences)) {
        const next = occurrences; delivered.add(next);
        try {callbacks.changed([...next]);} catch { /* 可选卡片失败不能阻断扫描和资源清理。 */ }
      }
    } finally {notifying = false;}
  }
  function clear(): void { paint?.clear(); occurrences = empty; notify(); }
  function cancelWork(): void {
    generation += 1;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    const pending = work; work = undefined;
    pending?.return({occurrences: empty, roots: [document]});
  }
  function schedule(): void {
    if (disposed) return;
    cancelWork();
    if (timer !== undefined) return;
    timer = view.setTimeout(scan, 180);
  }
  function observe(root: Document | ShadowRoot): void {
    if (observers.has(root)) return;
    const observer = new view.MutationObserver(records => {
      const relevant = records.filter(record => !irrelevant(record.target) && (record.type !== 'childList'
        || [...record.addedNodes, ...record.removedNodes].some(node => !irrelevant(node))));
      if (!relevant.length) return;
      if (relevant.some(record => record.type !== 'attributes')) clear();
      schedule();
    });
    observer.observe(root, {childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'contenteditable', 'translate', 'class', 'style', 'inert']});
    observers.set(root, observer);
  }
  function scan(): void {
    timer = undefined;
    if (disposed) return;
    work = scanReadingExpressionsWork(document, entries, index, observe);
    advance(generation);
  }
  function advance(owner: number): void {
    if (disposed || owner !== generation || !work) return;
    frame = undefined;
    const started = view.performance.now();
    for (let steps = 0; steps < 16_384; steps += 1) {
      const step = work.next();
      if (step.done) {work = undefined; commit(step.value); return;}
      if ((steps & 63) === 63 && view.performance.now() - started >= 4) break;
    }
    frame = view.requestAnimationFrame(() => advance(owner));
  }
  function commit(result: ReadingScan): void {
    paint?.clear();
    occurrences = result.occurrences.length ? result.occurrences : empty;
    const roots = new Set(result.roots);
    const paintedRoots = new Set<Document | ShadowRoot>();
    for (const occurrence of occurrences) paintedRoots.add(occurrence.root);
    for (const [root, observer] of observers) if (!roots.has(root)) { observer.disconnect(); observers.delete(root); }
    for (const [root, style] of styles) if (!paintedRoots.has(root)) { style.remove(); styles.delete(root); }
    for (const root of roots) {
      if (paint && paintedRoots.has(root) && !styles.has(root)) {
        const style = document.createElement('style');
        style.setAttribute('data-fr-reencounter-style', 'true'); style.textContent = css;
        (root.nodeType === 9 ? document.documentElement : root).appendChild(style);
        styles.set(root, style);
      }
      observe(root);
    }
    if (paint) {
      for (const occurrence of occurrences) for (const range of occurrence.ranges) paint.add(range);
      registry!.set(REENCOUNTER_HIGHLIGHT, paint);
    }
    notify();
  }
  function click(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || document.getSelection()?.isCollapsed === false) return;
    const target = event.composedPath().find(node => node instanceof view.Element) as Element | undefined;
    if (!target || owned(target) || target.closest('a,button,input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    const root = target.getRootNode();
    const hit = occurrences.find(occurrence => occurrence.root === root && occurrence.ranges.some(range => {
      if (!range.startContainer.isConnected) return false;
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0
        && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return true;
      return false;
    }));
    if (hit) {try {callbacks.open(hit);} catch { /* 保留宿主点击交付。 */ }}
  }
  document.addEventListener('click', click);
  document.addEventListener('scroll', schedule, {capture: true, passive: true});
  document.addEventListener('fluentread-route-change', schedule);
  document.addEventListener('fluentread-open-shadow-root', schedule, true);
  view.addEventListener('resize', schedule, {passive: true});
  // 无条目时也观察正文，随后收藏变更通过 setEntries 更新同一实例。
  observe(document);
  return {
    setEntries(next) { if (disposed) return; cancelWork(); entries = next.map(entry => ({...entry})); index = createExpressionIndex(entries); clear(); schedule(); },
    refresh: schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) view.clearTimeout(timer);
      timer = undefined;
      cancelWork();
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
      for (const style of styles.values()) style.remove();
      styles.clear();
      if (paint && registry?.get(REENCOUNTER_HIGHLIGHT) === paint) registry.delete(REENCOUNTER_HIGHLIGHT);
      document.removeEventListener('click', click);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('fluentread-route-change', schedule);
      document.removeEventListener('fluentread-open-shadow-root', schedule, true);
      view.removeEventListener('resize', schedule);
      entries = []; index = createExpressionIndex([]);
      clear();
    },
  };
}
