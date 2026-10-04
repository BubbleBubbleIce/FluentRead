import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {isAnchorNearViewport, TranslationSourceStabilityGate} from '@/src/features/full-page-translation/content/sourceStabilityGate';
import type {TranslationCandidate} from '@/src/core/translation/public';

function fixture() {
    const {document} = parseHTML('<html><body><p>Visitors: 1</p></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth:1280, innerHeight:900, setTimeout:globalThis.setTimeout, clearTimeout:globalThis.clearTimeout});
    const element = document.querySelector<HTMLElement>('p')!;
    const candidate: TranslationCandidate = {element, kind:'content', reason:'source-stability'};
    const session = {translationMode:'all', scheduled:new Map<Node, TranslationCandidate>(),
        unchangedCandidates:new WeakMap<Node, unknown>(), lifecycleRetries:new WeakMap<Node, unknown>()};
    const ports = {isCurrent:vi.fn(() => true), resolve:vi.fn<() => TranslationCandidate | null>(() => candidate),
        discover:vi.fn((_session: typeof session, fresh:TranslationCandidate) => {session.scheduled.set(fresh.element, {...fresh, scope:'all'});}),
        source:vi.fn(() => 'The latest source.'), queue:vi.fn(), drain:vi.fn()};
    const gate = new TranslationSourceStabilityGate(ports);
    gate.blocks(candidate, 'Visitors: 1', session);
    return {document, element, candidate, session, ports, gate};
}

describe('动态来源安静窗口调度', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

    it('只在最后一次变化后调度最新候选，清理旧 unchanged / retry 墓碑', async () => {
        const {candidate, session, ports, gate} = fixture();
        session.unchangedCandidates.set(candidate.element, 'old');
        session.lifecycleRetries.set(candidate.element, 'old');
        expect(gate.blocks(candidate,'Preparing the next section.',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);
        expect(gate.blocks(candidate,'The latest source.',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(1700);
        expect(ports.queue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(session.unchangedCandidates.has(candidate.element)).toBe(false);
        expect(session.lifecycleRetries.has(candidate.element)).toBe(false);
        expect(ports.queue).toHaveBeenCalledWith(session,candidate.element,session.scheduled.get(candidate.element),'The latest source.');
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(gate.blocks(candidate,'The latest source.',session)).toBe(false);
    });

    it('高频正文更新只保留一个安静窗口，稳定后仅派发最新来源一次', async () => {
        const {candidate, session, ports, gate} = fixture();
        let source = '';
        for (let index = 0; index < 500; index += 1) {
            source = `The article is being updated with section ${index}.`;
            expect(gate.blocks(candidate, source, session)).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(16);
        }
        expect(ports.queue).not.toHaveBeenCalled();
        ports.source.mockReturnValue(source);
        await vi.advanceTimersByTimeAsync(1800);
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(ports.queue.mock.calls[0][3]).toBe(source);
        expect(ports.drain).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        gate.dispose(session);
    });

    it('连续数字变化取消安静定时器，悬浮暂停时不创建后台请求', async () => {
        const {candidate, session, ports, gate} = fixture();
        expect(gate.blocks(candidate,'Visitors: 2',session)).toBe(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(gate.blocks(candidate,'Visitors: 3',session)).toBe(true);
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
        const hoverGate = new TranslationSourceStabilityGate(ports);
        expect(hoverGate.blocks(candidate,'Initial hover source.')).toBe(false);
        expect(hoverGate.blocks(candidate,'Changed hover source.')).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        gate.dispose(session);
        gate.dispose(session);
    });

    it.each(['inactive','detached','unresolved','unscheduled','offscreen'] as const)('安静窗口后拒绝 %s 候选', async failure => {
        const {element, candidate, session, ports, gate} = fixture();
        gate.blocks(candidate,'Changed source.',session);
        if (failure === 'inactive') ports.isCurrent.mockReturnValue(false);
        if (failure === 'detached') element.remove();
        if (failure === 'unresolved') ports.resolve.mockReturnValue(null);
        if (failure === 'unscheduled') ports.discover.mockImplementation(() => undefined);
        if (failure === 'offscreen') session.translationMode='viewport';
        await vi.runAllTimersAsync();
        expect(ports.queue).not.toHaveBeenCalled();
    });

    it('视口模式只唤醒仍可见的候选，恢复和路由切换取消旧回调', async () => {
        const {element, candidate, session, ports, gate} = fixture();
        Object.defineProperty(element,'getBoundingClientRect',{value:() => ({width:400,height:40,right:400,left:0,bottom:40,top:0})});
        session.translationMode='viewport';
        gate.blocks(candidate,'Changed source.',session);
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        gate.blocks(candidate,'Another source.',session);
        gate.dispose(session);
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        gate.blocks(candidate,'A pending source.',session);
        gate.reset();
        await vi.runAllTimersAsync();
        expect(ports.queue).toHaveBeenCalledOnce();
        expect(gate.blocks(candidate,'A new route source.',session)).toBe(false);
    });

    it.each([
        {width:0}, {height:0}, {rectWidth:0}, {rectHeight:0}, {right:0}, {left:1280}, {bottom:-10000}, {top:10000},
    ])('可见锚点拒绝无效或离屏几何 %j', overrides => {
        const {element} = fixture();
        Object.assign(window,{innerWidth:overrides.width ?? 1280,innerHeight:overrides.height ?? 900});
        Object.defineProperty(element,'getBoundingClientRect',{value:() => ({width:overrides.rectWidth ?? 400,height:overrides.rectHeight ?? 40,
            right:overrides.right ?? 400,left:overrides.left ?? 0,bottom:overrides.bottom ?? 40,top:overrides.top ?? 0})});
        expect(isAnchorNearViewport(element)).toBe(false);
    });

    it('可见锚点读取布局异常时保守等待 IO', () => {
        const {element} = fixture();
        Object.defineProperty(element,'getBoundingClientRect',{value:() => {throw new Error('Detached layout');}});
        expect(isAnchorNearViewport(element)).toBe(false);
    });
});
