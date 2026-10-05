/**
 * @file src/features/vocabulary/domain/expressionMatcher.ts
 * 文件职责：以统一的词界、排印与规范化规则定位阅读和学习中的真实表达。
 * 主要内容：编译多模式索引，按需交付最长不重叠匹配与工作检查点，保留组合字符和 UTF16 原文坐标；完整同步单表达请求可使用语义相同的 ASCII 快速路径，分帧阅读仍流式处理。
 * 模块边界：不读取词书模型、网页、存储或配置；收藏快照和学习语境各自使用本模块，不形成领域模型的运行时循环依赖。
 */
export interface ExpressionTerm {id: string; term: string}
export interface ExpressionMatch {entryId: string; start: number; end: number}
interface SymbolSpan {symbol: string; start: number; end: number}
interface Terminal {entryId: string; length: number}
interface TrieNode {next: Map<string, number>; fail: number; output: Terminal[]; link: number}
export interface ExpressionIndex {nodes: TrieNode[]; maxTermLength: number; singleAscii?: {entryId: string; matcher: RegExp}}
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
export function createExpressionIndex(entries: readonly ExpressionTerm[]): ExpressionIndex {
  const nodes: TrieNode[] = [node()];
  let maxTermLength = 0;
  let termCount = 0;
  let singleAscii: ExpressionIndex['singleAscii'];
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
    if (!nodes[state].output.length) {
      nodes[state].output.push({entryId: entry.id, length: term.length});
      termCount += 1;
      singleAscii = termCount === 1 && term.every(span => span.symbol.charCodeAt(0) < 128)
        ? {entryId: entry.id, matcher: new RegExp(`(?=(${term.map(({symbol}) => symbol === ' ' ? '\\s+' : symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}))`, 'gi')}
        : undefined;
    }
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
  return {nodes, maxTermLength, singleAscii};
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
  // Infinity 调用方已要求完整同步结果；有限上限和分帧迭代不得预读整段原文。
  if (limit === Infinity && index.singleAscii && /^[\x00-\x7f]*$/u.test(text)) {
    let end = -1;
    // 前瞻保留重叠候选：词内失败不能吞掉稍后开始的有效表达。
    for (const candidate of text.matchAll(index.singleAscii.matcher)) {
      const start = candidate.index; const finish = start + candidate[1].length;
      if (start < end || (wordCharacter(candidate[1][0]) && start > 0 && wordCharacter(text[start - 1]))
        || (wordCharacter(candidate[1].at(-1)!) && finish < text.length && wordCharacter(text[finish]))) continue;
      matches.push({entryId: index.singleAscii.entryId, start, end: finish}); end = finish;
    }
    return matches;
  }
  for (const match of iterateExpressionMatches(text, index)) {
    if (!match) continue;
    matches.push(match);
    if (matches.length >= limit) break;
  }
  return matches;
}
