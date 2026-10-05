/**
 * @file src/features/vocabulary/domain/reencounter.ts
 * 文件职责：在新阅读文本中定位主动收藏的表达，生成可对照的原句与最小收藏快照。
 * 主要内容：复用统一的 expressionMatcher 定位真实表达，抽取有界当前句与最近相关收藏原句，保留对照所需的最小字段和稳定公共匹配出口。
 * 模块边界：本模块不访问网页、存储、浏览器或模型，不记录遇见次数，也不修改掌握度或复习计划；内容层负责把坐标转换为只读 Range。
 */
import type {VocabularyEntry} from '../learningModel';
import {createExpressionIndex, matchExpressions} from './expressionMatcher';
export {createExpressionIndex, iterateExpressionMatches, matchExpressions, type ExpressionIndex, type ExpressionMatch} from './expressionMatcher';

export interface ReencounterEntry {
  id: string;
  term: string;
  sourceLanguage: string;
  reference: string;
  savedSentence: string;
  savedTitle: string;
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
