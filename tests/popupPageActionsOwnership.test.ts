/**
 * @file tests/popupPageActionsOwnership.test.ts
 * 文件职责：验证 Popup 页面状态与异步操作归属，防止旧读取、旧页面或旧任务覆盖新状态。
 * 主要内容：以真实页面控制器和受控浏览器端口覆盖翻译/恢复、导航、重复局部请求、失活、配置失效与站点规则。
 * 模块边界：不挂载 Popup 或连接供应商；组件实际生命周期另由组件和生产浏览器验证。
 */
import {afterEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {createPopupPageActions, type PopupActiveTab, type PopupPageState} from '@/src/app/popup/pageActions'

function deferred<T=unknown>() {let resolve!: (value:T)=>void,reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function settle() {for(let i=0;i<10;i++)await Promise.resolve()}
function setup() {
  const cfg=new Config();cfg.on=true;cfg.autoTranslate=false;cfg.alwaysTranslateDomains=[];cfg.disabledExtensionDomains=[]
  const state:PopupPageState={tabId:7,url:'https://example.com/a',domain:'example.com',translated:false,busy:false}
  let active=true,warning='',thunderbird=false
  const getTab=vi.fn(async():Promise<PopupActiveTab|undefined>=>({id:7,url:'https://example.com/a'})),send=vi.fn(async(_id:number,_message:{type:string;action?:string}):Promise<unknown>=>({status:'success',isTranslated:true})),notice=vi.fn(),close=vi.fn()
  const actions=createPopupPageActions({state,config:()=>cfg,active:()=>active,warning:()=>warning,getTab,send,notice,close,translate:key=>key,get thunderbird(){return thunderbird}})
  return {cfg,state,getTab,send,notice,close,actions,setActive:(value:boolean)=>{active=value},setWarning:(value:string)=>{warning=value},setThunderbird:()=>{thunderbird=true}}
}
afterEach(()=>vi.restoreAllMocks())
describe('Popup 页面状态与操作所有权',()=>{
  it('启动状态晚到不能覆盖刚完成的翻译；失败的旧状态也不能回退新结果',async()=>{
    for(const rejected of [false,true]){const {state,actions,send}=setup(),old=deferred();send.mockImplementationOnce(()=>old.promise);const hydrate=actions.hydrate();await settle();await actions.toggle();expect(state.translated).toBe(true);if(rejected)old.reject(Error('old receiver'));else old.resolve({isTranslated:false});await hydrate;expect(state.translated).toBe(true);expect(state.busy).toBe(false)}
  })
  it('较晚查询不能覆盖新查询，失效的查询不安装站点身份或启动消息',async()=>{
    const {state,getTab,actions,send}=setup(),old=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(old.promise);const first=actions.hydrate();getTab.mockResolvedValueOnce({id:0,pendingUrl:'https://sub.example.net/b'});send.mockResolvedValueOnce({isTranslated:true});await actions.hydrate();old.resolve({id:8,url:'https://old.example.org/a'});await first;expect(state).toMatchObject({tabId:0,domain:'example.net',translated:true});expect(send).toHaveBeenCalledTimes(1)
  })
  it.each([undefined,{id:-1},{id:1.5},{id:Infinity}])('无效启动标签页 %j 不发送状态请求',async tab=>{
    const {getTab,actions,send,state}=setup();getTab.mockResolvedValueOnce(tab);await actions.hydrate();expect(send).not.toHaveBeenCalled();expect(state).toMatchObject({tabId:null,domain:'',translated:false})
  })
  it('状态只接受真正布尔值，空 URL 或未安装内容脚本仍保留合法 tab ID',async()=>{
    const {getTab,actions,send,state}=setup();getTab.mockResolvedValueOnce({id:0});send.mockResolvedValueOnce({isTranslated:1});await actions.hydrate();expect(state).toMatchObject({tabId:0,url:'',domain:'',translated:false});getTab.mockResolvedValueOnce({id:0});send.mockRejectedValueOnce(Error('no receiver'));await actions.hydrate();expect(state.tabId).toBe(0);send.mockResolvedValueOnce(undefined);await actions.hydrate();expect(state.translated).toBe(false)
  })
  it('当前查询失败记录诊断；旧查询失败或失活查询不产生诊断',async()=>{
    const {actions,getTab,setActive,send}=setup(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});getTab.mockRejectedValueOnce(Error('query failed'));await actions.hydrate();expect(warn).toHaveBeenCalledOnce();const old=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(old.promise);const pending=actions.hydrate();actions.invalidate();old.reject(Error('old failure'));await pending;expect(warn).toHaveBeenCalledOnce();setActive(false);await actions.hydrate();expect(send).not.toHaveBeenCalled();expect(getTab).toHaveBeenCalledTimes(2)
  })
  it('失效的状态回复不写入界面',async()=>{
    const {actions,send,state,setActive}=setup(),old=deferred();send.mockReturnValueOnce(old.promise);const pending=actions.hydrate();await settle();setActive(false);old.resolve({isTranslated:true});await pending;expect(state.translated).toBe(false)
  })
  it('翻译、恢复、再翻译使用对应消息，明确回复与缺省回复保持原协议',async()=>{
    const {actions,send,state}=setup();send.mockImplementation(async(_id,message)=>({status:'success',isTranslated:message.action==='fullPage'}));await actions.toggle();await actions.toggle();await actions.toggle();expect(send.mock.calls.map(call=>call[1].action)).toEqual(['fullPage','restore','fullPage']);send.mockResolvedValueOnce({status:'success'});await actions.toggle();expect(state.translated).toBe(false);send.mockResolvedValueOnce({status:'success'});await actions.toggle();expect(state.translated).toBe(true)
  })
  it.each(['inactive','busy','off','disabled'])('%s 时全文和局部操作不查询、不发送、不关闭',async reason=>{
    const {actions,cfg,state,getTab,send,close,setActive}=setup();if(reason==='inactive')setActive(false);if(reason==='busy')state.busy=true;if(reason==='off')cfg.on=false;if(reason==='disabled')cfg.disabledExtensionDomains=['example.com'];await actions.toggle();await actions.section();expect(getTab).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
  })
  it('凭据提醒阻止新翻译和局部；恢复原文不受新凭据缺失影响',async()=>{
    const {actions,notice,setWarning,send,state}=setup();setWarning('missing key');await actions.toggle();await actions.section();expect(notice).toHaveBeenCalledTimes(2);expect(send).not.toHaveBeenCalled();state.translated=true;await actions.toggle();expect(send).toHaveBeenLastCalledWith(7,{type:'contextMenuTranslate',action:'restore'})
  })
  it('等待标签页时立即独占操作，连续局部触发只发一次命令、只关闭一次',async()=>{
    const {actions,getTab,state,send,close}=setup(),pending=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(pending.promise);const first=actions.section();expect(state.busy).toBe(true);await actions.section();await actions.toggle();expect(getTab).toHaveBeenCalledTimes(1);pending.resolve({id:7,url:state.url});await first;expect(send).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledOnce();expect(state.busy).toBe(false)
  })
  it('关闭或配置失效后晚查询不再发送翻译；旧完成不能释放新操作',async()=>{
    const {actions,getTab,send,state,close}=setup(),query=deferred<PopupActiveTab>();getTab.mockReturnValueOnce(query.promise);const cancelled=actions.section();actions.invalidate();query.resolve({id:7,url:state.url});await cancelled;expect(send).not.toHaveBeenCalled();const first=deferred(),second=deferred();send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const old=actions.toggle();await settle();actions.invalidate();const fresh=actions.section();await settle();first.resolve({status:'success',isTranslated:true});await old;expect(state.busy).toBe(true);expect(state.translated).toBe(false);second.resolve({status:'success'});await fresh;expect(close).toHaveBeenCalledOnce();expect(state.busy).toBe(false)
  })
  it('页面切换先读取新真值，不把旧恢复操作交给另一个标签页或同 ID 新 URL',async()=>{
    for(const tab of [{id:8,url:'https://example.net/b'},{id:7,pendingUrl:'https://example.org/new'}]){const {actions,state,getTab,send}=setup();state.translated=true;getTab.mockResolvedValue(tab);send.mockResolvedValue({isTranslated:false});await actions.toggle();expect(send.mock.calls.map(call=>call[1].type)).toEqual(['getFullPageTranslationState']);expect(state.tabId).toBe(tab.id);expect(state.translated).toBe(false);expect(state.busy).toBe(false)}
  })
  it('还未读取首屏标签页时可绑定实际页面，tab 0 合法',async()=>{
    const {actions,state,getTab,send}=setup();state.tabId=null;getTab.mockResolvedValueOnce({id:0,url:'https://example.com/a'});await actions.toggle();expect(send).toHaveBeenCalledWith(0,{type:'contextMenuTranslate',action:'fullPage'});expect(state.tabId).toBe(0)
  })
  it('无 URL 的同标签页仍可恢复；规则同步回调使页面失活时不启动翻译',async()=>{
    const {actions,state,getTab,send,cfg,setActive}=setup();state.url='';getTab.mockResolvedValueOnce({id:7});await actions.toggle();expect(send).toHaveBeenCalledOnce();send.mockClear();state.domain='example.com';const leave=vi.fn(()=>setActive(false));Object.defineProperty(cfg,'alwaysTranslateDomains',{get:()=>[],set:leave});await actions.setAlways(true);expect(leave).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled()
  })
  it.each(['invalid-tab','query-error','message-error','empty','failed'])('%s 拒绝成功状态并释放执行锁；局部失败保持窗口',async failure=>{
    const {actions,getTab,send,state,close,notice,setThunderbird}=setup();setThunderbird();const configure=()=>{if(failure==='invalid-tab')getTab.mockResolvedValueOnce(undefined);if(failure==='query-error')getTab.mockRejectedValueOnce(Error('query'));if(failure==='message-error')send.mockRejectedValueOnce(Error('receiver'));if(failure==='empty')send.mockResolvedValueOnce(undefined);if(failure==='failed')send.mockResolvedValueOnce({status:'disabled'})};configure();await actions.toggle();expect(state.translated).toBe(false);expect(state.busy).toBe(false);expect(notice).toHaveBeenLastCalledWith('请先打开一封邮件，然后重试翻译','error');configure();await actions.section();expect(close).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('popup.sectionTranslationUnavailable','error')
  })
  it('已经发送的旧成功或失败回复在失活后不关闭、不提示、不写状态',async()=>{
    for(const rejected of [false,true]){const {actions,send,setActive,notice,close,state}=setup(),old=deferred();send.mockReturnValueOnce(old.promise);const pending=actions.section();await settle();setActive(false);actions.invalidate();if(rejected)old.reject(Error('old'));else old.resolve({status:'success'});await pending;expect(close).not.toHaveBeenCalled();expect(notice).not.toHaveBeenCalled();expect(state.busy).toBe(false)}
  })
})
describe('Popup 站点规则与即时翻译',()=>{
  it('启用、重复启用、停用规则不产生重复域名；停用不执行恢复',async()=>{
    const {actions,cfg,send,state,notice}=setup();await actions.setAlways(true);await actions.setAlways(true);expect(cfg.alwaysTranslateDomains).toEqual(['example.com']);expect(state.translated).toBe(true);send.mockClear();actions.setAlways(false);expect(cfg.alwaysTranslateDomains).toEqual([]);expect(send).not.toHaveBeenCalled();expect(notice).toHaveBeenLastCalledWith('已关闭 example.com 的始终翻译，当前网页保持不变')
  })
  it('旧协议缺省/明确 false 状态与当前发送失败分别展示保存结果',async()=>{
    const {actions,send,state,notice}=setup();send.mockResolvedValueOnce({status:'success'});await actions.setAlways(true);expect(state.translated).toBe(true);send.mockResolvedValueOnce({status:'success',isTranslated:false});await actions.setAlways(true);expect(state.translated).toBe(false);send.mockRejectedValueOnce(Error('no receiver'));await actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com，当前网页请刷新后重试','error')
  })
  it.each(['inactive','busy','no-domain','no-tab','invalid'])('%s 时站点规则操作不修改配置或启动翻译',async reason=>{
    const {actions,cfg,state,send,setActive}=setup();if(reason==='inactive')setActive(false);if(reason==='busy')state.busy=true;if(reason==='no-domain')state.domain='';if(reason==='no-tab')state.tabId=null;await actions.setAlways(reason==='invalid'?'true' as never:true);if(reason!=='busy')actions.setDisabled(reason==='invalid'?'true' as never:true);expect(cfg.alwaysTranslateDomains).toEqual([]);expect(cfg.disabledExtensionDomains).toEqual([]);expect(send).not.toHaveBeenCalled()
  })
  it('全局自动翻译和站点禁用不接受启用规则；插件关闭或缺凭据时保存而不执行',async()=>{
    const {actions,cfg,send,notice,setWarning}=setup();cfg.autoTranslate=true;actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('所有网站自动翻译已开启，请在完整设置中关闭全局开关');cfg.autoTranslate=false;cfg.disabledExtensionDomains=['example.com'];actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('当前已在 example.com 禁用扩展，请先恢复扩展');cfg.disabledExtensionDomains=[];cfg.on=false;actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com，启动插件后生效');cfg.on=true;setWarning('key');actions.setAlways(true);expect(notice).toHaveBeenLastCalledWith('已保存 example.com；key','error');expect(send).not.toHaveBeenCalled()
  })
  it('站点禁用后旧任务不能重新标记成功，启停只修改本站且不发覆盖命令',async()=>{
    const {actions,cfg,state,send}=setup(),pending=deferred();send.mockReturnValueOnce(pending.promise);const old=actions.toggle();await settle();actions.setDisabled(true);actions.setDisabled(true);expect(cfg.disabledExtensionDomains).toEqual(['example.com']);expect(state.busy).toBe(false);expect(state.translated).toBe(false);pending.resolve({status:'success',isTranslated:true});await old;expect(state.translated).toBe(false);actions.setDisabled(false);expect(cfg.disabledExtensionDomains).toEqual([]);expect(send).toHaveBeenCalledTimes(1)
  })
  it('外部移除规则后旧即时翻译回复不声称规则已经开启',async()=>{
    const {actions,cfg,state,send,notice}=setup(),pending=deferred();send.mockReturnValueOnce(pending.promise);const old=actions.setAlways(true);await settle();cfg.alwaysTranslateDomains=[];pending.resolve({status:'success',isTranslated:true});await old;expect(state.translated).toBe(false);expect(notice).not.toHaveBeenCalled()
  })
})
