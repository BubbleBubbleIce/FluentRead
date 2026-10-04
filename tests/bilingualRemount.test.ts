import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    blocksBilingualRemountCandidate,
    createBilingualRemountCapitulationRegistry,
    createRemovedTranslationOwnerResolver,
    forgetBilingualRemountCandidate,
    stabilizeBilingualArtifact,
    transferEquivalentBilingualOwners,
    type BilingualRemountPreparation,
} from '@/src/features/full-page-translation/content/bilingualRemount';
import {
    beginTranslation,
    beginBilingualArtifactHostWriteGesture,
    acquireTranslationLayoutOverride,
    consumeBilingualArtifactHostWriteBudget,
    getTranslationSourceStructureSignature,
    getTranslationState,
    hasTranslationLayoutOverride,
    isBilingualArtifactHostWriteBudgetCapitulated,
    markTranslationComplete,
    resetAllBilingualArtifactHostWriteBudgets,
    restoreAllTranslations,
    setBilingualContent,
    setRenderedStyleAttribute,
    tryRepairBilingualTranslationArtifact,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';
import {collectLiveTranslationTextSlots, getCurrentTranslationCore, translationTruncationStyleOverrides} from '@/src/core/translation/public';
import {isTranslationArtifactCurrent} from '@/src/features/full-page-translation/content/translationStability';

const BILINGUAL_SELECTOR =
    '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';

function childListRecord(target: Node, addedNodes: readonly Node[], removedNodes: readonly Node[]): MutationRecord {
    return {
        type: 'childList',
        target,
        addedNodes: addedNodes as unknown as NodeList,
        removedNodes: removedNodes as unknown as NodeList,
    } as MutationRecord;
}

function preparation(
    reconcileLayout: (owner: HTMLElement) => boolean = vi.fn(() => true),
): BilingualRemountPreparation {
    return {sourceTextNodes: [], reconcileLayout};
}

function createCommittedScenario() {
    const {document} = parseHTML('<html><body><p id="old">Same source.</p></body></html>');
    const previousOwner = document.querySelector<HTMLElement>('#old')!;
    const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [] )!;
    expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
    const previousWrapper = document.createElement('span');
    previousWrapper.className = 'fluent-read-bilingual-content';
    previousWrapper.setAttribute('data-fr-translation-owned', 'true');
    previousWrapper.setAttribute('translate', 'no');
    previousWrapper.textContent = '相同译文。';
    previousOwner.appendChild(previousWrapper);
    setBilingualContent(previousOwner, previousWrapper);

    let replacementOwner: HTMLElement = document.createElement('p');
    replacementOwner.id = 'new';
    replacementOwner.innerHTML = attempt.state.sourceHTML;
    previousOwner.replaceWith(replacementOwner);
    return {
        document,
        previousOwner,
        previousState: attempt.state,
        previousWrapper,
        get replacementOwner() {
            return replacementOwner;
        },
        set replacementOwner(value: HTMLElement) {
            replacementOwner.replaceWith(value);
            replacementOwner = value;
        },
        record: () => childListRecord(document.body, [replacementOwner], [previousOwner]),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    restoreAllTranslations();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
});

describe('双语 owner 同源重挂交接', () => {
    it.each(['distinct', 'repeated'] as const)('500 个 %s 段落整批换代只线性验证可信译文模板', (kind) => {
        const count = 500;
        const {document} = parseHTML('<html><body></body></html>');
        const previousOwners: HTMLElement[] = [];
        const replacements: HTMLElement[] = [];
        let templateReads = 0;
        for (let index = 0; index < count; index += 1) {
            const source = kind === 'distinct' ? `Source paragraph ${index}.` : 'Repeated source paragraph.';
            const owner = document.createElement('p');
            owner.textContent = source;
            document.body.appendChild(owner);
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, source, [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = kind === 'distinct' ? `段落 ${index}` : '重复段落';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            const template = attempt.state.bilingualContentTemplate!;
            let prototype = Object.getPrototypeOf(template);
            while (!Object.getOwnPropertyDescriptor(prototype, 'innerHTML')) prototype = Object.getPrototypeOf(prototype);
            const readHTML = Object.getOwnPropertyDescriptor(prototype, 'innerHTML')!.get!;
            Object.defineProperty(template, 'innerHTML', {configurable: true, get() {
                templateReads += 1;
                return readHTML.call(this);
            }});
            previousOwners.push(owner);
            const replacement = document.createElement('p');
            replacement.textContent = source;
            replacements.push(replacement);
        }
        document.body.replaceChildren(...replacements);
        const prepare = vi.fn(() => preparation());
        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, replacements, previousOwners), prepare,
        );
        expect(result.transfers).toHaveLength(count);
        expect(result.capitulations).toEqual([]);
        expect(prepare).toHaveBeenCalledTimes(count);
        replacements.forEach((owner, index) => {
            expect(owner.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(1);
            expect(owner.querySelector(BILINGUAL_SELECTOR)?.textContent).toBe(
                kind === 'distinct' ? `段落 ${index}` : '重复段落',
            );
        });
        expect(templateReads).toBeLessThanOrEqual(count * 6);
    });

    it('全部节点中的 GitHub 动态文字熔断后保持范围签名，显式重试可清除记录', () => {
        vi.stubGlobal('location', {href: 'https://github.com/org/repo/issues/1'});
        try {
            const {document} = parseHTML('<html><body><p id="owner">Research result <span aria-live="polite">Analysis completed</span>.</p></body></html>');
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const slots = collectLiveTranslationTextSlots(owner, getCurrentTranslationCore('all').shouldStayOriginal);
            const source = slots.map((slot) => slot.source).join(' ');
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, source,
                slots.map((slot) => slot.node), false, 'profile', 'all')!;
            const registry = createBilingualRemountCapitulationRegistry();
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '研究结果：分析完成。';
            owner.append(wrapper);
            setBilingualContent(owner, wrapper);
            expect(stabilizeBilingualArtifact(owner, attempt.state, registry)).toBe('current');
            registry.remember(document.body, owner, attempt.state);
            restoreAllTranslations();

            expect(blocksBilingualRemountCandidate(registry, owner, source, false, 'profile', undefined, 'all')).toBe(true);
            expect(blocksBilingualRemountCandidate(registry, owner, source, false, 'profile')).toBe(false);
            forgetBilingualRemountCandidate(registry, owner, source, false, 'profile');
            expect(registry.hasEntries()).toBe(true);
            forgetBilingualRemountCandidate(registry, owner, source, false, 'profile', undefined, 'all');
            expect(registry.hasEntries()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('正文与全部节点的相同原文和结构独立熔断，重试只清除对应范围', () => {
        const {document} = parseHTML('<html><body><p id="owner">Same source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.')!;
        const registry = createBilingualRemountCapitulationRegistry();
        registry.remember(document.body, owner, attempt.state);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined)).toBe(true);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined, undefined, 'content')).toBe(true);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined, undefined, 'all')).toBe(false);
        registry.remember(document.body, owner, {...attempt.state, scope: 'all'});
        forgetBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined)).toBe(false);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined, undefined, 'all')).toBe(true);
        forgetBilingualRemountCandidate(registry, owner, 'Same source.', false, undefined, undefined, 'all');
        expect(registry.hasEntries()).toBe(false);
    });

    it.each([
        ['content', 'all'], ['all', 'content'],
    ] as const)('%s 范围宿主拒绝预算不会阻断 %s，当前范围的熔断仍有效', (previousScope, nextScope) => {
        const {document} = parseHTML('<html><body><p id="owner">Same source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.',
            undefined, false, 'profile', previousScope)!;
        const registry = createBilingualRemountCapitulationRegistry();
        for (let repair = 0; repair < 3; repair += 1) {
            expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(true);
        }
        expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(false);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, 'profile', undefined, previousScope)).toBe(true);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, 'profile', undefined, nextScope)).toBe(false);
        const nextState = {...attempt.state, scope: nextScope};
        for (let repair = 0; repair < 3; repair += 1) {
            expect(consumeBilingualArtifactHostWriteBudget(owner, nextState)).toBe(true);
        }
        expect(consumeBilingualArtifactHostWriteBudget(owner, nextState)).toBe(false);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, 'profile', undefined, nextScope)).toBe(true);
        expect(blocksBilingualRemountCandidate(registry, owner, 'Same source.', false, 'profile', undefined, previousScope)).toBe(false);
    });

    it('全部节点合成段恢复解包后仍以原范围匹配动态子节点的结构签名', () => {
        vi.stubGlobal('location', {href: 'https://github.com/org/repo/issues/1'});
        try {
            const {document} = parseHTML('<html><body><p id="host"><span id="segment" data-fr-translation-segment="true">Research result <span aria-live="polite">Analysis completed</span>.</span></p></body></html>');
            const host = document.querySelector<HTMLElement>('#host')!;
            const segment = document.querySelector<HTMLElement>('#segment')!;
            const nodes = Array.from(segment.childNodes);
            const slots = collectLiveTranslationTextSlots(segment, getCurrentTranslationCore('all').shouldStayOriginal, segment);
            const source = slots.map((slot) => slot.source).join(' ');
            const attempt = beginTranslation(segment, 'bilingual', 'content', true, source,
                slots.map((slot) => slot.node), false, 'profile', 'all')!;
            const registry = createBilingualRemountCapitulationRegistry();
            registry.remember(host, segment, attempt.state);
            restoreAllTranslations();

            expect(nodes.every((node) => node.parentNode === host)).toBe(true);
            expect(blocksBilingualRemountCandidate(registry, host, source, false, 'profile', nodes, 'all')).toBe(true);
            expect(blocksBilingualRemountCandidate(registry, host, source, false, 'profile', nodes)).toBe(false);
            forgetBilingualRemountCandidate(registry, host, source, false, 'profile', nodes, 'all');
            expect(registry.hasEntries()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('PR447 提交列表给译文链接反复设置 tabIndex 时保留同一译文，恢复后仍可再次翻译', () => {
        const {document} = parseHTML('<html><body><h4><a href="/commit/abc">Fix translation stability.</a></h4></body></html>');
        const owner = document.querySelector<HTMLElement>('h4')!;
        const source = owner.innerHTML;
        for (let turn = 0; turn < 2; turn += 1) {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Fix translation stability.', [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.innerHTML = '<a href="/commit/abc">修复翻译稳定性。</a>';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            const link = wrapper.querySelector('a')!;
            for (let frame = 0; frame < 12; frame += 1) {
                if (frame % 3 === 0) link.removeAttribute('tabindex');
                else link.setAttribute('tabindex', frame % 3 === 1 ? '-1' : '0');
                expect(isTranslationArtifactCurrent(owner, attempt.state), `turn ${turn} frame ${frame}`).toBe(true);
                expect(tryRepairBilingualTranslationArtifact(owner, attempt.state)).toBe('repaired');
                expect(attempt.state.bilingualContent).toBe(wrapper);
                expect(wrapper.querySelector('a')).toBe(link);
                expect(isBilingualArtifactHostWriteBudgetCapitulated(owner, attempt.state.sourceText,
                    attempt.state.sourceStructureSignature!, attempt.state.translationInvocationIdentity)).toBe(false);
            }
            restoreAllTranslations();
            expect(owner.innerHTML).toBe(source);
        }
    });

    it('同一 observer 批次缓存 removed subtree 的 owner 集合', () => {
        const scenario = createCommittedScenario();
        const resolve = createRemovedTranslationOwnerResolver();
        const first = resolve(scenario.previousOwner);

        expect(first).toContain(scenario.previousOwner);
        expect(resolve(scenario.previousOwner)).toBe(first);
    });

    it('空熔断状态对未翻译 synthetic 候选保持 O(1)，不克隆或扫描来源结构', () => {
        const {document} = parseHTML('<html><body><p id="host">Inline source.</p></body></html>');
        const host = document.querySelector<HTMLElement>('#host')!;
        const source = host.firstChild!;
        const clone = vi.spyOn(source, 'cloneNode');

        expect(blocksBilingualRemountCandidate(
            createBilingualRemountCapitulationRegistry(),
            host,
            'Inline source.',
            false,
            undefined,
            [source],
        )).toBe(false);
        expect(clone).not.toHaveBeenCalled();
    });

    it('synthetic 墓碑查询覆盖 allowTopLevel 签名并拒绝非宿主来源节点', () => {
        const {document} = parseHTML('<html><body><p id="host">Inline source.</p></body></html>');
        const host = document.querySelector<HTMLElement>('#host')!;
        const source = host.firstChild!;
        const registry = {
            hasEntries: () => true,
            remember: vi.fn(),
            blocks: vi.fn(() => false),
            forget: vi.fn(),
        };

        expect(blocksBilingualRemountCandidate(
            registry, host, 'Inline source.', true, 'profile', [source],
        )).toBe(false);
        expect(registry.blocks).toHaveBeenCalledOnce();

        const detached = document.createTextNode('Inline source.');
        expect(blocksBilingualRemountCandidate(
            registry, host, 'Inline source.', false, 'profile', [detached],
        )).toBe(false);
        expect(registry.blocks).toHaveBeenCalledOnce();
    });

    it('长行内片段的熔断查询只复制一次宿主兄弟列表，并保留精确节点位置', () => {
        const {document} = parseHTML('<html><body><p id="host"><code>Before</code><code>After</code></p></body></html>');
        const host = document.querySelector<HTMLElement>('#host')!;
        const before = host.firstChild!;
        const after = host.lastChild!;
        const sources = Array.from({length: 500}, (_, index) => document.createTextNode(`Source ${index}. `));
        sources.forEach(source => host.insertBefore(source, after));
        const registry = {hasEntries: () => true, remember: vi.fn(), blocks: vi.fn((_owner: HTMLElement, _source: string, _signature: string) => true), forget: vi.fn()};
        const from = Array.from;
        let siblingCopies = 0;
        const copies = vi.spyOn(Array, 'from').mockImplementation(((input: ArrayLike<unknown>, ...rest: unknown[]) => {
            if (input[0] === before && input[input.length - 1] === after) siblingCopies += 1;
            return Reflect.apply(from, Array, [input, ...rest]);
        }) as typeof Array.from);
        let blocked: boolean;
        try {
            blocked = blocksBilingualRemountCandidate(registry, host, sources.map(source => source.data).join(''), false, 'profile', sources);
        } finally {
            copies.mockRestore();
        }
        expect(blocked!).toBe(true);
        const signature = JSON.parse(registry.blocks.mock.calls[0][2] as string);
        expect(signature[1]).toEqual(Array.from({length: 500}, (_, index) => index + 1));
        expect(siblingCopies).toBeLessThanOrEqual(1);
        expect(Array.from(host.childNodes)).toEqual([before, ...sources, after]);
    });

    it('synthetic registry 从 materialized segment 记录墓碑，解包后可按 run 节点精确忘记', () => {
        const {document} = parseHTML(
            '<html><body><p id="host"><span id="segment" data-fr-translation-segment="true">Inline source.</span></p></body></html>',
        );
        const host = document.querySelector<HTMLElement>('#host')!;
        const segment = document.querySelector<HTMLElement>('#segment')!;
        const source = segment.firstChild as Text;
        const attempt = beginTranslation(
            segment, 'bilingual', 'content', true, source.data, [source], false, 'profile',
        )!;
        const registry = createBilingualRemountCapitulationRegistry();
        attempt.state.syntheticHost = undefined;
        registry.remember(host, segment, attempt.state);
        expect(registry.hasEntries()).toBe(true);

        restoreAllTranslations();
        expect(source.parentNode).toBe(host);
        expect(blocksBilingualRemountCandidate(
            registry, host, source.data, false, 'profile', [source],
        )).toBe(true);
        forgetBilingualRemountCandidate(
            registry,
            host,
            source.data,
            false,
            'profile',
            [document.createTextNode(source.data)],
        );
        expect(registry.hasEntries()).toBe(true);
        forgetBilingualRemountCandidate(
            registry, host, source.data, false, 'profile', [source],
        );
        expect(registry.hasEntries()).toBe(false);
    });

    it('synthetic registry 对缺失 host/source 和瞬时不一致的 childNodes 快照保守 no-op', () => {
        const {document} = parseHTML(
            '<html><body><p id="host"><span id="segment" data-fr-translation-segment="true">Inline source.</span></p></body></html>',
        );
        const host = document.querySelector<HTMLElement>('#host')!;
        const segment = document.querySelector<HTMLElement>('#segment')!;
        const source = segment.firstChild as Text;
        const attempt = beginTranslation(segment, 'bilingual', 'content', true, source.data, [source])!;
        const state = attempt.state;

        const missingHost = createBilingualRemountCapitulationRegistry();
        const detachedOwner = segment.cloneNode(true) as HTMLElement;
        missingHost.remember(document.body, detachedOwner, {
            ...state,
            syntheticHost: undefined,
            syntheticSourceNodes: [detachedOwner.firstChild!],
        });
        expect(missingHost.hasEntries()).toBe(false);

        const missingSources = createBilingualRemountCapitulationRegistry();
        missingSources.remember(host, segment, {...state, syntheticSourceNodes: undefined});
        expect(missingSources.hasEntries()).toBe(false);

        const mismatchedSource = createBilingualRemountCapitulationRegistry();
        mismatchedSource.remember(host, segment, {
            ...state,
            syntheticSourceNodes: [document.createTextNode('detached')],
        });
        expect(mismatchedSource.hasEntries()).toBe(false);

        const inconsistentSegmentSnapshot = createBilingualRemountCapitulationRegistry();
        Object.defineProperty(host, 'childNodes', {configurable: true, value: []});
        inconsistentSegmentSnapshot.remember(host, segment, state);
        expect(inconsistentSegmentSnapshot.hasEntries()).toBe(false);

        const directHost = document.createElement('p');
        document.body.appendChild(directHost);
        const directSource = document.createTextNode('Inline source.');
        directHost.appendChild(directSource);
        const detachedSegment = document.createElement('span');
        const inconsistentRunSnapshot = createBilingualRemountCapitulationRegistry();
        Object.defineProperty(directHost, 'childNodes', {configurable: true, value: []});
        inconsistentRunSnapshot.remember(document.body, detachedSegment, {
            ...state,
            syntheticHost: directHost,
            syntheticSourceNodes: [directSource],
        });
        expect(inconsistentRunSnapshot.hasEntries()).toBe(false);
    });

    it('无可信模板的已译 owner 在工件缺失后最多重试三次再熔断', () => {
        const {document} = parseHTML('<html><body><p id="owner">Same source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const source = owner.firstChild as Text;
        const attempt = beginTranslation(
            owner, 'bilingual', 'content', false, source.data, [source], false, 'profile',
        )!;
        expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
        const registry = createBilingualRemountCapitulationRegistry();

        expect([
            stabilizeBilingualArtifact(owner, attempt.state, registry),
            stabilizeBilingualArtifact(owner, attempt.state, registry),
            stabilizeBilingualArtifact(owner, attempt.state, registry),
            stabilizeBilingualArtifact(owner, attempt.state, registry),
        ]).toEqual(['retry', 'retry', 'retry', 'capitulated']);
        expect(registry.hasEntries()).toBe(true);
        expect(registry.blocks(
            owner,
            attempt.state.sourceText,
            attempt.state.sourceStructureSignature!,
            attempt.state.translationInvocationIdentity,
        )).toBe(true);
    });

    it('熔断墓碑绑定稳定父边界、结构与调用身份', () => {
        const scenario = createCommittedScenario();
        const registry = createBilingualRemountCapitulationRegistry();
        registry.remember(scenario.document.body, scenario.replacementOwner, scenario.previousState);
        registry.remember(scenario.document.body, scenario.replacementOwner, scenario.previousState);

        expect(registry.blocks(
            scenario.replacementOwner,
            'Same   source.',
            scenario.previousState.sourceStructureSignature!,
            undefined,
        )).toBe(true);
        expect(registry.blocks(
            scenario.replacementOwner,
            'Different source.',
            scenario.previousState.sourceStructureSignature!,
            undefined,
        )).toBe(false);
        expect(registry.blocks(
            scenario.replacementOwner,
            'Same source.',
            'different-structure',
            undefined,
        )).toBe(false);
        expect(registry.blocks(
            scenario.replacementOwner,
            'Same source.',
            scenario.previousState.sourceStructureSignature!,
            'different-profile',
        )).toBe(false);

        const emptyRegistry = createBilingualRemountCapitulationRegistry();
        emptyRegistry.remember(
            scenario.document.body,
            scenario.replacementOwner,
            {...scenario.previousState, sourceStructureSignature: undefined},
        );
        expect(emptyRegistry.blocks(
            scenario.replacementOwner,
            'Same source.',
            scenario.previousState.sourceStructureSignature!,
            undefined,
        )).toBe(false);
        emptyRegistry.remember(
            scenario.document.createElement('aside'),
            scenario.replacementOwner,
            scenario.previousState,
        );
        expect(emptyRegistry.hasEntries()).toBe(false);
    });

    it('熔断只屏蔽 boundary 下的原 replacement slot，不误伤同文同结构 sibling', () => {
        const scenario = createCommittedScenario();
        const sibling = scenario.document.createElement('p');
        sibling.textContent = 'Same source.';
        scenario.document.body.appendChild(sibling);
        const registry = createBilingualRemountCapitulationRegistry();

        registry.remember(scenario.document.body, scenario.replacementOwner, scenario.previousState);

        expect(registry.blocks(
            scenario.replacementOwner,
            'Same source.',
            scenario.previousState.sourceStructureSignature!,
            undefined,
        )).toBe(true);
        expect(registry.blocks(
            sibling,
            'Same source.',
            scenario.previousState.sourceStructureSignature!,
            undefined,
        )).toBe(false);
    });

    it('overflow 熔断跨同一精确 generation 的 owner 换代保持，根语义变化后解锁', () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        let deepest = owner;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        deepest.textContent = 'Same source.';
        const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.')!;
        expect(attempt.state.sourceStructureSignature).toBe('overflow');
        const registry = createBilingualRemountCapitulationRegistry();
        registry.remember(document.body, owner, attempt.state);

        expect(registry.hasEntries()).toBe(true);
        expect(registry.blocks(owner, 'Same source.', 'overflow', undefined)).toBe(true);
        expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(true);
        expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(true);
        expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(true);
        expect(consumeBilingualArtifactHostWriteBudget(owner, attempt.state)).toBe(false);
        expect(isBilingualArtifactHostWriteBudgetCapitulated(
            owner, 'Same source.', 'overflow', undefined,
        )).toBe(true);
        expect(blocksBilingualRemountCandidate(
            registry, owner, 'Same source.', false, undefined,
        )).toBe(true);

        const replacement = owner.cloneNode(true) as HTMLElement;
        owner.replaceWith(replacement);
        expect(isBilingualArtifactHostWriteBudgetCapitulated(
            replacement, 'Same source.', 'overflow', undefined,
        )).toBe(false);
        expect(blocksBilingualRemountCandidate(
            registry, replacement, 'Same source.', false, undefined,
        )).toBe(true);

        replacement.setAttribute('lang', 'fr');
        expect(blocksBilingualRemountCandidate(
            registry, replacement, 'Same source.', false, undefined,
        )).toBe(false);
    });

    it('registry.forget 只清除指定 slot，全部墓碑清除后 hasEntries 恢复 false', () => {
        const scenario = createCommittedScenario();
        const sibling = scenario.document.createElement('p');
        sibling.textContent = 'Same source.';
        scenario.document.body.appendChild(sibling);
        const registry = createBilingualRemountCapitulationRegistry();
        const signature = scenario.previousState.sourceStructureSignature!;

        expect(registry.hasEntries()).toBe(false);
        forgetBilingualRemountCandidate(
            registry,
            scenario.replacementOwner,
            'Same source.',
            false,
            undefined,
        );
        registry.forget(scenario.replacementOwner, 'Same source.', signature, undefined);
        registry.remember(scenario.document.body, scenario.replacementOwner, scenario.previousState);
        registry.remember(scenario.document.body, sibling, scenario.previousState);
        expect(registry.hasEntries()).toBe(true);

        forgetBilingualRemountCandidate(
            registry,
            scenario.replacementOwner,
            'Same source.',
            false,
            undefined,
        );
        expect(registry.hasEntries()).toBe(true);
        expect(registry.blocks(
            scenario.replacementOwner,
            'Same source.',
            signature,
            undefined,
        )).toBe(false);
        expect(registry.blocks(sibling, 'Same source.', signature, undefined)).toBe(true);

        registry.forget(sibling, 'Same source.', signature, undefined);
        expect(registry.hasEntries()).toBe(false);
        expect(registry.blocks(sibling, 'Same source.', signature, undefined)).toBe(false);
    });

    it('整个 source-only owner 被替换时同步复制译文并重建状态', () => {
        const scenario = createCommittedScenario();
        const reconcileLayout = vi.fn(() => true);
        const prepare = vi.fn(() => preparation(reconcileLayout));
        expect(getTranslationSourceStructureSignature(scenario.replacementOwner))
            .toBe(scenario.previousState.sourceStructureSignature);

        const {transfers, capitulations} = transferEquivalentBilingualOwners(scenario.record(), prepare);

        expect(transfers).toEqual([{
            previousOwner: scenario.previousOwner,
            replacementOwner: scenario.replacementOwner,
        }]);
        expect(capitulations).toEqual([]);
        expect(prepare).toHaveBeenCalledWith(
            scenario.previousOwner,
            scenario.replacementOwner,
            scenario.previousState,
        );
        expect(reconcileLayout).toHaveBeenCalledWith(scenario.replacementOwner);
        expect(getTranslationState(scenario.previousOwner)).toBeUndefined();
        expect(getTranslationState(scenario.replacementOwner)).toMatchObject({
            phase: 'translated',
            mode: 'bilingual',
            sourceText: 'Same source.',
        });
        expect(scenario.previousWrapper.isConnected).toBe(false);
        expect(scenario.replacementOwner.querySelector('.fluent-read-bilingual-content')?.textContent)
            .toBe('相同译文。');
    });

    it('含格式化空白 Text 的真实来源槽在原位修复、owner 换代与墓碑查询中保持同一签名', () => {
        const {document} = parseHTML('<html><body><p id="old">\n  <span>Same source.</span>\n</p></body></html>');
        const previousOwner = document.querySelector<HTMLElement>('#old')!;
        const source = previousOwner.querySelector('span')!.firstChild as Text;
        const attempt = beginTranslation(
            previousOwner, 'bilingual', 'content', false, 'Same source.', [source],
        )!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '相同译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);

        expect(getTranslationSourceStructureSignature(previousOwner))
            .toBe(attempt.state.sourceStructureSignature);
        wrapper.remove();
        expect(tryRepairBilingualTranslationArtifact(previousOwner, attempt.state)).toBe('repaired');

        const replacementOwner = document.createElement('p');
        replacementOwner.innerHTML = attempt.state.sourceHTML;
        previousOwner.replaceWith(replacementOwner);
        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, [replacementOwner], [previousOwner]),
            () => ({
                sourceTextNodes: [replacementOwner.querySelector('span')!.firstChild as Text],
                reconcileLayout: () => true,
            }),
        );
        expect(result.transfers).toHaveLength(1);
        expect(result.capitulations).toEqual([]);

        const registry = createBilingualRemountCapitulationRegistry();
        const replacementState = getTranslationState(replacementOwner)!;
        registry.remember(document.body, replacementOwner, replacementState);
        expect(registry.blocks(
            replacementOwner,
            replacementState.sourceText,
            getTranslationSourceStructureSignature(replacementOwner),
            replacementState.translationInvocationIdentity,
        )).toBe(true);
    });

    it('聚合同一 observer callback 中分开的 remove/add 记录', () => {
        const scenario = createCommittedScenario();
        const removeRecord = childListRecord(scenario.document.body, [], [scenario.previousOwner]);
        const addRecord = childListRecord(scenario.document.body, [scenario.replacementOwner], []);
        const otherBoundary = scenario.document.createElement('section');
        const unrelated = scenario.document.createElement('p');
        scenario.document.body.appendChild(otherBoundary);
        otherBoundary.appendChild(unrelated);

        const result = transferEquivalentBilingualOwners(
            [removeRecord, childListRecord(otherBoundary, [unrelated], []), addRecord],
            () => preparation(),
        );

        expect(result.transfers).toEqual([{
            previousOwner: scenario.previousOwner,
            replacementOwner: scenario.replacementOwner,
        }]);
        expect(result.capitulations).toEqual([]);
        expect(getTranslationState(scenario.replacementOwner)?.phase).toBe('translated');
        expect(scenario.replacementOwner.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(1);
    });

    it('不跨不同 mutation 边界配对 remove-only 与 add-only 记录', () => {
        const scenario = createCommittedScenario();
        const otherBoundary = scenario.document.createElement('section');
        scenario.document.body.appendChild(otherBoundary);
        const unrelated = scenario.replacementOwner.cloneNode(true) as HTMLElement;
        otherBoundary.appendChild(unrelated);
        const prepare = vi.fn(() => preparation());

        const result = transferEquivalentBilingualOwners([
            childListRecord(scenario.document.body, [], [scenario.previousOwner]),
            childListRecord(otherBoundary, [unrelated], []),
        ], prepare);

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(prepare).not.toHaveBeenCalled();
        expect(getTranslationState(scenario.previousOwner)).toBe(scenario.previousState);
        expect(getTranslationState(unrelated)).toBeUndefined();
    });

    it('结构快照溢出时只对精确 HTML 与根语义一致的 owner 换代复用旧译文', () => {
        const {document} = parseHTML('<html><body><div id="old"></div></body></html>');
        const previousOwner = document.querySelector<HTMLElement>('#old')!;
        let deepest = previousOwner;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        deepest.textContent = 'Deep source.';
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Deep source.')!;
        expect(attempt.state.sourceStructureSignature).toBe('overflow');
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '深层译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);

        const replacementOwner = previousOwner.cloneNode(false) as HTMLElement;
        replacementOwner.innerHTML = attempt.state.sourceHTML;
        previousOwner.replaceWith(replacementOwner);
        const prepare = vi.fn(() => preparation());

        expect(transferEquivalentBilingualOwners(
            childListRecord(document.body, [replacementOwner], [previousOwner]),
            prepare,
        ).transfers).toEqual([{previousOwner, replacementOwner}]);
        expect(prepare).toHaveBeenCalledOnce();
        expect(getTranslationState(replacementOwner)?.phase).toBe('translated');
        expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)?.textContent).toBe('深层译文。');

        const changedRootOwner = replacementOwner.cloneNode(false) as HTMLElement;
        changedRootOwner.setAttribute('lang', 'fr');
        changedRootOwner.innerHTML = getTranslationState(replacementOwner)!.sourceHTML;
        replacementOwner.replaceWith(changedRootOwner);
        expect(transferEquivalentBilingualOwners(
            childListRecord(document.body, [changedRootOwner], [replacementOwner]),
            () => preparation(),
        )).toEqual({transfers: [], capitulations: []});
        changedRootOwner.removeAttribute('lang');
        expect(transferEquivalentBilingualOwners(
            childListRecord(document.body, [changedRootOwner], [replacementOwner]),
            () => { changedRootOwner.setAttribute('lang', 'fr'); return preparation(); },
        )).toEqual({transfers: [], capitulations: []});
    });

    it('不等量批量替换只在唯一结构候选上交接，歧义时保守拒绝', () => {
        const scenario = createCommittedScenario();
        const unrelated = scenario.document.createElement('aside');
        unrelated.textContent = 'unrelated';
        scenario.document.body.insertBefore(unrelated, scenario.replacementOwner);
        const result = transferEquivalentBilingualOwners(
            childListRecord(
                scenario.document.body,
                [unrelated, scenario.replacementOwner],
                [scenario.previousOwner],
            ),
            () => preparation(),
        );
        expect(result.transfers).toHaveLength(1);

        restoreAllTranslations();
        const ambiguous = createCommittedScenario();
        const second = ambiguous.replacementOwner.cloneNode(true) as HTMLElement;
        ambiguous.document.body.appendChild(second);
        expect(transferEquivalentBilingualOwners(
            [
                childListRecord(ambiguous.document.body, [], [ambiguous.previousOwner]),
                childListRecord(ambiguous.document.body, [ambiguous.replacementOwner, second], []),
            ],
            () => preparation(),
        )).toEqual({transfers: [], capitulations: []});
    });

    it('同一 MutationRecord 删除一个但新增两个等价 owner 时拒绝歧义配对', () => {
        const scenario = createCommittedScenario();
        const secondReplacement = scenario.replacementOwner.cloneNode(true) as HTMLElement;
        scenario.document.body.appendChild(secondReplacement);
        const prepare = vi.fn(() => preparation());

        const result = transferEquivalentBilingualOwners(
            childListRecord(
                scenario.document.body,
                [scenario.replacementOwner, secondReplacement],
                [scenario.previousOwner],
            ),
            prepare,
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(prepare).not.toHaveBeenCalled();
        expect(getTranslationState(scenario.previousOwner)).toBe(scenario.previousState);
        expect(getTranslationState(scenario.replacementOwner)).toBeUndefined();
        expect(getTranslationState(secondReplacement)).toBeUndefined();
    });

    it('同一旧 owner 在一个 callback 的两条记录指向两个 replacement 时整体拒绝', () => {
        const scenario = createCommittedScenario();
        const secondReplacement = scenario.replacementOwner.cloneNode(true) as HTMLElement;
        scenario.document.body.appendChild(secondReplacement);
        const prepare = vi.fn(() => preparation());

        const result = transferEquivalentBilingualOwners([
            childListRecord(scenario.document.body, [scenario.replacementOwner], [scenario.previousOwner]),
            childListRecord(scenario.document.body, [secondReplacement], [scenario.previousOwner]),
        ], prepare);

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(prepare).not.toHaveBeenCalled();
        expect(getTranslationState(scenario.previousOwner)).toBe(scenario.previousState);
        expect(getTranslationState(scenario.replacementOwner)).toBeUndefined();
        expect(getTranslationState(secondReplacement)).toBeUndefined();
    });

    it('同一记录的两个同文 owner 按位置一一交接，不因结构相同误判歧义', () => {
        const {document} = parseHTML(
            '<html><body><p id="first">Same source.</p><p id="second">Same source.</p></body></html>',
        );
        const previousOwners = Array.from(document.querySelectorAll<HTMLElement>('p'));
        previousOwners.forEach((owner) => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.', [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '相同译文。';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
        });
        const replacements = previousOwners.map(() => {
            const replacement = document.createElement('p');
            replacement.textContent = 'Same source.';
            return replacement;
        });
        document.body.replaceChildren(...replacements);

        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, replacements, previousOwners),
            () => preparation(),
        );

        expect(result.transfers).toEqual([
            {previousOwner: previousOwners[0], replacementOwner: replacements[0]},
            {previousOwner: previousOwners[1], replacementOwner: replacements[1]},
        ]);
        replacements.forEach((owner) => {
            expect(getTranslationState(owner)?.phase).toBe('translated');
            expect(owner.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(1);
        });
    });

    it('同文 owner 的译文不同且列表重排时保守拒绝，避免按位置交叉接管', () => {
        const {document} = parseHTML(
            '<html><body><p data-id="a">Same source.</p><p data-id="b">Same source.</p></body></html>',
        );
        const previousOwners = Array.from(document.querySelectorAll<HTMLElement>('p'));
        previousOwners.forEach((owner, index) => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.', [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = `上下文译文 ${index + 1}`;
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
        });
        const replacements = ['b', 'a'].map((id) => {
            const replacement = document.createElement('p');
            replacement.dataset.id = id;
            replacement.textContent = 'Same source.';
            return replacement;
        });
        document.body.replaceChildren(...replacements);

        expect(transferEquivalentBilingualOwners(
            childListRecord(document.body, replacements, previousOwners),
            () => preparation(),
        )).toEqual({transfers: [], capitulations: []});
        replacements.forEach((owner) => {
            expect(getTranslationState(owner)).toBeUndefined();
            expect(owner.querySelector(BILINGUAL_SELECTOR)).toBeNull();
        });
    });

    it.each([false, true])('跨两种移除路径指向同一新 owner 时统一汇总输出歧义：相同=%s', (sameOutput) => {
        const {document} = parseHTML('<html><body><p>Same source.</p><section><p>Same source.</p></section></body></html>');
        const previousOwners = Array.from(document.querySelectorAll<HTMLElement>('p'));
        const previousSection = document.querySelector<HTMLElement>('section')!;
        previousOwners.forEach((owner, index) => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.', [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = sameOutput ? '同一译文' : `不同译文 ${index}`;
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
        });
        const replacementSection = document.createElement('section');
        const replacement = document.createElement('p');
        replacement.textContent = 'Same source.';
        replacementSection.appendChild(replacement);
        document.body.replaceChildren(replacementSection);
        const result = transferEquivalentBilingualOwners([
            childListRecord(document.body, [replacement], [previousOwners[0]!]),
            childListRecord(document.body, [replacementSection], [previousSection]),
        ], () => preparation());
        expect(result.transfers).toHaveLength(sameOutput ? 1 : 0);
        expect(replacement.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(sameOutput ? 1 : 0);
        if (sameOutput) expect(result.transfers[0]!.previousOwner).toBe(previousOwners[1]);
    });

    it('结构快照缺失的旧 owner 不复用已有译文', () => {
        const scenario = createCommittedScenario();
        scenario.previousState.sourceStructureSignature = undefined;
        expect(transferEquivalentBilingualOwners(scenario.record(), () => preparation()))
            .toEqual({transfers: [], capitulations: []});
        expect(scenario.replacementOwner.querySelector(BILINGUAL_SELECTOR)).toBeNull();
    });

    it.each([false, true])('批量接管先落位再校验布局，单项拒绝不影响其他段落：来源变更=%s', (changeSource) => {
        const {document} = parseHTML('<html><body><p>Source one.</p><p>Source two.</p></body></html>');
        const previousOwners = Array.from(document.querySelectorAll<HTMLElement>('p'));
        const replacements = previousOwners.map((owner) => owner.cloneNode(true) as HTMLElement);
        previousOwners.forEach((owner, index) => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, owner.textContent!, [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = `译文 ${index}`;
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
        });
        document.body.replaceChildren(...replacements);
        let firstLayoutWrapperCount: number | undefined;
        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, replacements, previousOwners),
            (_previous, replacement) => {
                if (changeSource && replacement === replacements[1]) replacements[0]!.textContent = 'Host changed source.';
                return preparation((owner) => {
                    firstLayoutWrapperCount ??= document.querySelectorAll(BILINGUAL_SELECTOR).length;
                    return owner !== replacements[0];
                });
            },
        );
        expect(firstLayoutWrapperCount).toBe(changeSource ? 1 : 2);
        expect(result.transfers).toEqual([{previousOwner: previousOwners[1], replacementOwner: replacements[1]}]);
        expect(getTranslationState(replacements[0]!)).toBeUndefined();
        expect(replacements[0]!.textContent).toBe(changeSource ? 'Host changed source.' : 'Source one.');
        expect(replacements[0]!.querySelector(BILINGUAL_SELECTOR)).toBeNull();
        expect(replacements[1]!.querySelector(BILINGUAL_SELECTOR)?.textContent).toBe('译文 1');
    });

    it('同一 MutationRecord 删除两个等价 owner 但只新增一个时拒绝歧义配对', () => {
        const {document} = parseHTML(`
            <html><body><p id="first">Same source.</p><p id="second">Same source.</p></body></html>
        `);
        const first = document.querySelector<HTMLElement>('#first')!;
        const second = document.querySelector<HTMLElement>('#second')!;
        const commit = (owner: HTMLElement) => {
            const attempt = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.', [])!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '相同译文。';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            return attempt.state;
        };
        const firstState = commit(first);
        const secondState = commit(second);
        const replacement = document.createElement('p');
        replacement.textContent = 'Same source.';
        document.body.replaceChildren(replacement);
        const prepare = vi.fn(() => preparation());

        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, [replacement], [first, second]),
            prepare,
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(prepare).not.toHaveBeenCalled();
        expect(getTranslationState(first)).toBe(firstState);
        expect(getTranslationState(second)).toBe(secondState);
        expect(getTranslationState(replacement)).toBeUndefined();
    });

    it('source-only owner 在同一手势的自反馈换代中继承预算并于第四次稳定降级', () => {
        const nowSpy = vi.spyOn(globalThis.performance, 'now').mockReturnValue(0);
        const {document} = parseHTML('<html><body><p>Same source.</p></body></html>');
        let previousOwner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '相同译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);

        try {
            for (let remount = 0; remount < 4; remount += 1) {
                const replacementOwner = document.createElement('p');
                replacementOwner.textContent = 'Same source.';
                previousOwner.replaceWith(replacementOwner);
                const record = childListRecord(document.body, [replacementOwner], [previousOwner]);
                const result = transferEquivalentBilingualOwners(record, () => preparation());
                if (remount < 3) {
                    expect(result.transfers, `remount ${remount + 1}`).toHaveLength(1);
                    expect(result.capitulations).toEqual([]);
                    previousOwner = replacementOwner;
                } else {
                    expect(result.transfers).toEqual([]);
                    expect(result.capitulations).toEqual([{
                        previousOwner,
                        replacementOwner,
                        boundary: document.body,
                    }]);
                    expect(getTranslationState(replacementOwner)).toBeUndefined();
                    expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)).toBeNull();

                    vi.advanceTimersByTime(1_000);
                    const retry = transferEquivalentBilingualOwners(record, () => preparation());
                    expect(retry.transfers).toEqual([]);
                    expect(retry.capitulations).toEqual([{
                        previousOwner,
                        replacementOwner,
                        boundary: document.body,
                    }]);
                }
            }
        } finally {
            nowSpy.mockRestore();
            restoreAllTranslations();
        }
    });

    it('不同 pointer 手势重置未熔断预算，但不会解锁已经熔断的 generation', () => {
        const {document} = parseHTML('<html><body><p>Same source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const state = beginTranslation(owner, 'bilingual', 'content', false, 'Same source.')!.state;

        try {
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            beginBilingualArtifactHostWriteGesture();
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(true);
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(false);
            beginBilingualArtifactHostWriteGesture();
            expect(consumeBilingualArtifactHostWriteBudget(owner, state)).toBe(false);
        } finally {
            resetAllBilingualArtifactHostWriteBudgets();
        }
    });

    it('无新 pointer 手势的 60Hz source-only 自反馈在第四次稳定熔断', () => {
        let now = 0;
        const nowSpy = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now);
        const {document} = parseHTML('<html><body><p>Same source.</p></body></html>');
        let previousOwner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '相同译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);

        try {
            for (let remount = 0; remount < 4; remount += 1) {
                now += 1_000 / 60;
                const replacementOwner = document.createElement('p');
                replacementOwner.textContent = 'Same source.';
                previousOwner.replaceWith(replacementOwner);
                const result = transferEquivalentBilingualOwners(
                    childListRecord(document.body, [replacementOwner], [previousOwner]),
                    () => preparation(),
                );
                if (remount < 3) {
                    expect(result.transfers, `remount ${remount + 1}`).toHaveLength(1);
                    expect(result.capitulations).toEqual([]);
                    expect(replacementOwner.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(1);
                    previousOwner = replacementOwner;
                } else {
                    expect(result.transfers).toEqual([]);
                    expect(result.capitulations).toEqual([{
                        previousOwner,
                        replacementOwner,
                        boundary: document.body,
                    }]);
                    expect(getTranslationState(replacementOwner)).toBeUndefined();
                    expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)).toBeNull();
                }
            }
        } finally {
            nowSpy.mockRestore();
            resetAllBilingualArtifactHostWriteBudgets();
        }
    });

    it('精确携带 copied wrapper 的 owner 每隔 100ms 连续换代六次不计费也不熔断', async () => {
        const {document} = parseHTML('<html><body><p>Same source.</p></body></html>');
        let previousOwner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.setAttribute('translate', 'no');
        wrapper.textContent = '相同译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);

        for (let remount = 0; remount < 6; remount += 1) {
            await vi.advanceTimersByTimeAsync(100);
            const replacementOwner = previousOwner.cloneNode(true) as HTMLElement;
            const copiedWrapper = replacementOwner.querySelector<HTMLElement>(BILINGUAL_SELECTOR)!;
            previousOwner.replaceWith(replacementOwner);

            const result = transferEquivalentBilingualOwners(
                childListRecord(document.body, [replacementOwner], [previousOwner]),
                () => preparation(),
            );

            expect(result.transfers, `remount ${remount + 1}`).toEqual([{
                previousOwner,
                replacementOwner,
            }]);
            expect(result.capitulations, `remount ${remount + 1}`).toEqual([]);
            expect(getTranslationState(replacementOwner)?.phase).toBe('translated');
            expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)).toBe(copiedWrapper);
            previousOwner = replacementOwner;
        }
    });

    it('宿主把同一个精确 wrapper 直接移动到新 owner 时零计费收养', () => {
        const scenario = createCommittedScenario();
        scenario.replacementOwner.appendChild(scenario.previousWrapper);

        const result = transferEquivalentBilingualOwners(scenario.record(), () => preparation());

        expect(result.transfers).toEqual([{
            previousOwner: scenario.previousOwner,
            replacementOwner: scenario.replacementOwner,
        }]);
        expect(result.capitulations).toEqual([]);
        expect(getTranslationState(scenario.previousOwner)).toBeUndefined();
        expect(getTranslationState(scenario.replacementOwner)?.bilingualContent)
            .toBe(scenario.previousWrapper);
        expect(scenario.previousWrapper.parentElement).toBe(scenario.replacementOwner);
    });

    it('祖先 clone 携带 allowTopLevel 的精确 synthetic segment 时原子转移并保持可恢复', () => {
        const {document} = parseHTML(
            '<html><body><article id="old-root"><div id="host"><span data-fr-translation-segment="true">Inline source.</span></div></article></body></html>',
        );
        const previousRoot = document.querySelector<HTMLElement>('#old-root')!;
        const previousOwner = previousRoot.querySelector<HTMLElement>('[data-fr-translation-segment]')!;
        const source = previousOwner.firstChild as Text;
        const attempt = beginTranslation(
            previousOwner, 'bilingual', 'content', true, source.data, [source], true,
        )!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '行内译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);
        const replacementRoot = previousRoot.cloneNode(true) as HTMLElement;
        const replacementOwner = replacementRoot.querySelector<HTMLElement>('[data-fr-translation-segment]')!;
        previousRoot.replaceWith(replacementRoot);

        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, [replacementRoot], [previousRoot]),
            (_old, replacement) => ({
                sourceTextNodes: [replacement.firstChild as Text],
                reconcileLayout: () => true,
            }),
        );

        expect(result.transfers).toEqual([{previousOwner, replacementOwner}]);
        expect(result.capitulations).toEqual([]);
        const replacementState = getTranslationState(replacementOwner)!;
        expect(replacementState.syntheticSegment).toBe(true);
        expect(replacementState.syntheticSourceNodes).toEqual([replacementOwner.firstChild]);
        expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)?.textContent).toBe('行内译文。');
        expect(restoreAllTranslations()).toBeUndefined();
        expect(replacementRoot.querySelector('[data-fr-translation-segment]')).toBeNull();
        expect(replacementRoot.querySelector('#host')?.textContent).toBe('Inline source.');
    });

    it('跨 pointer 手势累计 whole-owner 篡改并在第四次稳定熔断', () => {
        const initial = createCommittedScenario();
        let previousOwner = initial.previousOwner;
        let replacementOwner = initial.replacementOwner;
        const registry = createBilingualRemountCapitulationRegistry();

        for (let remount = 0; remount < 4; remount += 1) {
            beginBilingualArtifactHostWriteGesture();
            const previousState = getTranslationState(previousOwner)!;
            const tampered = previousState.bilingualContentTemplate!.cloneNode(true) as HTMLElement;
            tampered.setAttribute('lang', 'ja');
            replacementOwner.appendChild(tampered);
            const result = transferEquivalentBilingualOwners(
                childListRecord(replacementOwner.parentNode!, [replacementOwner], [previousOwner]),
                () => preparation(),
            );
            if (remount < 3) {
                expect(result.transfers).toHaveLength(1);
                expect(result.capitulations).toEqual([]);
                expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)?.getAttribute('lang')).not.toBe('ja');
                previousOwner = replacementOwner;
                replacementOwner = initial.document.createElement('p');
                replacementOwner.textContent = 'Same source.';
                previousOwner.replaceWith(replacementOwner);
            } else {
                expect(result.transfers).toEqual([]);
                expect(result.capitulations).toEqual([{
                    previousOwner,
                    replacementOwner,
                    boundary: initial.document.body,
                }]);
                registry.remember(initial.document.body, replacementOwner, previousState);
                expect(replacementOwner.querySelector(BILINGUAL_SELECTOR)).toBeNull();
                expect(blocksBilingualRemountCandidate(
                    registry,
                    replacementOwner,
                    'Same source.',
                    false,
                    previousState.translationInvocationIdentity,
                )).toBe(true);
            }
        }
    });

    it('嵌套 clone 中的精确 wrapper 可直接收养，并还原复制的插件 class/style', () => {
        const {document} = parseHTML(`
            <html><body><section id="old-root"><div><p id="old" class="host" style="color: red">Nested source.</p></div></section></body></html>
        `);
        const previousRoot = document.querySelector<HTMLElement>('#old-root')!;
        const previousOwner = document.querySelector<HTMLElement>('#old')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Nested source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const previousWrapper = document.createElement('span');
        previousWrapper.className = 'fluent-read-bilingual-content';
        previousWrapper.setAttribute('data-fr-translation-owned', 'true');
        previousWrapper.textContent = '嵌套译文。';
        previousOwner.appendChild(previousWrapper);
        setBilingualContent(previousOwner, previousWrapper);
        previousOwner.className = 'host host-hover fluent-read-bilingual';
        expect(acquireTranslationLayoutOverride(
            previousOwner,
            previousOwner,
            translationTruncationStyleOverrides,
        )).toBe(true);
        setRenderedStyleAttribute(previousOwner);

        const replacementRoot = previousRoot.cloneNode(true) as HTMLElement;
        const replacementOwner = replacementRoot.querySelector<HTMLElement>('#old')!;
        const copiedWrapper = replacementOwner.querySelector<HTMLElement>('.fluent-read-bilingual-content')!;
        previousRoot.replaceWith(replacementRoot);
        const record = childListRecord(
            document.body,
            [replacementRoot, replacementRoot],
            [previousRoot, previousRoot],
        );

        const {transfers, capitulations} = transferEquivalentBilingualOwners(record, () => preparation());

        expect(transfers).toHaveLength(1);
        expect(capitulations).toEqual([]);
        expect(replacementOwner.querySelector('.fluent-read-bilingual-content')).toBe(copiedWrapper);
        expect(replacementOwner.className).toBe('host host-hover');
        expect(replacementOwner.style.getPropertyValue('color')).toBe('red');
        expect(getTranslationState(replacementOwner)?.originalClassAttribute).toBe('host host-hover');
        expect(getTranslationState(replacementOwner)?.originalStyleAttribute).toContain('color:red');
    });

    it('祖先 remount 路径标签不一致时不拿旧租约基线改写新宿主样式', () => {
        const {document} = parseHTML(
            '<html><body><div id="old-root"><p id="old">Same source.</p></div></body></html>',
        );
        const previousRoot = document.querySelector<HTMLElement>('#old-root')!;
        const previousOwner = document.querySelector<HTMLElement>('#old')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '旧译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);
        expect(acquireTranslationLayoutOverride(
            previousOwner,
            previousRoot,
            translationTruncationStyleOverrides,
        )).toBe(true);

        const replacementRoot = document.createElement('section');
        replacementRoot.setAttribute('style', previousRoot.getAttribute('style')!);
        replacementRoot.innerHTML = '<p>Same source.</p>';
        const replacementOwner = replacementRoot.firstElementChild as HTMLElement;
        previousRoot.replaceWith(replacementRoot);
        const result = transferEquivalentBilingualOwners(
            childListRecord(document.body, [replacementRoot], [previousRoot]),
            () => preparation(),
        );

        expect(result).toEqual({transfers: [], capitulations: []});
        expect(getTranslationState(previousOwner)).toBe(attempt.state);
        expect(getTranslationState(replacementOwner)).toBeUndefined();
        expect(replacementRoot.style.getPropertyValue('max-height')).toBe('unset');
    });

    it('owner 单独换代时忽略 removed root 外的共享裁剪祖先并重新租用它', () => {
        const {document} = parseHTML(
            '<html><body><div id="clamp"><p id="old">Same source.</p></div></body></html>',
        );
        const clamp = document.querySelector<HTMLElement>('#clamp')!;
        const previousOwner = document.querySelector<HTMLElement>('#old')!;
        const attempt = beginTranslation(previousOwner, 'bilingual', 'content', false, 'Same source.', [])!;
        expect(markTranslationComplete(previousOwner, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '相同译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);
        expect(acquireTranslationLayoutOverride(
            previousOwner,
            clamp,
            translationTruncationStyleOverrides,
        )).toBe(true);

        const replacementOwner = document.createElement('p');
        replacementOwner.textContent = 'Same source.';
        previousOwner.replaceWith(replacementOwner);
        const result = transferEquivalentBilingualOwners(
            childListRecord(clamp, [replacementOwner], [previousOwner]),
            () => preparation(() => acquireTranslationLayoutOverride(
                replacementOwner,
                clamp,
                translationTruncationStyleOverrides,
            )),
        );

        expect(result.transfers).toHaveLength(1);
        expect(hasTranslationLayoutOverride(clamp)).toBe(true);
        expect(getTranslationState(replacementOwner)?.layoutOverrideElements?.has(clamp)).toBe(true);
    });

    it.each<[
        string,
        (scenario: ReturnType<typeof createCommittedScenario>) => void,
    ]>([
        ['无状态', (_scenario) => restoreAllTranslations()],
        ['非 translated', (scenario) => { scenario.previousState.phase = 'loading'; }],
        ['非双语', (scenario) => { scenario.previousState.mode = 'single'; }],
        ['非内容 owner', (scenario) => { scenario.previousState.kind = 'control'; }],
        ['合成片段', (scenario) => { scenario.previousState.syntheticSegment = true; }],
        ['旧 owner 仍连接', (scenario) => { scenario.document.body.appendChild(scenario.previousOwner); }],
        ['新 owner 未连接', (scenario) => { scenario.replacementOwner.remove(); }],
        ['新 owner 已有状态', (scenario) => { beginTranslation(scenario.replacementOwner, 'bilingual'); }],
        ['标签不同', (scenario) => {
            const replacement = scenario.document.createElement('div');
            replacement.innerHTML = scenario.previousState.sourceHTML;
            scenario.replacementOwner = replacement;
        }],
        ['命名空间不同', (scenario) => {
            const replacement = scenario.document.createElement('p');
            Object.defineProperty(replacement, 'namespaceURI', {configurable: true, value: 'urn:fixture'});
            replacement.innerHTML = scenario.previousState.sourceHTML;
            scenario.replacementOwner = replacement;
        }],
        ['缺少 wrapper', (scenario) => { scenario.previousState.bilingualContent = undefined; }],
        ['wrapper 被移到其他 owner', (scenario) => {
            scenario.document.body.appendChild(scenario.previousWrapper);
        }],
        ['原文结构不同', (scenario) => { scenario.replacementOwner.innerHTML = '<strong>changed</strong>'; }],
    ])('拒绝%s', (_label, mutate) => {
        const scenario = createCommittedScenario();
        mutate(scenario);
        const prepare = vi.fn(() => preparation());

        expect(transferEquivalentBilingualOwners(scenario.record(), prepare)).toEqual({
            transfers: [],
            capitulations: [],
        });
        expect(prepare).not.toHaveBeenCalled();
    });

    it.each([
        ['内容被篡改', (scenario: ReturnType<typeof createCommittedScenario>) => {
            scenario.previousWrapper.textContent = '篡改';
        }],
        ['所有权 class 被移除', (scenario: ReturnType<typeof createCommittedScenario>) => {
            scenario.previousWrapper.classList.remove('fluent-read-bilingual-content');
        }],
    ])('旧 wrapper %s 时从可信模板接管新 owner', (_label, mutate) => {
        const scenario = createCommittedScenario();
        mutate(scenario);

        const result = transferEquivalentBilingualOwners(scenario.record(), () => preparation());

        expect(result.transfers).toEqual([{
            previousOwner: scenario.previousOwner,
            replacementOwner: scenario.replacementOwner,
        }]);
        expect(result.capitulations).toEqual([]);
        const restored = scenario.replacementOwner.querySelector<HTMLElement>(BILINGUAL_SELECTOR)!;
        expect(restored.textContent).toBe('相同译文。');
        expect(restored.getAttribute('translate')).toBe('no');
    });

    it('同一 framework commit 先移除旧 wrapper 再替换 source-only owner 时仍原子接管', () => {
        const scenario = createCommittedScenario();
        scenario.previousWrapper.remove();
        const result = transferEquivalentBilingualOwners([
            childListRecord(scenario.previousOwner, [], [scenario.previousWrapper]),
            scenario.record(),
        ], () => preparation());

        expect(result.transfers).toEqual([{
            previousOwner: scenario.previousOwner,
            replacementOwner: scenario.replacementOwner,
        }]);
        expect(result.capitulations).toEqual([]);
        expect(getTranslationState(scenario.replacementOwner)?.phase).toBe('translated');
        expect(scenario.replacementOwner.querySelectorAll(BILINGUAL_SELECTOR)).toHaveLength(1);
    });

    it('用可信模板覆盖未知直属 owned 产物、重复 wrapper 和不一致的克隆 wrapper', () => {
        for (const mode of ['unknown', 'duplicate', 'mismatch'] as const) {
            const scenario = createCommittedScenario();
            if (mode === 'unknown') {
                const unknown = scenario.document.createElement('span');
                unknown.setAttribute('data-fr-translation-owned', 'true');
                scenario.replacementOwner.appendChild(unknown);
                scenario.previousState.sourceHTML = scenario.replacementOwner.innerHTML;
            } else {
                const copied = scenario.previousWrapper.cloneNode(true) as HTMLElement;
                scenario.replacementOwner.appendChild(copied);
                if (mode === 'duplicate') {
                    scenario.replacementOwner.appendChild(copied.cloneNode(true));
                } else {
                    copied.setAttribute('lang', 'ja');
                }
            }
            const result = transferEquivalentBilingualOwners(scenario.record(), () => preparation());
            expect(result.transfers).toEqual([{
                previousOwner: scenario.previousOwner,
                replacementOwner: scenario.replacementOwner,
            }]);
            expect(result.capitulations).toEqual([]);
            const wrappers = scenario.replacementOwner.querySelectorAll(BILINGUAL_SELECTOR);
            expect(wrappers).toHaveLength(1);
            expect(wrappers[0]?.textContent).toBe('相同译文。');
            expect(wrappers[0]?.getAttribute('lang')).not.toBe('ja');
            restoreAllTranslations();
        }
    });

    it('预处理拒绝、并发占用、提交时断开和布局失败都不会丢失旧状态', () => {
        const cases: Array<{
            name: string;
            prepare: (scenario: ReturnType<typeof createCommittedScenario>) =>
                (old: HTMLElement, replacement: HTMLElement, state: TranslationState) =>
                    BilingualRemountPreparation | null;
        }> = [
            {name: '预处理拒绝', prepare: () => () => null},
            {name: '并发占用', prepare: () => (_old, replacement) => {
                beginTranslation(replacement, 'bilingual');
                return preparation();
            }},
            {name: '提交时断开', prepare: () => (_old, replacement) => {
                replacement.remove();
                return preparation();
            }},
            {name: '布局失败', prepare: () => () => preparation(vi.fn(() => false))},
        ];

        cases.forEach(({name, prepare}) => {
            const scenario = createCommittedScenario();
            expect(transferEquivalentBilingualOwners(scenario.record(), prepare(scenario)), name).toEqual({
                transfers: [],
                capitulations: [],
            });
            expect(getTranslationState(scenario.previousOwner), name).toBe(scenario.previousState);
            restoreAllTranslations();
        });
    });

    it('忽略非 childList、空删除、数量不对等、非 owner 删除和无法映射的相对路径', () => {
        const scenario = createCommittedScenario();
        const prepare = vi.fn(() => preparation());
        const base = scenario.record();
        expect(transferEquivalentBilingualOwners({...base, type: 'attributes'} as MutationRecord, prepare)).toEqual({transfers: [], capitulations: []});
        expect(transferEquivalentBilingualOwners(childListRecord(scenario.document.body, [scenario.replacementOwner], []), prepare)).toEqual({transfers: [], capitulations: []});
        expect(transferEquivalentBilingualOwners(childListRecord(scenario.document.body, [], [scenario.previousOwner]), prepare)).toEqual({transfers: [], capitulations: []});

        const text = scenario.document.createTextNode('unrelated');
        expect(transferEquivalentBilingualOwners(childListRecord(scenario.document.body, [text], [text]), prepare)).toEqual({transfers: [], capitulations: []});

        const detachedWrapper = scenario.previousWrapper;
        detachedWrapper.remove();
        expect(transferEquivalentBilingualOwners(
            childListRecord(scenario.replacementOwner, [scenario.document.createTextNode('x')], [detachedWrapper]),
            prepare,
        )).toEqual({transfers: [], capitulations: []});

        const oldRoot = scenario.document.createElement('section');
        oldRoot.appendChild(scenario.previousOwner);
        const emptyReplacementRoot = scenario.document.createElement('section');
        scenario.document.body.appendChild(emptyReplacementRoot);
        expect(transferEquivalentBilingualOwners(
            childListRecord(scenario.document.body, [emptyReplacementRoot], [oldRoot]),
            prepare,
        )).toEqual({transfers: [], capitulations: []});
        expect(prepare).not.toHaveBeenCalled();
    });
});

describe('synthetic 行内候选熔断映射', () => {
    it('materialized owner 熔断并解包后仍阻止同一宿主候选再次写入', () => {
        const {document} = parseHTML(
            '<html><body><p id="host">prefix <span id="segment" data-fr-translation-segment="true">Inline source.</span> suffix</p></body></html>',
        );
        const host = document.querySelector<HTMLElement>('#host')!;
        const segment = document.querySelector<HTMLElement>('#segment')!;
        const source = segment.firstChild as Text;
        const attempt = beginTranslation(
            segment,
            'bilingual',
            'content',
            true,
            source.data,
            [source],
        )!;
        expect(markTranslationComplete(segment, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '行内译文。';
        segment.appendChild(wrapper);
        setBilingualContent(segment, wrapper);

        const registry = createBilingualRemountCapitulationRegistry();
        registry.remember(host, segment, attempt.state);
        restoreAllTranslations();

        expect(document.querySelector('[data-fr-translation-segment="true"]')).toBeNull();
        expect(blocksBilingualRemountCandidate(
            registry,
            host,
            'Inline source.',
            false,
            attempt.state.translationInvocationIdentity,
            [source],
        )).toBe(true);
    });

    it('整块宿主篡改换代熔断后仍阻止解包的 synthetic run', () => {
        const {document} = parseHTML(
            '<html><body><article id="root"><div id="host"><span data-fr-translation-segment="true">Inline source.</span></div></article></body></html>',
        );
        let previousRoot = document.querySelector<HTMLElement>('#root')!;
        let previousOwner = previousRoot.querySelector<HTMLElement>('[data-fr-translation-segment]')!;
        const source = previousOwner.firstChild as Text;
        const initial = beginTranslation(
            previousOwner,
            'bilingual',
            'content',
            true,
            source.data,
            [source],
        )!;
        expect(markTranslationComplete(previousOwner, initial.state, initial.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '行内译文。';
        previousOwner.appendChild(wrapper);
        setBilingualContent(previousOwner, wrapper);
        const registry = createBilingualRemountCapitulationRegistry();

        for (let remount = 0; remount < 4; remount += 1) {
            beginBilingualArtifactHostWriteGesture();
            const previousState = getTranslationState(previousOwner)!;
            const replacementRoot = previousRoot.cloneNode(true) as HTMLElement;
            const replacementOwner = replacementRoot.querySelector<HTMLElement>(
                '[data-fr-translation-segment]',
            )!;
            replacementOwner.querySelector<HTMLElement>(BILINGUAL_SELECTOR)!
                .setAttribute('lang', 'ja');
            previousRoot.replaceWith(replacementRoot);

            const result = transferEquivalentBilingualOwners(
                childListRecord(document.body, [replacementRoot], [previousRoot]),
                (_old, replacement) => ({
                    sourceTextNodes: [replacement.firstChild as Text],
                    reconcileLayout: () => true,
                }),
            );
            if (remount < 3) {
                expect(result.transfers).toEqual([{previousOwner, replacementOwner}]);
                previousRoot = replacementRoot;
                previousOwner = replacementOwner;
                continue;
            }

            expect(result.capitulations).toEqual([{
                previousOwner,
                replacementOwner,
                boundary: document.body,
            }]);
            registry.remember(document.body, replacementOwner, previousState);
            const replacementHost = replacementRoot.querySelector<HTMLElement>('#host')!;
            const replacementSource = replacementHost.firstChild!;
            expect(replacementRoot.querySelector('[data-fr-translation-segment]')).toBeNull();
            expect(blocksBilingualRemountCandidate(
                registry,
                replacementHost,
                'Inline source.',
                false,
                previousState.translationInvocationIdentity,
                [replacementSource],
            )).toBe(true);
        }
    });
});
