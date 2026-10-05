/**
 * @file src/features/vocabulary/domain/reencounter.ts
 * 文件职责：在新阅读文本中定位主动收藏的表达，生成可对照的原句与最小收藏快照。
 * 主要内容：按需规范化原文，用多模式索引与有界环形窗口决定最长完整表达；保留组合字符、排印和 UTF16 坐标，允许调用方在结果上限或工作切片处停止，并抽取有界的真实语境。
 * 模块边界：本模块不访问网页、存储、浏览器或模型，不记录遇见次数，也不修改掌握度或复习计划；内容层负责把坐标转换为只读 Range。
 */
import type {VocabularyEntry} from '../learningModel';

export interface ReencounterEntry {
  id: string;
  term: string;
  sourceLanguage: string;
  reference: string;
  savedSentence: string;
  savedTitle: string;
}
export interface ExpressionMatch {entryId: string; start: number; end: number}
interface SymbolSpan {symbol: string; start: number; end: number}
interface Terminal {entryId: string; length: number}
interface TrieNode {next: Map<string, number>; fail: number; output: Terminal[]; link: number}
export interface ExpressionIndex {nodes: TrieNode[]; maxTermLength: number}
interface PendingMatch extends ExpressionMatch {order: number}
const node = (): TrieNode => ({next: new Map(), fail: 0, output: [], link: 0});

/** 规范化时保留每个字符在原文中的区间；大小写扩展与组合字符不会造成 Range 偏移。 */
function* symbols(text: string): Generator<SymbolSpan | undefined> {
  let space: SymbolSpan | undefined;
  for (const part of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const start = part.index;
    const end = start + part[0].length;
    const normalized = part[0].normalize('NFC').toLowerCase().replace(/[’‘]/gu, "'").replace(/[‐‑‒–—]/gu, '-');
    for (const character of normalized) {
      const symbol = /\s/u.test(character) ? ' ' : character;
      if (symbol === ' ' && space) {space.end = end; yield undefined; continue;}
      const span = {symbol, start, end};
      space = symbol === ' ' ? span : undefined;
      yield span;
    }
  }
}

/** 编译收藏索引；重复表达保留列表中优先的收藏，不把整本词书逐项扫描每一段。 */
export function createExpressionIndex(entries: readonly Pick<ReencounterEntry, 'id' | 'term'>[]): ExpressionIndex {
  const nodes: TrieNode[] = [node()];
  let maxTermLength = 0;
  for (const entry of entries) {
    const term: SymbolSpan[] = [];
    for (const span of symbols(entry.term.trim())) if (span) term.push(span);
    if (!term.length || !/[\p{L}\p{N}]/u.test(entry.term)) continue;
    maxTermLength = Math.max(maxTermLength, term.length);
    let state = 0;
    for (const {symbol} of term) {
      let next = nodes[state].next.get(symbol);
      if (next === undefined) { next = nodes.length; nodes[state].next.set(symbol, next); nodes.push(node()); }
      state = next;
    }
    if (!nodes[state].output.length) nodes[state].output.push({entryId: entry.id, length: term.length});
  }
  const queue = [...nodes[0].next.values()];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    for (const [symbol, next] of nodes[state].next) {
      queue.push(next);
      let fallback = nodes[state].fail;
      while (fallback && !nodes[fallback].next.has(symbol)) fallback = nodes[fallback].fail;
      nodes[next].fail = nodes[fallback].next.get(symbol) ?? 0;
      const parent = nodes[next].fail;
      nodes[next].link = nodes[parent].output.length ? parent : nodes[parent].link;
    }
  }
  return {nodes, maxTermLength};
}

function wordCharacter(symbol: string): boolean {
  // 汉字与假名允许在连续原文中匹配；有空格词界的语言不匹配词内子串。
  return /[\p{L}\p{M}\p{N}'-]/u.test(symbol) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(symbol);
}

/** undefined 是可让出执行权的工作检查点；表达只在更长的同起点候选已不可能出现时交付。 */
export function* iterateExpressionMatches(text: string, index: ExpressionIndex): Generator<ExpressionMatch | undefined> {
  const {nodes} = index;
  if (nodes.length === 1) return;
  const capacity = index.maxTermLength + 1;
  const input: SymbolSpan[] = new Array(capacity);
  const pending: Array<PendingMatch | undefined> = new Array(capacity);
  const iterator = symbols(text);
  let current = iterator.next();
  let next = current;
  let state = 0;
  let cursor = -1; let front = 0; let order = 0; let end = -1;
  let best: PendingMatch | undefined;
  try {
    while (!current.done || front <= cursor) {
      if (!current.done) {
        // 当前 span 总来自首次读取或已经跳过工作检查点的前瞻。
        const span = current.value!;
        cursor += 1; input[cursor % capacity] = span; next = iterator.next();
        while (!next.done && !next.value) {yield undefined; next = iterator.next();}
        const symbol = span.symbol;
        while (state && !nodes[state].next.has(symbol)) {state = nodes[state].fail; yield undefined;}
        state = nodes[state].next.get(symbol) ?? 0;
        for (let outputState = state; outputState; outputState = nodes[outputState].link) {
          for (const output of nodes[outputState].output) {
            yield undefined;
            const start = cursor - output.length + 1;
            const first = input[start % capacity];
            if (wordCharacter(first.symbol) && start > 0 && wordCharacter(input[(start - 1) % capacity].symbol)) continue;
            if (wordCharacter(symbol) && !next.done && wordCharacter(next.value!.symbol)) continue;
            const candidate = {entryId: output.entryId, start: first.start, end: span.end, order: order++};
            const prior = pending[start % capacity];
            if (!prior || candidate.end > prior.end) pending[start % capacity] = candidate;
          }
        }
      }
      // 后续匹配最早只能从此窗口之后开始；环形空间只跟最长收藏有关。
      const safe = current.done ? cursor : cursor - index.maxTermLength + 1;
      while (front <= safe) {
        const candidate = pending[front % capacity]; pending[front % capacity] = undefined;
        if (candidate && (!best || candidate.end > best.end || (candidate.end === best.end && candidate.order < best.order))) best = candidate;
        front += 1;
        const possibleStart = front <= cursor ? input[front % capacity].start : next.done ? Infinity : next.value!.start;
        if (best && possibleStart > best.start) {
          if (best.start >= end) {end = best.end; yield {entryId: best.entryId, start: best.start, end: best.end};}
          best = undefined;
        }
      }
      if (current.done) break;
      yield undefined;
      current = next;
    }
  } finally {iterator.return(undefined);}
}

/** 返回不重叠的最长完整表达；上限达到时关闭迭代器，不规范化、缓存或排序余下原文。 */
export function matchExpressions(text: string, index: ExpressionIndex, limit = 300): ExpressionMatch[] {
  if (limit <= 0 || index.nodes.length === 1) return [];
  const matches: ExpressionMatch[] = [];
  for (const match of iterateExpressionMatches(text, index)) {
    if (!match) continue;
    matches.push(match);
    if (matches.length >= limit) break;
  }
  return matches;
}

/** 抽取当前句，超长段落只保留命中附近的有界原文，绝不拼造句子。 */
export function reencounterSentence(text: string, start: number, end: number): string {
  const left = Math.max(0, start - 400);
  const right = Math.min(text.length, end + 400);
  const before = text.slice(left, start);
  const after = text.slice(end, right);
  const boundary = /[.!?。！？\n]/gu;
  const previous = [...before.matchAll(boundary)].at(-1);
  const next = after.search(boundary);
  return text.slice(previous ? left + previous.index + 1 : left, next >= 0 ? end + next + 1 : right).trim();
}

/** 内容页只读取对照所需字段，不接收来源 URL、复习日志或整个历史问答。 */
export function reencounterSnapshot(entry: VocabularyEntry): ReencounterEntry {
  const index = createExpressionIndex([entry]);
  const saved = [...entry.contexts].sort((a, b) => b.capturedAt - a.capturedAt).find(context => {
    const hit = matchExpressions(context.text, index, 1)[0];
    return hit && /[\p{L}\p{N}]/u.test(context.text.slice(0, hit.start) + context.text.slice(hit.end));
  });
  const reference = Object.values(entry.translations).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.text || '';
  return {id: entry.id, term: entry.term, sourceLanguage: entry.sourceLanguage, reference,
    savedSentence: saved?.text || '', savedTitle: saved?.pageTitle || ''};
}

/** 用于本地匹配的列表只带身份和表达；原句与参考内容在主动打开卡片后读取。 */
export function reencounterTerm(entry: VocabularyEntry): ReencounterEntry {
  return {id: entry.id, term: entry.term, sourceLanguage: entry.sourceLanguage, reference: '', savedSentence: '', savedTitle: ''};
}
