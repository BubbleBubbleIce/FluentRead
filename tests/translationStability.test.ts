import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    canKeepTranslationAttempt,
    getCurrentTranslationStateSourceSnapshot,
    hasCurrentTranslationSource,
    isBilingualArtifactKept,
    isOwnCurrentArtifactAddition,
    isOwnStateArtifactMutation,
    isOwnSingleTextSlotMove,
    isTranslationArtifact,
    isTranslationArtifactCurrent,
    isTranslationCandidateCurrent,
    mutationTouchesCurrentTranslationArtifact,
    reboundLiveTextResult,
    statefulSourceAndTextSlotsAreCurrent,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    getTranslationOverflowGenerationIdentity,
    getTranslationSourceStructureSignature,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';

function state(overrides: Partial<TranslationState> = {}): TranslationState {
    return {
        mode: 'bilingual',
        kind: 'content',
        phase: 'loading',
        generation: 1,
        sourceText: 'source',
        sourceHTML: 'source',
        syntheticSegment: false,
        originalStyleAttribute: null,
        originalClassAttribute: null,
        originalTextValues: [],
        controller: new AbortController(),
        ...overrides,
    };
}

function childListRecord(
    target: Node,
    addedNodes: readonly Node[] = [],
    removedNodes: readonly Node[] = [],
): MutationRecord {
    return {
        type: 'childList',
        target,
        addedNodes: addedNodes as unknown as NodeList,
        removedNodes: removedNodes as unknown as NodeList,
    } as MutationRecord;
}

describe('动态翻译稳定性判定', () => {
    it('单个直接文本重挂时只遍历一次，并同时取得规范化原文与精确槽身份', () => {
        const {document} = parseHTML('<html><body><p>  Read\n the source.  </p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const walk = vi.spyOn(document, 'createTreeWalker');
        expect(getCurrentTranslationStateSourceSnapshot(owner, state())).toEqual({
            sourceText: 'Read the source.', sourceTextNodes: [owner.firstChild],
        });
        expect(walk).toHaveBeenCalledOnce();
    });

    it.each([
        {html: '<p><em>Read the source.</em></p>', source: 'Read the source.', slots: 1},
        {html: '<p translate="no">Protected source.</p>', source: '', slots: 0},
        {html: '<input type="button" value="Read the source">', source: 'Read the source', slots: 0},
        {html: '<p>Read <a href="https://example.test">https://example.test</a> carefully.<code>protected()</code></p>',
            source: 'Read https://example.test carefully.', slots: 2},
        {html: '<p>Read the source.<span data-fr-translation-owned="true">译文</span></p>', source: 'Read the source.', slots: 1},
    ])('复杂或受保护骨架保留独立的原文与槽提取政策：$html', ({html, source, slots}) => {
        const {document} = parseHTML(`<html><body>${html}</body></html>`);
        const snapshot = getCurrentTranslationStateSourceSnapshot(document.body.firstElementChild as HTMLElement, state());
        expect(snapshot.sourceText).toBe(source);
        expect(snapshot.sourceTextNodes).toHaveLength(slots);
        expect(snapshot.sourceTextNodes.every(node => node.isConnected)).toBe(true);
    });

    it('来源候选移出文档后失效，显式应用外壳例外仍不能穿过新增的局部禁译边界', () => {
        const {document} = parseHTML('<html><body><div translate="no"><p>Readable application source.</p></div></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const candidate = {element: owner, kind: 'content' as const, reason: 'explicit-source',
            allowTopLevelApplicationShell: true};
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        owner.setAttribute('translate', 'no');
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
        owner.removeAttribute('translate');
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        owner.remove();
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
    });

    it('视觉手动分块只要仍是已标记的合成段且挂在文档中就保持有效', () => {
        const {document} = parseHTML('<html><body><div id="host"><span data-fr-translation-manual="true">Chunk text.</span></div></body></html>');
        const chunk = document.querySelector<HTMLElement>('span')!;
        const candidate = {element: chunk, kind: 'content' as const, reason: 'visual-text-chunk', manualChunk: true};
        // 物化后尚未标记为合成段时不能被当作当前手动块。
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
        chunk.setAttribute('data-fr-translation-segment', 'true');
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        const detachedHost = document.createElement('div');
        const detachedChunk = chunk.cloneNode(true) as HTMLElement;
        detachedHost.append(detachedChunk);
        expect(isTranslationCandidateCurrent({...candidate, element: detachedChunk})).toBe(false);
        chunk.remove();
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
    });

    it('只在连接、内容候选且原文仍匹配时认为来源稳定', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const readSource = vi.fn(() => true);
        expect(hasCurrentTranslationSource(node, state(), readSource)).toBe(true);
        expect(readSource).toHaveBeenCalledWith(node, expect.anything());
        expect(hasCurrentTranslationSource(node, state({syntheticSegment: true}), readSource)).toBe(false);
        expect(hasCurrentTranslationSource(node, state({kind: 'control'}), readSource)).toBe(false);
        expect(hasCurrentTranslationSource(node, state(), () => false)).toBe(false);
        const detached = document.createElement('p');
        expect(hasCurrentTranslationSource(detached, state(), readSource)).toBe(false);
    });

    it('覆盖 loading、双语和仅译文状态的 artifact/slot 分支', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const readSource = () => true;
        const readSlots = vi.fn(() => true);

        expect(canKeepTranslationAttempt(node, state(), readSource, readSlots)).toBe(true);

        const bilingual = document.createElement('span');
        bilingual.className = 'fluent-read-bilingual-content';
        bilingual.setAttribute('data-fr-translation-owned', 'true');
        bilingual.textContent = '译文';
        node.appendChild(bilingual);
        const bilingualState = state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: '译文',
            bilingualOuterHTML: bilingual.outerHTML,
        });
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(true);
        expect(canKeepTranslationAttempt(node, bilingualState, readSource, readSlots)).toBe(true);
        expect(canKeepTranslationAttempt(node, state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: '译文',
            bilingualOuterHTML: bilingual.outerHTML,
        }), readSource, readSlots, false)).toBe(false);
        expect(canKeepTranslationAttempt(node, state({
            phase: 'translated',
        }), readSource, readSlots)).toBe(false);
        const duplicate = bilingual.cloneNode(true) as HTMLElement;
        node.appendChild(duplicate);
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        duplicate.remove();
        bilingual.textContent = '被站点篡改';
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        bilingual.textContent = '译文';
        bilingual.classList.add('site-tampered');
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        bilingual.classList.remove('site-tampered');

        const sourceNode = document.createTextNode('source');
        const slotHost = document.createElement('span');
        slotHost.appendChild(sourceNode);
        node.appendChild(slotHost);
        expect(canKeepTranslationAttempt(node, state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [sourceNode],
            singleTextSlotHosts: [{host: slotHost, source: sourceNode, sourceValue: 'source'}],
        }), readSource, readSlots)).toBe(true);
        expect(canKeepTranslationAttempt(node, state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [sourceNode],
            singleTextSlotHosts: [],
        }), readSource, readSlots)).toBe(false);
        expect(canKeepTranslationAttempt(node, state({phase: 'error'}), readSource, readSlots)).toBe(false);

        expect(isTranslationArtifactCurrent(node, state({
            kind: 'control',
            phase: 'translated',
            textSlotsApplied: true,
        }))).toBe(true);
        expect(isTranslationArtifactCurrent(node, state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            textSlotsApplied: false,
        }))).toBe(false);
        expect(readSlots).toHaveBeenCalled();
    });

    it('完整 outerHTML 快照会拒绝 wrapper 任一展示属性被篡改', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const bilingual = document.createElement('span');
        bilingual.className = 'fluent-read-bilingual-content baseline-style';
        bilingual.setAttribute('data-fr-translation-owned', 'true');
        bilingual.setAttribute('style', 'color: inherit');
        bilingual.setAttribute('lang', 'zh-CN');
        bilingual.setAttribute('dir', 'ltr');
        bilingual.setAttribute('translate', 'no');
        bilingual.textContent = '译文';
        node.appendChild(bilingual);
        const bilingualState = state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: bilingual.innerHTML,
            bilingualOuterHTML: bilingual.outerHTML,
        });

        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(true);
        const mutations = [
            ['class', 'fluent-read-bilingual-content baseline-style site-tampered'],
            ['style', 'color: red'],
            ['lang', 'fr'],
            ['dir', 'rtl'],
            ['translate', 'yes'],
        ] as const;
        mutations.forEach(([name, tamperedValue]) => {
            const originalValue = bilingual.getAttribute(name)!;
            bilingual.setAttribute(name, tamperedValue);
            expect(isTranslationArtifactCurrent(node, bilingualState), `${name} 篡改`).toBe(false);
            bilingual.setAttribute(name, originalValue);
            expect(isTranslationArtifactCurrent(node, bilingualState), `${name} 恢复`).toBe(true);
        });
    });

    it.each(['attribute', 'class', 'both'])('允许字体脚本在 wrapper 和行内后代添加或移除 %s 标记', (mode) => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<strong>粗体译文</strong><a href="/original" class="host-link">链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        for (const element of [wrapper, ...Array.from(wrapper.querySelectorAll('*'))]) {
            if (mode !== 'class') element.setAttribute('ultimate-bold-correct', '');
            if (mode !== 'attribute') element.classList.add('ultimate-bold-correct');
        }
        wrapper.querySelector('a')!.setAttribute('tabindex', '-1');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(true);
        // 初次渲染快照也可能从原文继承字体标记，脚本移除标记同样不应使译文失效。
        const marked = state({...snapshot, bilingualHTML: wrapper.innerHTML,
            bilingualOuterHTML: wrapper.outerHTML, bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        for (const element of [wrapper, ...Array.from(wrapper.querySelectorAll('*'))]) {
            element.removeAttribute('ultimate-bold-correct');
            element.classList.remove('ultimate-bold-correct');
            if (!element.getAttribute('class')) element.removeAttribute('class');
        }
        expect(isTranslationArtifactCurrent(owner, marked)).toBe(true);
    });

    it.each([
        ['href', '/other'], ['title', 'Changed meaning'], ['role', 'button'],
        ['aria-hidden', 'true'], ['style', 'display:none'], ['class', 'hidden'],
        ['onclick', 'run()'], ['lang', 'fr'], ['tabindex', '2'], ['tabindex', 'invalid'],
    ])('接受焦点管理前仍拒绝译文链接的 %s=%s 篡改', (attribute, value) => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<a href="/original">译文链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        const link = wrapper.querySelector('a')!;
        link.setAttribute('tabindex', '-1');
        link.setAttribute('ultimate-bold-correct', '');
        link.classList.add('ultimate-bold-correct');
        wrapper.setAttribute('ultimate-bold-correct', '');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(true);
        link.setAttribute(attribute, value);
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
    });

    it('复制节点的属性漂移仍算当前工件尝试，译文内容或外层属性被改写才失效', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<a href="/original">译文链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        const readSource = () => true;
        const readSlots = () => true;

        // 悬停预览改写的 title 只改变复制节点的属性，译文与来源都没有变化。
        wrapper.querySelector('a')!.setAttribute('title', 'Host tooltip');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(true);
        expect(canKeepTranslationAttempt(owner, snapshot, readSource, readSlots)).toBe(true);

        // 即使 title 同时漂移，也不能掩盖只落在译文上的链接目的地变化。
        wrapper.querySelector('a')!.setAttribute('href', '/unrelated');
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
        expect(canKeepTranslationAttempt(owner, snapshot, readSource, readSlots)).toBe(false);
        wrapper.querySelector('a')!.setAttribute('href', '/original');

        // wrapper 外层属性仍按篡改处理，不能被容忍分支保留。
        wrapper.setAttribute('style', 'display:none');
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
        wrapper.removeAttribute('style');
        wrapper.querySelector('a')!.textContent = 'HOST INJECTED';
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
    });

    it.each(['text', 'extra-node', 'missing-node', 'non-link-tabindex', 'root-tabindex', 'missing-template', 'stale-template']) (
        '焦点属性例外不接受 %s', (mutation) => {
            const {document} = parseHTML('<html><body><p>source</p></body></html>');
            const owner = document.querySelector<HTMLElement>('p')!;
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.innerHTML = '<a href="/original">译文链接</a><span>译文内容</span>';
            owner.appendChild(wrapper);
            const snapshot = state({phase: 'translated', bilingualContent: wrapper,
                bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
                bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
            wrapper.querySelector('a')!.setAttribute('tabindex', '-1');
            wrapper.querySelector('span')!.setAttribute('ultimate-bold-correct', '');
            if (mutation === 'text') wrapper.querySelector('a')!.textContent = 'Changed';
            if (mutation === 'extra-node') wrapper.appendChild(document.createElement('span'));
            if (mutation === 'missing-node') wrapper.querySelector('span')!.remove();
            if (mutation === 'non-link-tabindex') wrapper.querySelector('span')!.setAttribute('tabindex', '-1');
            if (mutation === 'root-tabindex') wrapper.setAttribute('tabindex', '-1');
            if (mutation === 'missing-template') snapshot.bilingualContentTemplate = undefined;
            if (mutation === 'stale-template') snapshot.bilingualContentTemplate!.textContent = 'Changed template';
            expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
        },
    );

    it('双语仅在语义与精确原文结构一致时重绑文本节点', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const originalText = node.querySelector('span')!.firstChild as Text;
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [originalText],
        });

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([originalText]);

        const replacement = document.createTextNode('source');
        originalText.replaceWith(replacement);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([replacement]);

        const stateWithoutCapturedNodes = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: undefined,
            allowTopLevelApplicationShell: true,
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, stateWithoutCapturedNodes)).toBe(true);
        expect(stateWithoutCapturedNodes.sourceTextNodes).toEqual([replacement]);

        replacement.replaceWith(document.createElement('strong'));
        node.querySelector('strong')!.textContent = 'source';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);

        node.querySelector('strong')!.textContent = 'changed';
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
        }))).toBe(false);
    });

    it('结构签名忽略 hover 展示属性，但拒绝译文骨架内容或链接变化', () => {
        const {document} = parseHTML(`
            <html><body><p id="owner"><a id="link" href="/before">source</a><span class="MathJax">render 1</span></p></body></html>
        `);
        const node = document.querySelector<HTMLElement>('#owner')!;
        const link = document.querySelector<HTMLAnchorElement>('#link')!;
        const source = link.firstChild as Text;
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [source],
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
        });

        node.className = 'hovered';
        node.style.color = 'red';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([source]);

        node.querySelector<HTMLElement>('.MathJax')!.textContent = 'render 2';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.querySelector<HTMLElement>('.MathJax')!.textContent = 'render 1';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);

        const replacementLink = document.createElement('a');
        replacementLink.href = '/after';
        replacementLink.appendChild(source);
        link.replaceWith(replacementLink);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
    });

    it('有界结构快照溢出时同 owner 保持稳定，但真实 mutation 或 Text 换代立即失效', () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        const node = document.querySelector<HTMLElement>('#owner')!;
        let deepest = node;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        const source = document.createTextNode('source');
        deepest.appendChild(source);
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [source],
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
            sourceOverflowGenerationIdentity: getTranslationOverflowGenerationIdentity(node),
        });

        expect(current.sourceStructureSignature).toBe('overflow');
        expect(getTranslationOverflowGenerationIdentity(node)).toBe(current.sourceOverflowGenerationIdentity);
        const cloneSpy = vi.spyOn(node, 'cloneNode');
        for (let check = 0; check < 20; check += 1) {
            expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        }
        expect(cloneSpy).not.toHaveBeenCalled();
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...current,
            sourceTextNodes: undefined,
        })).toBe(true);

        current.sourceStructureDirty = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);

        current.sourceStructureDirty = false;
        const replacementSource = document.createTextNode('source');
        source.replaceWith(replacementSource);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([replacementSource]);

        replacementSource.data = 'changed';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
    });

    it('仅译文合成段只忽略自身扩展标记，持续尊重父级和内部原文保护区', () => {
        const {document} = parseHTML('<html><body><div id="app"><span data-fr-translation-segment="true"><span data-fr-translation-owned="true" translate="no">source</span></span></div></body></html>');
        const parent = document.querySelector<HTMLElement>('#app')!;
        const node = parent.firstElementChild as HTMLElement;
        const host = node.firstElementChild as HTMLElement;
        const source = host.firstChild as Text;
        const current = state({mode: 'single', phase: 'translated', syntheticSegment: true,
            sourceTextNodes: [source], singleTextSlotHosts: [{host, source, sourceValue: 'source'}]});

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        parent.className = 'notranslate';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        current.allowTopLevelApplicationShell = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        node.className = 'notranslate';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.className = '';
        node.hidden = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.hidden = false;
        parent.className = '';
        node.remove();
        // 此纯判定只比较来源；是否仍连接由调用处的 generation/artifact 检查负责。
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
    });

    it('仅译文既有槽完整但新正文变为可译时，拒绝沿用遗漏新增内容的来源快照', () => {
        const {document} = parseHTML('<html><body><p><span data-fr-translation-owned="true" translate="no">source</span><em class="notranslate">new source</em></p></body></html>');
        const node = document.querySelector<HTMLElement>('p')!;
        const host = node.firstElementChild as HTMLElement;
        const source = host.firstChild as Text;
        const addition = node.querySelector<HTMLElement>('em')!;
        const current = state({mode: 'single', phase: 'translated', sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}]});
        const cloneSpy = vi.spyOn(node, 'cloneNode');

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        addition.className = '';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        addition.hidden = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(cloneSpy).not.toHaveBeenCalled();
    });

    it('校验仅译文与控件文本槽的节点身份和译文值', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const host = node.querySelector('span') as HTMLElement;
        const source = host.firstChild as Text;
        const slotState = state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}],
        });

        expect(statefulSourceAndTextSlotsAreCurrent(node, slotState)).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...slotState,
            sourceTextNodes: undefined,
        })).toBe(false);

        const translatedValues = new WeakMap<Text, string>([[source, 'source']]);
        const controlState = state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            sourceTextNodes: [source],
            translatedTextNodes: [source],
            textSlotsApplied: true,
            translatedTextValues: translatedValues,
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, controlState)).toBe(true);
        translatedValues.set(source, 'different');
        expect(statefulSourceAndTextSlotsAreCurrent(node, controlState)).toBe(false);
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...controlState,
            translatedTextValues: undefined,
        })).toBe(false);

        const button = document.createElement('button');
        button.innerHTML = '<span aria-hidden="true">★</span><span>保存更改</span>';
        document.body.appendChild(button);
        const buttonText = button.lastElementChild!.firstChild as Text;
        expect(statefulSourceAndTextSlotsAreCurrent(button, state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            sourceTextNodes: [buttonText],
            translatedTextNodes: [buttonText],
            textSlotsApplied: true,
            translatedTextValues: new WeakMap([[buttonText, '保存更改']]),
        }))).toBe(true);

        const singleState = state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [source],
            translatedTextNodes: [source],
            textSlotsApplied: true,
            translatedTextValues: new WeakMap([[source, 'source']]),
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, singleState)).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            mode: 'single',
            sourceText: 'source',
            sourceTextNodes: [source],
        }))).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            mode: 'single',
            sourceTextNodes: undefined,
        }))).toBe(false);
    });

    it('只接受当前控件 generation 的 spinner 事务与最终 Text 写入', () => {
        const {document} = parseHTML('<html><body><button>Save changes</button><aside></aside></body></html>');
        const button = document.querySelector('button') as HTMLElement;
        const other = document.querySelector('aside') as HTMLElement;
        const source = button.firstChild as Text;
        const spinner = document.createElement('span');
        spinner.setAttribute('data-fr-translation-owned', 'true');
        button.appendChild(spinner);
        const loading = state({
            kind: 'control', sourceText: 'Save changes', sourceTextNodes: [source], spinner,
        });

        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner]), button, loading)).toBe(true);
        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner], [source]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(other, [spinner]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [other]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner]), button,
            {...loading, kind: 'content'})).toBe(true);

        spinner.remove();
        source.data = '保存更改';
        const translated = state({
            kind: 'control', phase: 'translated', settledSpinner: spinner,
            sourceTextNodes: [source], translatedTextNodes: [source], textSlotsApplied: true,
            translatedTextValues: new WeakMap([[source, '保存更改']]),
        });
        const characterMutation = {
            type: 'characterData', target: source,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;
        expect(isOwnStateArtifactMutation(characterMutation, button, translated)).toBe(true);
        translated.translatedTextValues!.set(source, '被篡改');
        expect(isOwnStateArtifactMutation(characterMutation, button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [], [spinner]), button, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(childListRecord(button), button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(other, [], [spinner]), button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation({...characterMutation, type: 'attributes'} as MutationRecord,
            button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(characterMutation, button, {...translated, phase: 'error'})).toBe(false);

        expect(isOwnStateArtifactMutation(
            childListRecord(button, [], [spinner]),
            button,
            {...translated, kind: 'content'},
        )).toBe(true);
    });

    it('按钮型 input 的属性译文按已记录值复验，宿主改回原标签即判为失效', () => {
        const {document} = parseHTML(
            '<html><body><input id="save" type="button" value="保存草稿"></body></html>');
        const node = document.querySelector<HTMLElement>('#save')!;
        const translated = state({
            kind: 'control', phase: 'translated', mode: 'bilingual', sourceText: 'Save draft',
            sourceHTML: node.innerHTML, sourceTextNodes: [], translatedTextNodes: [],
            textSlotsApplied: true, translatedTextValues: new WeakMap(),
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
            controlValue: {attribute: 'value', original: 'Save draft', translated: '保存草稿'},
        });
        const valueMutation = {
            type: 'attributes', attributeName: 'value', target: node,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;

        expect(statefulSourceAndTextSlotsAreCurrent(node, translated)).toBe(true);
        expect(isTranslationArtifactCurrent(node, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(valueMutation, node, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(
            {...valueMutation, attributeName: 'class'} as MutationRecord, node, translated)).toBe(false);

        node.setAttribute('value', 'Save draft');
        expect(statefulSourceAndTextSlotsAreCurrent(node, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(valueMutation, node, translated)).toBe(false);
    });

    it('只把当前 single-slot host 和完整双语 wrapper 识别为自身新增工件', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const source = owner.firstChild as Text;
        const slotHost = document.createElement('span');
        slotHost.appendChild(source);
        owner.appendChild(slotHost);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        owner.appendChild(wrapper);
        const current = state({
            phase: 'translated',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host: slotHost, source, sourceValue: 'source'}],
            bilingualContent: wrapper,
            bilingualOuterHTML: wrapper.outerHTML,
        });

        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [slotHost]), current)).toBe(true);
        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [wrapper]), current)).toBe(true);
        wrapper.setAttribute('lang', 'ja');
        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [wrapper]), current)).toBe(false);
        expect(isOwnCurrentArtifactAddition(
            childListRecord(owner, [document.createElement('aside')]),
            current,
        )).toBe(false);
        expect(isOwnCurrentArtifactAddition(childListRecord(owner), current)).toBe(false);
    });

    it('识别当前译文工件 mutation，并严格识别自身 single-slot 搬移', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const host = node.querySelector('span') as HTMLElement;
        const source = host.firstChild as Text;
        const emptyState = state();
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node), emptyState)).toBe(false);

        const artifact = document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true');
        const child = document.createElement('em');
        artifact.appendChild(child);
        node.appendChild(artifact);
        const artifactState = state({spinner: artifact});
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(artifact), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(child), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node, [artifact]), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node, [node]), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(
            childListRecord(node, [document.createTextNode('other')]),
            artifactState,
        )).toBe(false);

        const slotState = state({
            mode: 'single',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}],
        });
        expect(isOwnSingleTextSlotMove(
            childListRecord(host, [source], [source]),
            node,
            slotState,
        )).toBe(true);
        expect(isOwnSingleTextSlotMove(childListRecord(host), node, slotState)).toBe(false);
        expect(isOwnSingleTextSlotMove(
            {...childListRecord(host, [source]), type: 'attributes'} as MutationRecord,
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(host, [source]), node, state())).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(source, [source]),
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(node, [source]),
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(host, [document.createTextNode('other')]),
            node,
            slotState,
        )).toBe(false);
    });

    it('仅把标记工件及其后代当作 FluentRead 产物', () => {
        const {document} = parseHTML(`
            <html><body>
                <span id="segment" data-fr-translation-segment="true"><em id="child">translated</em></span>
                <span id="owned" data-fr-translation-owned="true">owned</span>
                <span id="plain">plain</span>
            </body></html>
        `);
        const segment = document.querySelector('#segment')!;
        const child = document.querySelector('#child')!;
        const ownedText = document.querySelector('#owned')!.firstChild!;
        const plain = document.querySelector('#plain')!;

        expect(isTranslationArtifact(segment)).toBe(true);
        expect(isTranslationArtifact(child)).toBe(true);
        expect(isTranslationArtifact(ownedText)).toBe(true);
        expect(isTranslationArtifact(plain)).toBe(false);
        expect(isTranslationArtifact(document.createTextNode('detached'))).toBe(false);
    });

    it('复用同一 Text、重绑定等价重建 Text，并拒绝数量或来源不一致', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const original = document.createTextNode('source');
        const replacement = document.createTextNode('source');
        const result = {
            sources: ['source'],
            translations: ['译文'],
            nodes: [original],
            slots: [{node: original, text: '译文'}],
        };
        const currentPart = {node: replacement, prefix: '(', source: 'source', suffix: ')'};

        expect(reboundLiveTextResult([original], result, [{...currentPart, node: original}])).toEqual({
            nodes: [original],
            slots: [{node: original, text: '(译文)'}],
        });
        expect(reboundLiveTextResult([replacement], result, [currentPart])).toEqual({
            nodes: [replacement],
            slots: [{node: replacement, text: '(译文)'}],
        });
        expect(reboundLiveTextResult([replacement], {...result, translations: []}, [currentPart])).toEqual({
            nodes: [replacement],
            slots: [{node: replacement, text: '(source)'}],
        });
        expect(reboundLiveTextResult([], result, [])).toBeNull();
        expect(reboundLiveTextResult([replacement], result, [{...currentPart, source: 'other'}])).toBeNull();
    });

    it('相同 Text 身份但分槽原文变化时拒绝迟到结果，即使整段拼接原文相同', () => {
        const {document} = parseHTML('<html><body><p><b>Hello world</b> again</p></body></html>');
        const first = document.querySelector('b')!.firstChild as Text;
        const second = document.querySelector('p')!.lastChild as Text;
        const result = {
            sources: ['Hello world', 'again'],
            translations: ['你好世界', '再次'],
            nodes: [first, second],
            slots: [{node: first, text: '你好世界'}, {node: second, text: ' 再次'}],
        };
        first.data = 'Hello';
        second.data = ' world again';
        const parts = [
            {node: first, prefix: '', source: 'Hello', suffix: ''},
            {node: second, prefix: ' ', source: 'world again', suffix: ''},
        ];

        expect(document.querySelector('p')!.textContent).toBe('Hello world again');
        expect(reboundLiveTextResult([first, second], result, parts)).toBeNull();
        expect(first.data).toBe('Hello');
        expect(second.data).toBe(' world again');
    });

    it('相同 Text 身份的空白更新使用最新前后缀，不把旧展示快照写回宿主', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const source = document.querySelector('p')!.firstChild as Text;
        const result = {
            sources: ['source'], translations: ['译文'], nodes: [source],
            slots: [{node: source, text: '译文'}],
        };
        source.data = '\n source  ';
        const parts = [{node: source, prefix: '\n ', source: 'source', suffix: '  '}];

        expect(reboundLiveTextResult([source], result, parts)).toEqual({
            nodes: [source], slots: [{node: source, text: '\n 译文  '}],
        });
        expect(reboundLiveTextResult([], result, parts)).toBeNull();
        expect(reboundLiveTextResult([document.createTextNode('source')], result, parts)).toBeNull();
        expect(reboundLiveTextResult([source], result, [])).toBeNull();
    });
});


describe('仅译文合成段原文搬移回归', () => {
    it('Latest 原父移除与槽内加入均属于自身操作，真实内容变动仍需重译', () => {
        const {document} = parseHTML('<html><body><div><span data-fr-translation-segment="true"><a href="/releases/latest"><span class="Label">Latest</span></a></span></div></body></html>');
        const owner = document.querySelector<HTMLElement>('[data-fr-translation-segment]')!;
        const label = document.querySelector<HTMLElement>('.Label')!;
        const source = label.firstChild as Text;
        const host = document.createElement('span');
        host.className = 'fluent-read-single-slot';
        host.setAttribute('data-fr-translation-owned', 'true');
        host.setAttribute('translate', 'no');
        label.insertBefore(host, source);
        host.appendChild(source);
        const current = state({
            mode: 'single', phase: 'translated', sourceText: 'Latest', syntheticSegment: true,
            syntheticHost: owner.parentElement!, sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'Latest'}],
        });
        const removal = childListRecord(label, [], [source]);
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(true);
        expect(isTranslationArtifact(label)).toBe(true);
        expect(canKeepTranslationAttempt(owner, current, () => true, () => true)).toBe(false);
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(true);
        expect(isOwnSingleTextSlotMove(childListRecord(host, [source]), owner, current)).toBe(true);
        const replacement = document.createTextNode('Latest');
        expect(isOwnSingleTextSlotMove(childListRecord(label, [], [replacement]), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label, [replacement], [source]), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label, [], [source, replacement]), owner, current)).toBe(false);
        source.data = 'Changed';
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(false);
        source.data = 'Latest';
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(true);
        host.remove();
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(false);
    });
});
