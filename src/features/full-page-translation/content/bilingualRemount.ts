/**
 * @file src/features/full-page-translation/content/bilingualRemount.ts
 * 文件职责：在 React/Vue 等宿主框架等价重挂双语 owner 时，于同一 MutationObserver 检查点原子接管已提交译文。
 * 主要内容：按 childList 相对路径配对新旧 owner，一次建立兄弟节点位置索引以线性核对行内片段，按正文/全部节点范围隔离熔断身份并校验原文/译文快照与直属工件，重建 WeakMap 状态并安全转移布局租约。
 * 模块边界：本文件不发起翻译请求、不发现候选也不持有页面会话；runtime 提供候选/语义验证与会话索引收尾。
 */
import {
    beginTranslation,
    consumeBilingualArtifactHostWriteBudget,
    discardTranslation,
    getTranslationSourceStructureSignature,
    getTranslationOverflowGenerationIdentity,
    getTranslationOwnersForRemovedNode,
    getTranslationState,
    hasBilingualArtifactHostWriteBudget,
    inheritBilingualArtifactRepairBudget,
    isBilingualArtifactHostWriteBudgetCapitulated,
    isTrustedBilingualArtifactWithHostClass,
    isTranslationSourceStructureOverflow,
    markTranslationComplete,
    restoreClonedTranslationOwnerPresentation,
    setBilingualContent,
    setRenderedStyleAttribute,
    tryRepairBilingualTranslationArtifact,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';
import {
    isBilingualArtifactKept,
    statefulSourceAndTextSlotsAreCurrent,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    collectLiveTranslationTextSlots,
    getCurrentTranslationCore,
    type TranslationScope,
} from '@/src/core/translation/public';

const BILINGUAL_ARTIFACT_SELECTOR =
    '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';

export interface BilingualRemountPreparation {
    sourceTextNodes: readonly Text[];
    reconcileLayout: (owner: HTMLElement) => boolean;
}

export interface BilingualOwnerTransfer {
    previousOwner: HTMLElement;
    replacementOwner: HTMLElement;
}

export interface BilingualOwnerCapitulation extends BilingualOwnerTransfer {
    boundary: Node;
}

export interface BilingualRemountResult {
    transfers: BilingualOwnerTransfer[];
    capitulations: BilingualOwnerCapitulation[];
}

export type RemovedTranslationOwnerResolver = (removed: Node) => readonly HTMLElement[];

export function createRemovedTranslationOwnerResolver(): RemovedTranslationOwnerResolver {
    const cache = new WeakMap<Node, readonly HTMLElement[]>();
    return (removed) => {
        const cached = cache.get(removed);
        if (cached) return cached;
        const owners = getTranslationOwnersForRemovedNode(removed);
        cache.set(removed, owners);
        return owners;
    };
}

export interface BilingualRemountCapitulationRegistry {
    hasEntries: () => boolean;
    remember: (boundary: Node, owner: HTMLElement, state: TranslationState) => void;
    blocks: (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope?: TranslationScope,
    ) => boolean;
    forget: (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope?: TranslationScope,
    ) => void;
}

function syntheticRunIndexes(
    host: HTMLElement,
    sourceNodes: readonly Node[],
    segment?: HTMLElement,
): number[] | null {
    if (sourceNodes.length === 0) return null;
    if (segment?.parentNode === host && sourceNodes.every((node) => node.parentNode === segment)) {
        const start = Array.from(host.childNodes).indexOf(segment);
        return start < 0 ? null : sourceNodes.map((_node, index) => start + index);
    }
    if (!sourceNodes.every((node) => node.parentNode === host)) return null;
    const positions = new Map(Array.from(host.childNodes, (node, index) => [node, index] as const));
    const indexes = sourceNodes.map((node) => positions.get(node as ChildNode) ?? -1);
    return indexes.some((index) => index < 0) ? null : indexes;
}

function syntheticCandidateStructureSignature(
    owner: HTMLElement,
    nodes: readonly Node[],
    allowTopLevelApplicationShell: boolean,
    scope?: TranslationScope,
): string | null {
    const indexes = syntheticRunIndexes(owner, nodes);
    if (!indexes) return null;
    const segment = owner.ownerDocument.createElement('span');
    nodes.forEach((node) => segment.appendChild(node.cloneNode(true)));
    const protectionOptions = allowTopLevelApplicationShell
        ? {allowTopLevelApplicationShell: true, protectedElement: segment}
        : {protectedElement: segment};
    const textNodes = collectLiveTranslationTextSlots(
        segment,
        getCurrentTranslationCore(scope).shouldStayOriginal,
        segment,
        protectionOptions,
    ).map((slot) => slot.node);
    return JSON.stringify(['synthetic-run', indexes, getTranslationSourceStructureSignature(
        segment,
        allowTopLevelApplicationShell,
        textNodes,
        scope,
    )]);
}

function capitulationKey(
    owner: HTMLElement,
    path: readonly number[],
    sourceText: string,
    sourceStructureSignature: string,
    translationInvocationIdentity: string | undefined,
    overflowGenerationIdentity?: string,
    scope?: TranslationScope,
): string {
    return JSON.stringify([
        owner.namespaceURI,
        owner.localName,
        path,
        sourceText.replace(/[\s\u3000]+/gu, ' ').trim(),
        isTranslationSourceStructureOverflow(sourceStructureSignature)
            ? [sourceStructureSignature, overflowGenerationIdentity]
            : sourceStructureSignature,
        translationInvocationIdentity ?? '',
        scope ?? 'content',
    ]);
}

/** 以稳定 mutation 边界而不是短命 owner 作为熔断所有者，使后续同源换代也保持降级。 */
export function createBilingualRemountCapitulationRegistry(): BilingualRemountCapitulationRegistry {
    const blockedByBoundary = new WeakMap<Node, Set<string>>();
    let blockedEntries = 0;
    const visitBoundaryKeys = (
        owner: HTMLElement,
        sourceText: string,
        sourceStructureSignature: string,
        translationInvocationIdentity: string | undefined,
        scope: TranslationScope | undefined,
        visit: (boundary: Node, key: string) => boolean,
    ): boolean => {
        const path: number[] = [];
        const overflowGenerationIdentity = isTranslationSourceStructureOverflow(sourceStructureSignature)
            ? getTranslationOverflowGenerationIdentity(owner)
            : undefined;
        let current: Node = owner;
        let boundary: Node | null = owner.parentNode;
        let depth = 0;
        while (boundary && depth < 128) {
            const index = Array.from(boundary.childNodes).indexOf(current as ChildNode);
            path.unshift(index);
            const key = capitulationKey(
                owner,
                path,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                overflowGenerationIdentity,
                scope,
            );
            if (visit(boundary, key)) return true;
            current = boundary;
            boundary = boundary.parentNode;
            depth += 1;
        }
        return false;
    };
    return {
        hasEntries: () => blockedEntries > 0,
        remember(boundary, owner, state) {
            if (!state.sourceStructureSignature) return;
            let identityOwner = owner;
            let sourceStructureSignature = state.sourceStructureSignature;
            if (state.syntheticSegment) {
                const host = state.syntheticHost ?? owner.parentElement ?? undefined;
                const sourceNodes = state.syntheticSourceNodes ?? [];
                const indexes = host ? syntheticRunIndexes(host, sourceNodes, owner) : null;
                if (!host || !indexes) return;
                identityOwner = host;
                sourceStructureSignature = JSON.stringify([
                    'synthetic-run', indexes, state.sourceStructureSignature,
                ]);
            }
            const storageBoundary = boundary === identityOwner && identityOwner.parentNode
                ? identityOwner.parentNode : boundary;
            const path = nodePathWithin(storageBoundary, identityOwner);
            if (!path) return;
            let blocked = blockedByBoundary.get(storageBoundary);
            if (!blocked) {
                blocked = new Set<string>();
                blockedByBoundary.set(storageBoundary, blocked);
            }
            const key = capitulationKey(
                identityOwner,
                path,
                state.sourceText,
                sourceStructureSignature,
                state.translationInvocationIdentity,
                state.sourceOverflowGenerationIdentity,
                state.scope,
            );
            if (!blocked.has(key)) {
                blocked.add(key);
                blockedEntries += 1;
            }
        },
        blocks(owner, sourceText, sourceStructureSignature, translationInvocationIdentity, scope) {
            if (blockedEntries === 0) return false;
            return visitBoundaryKeys(
                owner,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                scope,
                (boundary, key) => blockedByBoundary.get(boundary)?.has(key) === true,
            );
        },
        forget(owner, sourceText, sourceStructureSignature, translationInvocationIdentity, scope) {
            if (blockedEntries === 0) return;
            visitBoundaryKeys(
                owner,
                sourceText,
                sourceStructureSignature,
                translationInvocationIdentity,
                scope,
                (boundary, key) => {
                    const blocked = blockedByBoundary.get(boundary);
                    if (!blocked?.delete(key)) return false;
                    blockedEntries -= 1;
                    if (blocked.size === 0) blockedByBoundary.delete(boundary);
                    return false;
                },
            );
        },
    };
}

export function blocksBilingualRemountCandidate(
    registry: BilingualRemountCapitulationRegistry,
    owner: HTMLElement,
    sourceText: string,
    allowTopLevelApplicationShell: boolean,
    translationInvocationIdentity: string | undefined,
    sourceNodes?: readonly Node[],
    scope?: TranslationScope,
): boolean {
    const registryHasEntries = registry.hasEntries();
    if (!registryHasEntries && !hasBilingualArtifactHostWriteBudget(owner)) return false;
    const sourceStructureSignature = sourceNodes?.length
        ? syntheticCandidateStructureSignature(owner, sourceNodes, allowTopLevelApplicationShell, scope)
        : getTranslationSourceStructureSignature(owner, allowTopLevelApplicationShell, undefined, scope);
    if (!sourceStructureSignature) return false;
    return isBilingualArtifactHostWriteBudgetCapitulated(
        owner,
        sourceText,
        sourceStructureSignature,
        translationInvocationIdentity,
        scope,
    ) || registryHasEntries && registry.blocks(
        owner,
        sourceText,
        sourceStructureSignature,
        translationInvocationIdentity,
        scope,
    );
}

export function forgetBilingualRemountCandidate(
    registry: BilingualRemountCapitulationRegistry,
    owner: HTMLElement,
    sourceText: string,
    allowTopLevelApplicationShell: boolean,
    translationInvocationIdentity: string | undefined,
    sourceNodes?: readonly Node[],
    scope?: TranslationScope,
): void {
    if (!registry.hasEntries()) return;
    registry.forget(
        owner,
        sourceText,
        sourceNodes?.length
            ? syntheticCandidateStructureSignature(owner, sourceNodes, allowTopLevelApplicationShell, scope) ?? ''
            : getTranslationSourceStructureSignature(owner, allowTopLevelApplicationShell, undefined, scope),
        translationInvocationIdentity,
        scope,
    );
}

export type BilingualArtifactDisposition = 'current' | 'retry' | 'capitulated';

/** 统一判定一次双语工件拒绝，确保重挂、重建与熔断只消费一格共享预算。 */
export function stabilizeBilingualArtifact(
    owner: HTMLElement,
    state: TranslationState,
    registry: BilingualRemountCapitulationRegistry,
    reconcileLayout?: (owner: HTMLElement) => boolean,
): BilingualArtifactDisposition {
    const repair = tryRepairBilingualTranslationArtifact(owner, state, reconcileLayout);
    const sourceCurrent = statefulSourceAndTextSlotsAreCurrent(owner, state);
    // 属性漂移（宿主改写复制链接的 title 等）不改变译文，仍算当前工件：
    // 继续走恢复流程会撤下译文并重新请求，正是“划过译文里的链接就丢译文”的来源。
    const artifactCurrent = isBilingualArtifactKept(owner, state);
    if (sourceCurrent && artifactCurrent) return 'current';

    let capitulated = repair === 'capitulated';
    if (!capitulated && owner.isConnected && repair === 'not-repairable' && sourceCurrent && !artifactCurrent &&
        state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content') {
        capitulated = !consumeBilingualArtifactHostWriteBudget(owner, state);
    }
    if (!capitulated) return 'retry';
    if (owner.parentNode) registry.remember(owner.parentNode, owner, state);
    return 'capitulated';
}

function nodePathWithin(root: Node, target: Node): number[] | null {
    if (root === target) return [];
    const path: number[] = [];
    let current: Node | null = target;
    while (current && current !== root) {
        const parent: Node | null = current.parentNode;
        if (!parent) return null;
        const index = Array.from(parent.childNodes).indexOf(current as ChildNode);
        path.unshift(index);
        current = parent;
    }
    return path;
}

function nodeAtPath(root: Node, path: readonly number[]): Node | null {
    let current: Node | null = root;
    for (const index of path) {
        current = current?.childNodes.item(index) ?? null;
        if (!current) return null;
    }
    return current;
}

function asHTMLElement(node: Node | null): HTMLElement | null {
    if (!node || node.nodeType !== 1) return null;
    return node as HTMLElement;
}

function hasTransferableBilingualOwner(
    previousOwner: HTMLElement,
    replacementOwner: HTMLElement,
    signatureCache: WeakMap<HTMLElement, Map<string, string>>,
): boolean {
    const previousState = getTranslationState(previousOwner);
    const previousWrapper = previousState?.bilingualContent;
    const trustedTemplate = previousState?.bilingualContentTemplate;
    if (
        !previousState ||
        previousState.phase !== 'translated' ||
        previousState.mode !== 'bilingual' ||
        previousState.kind !== 'content' ||
        previousOwner.isConnected ||
        !replacementOwner.isConnected ||
        getTranslationState(replacementOwner) ||
        previousOwner.localName !== replacementOwner.localName ||
        previousOwner.namespaceURI !== replacementOwner.namespaceURI ||
        !previousWrapper ||
        !trustedTemplate ||
        !isTrustedBilingualArtifactWithHostClass(trustedTemplate, previousState) ||
        previousState.syntheticSegment !==
            (replacementOwner.getAttribute('data-fr-translation-segment') === 'true') ||
        (previousWrapper.parentNode !== previousOwner && previousWrapper.parentNode !== null &&
            previousWrapper.parentNode !== replacementOwner)
    ) return false;
    const replacementSignature = cachedSourceStructureSignature(
            replacementOwner,
            previousState.allowTopLevelApplicationShell === true,
            signatureCache,
            previousState,
        );
    if (isTranslationSourceStructureOverflow(previousState.sourceStructureSignature)
        ? getTranslationOverflowGenerationIdentity(replacementOwner) !==
            previousState.sourceOverflowGenerationIdentity
        : replacementSignature !== previousState.sourceStructureSignature) return false;

    return true;
}

function cachedSourceStructureSignature(
    owner: HTMLElement,
    allowTopLevelApplicationShell: boolean,
    cache: WeakMap<HTMLElement, Map<string, string>>,
    state?: TranslationState,
): string {
    let signatures = cache.get(owner);
    if (!signatures) {
        signatures = new Map<string, string>();
        cache.set(owner, signatures);
    }
    const cacheKey = `${allowTopLevelApplicationShell ? 1 : 0}:${state?.syntheticSegment ? 1 : 0}:${state?.scope ?? 'content'}`;
    const cached = signatures.get(cacheKey);
    if (cached !== undefined) return cached;
    const sourceTextNodes = state?.syntheticSegment ? collectLiveTranslationTextSlots(
        owner,
        getCurrentTranslationCore(state.scope).shouldStayOriginal,
        owner,
        state.allowTopLevelApplicationShell === true
            ? {allowTopLevelApplicationShell: true, protectedElement: owner}
            : {protectedElement: owner},
    ).map((slot) => slot.node) : undefined;
    const signature = getTranslationSourceStructureSignature(
        owner,
        allowTopLevelApplicationShell,
        sourceTextNodes,
        state?.scope,
    );
    signatures.set(cacheKey, signature);
    return signature;
}

function haveEquivalentBilingualOutputs(owners: ReadonlySet<HTMLElement> | undefined): boolean {
    if (!owners || owners.size <= 1) return true;
    return new Set(Array.from(owners, (owner) => getTranslationState(owner)?.bilingualOuterHTML)).size === 1;
}

type BilingualTransferOutcome = 'transferred' | 'capitulated' | 'rejected';

function tryTransferBilingualOwner(
    previousOwner: HTMLElement,
    replacementOwner: HTMLElement,
    layoutElementPairs: readonly (readonly [HTMLElement, HTMLElement])[],
    prepare: (
        previousOwner: HTMLElement,
        replacementOwner: HTMLElement,
        state: TranslationState,
    ) => BilingualRemountPreparation | null,
): BilingualTransferOutcome {
    const previousState = getTranslationState(previousOwner)!;
    const previousWrapper = previousState.bilingualContent!;
    const trustedTemplate = previousState.bilingualContentTemplate!;
    const directOwnedArtifacts = Array.from(replacementOwner.children).filter((child) =>
        child.matches('[data-fr-translation-owned="true"]')) as HTMLElement[];
    const copiedWrappers = directOwnedArtifacts.filter((child) =>
        child.matches(BILINGUAL_ARTIFACT_SELECTOR)) as HTMLElement[];

    const preparation = prepare(previousOwner, replacementOwner, previousState);
    if (!preparation) return 'rejected';
    const copiedContent = directOwnedArtifacts.length === 1 && copiedWrappers.length === 1 &&
        isTrustedBilingualArtifactWithHostClass(copiedWrappers[0]!, previousState)
        ? copiedWrappers[0] : undefined;
    const tamperedContent = directOwnedArtifacts.length > 0 && !copiedContent;
    const content = copiedContent ?? trustedTemplate.cloneNode(true) as HTMLElement;
    if (tamperedContent || copiedContent) directOwnedArtifacts.forEach((artifact) => artifact.remove());
    restoreClonedTranslationOwnerPresentation(
        previousOwner,
        replacementOwner,
        previousState,
        layoutElementPairs,
    );

    const attempt = beginTranslation(
        replacementOwner,
        'bilingual',
        'content',
        previousState.syntheticSegment,
        previousState.sourceText,
        preparation.sourceTextNodes,
        previousState.allowTopLevelApplicationShell === true,
        previousState.translationInvocationIdentity,
        previousState.scope,
    );
    if (!attempt) return 'rejected';
    if (!markTranslationComplete(replacementOwner, attempt.state, attempt.generation)) {
        discardTranslation(replacementOwner, attempt.state);
        return 'rejected';
    }
    if (!inheritBilingualArtifactRepairBudget(
        previousOwner,
        replacementOwner,
        previousState,
        attempt.state,
        copiedContent ? false : tamperedContent ? 'tamper' : true,
    )) {
        if (previousState.syntheticSegment) {
            previousState.syntheticHost = attempt.state.syntheticHost;
            previousState.syntheticSourceNodes = attempt.state.syntheticSourceNodes;
        }
        discardTranslation(replacementOwner, attempt.state);
        return 'capitulated';
    }

    if (content.parentNode !== replacementOwner) replacementOwner.appendChild(content);
    if (!preparation.reconcileLayout(replacementOwner)) {
        content.remove();
        discardTranslation(replacementOwner, attempt.state);
        return 'rejected';
    }
    setBilingualContent(
        replacementOwner,
        content,
        previousState.bilingualReplay,
        trustedTemplate,
    );
    setRenderedStyleAttribute(replacementOwner);
    if (previousWrapper === content) previousState.bilingualContent = undefined;
    discardTranslation(previousOwner, previousState);
    return 'transferred';
}

export function transferEquivalentBilingualOwners(
    mutationInput: MutationRecord | readonly MutationRecord[],
    prepare: (
        previousOwner: HTMLElement,
        replacementOwner: HTMLElement,
        state: TranslationState,
    ) => BilingualRemountPreparation | null,
    resolveRemovedOwners: RemovedTranslationOwnerResolver = getTranslationOwnersForRemovedNode,
): BilingualRemountResult {
    const mutations: readonly MutationRecord[] = Array.isArray(mutationInput)
        ? mutationInput as readonly MutationRecord[]
        : [mutationInput as MutationRecord];
    const childListMutations = mutations.filter((mutation) => mutation.type === 'childList');
    const addedEntries = childListMutations.flatMap((mutation) =>
        Array.from(mutation.addedNodes).map((node, index) => ({mutation, node, index})));
    if (addedEntries.length === 0 || !childListMutations.some((mutation) => mutation.removedNodes.length > 0)) {
        return {transfers: [], capitulations: []};
    }

    type RemovedEntry = {
        mutation: MutationRecord;
        removedRoot: Node;
        previousOwner: HTMLElement;
        path: number[];
        index: number;
    };
    const removedEntries: RemovedEntry[] = [];
    childListMutations.forEach((mutation) => Array.from(mutation.removedNodes).forEach((removedRoot, index) => {
        resolveRemovedOwners(removedRoot).forEach((previousOwner) => {
            const path = nodePathWithin(removedRoot, previousOwner);
            if (path) removedEntries.push({mutation, removedRoot, previousOwner, path, index});
        });
    }));
    const addedByBoundary = new Map<Node, typeof addedEntries>();
    addedEntries.forEach((entry) => {
        const entries = addedByBoundary.get(entry.mutation.target) ?? [];
        entries.push(entry);
        addedByBoundary.set(entry.mutation.target, entries);
    });
    const signatureCache = new WeakMap<HTMLElement, Map<string, string>>();
    const eligibleByRemoved = new Map<RemovedEntry, Map<HTMLElement, Node>>();
    const removedByReplacement = new Map<HTMLElement, Set<HTMLElement>>();
    const replacementsByPrevious = new Map<HTMLElement, Set<HTMLElement>>();
    const entriesByPrevious = new Map<HTMLElement, number>();
    removedEntries.forEach((entry) => {
        entriesByPrevious.set(entry.previousOwner, (entriesByPrevious.get(entry.previousOwner) ?? 0) + 1);
        const eligible = new Map<HTMLElement, Node>();
        for (const added of addedByBoundary.get(entry.mutation.target) ?? []) {
            const replacement = asHTMLElement(nodeAtPath(added.node, entry.path));
            if (replacement && hasTransferableBilingualOwner(
                entry.previousOwner,
                replacement,
                signatureCache,
            )) eligible.set(replacement, added.node);
        }
        eligibleByRemoved.set(entry, eligible);
        eligible.forEach((_addedRoot, replacement) => {
            const replacements = replacementsByPrevious.get(entry.previousOwner) ?? new Set<HTMLElement>();
            replacements.add(replacement);
            replacementsByPrevious.set(entry.previousOwner, replacements);
            const previousOwners = removedByReplacement.get(replacement) ?? new Set<HTMLElement>();
            previousOwners.add(entry.previousOwner);
            removedByReplacement.set(replacement, previousOwners);
        });
    });

    const pairs: Array<BilingualOwnerTransfer & {
        depth: number;
        boundary: Node;
        previousRoot: Node;
        replacementRoot: Node;
    }> = [];
    removedEntries.forEach((entry) => {
        const eligible = eligibleByRemoved.get(entry)!;
        if (entriesByPrevious.get(entry.previousOwner)! > 1 &&
            replacementsByPrevious.get(entry.previousOwner)?.size !== 1) return;
        const positionalOwner = entry.mutation.addedNodes.length === entry.mutation.removedNodes.length
            ? asHTMLElement(nodeAtPath(Array.from(entry.mutation.addedNodes)[entry.index]!, entry.path))
            : null;
        let replacementOwner = positionalOwner && eligible.has(positionalOwner) &&
            haveEquivalentBilingualOutputs(removedByReplacement.get(positionalOwner)) ? positionalOwner : null;
        if (!replacementOwner && eligible.size === 1) {
            const onlyCandidate = [...eligible.keys()][0]!;
            if (removedByReplacement.get(onlyCandidate)?.size === 1) replacementOwner = onlyCandidate;
        }
        if (replacementOwner) pairs.push({
            previousOwner: entry.previousOwner,
            replacementOwner,
            depth: entry.path.length,
            boundary: entry.mutation.target,
            previousRoot: entry.removedRoot,
            replacementRoot: eligible.get(replacementOwner)!,
        });
    });

    pairs.sort((left, right) => right.depth - left.depth);
    const adopted = new Set<HTMLElement>();
    const consumedPrevious = new Set<HTMLElement>();
    const transfers: BilingualOwnerTransfer[] = [];
    const capitulations: BilingualOwnerCapitulation[] = [];
    pairs.forEach(({previousOwner, replacementOwner, boundary, previousRoot, replacementRoot}) => {
        if (adopted.has(replacementOwner) || consumedPrevious.has(previousOwner)) return;
        const previousState = getTranslationState(previousOwner)!;
        const layoutElementPairs: Array<readonly [HTMLElement, HTMLElement]> = [];
        for (const previousElement of previousState.layoutOverrideElements ?? []) {
            const path = nodePathWithin(previousRoot, previousElement);
            if (!path) continue;
            const replacementElement = asHTMLElement(nodeAtPath(replacementRoot, path));
            if (!replacementElement || previousElement.localName !== replacementElement.localName ||
                previousElement.namespaceURI !== replacementElement.namespaceURI) return;
            layoutElementPairs.push([previousElement, replacementElement]);
        }
        const outcome = tryTransferBilingualOwner(
            previousOwner,
            replacementOwner,
            layoutElementPairs,
            prepare,
        );
        if (outcome === 'rejected') return;
        adopted.add(replacementOwner);
        consumedPrevious.add(previousOwner);
        if (outcome === 'transferred') transfers.push({previousOwner, replacementOwner});
        else capitulations.push({previousOwner, replacementOwner, boundary});
    });
    return {transfers, capitulations};
}
