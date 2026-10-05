import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {composeMangaPage} from '@/src/features/image-translation/content/mangaCompositor';
const draw=vi.fn(),decode=vi.fn();let canvas:{width:number;height:number;getContext:ReturnType<typeof vi.fn>};
const source={} as HTMLImageElement;
const page={width:400,height:300,patches:[{x:10,y:20,width:50,height:30,bytes:new Uint8Array([1])}],lines:[]};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
beforeEach(()=>{vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});vi.resetAllMocks();canvas={width:0,height:0,getContext:vi.fn(()=>({drawImage:draw}))};vi.stubGlobal('document',{createElement:()=>canvas});vi.stubGlobal('createImageBitmap',decode);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('直接合成漫画画布的生命周期',()=>{
    it('绘制原图及局部结果并立即关闭解码位图，不进行 PNG 再编码',async()=>{
        const bitmap={width:50,height:30,close:vi.fn()};decode.mockResolvedValue(bitmap);
        const c=await composeMangaPage(source,page,new AbortController().signal);expect(c).toBe(canvas);expect([c.width,c.height]).toEqual([400,300]);
        expect(draw.mock.calls).toEqual([[source,0,0,400,300],[bitmap,10,20]]);expect(bitmap.close).toHaveBeenCalledOnce();expect(decode.mock.calls[0][0].size).toBe(1);expect(vi.getTimerCount()).toBe(0);
    });
    it('无图块仍可合成原图，不启动任何解码',async()=>{await composeMangaPage(source,{...page,patches:[]},new AbortController().signal);expect(decode).not.toHaveBeenCalled();});
    it('预取消不绘图，清理画布',async()=>{const c=new AbortController();c.abort();await expect(composeMangaPage(source,page,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(draw).not.toHaveBeenCalled();expect(canvas.width).toBe(0);});
    it('浏览器缺少 Canvas 时释放画布',async()=>{canvas.getContext.mockReturnValue(null);await expect(composeMangaPage(source,page,new AbortController().signal)).rejects.toThrow('不支持');expect(canvas.height).toBe(0);});
    it.each(['sync','reject','wrong-width','wrong-height','draw'] as const)('失败释放图块和画布：%s',async mode=>{
        const bitmap={width:mode==='wrong-width'?1:50,height:mode==='wrong-height'?1:30,close:vi.fn()};
        if(mode==='sync')decode.mockImplementation(()=>{throw new Error('decode');});else if(mode==='reject')decode.mockRejectedValue(new Error('decode'));else decode.mockResolvedValue(bitmap);
        if(mode==='draw')draw.mockImplementationOnce(()=>undefined).mockImplementationOnce(()=>{throw new Error('draw');});
        await expect(composeMangaPage(source,page,new AbortController().signal)).rejects.toThrow();expect(canvas.width).toBe(0);
        if(!['sync','reject'].includes(mode))expect(bitmap.close).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['abort','timeout','late-reject'] as const)('解码等待停止后关闭迟到位图，无迟到结果：%s',async mode=>{
        let resolve!:(v:unknown)=>void,reject!:(e:Error)=>void;decode.mockReturnValue(new Promise((yes,no)=>{resolve=yes;reject=no;}));
        const c=new AbortController(),task=composeMangaPage(source,page,c.signal);const failure=expect(task).rejects.toThrow();await flush();
        if(mode==='timeout')vi.advanceTimersByTime(15000);else c.abort();await failure;
        const bitmap={width:50,height:30,close:vi.fn()};if(mode==='late-reject')reject(new Error('late'));else resolve(bitmap);await flush();
        if(mode!=='late-reject')expect(bitmap.close).toHaveBeenCalledOnce();expect(canvas.width).toBe(0);expect(vi.getTimerCount()).toBe(0);
    });
    it('解码完成同一微任务取消时也关闭位图',async()=>{
        const c=new AbortController(),bitmap={width:50,height:30,close:vi.fn()};decode.mockImplementation(()=>Promise.resolve(bitmap).then(v=>{queueMicrotask(()=>c.abort());return v;}));
        await expect(composeMangaPage(source,page,c.signal)).rejects.toMatchObject({name:'AbortError'});expect(bitmap.close).toHaveBeenCalledOnce();
    });
    it('多个图块共用十五秒整页预算，前块耗时不能给后块重新发放完整预算', async () => {
        let first!: (value: any) => void, second!: (value: any) => void;
        decode.mockReturnValueOnce(new Promise(resolve => {first = resolve;})).mockReturnValueOnce(new Promise(resolve => {second = resolve;}));
        let outcome: string | undefined;
        const task = composeMangaPage(source, {...page, patches: [page.patches[0], page.patches[0]]}, new AbortController().signal);
        const settled = task.then(() => {outcome = 'success';}, error => {outcome = error.message;});
        const initial = {width: 50, height: 30, close: vi.fn()}; vi.advanceTimersByTime(9000); first(initial); await flush();
        expect(decode).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(6000); await flush(); const atDeadline = outcome;
        const late = {width: 50, height: 30, close: vi.fn()}; second(late); await settled; await flush();
        expect(atDeadline).toBe('译图加载超时'); expect(initial.close).toHaveBeenCalledOnce(); expect(late.close).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['source', 'patch'] as const)('%s 绘制耗尽整页预算后不成功交付，也不启动后续图块', async stage => {
        const bitmap = {width: 50, height: 30, close: vi.fn()}; decode.mockResolvedValue(bitmap);
        if (stage === 'source') draw.mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        else draw.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        await expect(composeMangaPage(source, {...page, patches: [page.patches[0], page.patches[0]]}, new AbortController().signal)).rejects.toThrow('译图加载超时');
        expect(decode).toHaveBeenCalledTimes(stage === 'source' ? 0 : 1);
        if (stage === 'patch') expect(bitmap.close).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['source-only', 'last-patch'] as const)('最后的 %s 绘制耗尽预算也不能交付', async stage => {
        const bitmap = {width: 50, height: 30, close: vi.fn()}; decode.mockResolvedValue(bitmap);
        if (stage === 'source-only') draw.mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        else draw.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {vi.advanceTimersByTime(15000);});
        await expect(composeMangaPage(source, {...page, patches: stage === 'source-only' ? [] : page.patches}, new AbortController().signal)).rejects.toThrow('译图加载超时');
        expect(decode).toHaveBeenCalledTimes(stage === 'source-only' ? 0 : 1);
        if (stage === 'last-patch') expect(bitmap.close).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(vi.getTimerCount()).toBe(0);
    });
    it('在整页截止前完成成功，后续独立调用拥有自己的预算', async () => {
        const bitmap = {width: 50, height: 30, close: vi.fn()};
        decode.mockImplementation(() => new Promise(resolve => {setTimeout(() => resolve(bitmap), 14999);}));
        for (let i = 0; i < 2; i++) {
            const task = composeMangaPage(source, page, new AbortController().signal); vi.advanceTimersByTime(14999);
            await expect(task).resolves.toBe(canvas); expect(vi.getTimerCount()).toBe(0);
        }
        expect(bitmap.close).toHaveBeenCalledTimes(2); expect(decode).toHaveBeenCalledTimes(2);
    });
});
