import {beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeElement {
    id: string;
    parentElement: FakeElement | null;
    textContent: string;
    rect: {top: number; bottom: number};
    getBoundingClientRect(): {top: number; bottom: number};
}

interface FakeCandidate {
    element: FakeElement;
    nodes?: {textContent: string}[];
    kind: 'content';
    reason: string;
}

const harness = vi.hoisted(() => ({
    config: {translationScope: 'content' as 'content' | 'all'},
    checkConfig: vi.fn(() => true),
    capture: vi.fn((overrides = {}) => ({displayMode: 'bilingual', ...overrides})),
    identity: vi.fn((snapshot: unknown) => JSON.stringify(snapshot)),
    translateTarget: vi.fn(),
    restoreTranslationOwner: vi.fn((_owner: unknown) => true),
    states: new Map<unknown, Record<string, unknown>>(),
    owners: [] as unknown[],
    ownersWithin: vi.fn(),
    discoveries: {content: [] as unknown[], all: [] as unknown[]},
    structural: vi.fn(() => false),
    scopesUsed: [] as string[],
}));

vi.mock('@/src/services/config/store', () => ({config: harness.config}));
vi.mock('@/src/app/translation/check', () => ({checkConfig: harness.checkConfig}));
vi.mock('@/src/features/full-page-translation/content/translationRequest', () => ({
    captureFullPageTranslationConfig: harness.capture,
    getTranslationInvocationIdentity: harness.identity,
}));
vi.mock('@/src/features/full-page-translation/content/runtime', () => ({
    translateTarget: harness.translateTarget,
    restoreTranslationOwner: harness.restoreTranslationOwner,
}));
vi.mock('@/src/features/full-page-translation/content/state', () => ({
    getTranslationState: (node: unknown) => harness.states.get(node),
    getTranslationOwnersWithin: harness.ownersWithin,
    resolveTranslationStateNode: (candidate: FakeCandidate) => candidate.nodes?.length
        ? (candidate.nodes[0] as unknown as {owner?: unknown}).owner ?? null
        : candidate.element,
}));
vi.mock('@/src/core/translation/public', () => ({
    getComposedParent: (element: FakeElement) => element.parentElement,
    getTranslationCandidateKey: (candidate: FakeCandidate) => candidate.nodes?.[0] ?? candidate.element,
    selectPreferredTranslationCandidate: (existing: unknown, incoming: unknown) => existing ?? incoming,
    getCurrentTranslationCore: (scope: 'content' | 'all') => ({
        isWithinStructuralRegion: harness.structural,
        *discoverSteps() {
            harness.scopesUsed.push(scope);
            for (const step of harness.discoveries[scope]) yield step;
        },
    }),
}));

import {
    SECTION_PREVIEW_DISCOVERY_STEPS,
    inspectTranslationSection,
    toggleTranslationSection,
} from '@/src/features/full-page-translation/content/sectionTranslation';

function element(id: string, top = 0, parent: FakeElement | null = null, text = `text ${id}`): FakeElement {
    const rect = {top, bottom: top + 20};
    return {id, parentElement: parent, textContent: text, rect, getBoundingClientRect: () => rect};
}

function candidate(el: FakeElement, nodes?: FakeCandidate['nodes']): FakeCandidate {
    return {element: el, kind: 'content', reason: 'test', ...(nodes ? {nodes} : {})};
}

function steps(candidates: FakeCandidate[], extraSteps = 0): unknown[] {
    return [
        ...Array.from({length: extraSteps}, () => ({phase: 'enter'})),
        ...candidates.map((item) => ({phase: 'exit', element: item.element, candidate: item})),
    ];
}

const root = element('root');

function own(target: unknown, phase: string, extra: Record<string, unknown> = {}): void {
    harness.states.set(target, {phase, kind: 'content', ...extra});
    harness.owners.push(target);
}

beforeEach(() => {
    vi.clearAllMocks();
    harness.config.translationScope = 'content';
    harness.checkConfig.mockReturnValue(true);
    harness.restoreTranslationOwner.mockReturnValue(true);
    harness.states.clear();
    harness.owners = [];
    harness.ownersWithin.mockImplementation(() => harness.owners);
    harness.discoveries.content = [];
    harness.discoveries.all = [];
    harness.structural.mockReturnValue(false);
    harness.scopesUsed.length = 0;
    vi.stubGlobal('window', {innerHeight: 600});
});

describe('局部翻译区域盘点', () => {
    it('区分已翻译、失败待重试和未翻译段落，失败段落计入待翻译', () => {
        const translated = candidate(element('translated', 0, root));
        const failed = candidate(element('failed', 40, root));
        const fresh = candidate(element('fresh', 80, root));
        own(translated.element, 'translated');
        own(failed.element, 'error');
        harness.discoveries.content = steps([translated, failed, fresh]);

        expect(inspectTranslationSection(root as unknown as Element)).toEqual({
            total: 3, active: 1, pending: 2, truncated: false, action: 'translate',
        });
        expect(SECTION_PREVIEW_DISCOVERY_STEPS).toBeGreaterThan(1000);
    });

    it('全部已翻译或翻译中时点击恢复原文，没有候选时说明无可翻译文字', () => {
        const done = candidate(element('done', 0, root));
        const loading = candidate(element('loading', 40, root));
        own(done.element, 'translated');
        own(loading.element, 'loading');
        harness.discoveries.content = steps([done, loading]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 2, active: 2, pending: 0, action: 'restore'});

        harness.owners = [];
        harness.discoveries.content = [];
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 0, action: 'empty'});
        // 正文范围为空时再用全部节点范围确认一次，两次都为空才算没有文字。
        expect(harness.scopesUsed).toEqual(['content', 'content', 'all']);
    });

    it('预览步数用尽时标记为下限，没有已知状态时仍按翻译提示', () => {
        const first = candidate(element('first', 0, root));
        harness.discoveries.content = steps([first], 5);
        expect(inspectTranslationSection(root as unknown as Element, 3)).toEqual({
            total: 0, active: 0, pending: 0, truncated: true, action: 'translate',
        });
        own(first.element, 'translated');
        harness.discoveries.content = steps([first, candidate(element('later', 40, root))]);
        expect(inspectTranslationSection(root as unknown as Element, 1)).toMatchObject({truncated: true, active: 1, action: 'restore'});
    });

    it('页面框架内或全局设置为全部节点时直接使用全部节点范围', () => {
        const item = candidate(element('nav-item', 0, root));
        harness.discoveries.all = steps([item]);
        harness.structural.mockReturnValue(true);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, pending: 1});
        expect(harness.scopesUsed).toEqual(['all']);

        harness.structural.mockReturnValue(false);
        harness.config.translationScope = 'all';
        harness.scopesUsed.length = 0;
        inspectTranslationSection(root as unknown as Element);
        expect(harness.scopesUsed).toEqual(['all']);
        expect(harness.structural).toHaveBeenCalledOnce();
    });

    it('同一候选键只保留一个候选，合成文本段按首个来源节点识别状态', () => {
        const owner = element('segment-owner', 0, root);
        const node = {textContent: 'inline run', owner};
        const segment = candidate(element('host', 0, root), [node]);
        own(owner, 'translated');
        harness.discoveries.content = steps([segment, segment]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, active: 1, action: 'restore'});
        // 找不到状态宿主的合成段按未翻译处理。
        const orphan = candidate(element('orphan', 0, root), [{textContent: 'orphan run'}]);
        harness.owners = [];
        harness.discoveries.content = steps([orphan]);
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({pending: 1, action: 'translate'});
    });

    it('点选范围在已翻译的更大段落内部时，整段视为该区域并可恢复', async () => {
        const owner = element('owner', 0);
        const inner = element('inner', 0, owner);
        harness.states.set(owner, {phase: 'translated'});
        expect(inspectTranslationSection(inner as unknown as Element)).toEqual({
            total: 1, active: 1, pending: 0, truncated: false, action: 'restore',
        });
        expect(harness.scopesUsed).toEqual([]);

        await expect(toggleTranslationSection(inner as unknown as Element)).resolves.toMatchObject({action: 'restored', restored: 1});
        expect(harness.restoreTranslationOwner).toHaveBeenCalledWith(owner);
    });
});

describe('局部翻译切换', () => {
    it('按阅读位置翻译待处理段落：先视口内，再下方，最后上方', async () => {
        const above = candidate(element('above', -300, root));
        const below = candidate(element('below', 900, root));
        const farBelow = candidate(element('far-below', 1800, root));
        const visibleLower = candidate(element('visible-lower', 400, root));
        const visibleTop = candidate(element('visible-top', 10, root));
        const nearAbove = candidate(element('near-above', -60, root));
        // 同一行并排的两个段落保持发现顺序。
        const besideTop = candidate(element('beside-top', 10, root));
        harness.discoveries.content = steps([above, below, farBelow, visibleLower, visibleTop, besideTop, nearAbove]);
        harness.translateTarget.mockResolvedValue({status: 'committed'});

        const result = await toggleTranslationSection(root as unknown as Element);

        expect(harness.translateTarget.mock.calls.map(([item]) => (item as FakeCandidate).element.id)).toEqual([
            'visible-top', 'beside-top', 'visible-lower', 'below', 'far-below', 'near-above', 'above',
        ]);
        expect(harness.translateTarget).toHaveBeenCalledWith(visibleTop, 'bilingual', false, undefined, {displayMode: 'bilingual'});
        expect(result).toEqual({action: 'translated', translated: 7, failed: 0, unchanged: 0, restored: 0});
    });

    it('统计成功、失败与无需翻译的段落，并记住无需翻译的段落供下次切换', async () => {
        const committed = candidate(element('committed', 0, root));
        const failed = candidate(element('failed', 30, root));
        const same = candidate(element('same', 60, root));
        const blank = candidate(element('blank', 90, root));
        const thrown = candidate(element('thrown', 120, root));
        const owned = candidate(element('owned', 150, root));
        harness.discoveries.content = steps([committed, failed, same, blank, thrown, owned]);
        harness.translateTarget.mockImplementation(async (item: FakeCandidate) => {
            if (item === failed) {
                own(item.element, 'error');
                return {status: 'failed'};
            }
            if (item === same) return {status: 'unchanged', source: 'text'};
            if (item === blank) return {status: 'empty'};
            if (item === thrown) throw new Error('boom');
            if (item === owned) return {status: 'owned'};
            own(item.element, 'translated');
            return {status: 'committed'};
        });

        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'translated', translated: 1, failed: 2, unchanged: 2, restored: 0,
        });

        // 目标语言段落不再算作待翻译；失败、异常与被占用的段落仍可再次点选重试。
        own(owned.element, 'loading');
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({active: 2, pending: 2, total: 6, action: 'translate'});

        // 原文变化后，之前“无需翻译”的记忆失效。
        same.element.textContent = 'changed text';
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({pending: 3});
    });

    it('区域全部为目标语言时切换结果为 settled，不再重复请求', async () => {
        const only = candidate(element('only', 0, root), [{textContent: 'inline'}]);
        harness.discoveries.content = steps([only]);
        harness.translateTarget.mockResolvedValue({status: 'unchanged', source: 'inline'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'translated', unchanged: 1});

        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 1, pending: 0, action: 'settled'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'settled', translated: 0, failed: 0, unchanged: 0, restored: 0,
        });
        expect(harness.translateTarget).toHaveBeenCalledOnce();
    });

    it('失败的合成行内段不在候选发现中，也会按其状态重建候选并重试', async () => {
        const segment = element('failed-segment', 0, root);
        const source = {textContent: 'inline source'};
        own(segment, 'error', {syntheticSegment: true, sourceTextNodes: [source], scope: 'all', allowTopLevelApplicationShell: true});
        const plain = element('failed-block', 30, root);
        own(plain, 'error');
        harness.translateTarget.mockResolvedValue({status: 'committed'});

        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({total: 2, pending: 2, active: 0, action: 'translate'});
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'translated', translated: 2});
        expect(harness.translateTarget.mock.calls.map(([item]) => item)).toEqual([
            {element: segment, kind: 'content', reason: 'section-retry', scope: 'all', nodes: [source], allowTopLevelApplicationShell: true},
            {element: plain, kind: 'content', reason: 'section-retry'},
        ]);
    });

    it('配置检查未通过时不发出任何请求', async () => {
        harness.discoveries.content = steps([candidate(element('blocked', 0, root))]);
        harness.checkConfig.mockReturnValue(false);
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'blocked'});
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });

    it('没有候选时返回 empty；全部已翻译时只恢复该区域内的译文', async () => {
        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toMatchObject({action: 'empty'});

        const done = candidate(element('done', 0, root));
        own(done.element, 'translated');
        harness.discoveries.content = steps([done]);
        // 仅译文槽不会出现在候选发现里，只能通过所有者索引找到并恢复。
        const extra = element('translation-only-owner', 0, root);
        own(extra, 'translated');
        harness.restoreTranslationOwner.mockImplementation((owner: unknown) => owner === done.element);

        await expect(toggleTranslationSection(root as unknown as Element)).resolves.toEqual({
            action: 'restored', translated: 0, failed: 0, unchanged: 0, restored: 1,
        });
        expect(harness.ownersWithin).toHaveBeenCalledWith(root);
        expect(harness.restoreTranslationOwner).toHaveBeenCalledWith(extra);
        expect(harness.translateTarget).not.toHaveBeenCalled();
    });
});


describe('局部快捷方案请求隔离', () => {
    it('全部候选使用同一独立快照，而非全局默认服务和显示方式', async () => {
        const first = candidate(element('profile-first', 0, root));
        const second = candidate(element('profile-second', 50, root));
        harness.discoveries.content = steps([first, second]);
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        const overrides = {profileId: 'section-1', service: 'openai', model: 'chosen', targetLanguage: 'ja', displayMode: 'single' as const};
        await toggleTranslationSection(root as unknown as Element, overrides);
        expect(harness.checkConfig).toHaveBeenCalledWith(overrides);
        for (const item of [first, second]) {
            expect(harness.translateTarget).toHaveBeenCalledWith(item, 'single', false, undefined, overrides);
        }
    });

    it('换目标语言时重新判断先前无需翻译的段落', async () => {
        const item = candidate(element('settled-profile', 0, root));
        harness.discoveries.content = steps([item]);
        harness.translateTarget.mockResolvedValue({status: 'unchanged'});
        const japanese = {profileId: 'section-ja', targetLanguage: 'ja'};
        await toggleTranslationSection(root as unknown as Element, japanese);
        expect(inspectTranslationSection(root as unknown as Element, undefined, japanese).action).toBe('settled');
        const chinese = {profileId: 'section-zh', targetLanguage: 'zh-Hans'};
        expect(inspectTranslationSection(root as unknown as Element, undefined, chinese).action).toBe('translate');
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        expect((await toggleTranslationSection(root as unknown as Element, chinese)).translated).toBe(1);
    });

    it('同一方案恢复已有容器，另一方案重新翻译该容器', async () => {
        const el = element('translated-profile', 0, root);
        const overrides = {profileId: 'section-ja', targetLanguage: 'ja'};
        own(el, 'translated', {translationInvocationIdentity: JSON.stringify({displayMode: 'bilingual', ...overrides})});
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides).action).toBe('restore');
        const alternate = {profileId: 'section-zh', targetLanguage: 'zh-Hans'};
        expect(inspectTranslationSection(root as unknown as Element, undefined, alternate).action).toBe('translate');
        harness.translateTarget.mockResolvedValue({status: 'committed'});
        expect((await toggleTranslationSection(root as unknown as Element, alternate)).translated).toBe(1);
        expect(harness.restoreTranslationOwner).not.toHaveBeenCalled();
        expect((await toggleTranslationSection(root as unknown as Element, overrides)).restored).toBe(1);
    });
});


it('在已有译文段落内部换方案时，按原文所有者重建候选并使用新请求', async () => {
    const owner = element('ancestor-profile', 0, root);
    const inner = element('inside-profile', 0, owner);
    own(owner, 'translated', {translationInvocationIdentity: 'old-profile', sourceTextNodes: [{textContent: 'original'}]});
    const overrides = {profileId: 'section-new', targetLanguage: 'fr'};
    expect(inspectTranslationSection(inner as unknown as Element, undefined, overrides)).toMatchObject({action: 'translate', pending: 1, active: 0});
    harness.translateTarget.mockResolvedValue({status: 'committed'});
    expect((await toggleTranslationSection(inner as unknown as Element, overrides)).translated).toBe(1);
    expect(harness.translateTarget).toHaveBeenCalledWith(expect.objectContaining({element: owner}), 'bilingual', false, undefined, expect.objectContaining(overrides));
});

describe('局部盘点快照和迟到无需翻译结果', () => {
    it.each(['element', 'nodes'] as const)('旧结果不会把新原文记为无需翻译：%s', async mode => {
        const el = element(`late-source-${mode}`, 0, root, '已经是目标语言');
        const nodes = [{textContent: '已经是目标语言'}];
        const item = candidate(el, mode === 'nodes' ? nodes : undefined); harness.discoveries.content = steps([item]);
        let finish!: (value: unknown) => void; harness.translateTarget.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
        const task = toggleTranslationSection(root as unknown as Element);
        el.textContent = nodes[0].textContent = 'New foreign source'; finish({status: 'unchanged', source: '已经是目标语言'}); await task;
        expect(inspectTranslationSection(root as unknown as Element)).toMatchObject({action: 'translate', pending: 1});
        harness.translateTarget.mockResolvedValueOnce({status: 'committed'}); await toggleTranslationSection(root as unknown as Element);
        expect(harness.translateTarget).toHaveBeenCalledTimes(2);
    });
    it.each([undefined, {profileId: 'section-lazy', targetLanguage: 'ja'}])('新候选预览不读取全文文本或重建请求快照：%s', overrides => {
        const el = element('fresh-lazy', 0, root), readText = vi.fn(() => 'Fresh text');
        Object.defineProperty(el, 'textContent', {get: readText}); harness.discoveries.content = steps([candidate(el)]);
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides)).toMatchObject({action: 'translate', pending: 1});
        expect(harness.capture).not.toHaveBeenCalled(); expect(harness.identity).not.toHaveBeenCalled(); expect(readText).not.toHaveBeenCalled();
    });
    it('同方案已有译文默认预览不构造快照，比较方案时仅构造一次', () => {
        const overrides = {profileId: 'section-lazy', targetLanguage: 'ja'};
        const first = element('first-owner-lazy', 0, root), second = element('second-owner-lazy', 20, root);
        const identity = JSON.stringify({displayMode: 'bilingual', ...overrides});
        own(first, 'translated', {translationInvocationIdentity: identity}); own(second, 'translated', {translationInvocationIdentity: identity});
        expect(inspectTranslationSection(root as unknown as Element).action).toBe('restore'); expect(harness.capture).not.toHaveBeenCalled();
        expect(inspectTranslationSection(root as unknown as Element, undefined, overrides).action).toBe('restore');
        expect(harness.capture).toHaveBeenCalledOnce(); expect(harness.identity).toHaveBeenCalledOnce();
    });
});
