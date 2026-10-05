/**
 * @file src/features/full-page-translation/content/sectionTranslation.ts
 * 文件职责：把全文翻译引擎限定在用户点选的一块网页区域内执行，负责区域候选发现、译文状态盘点、按阅读位置排序的批量翻译，以及只恢复该区域的原文。
 * 主要内容：导出区域盘点与切换接口；按译文所有者索引发现待翻译、失败与需切换方案的段落，冻结局部快捷方案请求配置并传给每个候选；以请求身份记住无需翻译的原文，支持独立目标语言和显示方式，同时保留区域恢复、发现预算与阅读位置排序。
 * 模块边界：本文件只编排区域级调用，单个候选的请求、渲染、状态机和全文会话协作全部复用 runtime 的 translateTarget 与 restoreTranslationOwner；不监听手势、不绘制高亮，也不决定提示文案。
 */
import {checkConfig} from '@/src/app/translation/check';
import {
    getComposedParent,
    getCurrentTranslationCore,
    getTranslationCandidateKey,
    selectPreferredTranslationCandidate,
    type TranslationCandidate,
    type TranslationScope,
} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {restoreTranslationOwner, translateTarget, type TranslationTargetOutcome} from './runtime';
import {getTranslationOwnersWithin, getTranslationState, resolveTranslationStateNode} from './state';
import {
    captureFullPageTranslationConfig,
    getTranslationInvocationIdentity,
    type FullPageTranslationConfigSnapshot,
    type PageTranslationConfigOverrides,
} from './translationRequest';

/** 悬停预览只盘点有限的 DOM 步数，整页级容器也不会在移动鼠标时卡顿；点击时再完整盘点。 */
export const SECTION_PREVIEW_DISCOVERY_STEPS = 4000;

/**
 * - translate：区域内还有待翻译段落；
 * - restore：区域内段落都已翻译或正在翻译，点击恢复原文；
 * - settled：区域内段落都已确认无需翻译（例如已是目标语言）；
 * - empty：区域内没有可翻译的文字。
 */
export type TranslationSectionAction = 'translate' | 'restore' | 'settled' | 'empty';

export interface TranslationSectionSummary {
    /** 区域内发现的候选段落数；预算耗尽时为下限。 */
    readonly total: number;
    /** 已翻译或正在翻译的段落数。 */
    readonly active: number;
    /** 仍待翻译的段落数；已确认无需翻译的段落不计入。 */
    readonly pending: number;
    /** 发现步数超过预算，total、active 与 pending 都只是下限。 */
    readonly truncated: boolean;
    readonly action: TranslationSectionAction;
}

export interface TranslationSectionResult {
    /** blocked 表示翻译前的配置检查未通过，检查本身已向页面提示原因。 */
    readonly action: 'translated' | 'restored' | 'settled' | 'empty' | 'blocked';
    readonly translated: number;
    readonly failed: number;
    /** 已是目标语言或没有有效文字、因此未发出请求的段落数。 */
    readonly unchanged: number;
    readonly restored: number;
}

interface SectionDiscovery {
    candidates: TranslationCandidate[];
    truncated: boolean;
}

/** 已确认无需翻译的候选及当时的原文快照；原文变化后快照不再相等，记忆自动失效。 */
const settledCandidates = new WeakMap<Node, {text: string; identity: string}>();

function candidateSnapshot(candidate: TranslationCandidate): string {
    // join 会把 null 视为空串，无需逐个兜底。
    return (candidate.nodes?.length ? candidate.nodes : [candidate.element]).map((node) => node.textContent).join('');
}

/**
 * 正文范围会把 header/footer/nav/aside 当作页面框架整体跳过；用户显式点选这些区域时，
 * 说明它们就是想读的内容，因此改用全部节点范围。
 */
function resolveSectionScope(root: Element): TranslationScope {
    if (config.translationScope === 'all') return 'all';
    return getCurrentTranslationCore('content').isWithinStructuralRegion(root) ? 'all' : 'content';
}

function discoverInScope(root: Element, scope: TranslationScope, maxSteps: number): SectionDiscovery {
    const unique = new Map<Node, TranslationCandidate>();
    let steps = 0;
    for (const step of getCurrentTranslationCore(scope).discoverSteps(root)) {
        steps += 1;
        if (steps > maxSteps) return {candidates: [...unique.values()], truncated: true};
        if (!step.candidate) continue;
        const key = getTranslationCandidateKey(step.candidate);
        unique.set(key, selectPreferredTranslationCandidate(unique.get(key), step.candidate));
    }
    return {candidates: [...unique.values()], truncated: false};
}

function discoverSectionCandidates(root: Element, maxSteps: number): SectionDiscovery {
    const scope = resolveSectionScope(root);
    const discovery = discoverInScope(root, scope, maxSteps);
    // 站点规则只放行指定目标、或区域内全是界面控件时，正文范围可能一无所获；
    // 用户已经明确点选了这块区域，此时改用全部节点范围，安全守卫仍然生效。
    if (discovery.candidates.length > 0 || discovery.truncated || scope === 'all') return discovery;
    return discoverInScope(root, 'all', maxSteps);
}

function isSettled(candidate: TranslationCandidate, identity: () => string): boolean {
    const settled = settledCandidates.get(getTranslationCandidateKey(candidate));
    return Boolean(settled && settled.text === candidateSnapshot(candidate) && settled.identity === identity());
}

/** 失败或切换方案时按所有者状态重建候选；合成行内段沿用首个来源文本节点定位。 */
function translationOwnerCandidate(owner: HTMLElement): TranslationCandidate {
    const state = getTranslationState(owner)!;
    return {
        element: owner,
        kind: state.kind,
        reason: 'section-retry',
        ...(state.scope ? {scope: state.scope} : {}),
        ...(state.syntheticSegment && state.sourceTextNodes?.length ? {nodes: state.sourceTextNodes} : {}),
        ...(state.allowTopLevelApplicationShell ? {allowTopLevelApplicationShell: true} : {}),
    };
}

/** 点选范围落在一个已翻译的更大段落内部时，该段落就是这块区域的译文所有者。 */
function findActiveAncestorOwner(root: Element): HTMLElement | null {
    for (let current = getComposedParent(root); current; current = getComposedParent(current)) {
        const phase = getTranslationState(current as HTMLElement)?.phase;
        if (phase === 'loading' || phase === 'translated') return current as HTMLElement;
    }
    return null;
}

function resolveSectionAction(total: number, active: number, pending: number): TranslationSectionAction {
    if (pending > 0) return 'translate';
    if (active > 0) return 'restore';
    return total > 0 ? 'settled' : 'empty';
}

function summarize(root: Element, maxSteps: number, snapshot: () => FullPageTranslationConfigSnapshot,
    compareInvocation: boolean): {summary: TranslationSectionSummary; pending: TranslationCandidate[]} {
    // 新候选和默认恢复不比较请求身份；避免每次预览都归一化、散列整份词库。
    let identity: string | undefined;
    const invocationIdentity = (): string => identity ??= getTranslationInvocationIdentity(snapshot());
    const needsProfileSwitch = (owner: HTMLElement): boolean => compareInvocation
        && getTranslationState(owner)?.translationInvocationIdentity !== invocationIdentity();
    const ancestor = findActiveAncestorOwner(root);
    if (ancestor) {
        if (needsProfileSwitch(ancestor)) {
            return {summary: {total: 1, active: 0, pending: 1, truncated: false, action: 'translate'},
                pending: [translationOwnerCandidate(ancestor)]};
        }
        return {summary: {total: 1, active: 1, pending: 0, truncated: false, action: 'restore'}, pending: []};
    }
    // Step 1: 从译文所有者索引盘点区域内已有译文；失败段落直接作为待重试项。
    const activeOwners = new Set<Node>();
    const pending = new Map<Node, TranslationCandidate>();
    for (const owner of getTranslationOwnersWithin(root)) {
        if (getTranslationState(owner)?.phase === 'error' || needsProfileSwitch(owner)) pending.set(owner, translationOwnerCandidate(owner));
        else activeOwners.add(owner);
    }
    // Step 2: 候选发现补齐尚未翻译的段落，并跳过已由所有者覆盖或已确认无需翻译的候选。
    const {candidates, truncated} = discoverSectionCandidates(root, maxSteps);
    let settled = 0;
    for (const candidate of candidates) {
        const owner = resolveTranslationStateNode(candidate);
        if (owner && (activeOwners.has(owner) || pending.has(owner))) continue;
        if (isSettled(candidate, invocationIdentity)) settled += 1;
        else pending.set(owner ?? getTranslationCandidateKey(candidate), candidate);
    }
    const active = activeOwners.size;
    const total = active + pending.size + settled;
    // 预算耗尽时剩余部分未知：没有看到任何段落也不能断言“没有文字”，先按翻译提示。
    const action = truncated && total === 0 ? 'translate' : resolveSectionAction(total, active, pending.size);
    return {summary: {total, active, pending: pending.size, truncated, action}, pending: [...pending.values()]};
}

/** 盘点区域状态，供选择模式的标签显示“翻译/恢复原文/无需翻译”及段落数。 */
export function inspectTranslationSection(
    root: Element,
    maxSteps: number = SECTION_PREVIEW_DISCOVERY_STEPS,
    overrides?: PageTranslationConfigOverrides,
): TranslationSectionSummary {
    return summarize(root, maxSteps, () => captureFullPageTranslationConfig(overrides), Boolean(overrides)).summary;
}

/** 视口内的段落先翻译，其次是下方即将读到的内容，最后才是已经滚过的上方内容。 */
function orderByReadingPosition(candidates: readonly TranslationCandidate[]): TranslationCandidate[] {
    const viewportHeight = window.innerHeight;
    return candidates
        .map((candidate, index) => {
            const rect = candidate.element.getBoundingClientRect();
            const band = rect.bottom <= 0 ? 2 : rect.top >= viewportHeight ? 1 : 0;
            return {candidate, index, band, distance: band === 2 ? -rect.bottom : rect.top};
        })
        .sort((left, right) => left.band - right.band || left.distance - right.distance || left.index - right.index)
        .map(({candidate}) => candidate);
}

const EMPTY_TALLY = {translated: 0, failed: 0, unchanged: 0, restored: 0} as const;

async function translatePendingCandidates(pending: readonly TranslationCandidate[],
    translationConfig: FullPageTranslationConfigSnapshot): Promise<TranslationSectionResult> {
    if (!checkConfig(translationConfig)) return {action: 'blocked', ...EMPTY_TALLY};
    const identity = getTranslationInvocationIdentity(translationConfig);
    // translateTarget 在首次 await 前同步入队，因此调用顺序就是共享翻译队列的派发顺序。
    const outcomes = await Promise.all(orderByReadingPosition(pending).map(async (candidate) => {
        const source = candidateSnapshot(candidate);
        const outcome: TranslationTargetOutcome = await translateTarget(candidate, translationConfig.displayMode, false, undefined, translationConfig)
            .catch(() => ({status: 'failed' as const}));
        if (outcome.status === 'unchanged' || outcome.status === 'empty') {
            settledCandidates.set(getTranslationCandidateKey(candidate), {
                text: source, identity,
            });
        }
        return outcome.status;
    }));
    return {
        action: 'translated',
        translated: outcomes.filter((status) => status === 'committed').length,
        failed: outcomes.filter((status) => status === 'failed').length,
        unchanged: outcomes.filter((status) => status === 'unchanged' || status === 'empty').length,
        restored: 0,
    };
}

function restoreSection(root: Element): number {
    const owners = new Set<HTMLElement>(getTranslationOwnersWithin(root));
    const ancestor = findActiveAncestorOwner(root);
    if (ancestor) owners.add(ancestor);
    let restored = 0;
    owners.forEach((owner) => {
        if (restoreTranslationOwner(owner)) restored += 1;
    });
    return restored;
}

/**
 * 对点选区域执行一次“翻译或恢复原文”：区域内还有待翻译段落就翻译它们（失败段落一并重试），
 * 否则恢复区域内的全部译文。点击时完整盘点，不受悬停预览的步数预算影响。
 */
export async function toggleTranslationSection(root: Element, overrides?: PageTranslationConfigOverrides): Promise<TranslationSectionResult> {
    const snapshot = captureFullPageTranslationConfig(overrides);
    const {summary, pending} = summarize(root, Number.POSITIVE_INFINITY, () => snapshot, Boolean(overrides));
    if (summary.action === 'translate') return translatePendingCandidates(pending, snapshot);
    if (summary.action === 'restore') return {action: 'restored', ...EMPTY_TALLY, restored: restoreSection(root)};
    return {action: summary.action, ...EMPTY_TALLY};
}
