import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {
        on: true,
        harness: undefined as {enabled: boolean} | undefined,
        disableSelectionTranslator: false,
        selectionTranslatorMode: 'bilingual',
        selectionAreaEnabled: true,
    },
    createVueShadowUi: vi.fn(),
    createModalDialogHostController: vi.fn(),
    shouldStartAreaTranslationFromHotkey: vi.fn(),
}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: mocks.createVueShadowUi}));
vi.mock('@/src/features/area-translation/content/areaHotkey', () => ({
    shouldStartAreaTranslationFromHotkey: mocks.shouldStartAreaTranslationFromHotkey,
}));
vi.mock('@/src/features/selection-translation/content/modalDialogHost', () => ({
    createModalDialogHostController: mocks.createModalDialogHostController,
}));
vi.mock('@/src/features/selection-translation/ui/SelectionTranslator.vue', () => ({default: {name: 'SelectionTranslator'}}));
vi.mock('@/src/features/area-translation/ui/AreaTranslator.vue', () => ({default: {name: 'AreaTranslator'}}));

interface MockUi {
    mounted?: {app?: unknown; instance?: unknown};
    remove: ReturnType<typeof vi.fn>;
}

function ui(instance: unknown = {feature: 'mounted'}): MockUi {
    return {
        mounted: {app: {unmount: vi.fn()}, instance},
        remove: vi.fn(),
    };
}

function pendingUi(): {
    promise: Promise<MockUi>;
    resolve: (value: MockUi) => void;
} {
    let resolve!: (value: MockUi) => void;
    return {
        promise: new Promise<MockUi>((done) => {
            resolve = done;
        }),
        resolve,
    };
}

beforeEach(() => {
    vi.resetModules();
    mocks.createVueShadowUi.mockReset();
    mocks.createModalDialogHostController.mockReset();
    mocks.shouldStartAreaTranslationFromHotkey.mockReset();
    mocks.config.harness = undefined;
    mocks.config.disableSelectionTranslator = false;
    mocks.config.selectionTranslatorMode = 'bilingual';
    mocks.config.selectionAreaEnabled = true;
    mocks.config.on = true;
    vi.stubGlobal('document', Object.assign(new EventTarget(), {getElementById: vi.fn(() => null)}));
});

describe('划词翻译挂载生命周期', () => {
    it('选区仅转发给当前 host，卸载先恢复 modal 所有权再移除界面', async () => {
        const pending = pendingUi();
        const shadowHost = {style: {setProperty: vi.fn()}};
        const controller = {placeForRange: vi.fn(), dispose: vi.fn()};
        const mountedUi = {...ui(), shadowHost};
        mocks.createModalDialogHostController.mockReturnValue(controller);
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const request = runtime.mountSelectionTranslator({} as never);
        const reportRange = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};

        reportRange(range);
        expect(controller.placeForRange).not.toHaveBeenCalled();
        pending.resolve(mountedUi);
        await request;
        expect(shadowHost.style.setProperty).toHaveBeenCalledWith('position', 'static', 'important');
        expect(mocks.createModalDialogHostController).toHaveBeenCalledWith(shadowHost);
        reportRange(range);
        reportRange(null);
        expect(controller.placeForRange.mock.calls).toEqual([[range], [null]]);

        runtime.unmountSelectionTranslator();
        expect(controller.dispose).toHaveBeenCalledOnce();
        expect(controller.dispose.mock.invocationCallOrder[0]).toBeLessThan(mountedUi.remove.mock.invocationCallOrder[0]);
        reportRange(range);
        expect(controller.placeForRange).toHaveBeenCalledTimes(2);
    });

    it('不完整挂载句柄缺少 host 样式时仍可安全卸载', async () => {
        const mountedUi = {...ui(), shadowHost: {}};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        await runtime.mountSelectionTranslator({} as never);
        expect(mocks.createModalDialogHostController).not.toHaveBeenCalled();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('划词总开关关闭时 Harness 不单独挂载，重新启用后关闭会丢弃待挂载 UI', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const mounted = ui();
        mocks.createVueShadowUi.mockResolvedValueOnce(mounted);
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'bilingual';
        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toEqual({feature: 'mounted'});
        runtime.unmountSelectionTranslator();
        const pending = pendingUi();
        const late = ui();
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise);
        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config.harness.enabled = false;
        mocks.config.disableSelectionTranslator = true;
        mocks.config.selectionTranslatorMode = 'disabled';
        pending.resolve(late);
        await expect(request).resolves.toBeNull();
        expect(late.remove).toHaveBeenCalledOnce();
    });

    it('启用划词的 Harness 共享实例重挂载后，旧组件 Range 回调不得移动新 modal host', async () => {
        mocks.config.harness = {enabled: true};
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'bilingual';
        const firstHost = {style: {setProperty: vi.fn()}};
        const secondHost = {style: {setProperty: vi.fn()}};
        const firstController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const secondController = {placeForRange: vi.fn(), dispose: vi.fn()};
        const firstUi = {...ui(), shadowHost: firstHost};
        const secondUi = {...ui(), shadowHost: secondHost};
        mocks.createVueShadowUi.mockResolvedValueOnce(firstUi).mockResolvedValueOnce(secondUi);
        mocks.createModalDialogHostController.mockReturnValueOnce(firstController).mockReturnValueOnce(secondController);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        await runtime.mountSelectionTranslator({} as never);
        const firstReport = mocks.createVueShadowUi.mock.calls[0][1].props.onSelectionRangeChange;
        const range = {startContainer: {nodeType: 3}};
        firstReport(range);
        expect(firstController.placeForRange).toHaveBeenCalledWith(range);
        runtime.unmountSelectionTranslator();
        expect(firstController.dispose.mock.invocationCallOrder[0]).toBeLessThan(firstUi.remove.mock.invocationCallOrder[0]);

        await runtime.mountSelectionTranslator();
        const secondReport = mocks.createVueShadowUi.mock.calls[1][1].props.onSelectionRangeChange;
        firstReport(range);
        firstReport(null);
        expect(secondController.placeForRange).not.toHaveBeenCalled();
        secondReport(range);
        secondReport(null);
        expect(secondController.placeForRange.mock.calls).toEqual([[range], [null]]);
        runtime.unmountSelectionTranslator();
        expect(secondController.dispose.mock.invocationCallOrder[0]).toBeLessThan(secondUi.remove.mock.invocationCallOrder[0]);
    });

    it('没有内容脚本上下文或功能关闭时不挂载', async () => {
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        expect(runtime.mountSelectionTranslator()).toBeUndefined();
        mocks.config.disableSelectionTranslator = true;
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        mocks.config.disableSelectionTranslator = false;
        mocks.config.selectionTranslatorMode = 'disabled';
        expect(runtime.mountSelectionTranslator({} as never)).toBeNull();
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('只创建一个关闭 Shadow DOM，并在卸载时清理', async () => {
        const mountedUi = ui();
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');
        const context = {name: 'content'} as never;

        await expect(runtime.mountSelectionTranslator(context)).resolves.toEqual({feature: 'mounted'});
        expect(mocks.createVueShadowUi).toHaveBeenCalledWith(context, expect.objectContaining({
            name: 'fluent-read-selection-translator-ui',
            hostId: 'fluent-read-selection-translator-container',
            zIndex: 2_147_483_646,
            mode: 'closed',
        }));
        expect(runtime.mountSelectionTranslator()).toBeNull();

        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('复用正在挂载的请求，并丢弃卸载后的迟到结果', async () => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        expect(runtime.mountSelectionTranslator()).toBe(request);
        runtime.unmountSelectionTranslator();
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it.each([
        ['disableSelectionTranslator', true],
        ['selectionTranslatorMode', 'disabled'],
    ] as const)('挂载期间配置字段 %s 关闭时移除迟到界面', async (key, value) => {
        const pending = pendingUi();
        const mountedUi = ui();
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        const request = runtime.mountSelectionTranslator({} as never);
        mocks.config[key] = value as never;
        pending.resolve(mountedUi);

        await expect(request).resolves.toBeNull();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('允许挂载器返回没有 Vue 实例的安全空结果', async () => {
        const mountedUi = {remove: vi.fn()};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/selection-translation/content/runtime');

        await expect(runtime.mountSelectionTranslator({} as never)).resolves.toBeNull();
        runtime.unmountSelectionTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });
});

describe('圈选翻译按需挂载生命周期', () => {
    it('可信快捷键由入口启动覆盖层，未匹配手势不创建 UI', async () => {
        const beginSelection = vi.fn().mockReturnValue(true);
        mocks.createVueShadowUi.mockResolvedValue(ui({beginSelection}));
        const addEventListener = vi.spyOn(document, 'addEventListener');
        const runtime = await import('@/src/features/area-translation/content/runtime');
        runtime.mountAreaTranslator({} as never);
        const onKeydown = addEventListener.mock.calls.find(([type]) => type === 'keydown')?.[1] as (event: KeyboardEvent) => void;
        const event = {preventDefault: vi.fn()} as unknown as KeyboardEvent;

        mocks.shouldStartAreaTranslationFromHotkey.mockReturnValueOnce(false).mockReturnValueOnce(true);
        onKeydown(event);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        onKeydown(event);
        await vi.waitFor(() => expect(beginSelection).toHaveBeenCalledOnce());
        expect(event.preventDefault).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
        // 已排队的旧事件回调即使迟到，也不得重新创建覆盖层。
        mocks.shouldStartAreaTranslationFromHotkey.mockReturnValueOnce(true);
        onKeydown(event);
        expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();
    });
    it('空闲页面只注册入口，不创建 Shadow DOM；卸载时清除入口', async () => {
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(true);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        runtime.unmountAreaTranslator();
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        expect(startAreaTranslationFromContextMenu()).toBe(false);
    });

    it('没有上下文、总开关关闭或圈选关闭时不注册入口', async () => {
        const runtime = await import('@/src/features/area-translation/content/runtime');

        expect(runtime.mountAreaTranslator()).toBeUndefined();
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        mocks.config.selectionAreaEnabled = false;
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        mocks.config.selectionAreaEnabled = true;
        mocks.config.on = false;
        runtime.mountAreaTranslator({} as never);
        expect(runtime.isAreaTranslatorMounted()).toBe(false);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
    });

    it('首次右键命令才创建 closed Shadow DOM，后续命令复用当前实例', async () => {
        const beginSelection = vi.fn().mockReturnValue(true);
        const mountedUi = ui({beginSelection});
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');
        const context = {name: 'content'} as never;

        runtime.mountAreaTranslator(context);
        runtime.mountAreaTranslator(context);
        expect(mocks.createVueShadowUi).not.toHaveBeenCalled();
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(beginSelection).toHaveBeenCalledOnce();
        expect(mocks.createVueShadowUi).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
            name: 'fluent-read-area-translator-ui',
            hostId: 'fluent-read-area-translator-container',
            zIndex: 2_147_483_647,
            mode: 'closed',
        }));
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(beginSelection).toHaveBeenCalledTimes(2);
        expect(mocks.createVueShadowUi).toHaveBeenCalledOnce();

        runtime.unmountAreaTranslator();
        expect(mountedUi.remove).toHaveBeenCalledOnce();
    });

    it('卸载时丢弃迟到 UI，并允许下一次入口重新挂载', async () => {
        const pending = pendingUi();
        const staleUi = ui({beginSelection: vi.fn().mockReturnValue(true)});
        const nextBegin = vi.fn().mockReturnValue(true);
        const nextUi = ui({beginSelection: nextBegin});
        mocks.createVueShadowUi.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(nextUi);
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        const activation = startAreaTranslationFromContextMenu();
        runtime.unmountAreaTranslator();
        pending.resolve(staleUi);
        await expect(activation).resolves.toBe(false);
        expect(staleUi.remove).toHaveBeenCalledOnce();
        expect(startAreaTranslationFromContextMenu()).toBe(false);

        runtime.mountAreaTranslator({} as never);
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(true);
        expect(nextBegin).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
    });

    it('挂载期间被关闭时移除迟到界面', async () => {
        const pending = pendingUi();
        const mountedUi = ui({beginSelection: vi.fn().mockReturnValue(true)});
        mocks.createVueShadowUi.mockReturnValue(pending.promise);
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        const activation = startAreaTranslationFromContextMenu();
        mocks.config.selectionAreaEnabled = false;
        pending.resolve(mountedUi);

        await expect(activation).resolves.toBe(false);
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        expect(startAreaTranslationFromContextMenu()).toBe(false);
        runtime.unmountAreaTranslator();
    });

    it('挂载器返回没有可启动实例时清除空 UI', async () => {
        const mountedUi = {remove: vi.fn()};
        mocks.createVueShadowUi.mockResolvedValue(mountedUi);
        const runtime = await import('@/src/features/area-translation/content/runtime');
        const {startAreaTranslationFromContextMenu} = await import('@/src/features/area-translation/content/contextMenuBridge');

        runtime.mountAreaTranslator({} as never);
        await expect(startAreaTranslationFromContextMenu()).resolves.toBe(false);
        expect(mountedUi.remove).toHaveBeenCalledOnce();
        runtime.unmountAreaTranslator();
    });
});
