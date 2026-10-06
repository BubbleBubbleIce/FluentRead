/**
 * @file tests/tabTranslationQueryOwnership.test.ts
 * 文件职责：验证后台共享真值读取不会让旧文档、旧请求或失败回复覆盖新状态。
 * 主要内容：真实状态仓库和两个独立读取器共享查询归属，覆盖导航、关闭、权威消息、乱序、缓存与安全回退。
 * 模块边界：仅受控浏览器消息端口，不调用实际内容脚本或翻译服务。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTabTranslationStateReader} from '@/src/app/background/tabTranslationQuery';
import {TabTranslationStateStore} from '@/src/app/background/tabTranslationState';
function deferred() {let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;const promise = new Promise((yes, no) => {resolve = yes;reject = no;});return {promise,resolve,reject};}
function setup() {const store = new TabTranslationStateStore(), sendMessage = vi.fn();vi.stubGlobal('browser',{tabs:{sendMessage}});return {store,sendMessage,read:createTabTranslationStateReader(store)};}
const reply = {status:'success',isTranslated:true,isSiteDisabled:false,toolbarStatus:'translated'};
afterEach(() => vi.unstubAllGlobals());
describe('共享标签页真值查询归属', () => {
    it.each(['reset','delete','translated','site','set'])('%s 使旧文档回复失效且不复活缓存', async mode => {
        const {store,sendMessage,read} = setup(), pending = deferred();sendMessage.mockReturnValue(pending.promise);const old = read(9);
        if(mode==='reset') store.reset(9);if(mode==='delete') store.delete(9);if(mode==='translated') store.setTranslated(9,false,'idle');if(mode==='site') store.setSiteDisabled(9,true);if(mode==='set') store.set(9,{isTranslated:false,isSiteDisabled:false});
        const expected = store.get(9), complete = store.hasCompleteState(9);pending.resolve(reply);expect(await old).toEqual(expected);expect(store.get(9)).toEqual(expected);expect(store.hasCompleteState(9)).toBe(complete);
    });
    it('不同消费者共享查询次序，较早成功回复不能覆盖较新真值', async () => {
        const {store,sendMessage,read} = setup(), pending = deferred();sendMessage.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({...reply,isTranslated:false,toolbarStatus:'idle'});
        const old = read(9);await createTabTranslationStateReader(store)(9);pending.resolve(reply);expect((await old).isTranslated).toBe(false);expect(store.get(9).isTranslated).toBe(false);
    });
    it('旧回复先到而新查询仍在等待时，消费者等待最新真值，不提前返回默认态', async () => {
        const {store,sendMessage,read} = setup(), first = deferred(), second = deferred();sendMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        let finished = false;const old = read(9).then(value => {finished=true;return value;});const latest = createTabTranslationStateReader(store)(9);
        first.resolve({...reply,isTranslated:false,toolbarStatus:'idle'});for(let i=0;i<20;i++) await Promise.resolve();const finishedBeforeLatest = finished;
        second.resolve(reply);expect(await old).toEqual(await latest);expect(finishedBeforeLatest).toBe(false);expect(store.get(9).isTranslated).toBe(true);
    });
    it('旧失败回复不为已关闭标签页写入默认缓存', async () => {
        const {store,sendMessage,read} = setup(), pending = deferred();sendMessage.mockReturnValueOnce(pending.promise);const old = read(9);store.delete(9);pending.reject(new Error('old document gone'));await old;expect(store.hasCompleteState(9)).toBe(false);
    });
    it('完整缓存不查询，强制回源规范化真实状态，当前失败保留安全缓存', async () => {
        const {store,sendMessage,read} = setup();store.set(9,{isTranslated:false,isSiteDisabled:false});await read(9);expect(sendMessage).not.toHaveBeenCalled();
        sendMessage.mockResolvedValueOnce(reply);expect((await read(9,true)).toolbarStatus).toBe('translated');sendMessage.mockRejectedValueOnce(new Error('unavailable'));expect((await read(9,true)).isTranslated).toBe(true);
        sendMessage.mockResolvedValueOnce(undefined);expect(await read(10)).toEqual({isTranslated:false,isSiteDisabled:false});expect(store.hasCompleteState(10)).toBe(true);
        sendMessage.mockResolvedValueOnce({status:'success',isTranslated:1,isSiteDisabled:'false'});expect(await read(11)).toMatchObject({isTranslated:false,isSiteDisabled:false,toolbarStatus:'idle'});
    });
});
