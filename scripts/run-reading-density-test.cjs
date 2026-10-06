#!/usr/bin/env node
// 学习面板专项：在隔离生产扩展中检查四个动作的原句滚动、历史逐轮展开、选中状态、点词、键盘和追问。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const support = require('./run-selection-trigger-test.cjs');
const arg = (key) => process.argv[process.argv.indexOf(`--${key}`) + 1];
const output = path.resolve(arg('artifacts-dir'));
const extensionDir = path.resolve(arg('extension-dir'));
const {chromium} = createRequire(path.join(arg('playwright-root'), 'package.json'))('playwright');
const helper = require(path.resolve(arg('focus-safe-helper')));
const sentence = 'Different printing sequences have different filament switching sequences';
const grammar = '| Text | POS | Role | Meaning |\n| --- | --- | --- | --- |\n| Different | adjective | 定语，修饰 printing sequences | 不同的 |\n| printing sequences | phrase | 主语 | 打印顺序 |\n| have | verb | 谓语 | 具有、带来 |\n| different | adjective | 定语，修饰后面的名词短语 | 不同的 |\n| filament switching sequences | phrase | 宾语 | 耗材切换顺序 |\n\n### 句子主干\n打印顺序不同，耗材的切换顺序也会不同。\n\n这里的 switching 修饰 sequences，说明是“切换的顺序”。';
let nextAnswer = grammar;
let chunkDelay = 15;
const report = {providerEvidence:'Production extension in isolated Edge; translation and AI responses use deterministic local fixtures. No live translation or AI quality claim.',ok:false,cases:[],screenshots:[],consoleErrors:[],translationRequests:0,aiRequests:0};
const record = name => {report.cases.push(name); console.log('PASS',name);};
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
let launchAttempted = false;
let session, context, worker, server, optionsPage, popup, page;
async function screenshot(target,name) {const file=path.join(output,name+'.png'); await target.screenshot({path:file,fullPage:false}); report.screenshots.push(file);}
async function node(predicate) {const {root}=await support.getSelectionUiTree(page); return support.findCdpNode(root,predicate);}
const cls = name => n => support.hasCdpClass(n,name);
async function until(predicate,message) {for(let i=0;i<80;i++){if(await predicate()) return; await wait(100);} throw new Error(message);}
async function clickNode(predicate) {const {session:cdp,root}=await support.getSelectionUiTree(page); const n=support.findCdpNode(root,predicate); assert(n,'Missing UI node'); const {model}=await cdp.send('DOM.getBoxModel',{nodeId:n.nodeId}); const q=model.content; await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);}
const button = text => n=> n.nodeName==='BUTTON' && support.cdpText(n).trim()===text;
async function choose(selector) {
 await helper.activateExtensionTabWithoutForeground(context,page);
 const points=await page.evaluate(selector=>{
  const target=document.querySelector(selector),text=target.firstChild,range=document.createRange();
  range.setStart(text,0);range.setEnd(text,1);const first=range.getBoundingClientRect();
  range.setStart(text,text.length-1);range.setEnd(text,text.length);const last=range.getBoundingClientRect();
  return {start:{x:first.left,y:first.top+first.height/2},end:{x:last.right+2,y:last.top+last.height/2}};
 },selector);
 await page.mouse.move(points.start.x,points.start.y);await page.mouse.down();await page.mouse.move(points.end.x,points.end.y,{steps:12});await page.mouse.up();
}
async function select(selector) {await helper.activateExtensionTabWithoutForeground(context,page); await page.mouse.click(20,20); await choose(selector); await until(()=>node(cls('fr-selection-indicator')),'selection indicator missing');
 const state=await support.getSelectionUiTree(page);const indicator=support.findCdpNode(state.root,cls('fr-selection-indicator'));const {model}=await state.session.send('DOM.getBoxModel',{nodeId:indicator.nodeId});
 const anchor=await page.evaluate(()=>{const range=getSelection().getRangeAt(0),r=[...range.getClientRects()].at(-1)||range.getBoundingClientRect();return {right:r.right,bottom:r.bottom};});
 assert(Math.abs(model.border[0]+model.width/2-anchor.right)<24 && Math.abs(model.border[1]+model.height/2-anchor.bottom)<24,'selection icon is not anchored beside the selected text');
 await clickNode(cls('fr-selection-indicator')); await until(()=>node(cls('fr-translation-tooltip')),'selection popup missing');}
async function patch(value) {await support.patchStoredConfig(popup,value); await wait(350);}
async function ui(fn, value) {
 const state=await support.getSelectionUiTree(page), card=support.findCdpNode(state.root,cls('fr-translation-tooltip'));assert(card,'popup missing');
 const object=await state.session.send('DOM.resolveNode',{nodeId:card.nodeId});
 try {
 const result=await state.session.send('Runtime.callFunctionOn',{objectId:object.object.objectId,functionDeclaration:fn.toString(),arguments:[{value}],returnByValue:true});
 if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;
 } finally {await state.session.send('Runtime.releaseObject', {objectId:object.object.objectId});}
}
async function settled() {await until(()=>ui(function(){return !!this.querySelector('.fr-reading-answer[aria-busy="false"]')}),'answer did not finish');}
async function menu() {await clickNode(n=>n.nodeName==='SUMMARY'&&support.cdpAttribute(n,'aria-label')==='更多操作');}
async function shot(name) {
 const box=await ui(function(){const r=this.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}});
 const file=path.join(output,name+'.png');await page.screenshot({path:file,clip:box});report.screenshots.push(file);
}
async function layout() {return ui(function(){
 const area=this.querySelector('.fr-reading-result').getBoundingClientRect(),tokens=this.querySelector('.fr-sentence-tokens'),detail=this.querySelector('.fr-sentence-detail').getBoundingClientRect(),card=this.getBoundingClientRect();
 return{cardHeight:card.height,cardWidth:card.width,answerHeight:area.height,tokensHeight:tokens.getBoundingClientRect().height,sourceCopies:this.querySelectorAll('.fr-reading-source').length,sourceText:[...tokens.children].map(element=>element.matches('button') ? (element.querySelector('.fr-sentence-token-text')||element).textContent : element.textContent).join(''),labels:[...tokens.querySelectorAll('.fr-sentence-token-meta')].map(element=>({text:element.textContent.trim(),visible:element.getBoundingClientRect().bottom<=area.bottom&&element.getBoundingClientRect().top>=area.top,clipped:element.scrollWidth>element.clientWidth+1})),detailVisible:detail.top>=area.top&&detail.bottom<=area.bottom,overflow:this.scrollWidth>this.clientWidth+1,hostScroll:scrollY};
});}
async function sourceLayout() {return ui(function(){
 const scroll=this.querySelector('.fr-reading-result'),area=scroll.getBoundingClientRect(),source=scroll.querySelector('.fr-reading-source'),text=source.querySelector('p').getBoundingClientRect(),body=scroll.querySelector('.fr-reading-body').getBoundingClientRect();
 return {text:source.querySelector('p').textContent,sourceTag:source.tagName,sourceFirst:scroll.firstElementChild===source,scrollTop:scroll.scrollTop,sourceTop:text.top-area.top,sourceBottom:text.bottom-area.top,bodyTop:body.top-area.top,contentPadding:parseFloat(getComputedStyle(scroll).paddingTop),overflow:this.scrollWidth>this.clientWidth+1,hostScroll:scrollY};
});}
async function assertSourceSkipped(expected=sentence) {
 await until(async()=>{const state=await sourceLayout();return state.scrollTop>0&&state.sourceBottom<=1;},'source was not skipped after popup layout settled');
 const state=await sourceLayout();
 assert.equal(state.text,expected);assert.equal(state.sourceTag,'SECTION');assert(state.sourceFirst);assert(state.scrollTop>0);assert(state.sourceBottom<=1,`source is still visible: ${JSON.stringify(state)}`);assert(state.bodyTop>=-1&&state.bodyTop<=state.contentPadding+1,`answer is not aligned below the source: ${JSON.stringify(state)}`);assert.equal(state.hostScroll,0);assert.equal(state.overflow,false);
 return state;
}
async function revealSource(expected=sentence) {
 const area=await ui(function(){const r=this.querySelector('.fr-reading-result').getBoundingClientRect();return{x:r.x+20,y:r.y+50}});
 await page.mouse.move(area.x,area.y);await page.mouse.wheel(0,-5000);
 await until(async()=>(await sourceLayout()).scrollTop===0,'upward wheel did not reveal the source');
 const state=await sourceLayout();assert.equal(state.text,expected);assert(state.sourceTop>=0);assert(state.sourceBottom>0);assert.equal(state.hostScroll,0);
 return state;
}
async function verifyHistory() {
 const translationState = () => ui(function() {
  return {pressed:[...this.querySelectorAll('.fr-study-toolbar button[aria-pressed]')].map(button=>button.getAttribute('aria-pressed')),
   visible:this.querySelector('.fr-study-toolbar')?.getBoundingClientRect().height>0,
   hiddenActive:[...this.querySelectorAll('.fr-reading-actions button[aria-pressed="true"]')].length};
 });
 await until(()=>ui(function(){return this.textContent.includes('不同的打印顺序会带来不同的耗材切换顺序。')}),'translation did not finish');
 assert.deepEqual((await translationState()).pressed,['true','false','false','false','false','false']);
 assert.equal(report.aiRequests,0);await shot('translation-no-active-learning');record('ordinary translation has no selected learning action and makes no AI request');
 nextAnswer='### 读懂\n打印顺序会影响耗材切换顺序。';await clickNode(button('读懂'));await settled();
 assert.equal(await ui(function(){return this.querySelector('.fr-study-toolbar button[aria-pressed="true"]').textContent}),'读懂');
 record('one click enters the actual meaning answer and selects its action');
 nextAnswer='### 主干\n主语是 printing sequences，谓语是 have。';await clickNode(button('句法'));await settled();
 const ask = async (question, answer) => {
  nextAnswer=answer;await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');await page.keyboard.type(question);await page.keyboard.press('Enter');await settled();
 };
 await ask('这里的 switching 是什么词性？为什么它能放在 sequences 前面？请结合原文说明它是动名词、现在分词还是名词修饰语，并比较 filament switching sequences 与 reading habits 的结构，解释这种用法与表示正在进行的动作有什么区别。','### 修饰关系\n`switching` 修饰 sequences，说明切换的顺序。');
 await ask('给我一个类似的例子。','### 类似表达\n**reading habits** 表示阅读习惯。');
 const inspect = () => ui(function() {
  const details=this.querySelector('.fr-reading-session-detail');
  return {open:details.open,turns:[...details.querySelectorAll('.fr-reading-turn-toggle')].map(button=>({expanded:button.getAttribute('aria-expanded'),meta:button.querySelector('.fr-reading-turn-meta').textContent,title:button.querySelector('.fr-reading-turn-title').textContent})),
   renderedAnswers:details.querySelectorAll('.fr-reading-markdown').length,current:this.querySelector('.fr-reading-answer').textContent,question:this.querySelector('.fr-reading-question p').textContent,
   currentLabel:this.querySelector('.fr-reading-current-label').textContent,overflow:this.scrollWidth>this.clientWidth+1,hostScroll:scrollY};
 });
 const before=report.aiRequests;const current=await inspect();assert.equal(current.open,false);assert.equal(current.turns.length,3);assert.equal(current.renderedAnswers,0);
 await shot('history-collapsed-current-question');record('history starts folded and clearly labels the current question');
 await clickNode(n=>n.nodeName==='SUMMARY'&&support.cdpText(n).includes('历史问答'));await wait(100);
 let state=await inspect();assert.equal(state.open,true);assert(state.turns.every(turn=>turn.expanded==='false'));assert.equal(state.renderedAnswers,0);
 assert(state.turns.every((turn,index)=>turn.meta.includes(`第 ${index+1} 轮`)));await shot('history-question-list');record('opening history reveals numbered question summaries without expanding old answers');
 const clickTurn = async index => {
  const point=await ui(function(index){const button=this.querySelectorAll('.fr-reading-turn-toggle')[index];button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return{x:r.x+15,y:r.y+15};},index);
  await page.mouse.click(point.x,point.y);await wait(80);
 };
 await clickTurn(0);state=await inspect();assert.equal(state.renderedAnswers,1);assert.equal(state.turns[0].expanded,'true');await shot('history-one-answer');
 await clickTurn(1);state=await inspect();assert.equal(state.turns[0].expanded,'false');assert.equal(state.turns[1].expanded,'true');assert.equal(state.renderedAnswers,1);
 await page.keyboard.press('Enter');await wait(80);assert.equal((await inspect()).renderedAnswers,0);
 assert.equal(report.aiRequests,before);assert.equal((await inspect()).current,current.current);assert.equal((await inspect()).question,current.question);
 record('mouse and keyboard expand one old answer at a time without requests or changes to the current conversation');
 await clickTurn(2);assert.equal((await inspect()).turns[2].expanded,'true');await shot('history-full-long-question');
 await ui(function(){this.querySelector('.fr-reading-session-detail > summary').scrollIntoView({block:'start'});});
 await page.setViewportSize({width:390,height:844});await patch({theme:'dark'});await wait(200);
 state=await inspect();assert.equal(state.overflow,false);assert.equal(state.hostScroll,0);await shot('history-dark-390');
 assert(await ui(function(){const title=this.querySelector('.fr-reading-turn-toggle[aria-expanded="true"] .fr-reading-turn-title');return title.scrollWidth<=title.clientWidth+1;}));
 record('long questions wrap in 390px dark mode without horizontal or host-page scrolling');
 await patch({theme:'light'});await page.setViewportSize({width:1440,height:960});
 await clickNode(button('翻译'));await wait(100);state=await translationState();assert.equal(state.visible,true);assert.deepEqual(state.pressed,['true','false','false','false','false','false']);assert.equal(state.hiddenActive,0);assert.equal(report.aiRequests,before);
 await shot('translation-after-learning');record('returning to translation clears the learning selection, including the hidden panel');
 await clickNode(button('读懂'));await settled();assert.equal(report.aiRequests,before);
 assert.equal(await ui(function(){return this.querySelector('.fr-study-toolbar button[aria-pressed="true"]').textContent}),'读懂');
 assert.equal(await ui(function(){return this.querySelector('.fr-reading-session-detail').open;}),false);record('reentering meaning selects its cached answer and folds history without another request');
 await menu();await clickNode(button('阅读记录'));await until(()=>node(cls('fr-reading-session')),'saved conversation missing');
 await clickNode(cls('fr-reading-session'));await settled();assert.equal(report.aiRequests,before);await shot('history-restored');record('restoring a saved conversation keeps history folded without a model request');
 assert.equal(report.consoleErrors.length,0);report.ok=true;
}
async function main(){
 fs.mkdirSync(output,{recursive:true});const profileDir=fs.mkdtempSync(path.join(os.tmpdir(),'fluentread-reading-density-'));
 server=http.createServer(async(req,res)=>{
  if(req.url==='/translate'){report.translationRequests++;let raw='';for await(const part of req)raw+=part;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(JSON.parse(raw).map(()=>({translations:[{text:'不同的打印顺序会带来不同的耗材切换顺序。',to:'zh-Hans'}]}))));return;}
  report.aiRequests++;for await(const part of req){};
  res.writeHead(200,{'content-type':'text/event-stream','access-control-allow-origin':'*'});
  const response=nextAnswer;
  for(const part of response.match(/[\s\S]{1,40}/g)){res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{content:part},finish_reason:null}]})+'\n\n');await wait(chunkDelay);}
  res.end('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 
 try{
   await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); reject(error);};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });const port=server.address().port;
    launchAttempted = true;
    session=await helper.launchFocusSafePersistentContext({chromium,profileDir,browserPath:'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',headless:false,background:true,browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check'],viewport:{width:1440,height:960}});
   context=session.context;Object.assign(report,{launchMode:session.launchMode,focusPolicy:session.focusPolicy,windowPlacement:session.windowPlacement,extensionDir});
   const ready=await support.waitForWorker(context);worker=ready.worker;const id=ready.extensionId;
   const newPage=async()=>{const p=await helper.newPageWithoutForeground(context);p.on('pageerror',error=>report.consoleErrors.push(error.message));return p;};
   popup=await newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.locator('.popup-shell[data-config-ready="true"]').waitFor();
   const saved=await support.readStoredConfig(popup);
   await patch({on:true,uiLanguage:'zh-CN',uiLanguageSetupCompleted:true,service:'microsoft',from:'auto',to:'zh-Hans',selectionTranslatorMode:'bilingual',selectionTranslatorPresentation:'card',selectionTranslatorTrigger:'icon',selectionTranslatorDelay:0,hotkey:'none',floatingBallHotkey:'none',useCache:false,harness:{...saved.harness,enabled:true,service:'custom:fixture',model:'learning-fixture',trigger:'click'},customOpenAIProviders:[{id:'custom:fixture',name:'Local fixture',endpoint:`http://127.0.0.1:${port}/v1/chat/completions`,models:['learning-fixture']}],token:{'custom:fixture':'fixture-token'},model:{...saved.model,'custom:fixture':'learning-fixture'}});
   await worker.evaluate(url=>{const native=fetch.bind(globalThis);globalThis.__selectionTestNativeFetch=native;globalThis.fetch=(input,init)=>String(input).startsWith('https://edge.microsoft.com/translate/translatetext')?native(url,init):native(input,init);},`http://127.0.0.1:${port}/translate`);

  await context.route('https://example.com/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><head><style>body{margin:50px;font:20px/1.8 system-ui;color:#253248}p{max-width:730px}button{font-size:32px!important}section{padding:50px!important}</style></head><body><p><span id="sentence">${sentence}</span>.</p><p>Keep reading without losing your place.</p><div style="height:2400px"></div></body></html>`}));
  page=await newPage();await page.goto('https://example.com/');await page.locator('#fluent-read-selection-translator-container').waitFor({state:'attached'});
  await select('#sentence');await until(()=>node(cls('fr-study-toolbar')),'learning entry missing');
  if(process.argv.includes('--history-only')){await verifyHistory();return;}
  await clickNode(button('词性与句法'));await settled();
  report.initial=await layout();
  if(process.argv.includes('--baseline')){await shot('before');report.ok=true;return;}
  await assertSourceSkipped();
  if(process.argv.includes('--source-scroll-only')) {
    report.sourcePositions=[];
    for(const [action,label] of [['meaning','读懂'],['grammar','句法'],['usage','用法'],['practice','练习']]) {
      nextAnswer=action==='grammar'?grammar:`### ${label}\n\n这句话说明打印顺序会影响耗材切换顺序。`;
      await clickNode(button(label));await settled();
      report.sourcePositions.push({action,...await assertSourceSkipped()});await shot(`source-skipped-${action}`);
      await revealSource();await shot(`source-visible-${action}`);record(`${label}: starts after full source; upward wheel reveals it without scrolling the host`);
    }
    const cachedCount=report.aiRequests;
    await clickNode(button('读懂'));await settled();await assertSourceSkipped();assert.equal(report.aiRequests,cachedCount);record('cached action reopens after the source without a model request');
    await menu();await clickNode(button('查看原文'));await until(async()=>(await sourceLayout()).scrollTop===0,'source shortcut did not reveal the source');
    assert(await ui(function(){return this.getRootNode().activeElement===this.querySelector('.fr-reading-result')}));assert.equal(report.aiRequests,cachedCount);record('source shortcut reveals the original, focuses its scroll area and makes no request');
    await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');await page.keyboard.type('保留输入');await clickNode(button('读懂'));await wait(100);
    assert.equal((await sourceLayout()).scrollTop,0);assert.equal(await ui(function(){return this.querySelector('.fr-reading-followup input').value}),'保留输入');assert.equal(report.aiRequests,cachedCount);record('clicking the active tab preserves the source view and unsent follow-up');
    await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');await page.keyboard.press('Meta+A');await page.keyboard.press('Backspace');
    chunkDelay=40;nextAnswer='### 连续回答\n\n'+('打印顺序不同，耗材切换顺序也不同。\n\n'.repeat(45));
    await menu();await clickNode(button('重新生成'));await until(()=>ui(function(){return !!this.querySelector('.fr-reading-status')}),'streaming status missing');
    await assertSourceSkipped();await revealSource();await settled();assert.equal((await sourceLayout()).scrollTop,0);record('scrolling up during generation remains at the source through all streamed updates and completion');
    chunkDelay=15;nextAnswer='这是追问的简短回答。';
    await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');await page.keyboard.type('解释一下');await page.keyboard.press('Enter');await settled();await assertSourceSkipped();await revealSource();record('short follow-up also starts after the source and allows scrolling up');
    await menu();await clickNode(button('阅读记录'));await until(()=>node(cls('fr-reading-records')),'records missing');await clickNode(button('‹ 返回当前阅读'));await assertSourceSkipped();
    await menu();await clickNode(button('阅读记录'));await until(()=>node(cls('fr-reading-session')),'saved session missing');await clickNode(cls('fr-reading-session'));await settled();await assertSourceSkipped();await revealSource();record('returning from records and restoring a saved conversation retains full source above the answer');
    for(const [width,height,theme] of [[390,800,'light'],[390,800,'dark'],[1440,960,'light']]) {
      await page.setViewportSize({width,height});await patch({theme});
      await clickNode(button('读懂'));await settled();
      await clickNode(button('用法'));await settled();await assertSourceSkipped();await revealSource();await shot(`source-${width}-${theme}`);record(`${width}px ${theme}: full source stays readable and the host stays still`);
    }
    await page.keyboard.press('Escape');
    const longSource='When a model is printed using a particular filament, then it can only be printed using the corresponding nozzle. '.repeat(10).trim();
    await page.evaluate(text=>{document.querySelector('#sentence').textContent=text;document.querySelector('#sentence').parentElement.style.maxWidth='1100px';document.body.style.margin='20px';document.querySelector('#sentence').style.fontSize='13px';},longSource);
    await select('#sentence');await clickNode(button('读懂'));await settled();await assertSourceSkipped(longSource);await revealSource(longSource);await shot('source-long');record('a long selected passage is retained in full above a short answer');
    assert.equal(report.consoleErrors.length,0);report.ok=true;return;
  }
  if (process.argv.includes('--multilingual-only')) {
    for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']) {
      await patch({uiLanguage: language});
      await wait(250);
      for (const width of [1440, 390]) {
        await page.setViewportSize({width, height: width === 390 ? 844 : 960}); await wait(100);
        const clipped = await ui(function() {
          return [...this.querySelectorAll('.fr-study-toolbar button, .fr-reading-footer button, .fr-tooltip-title span')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim());
        });
        assert.deepEqual(clipped, [], `${language} ${width}px labels must stay complete`);
        assert.equal((await layout()).overflow, false);
        await shot(`reading-${language}-${width}`);
      }
      record(`${language}: complete reading actions at desktop and 390px, source remains unchanged`);
      assert.equal((await layout()).sourceText.trim(), sentence);
    }
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'host language is unchanged');
    report.ok = true; return;
  }
  assert.equal(report.initial.sourceCopies,1);await assertSourceSkipped();assert.equal(report.initial.sourceText.trim(),sentence);assert(report.initial.answerHeight>=365,'too little room for the answer');assert(report.initial.tokensHeight<115,'annotations still occupy too much space');assert(report.initial.detailVisible);assert.equal(report.initial.overflow,false);
  await shot('grammar-after');record('user sentence stays in source order with full original above the initial view and selected details visible');
  assert.deepEqual(report.initial.labels.map(item=>item.text),['定语 · 形容词','主语 · 短语','谓语 · 动词','定语 · 形容词','宾语 · 短语']);assert(report.initial.labels.every(item=>item.visible&&!item.clipped));record('all fragment roles and word classes are visible before any click');
  await clickNode(n=>support.cdpAttribute(n,'data-pos')==='phrase');
  assert.equal(await ui(function(){return this.querySelector('.fr-sentence-meaning').textContent}),'打印顺序');
  await page.keyboard.press('ArrowRight');assert.equal(await ui(function(){return this.querySelector('.fr-sentence-detail-heading strong').textContent}),'have');
  await page.keyboard.press('End');assert.equal(await ui(function(){return this.querySelector('.fr-sentence-detail-heading strong').textContent}),'filament switching sequences');
  await page.keyboard.press('Home');assert.equal(await ui(function(){return this.querySelector('.fr-sentence-detail-heading strong').textContent}),'Different');
  assert.equal(await page.evaluate(()=>scrollY),0);record('click, arrows, Home and End reveal meaning and role without scrolling host');
  const reference=n=>n.nodeName==='SUMMARY'&&support.cdpText(n).trim()==='词性说明';
  await clickNode(reference);assert(await ui(function(){return this.querySelector('.fr-sentence-reference').open}));
  await clickNode(n=>support.cdpAttribute(n,'data-pos')==='verb');assert.equal(await ui(function(){return this.querySelector('.fr-sentence-reference').open}),false);record('optional word class notes collapse when switching words');
  await menu();assert(await ui(function(){return this.querySelector('.fr-reading-tools').open}));await shot('more-actions');
  await page.keyboard.press('Escape');assert.equal(await ui(function(){return this.querySelector('.fr-reading-tools').open}),false);record('Escape dismisses secondary actions and preserves the answer');
  await menu();await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');assert.equal(await ui(function(){return this.querySelector('.fr-reading-tools').open}),false);
  await page.keyboard.type('Why switching?');await menu();const count=report.aiRequests;await clickNode(button('阅读记录'));await until(()=>node(cls('fr-reading-records')),'records missing');await clickNode(button('‹ 返回当前阅读'));
  assert.equal(await ui(function(){return this.querySelector('.fr-reading-followup input').value}),'Why switching?');assert.equal(report.aiRequests,count);record('history round trip preserves answer and unsent follow-up without a new request');
  nextAnswer='Switching describes the type of sequence. Here it modifies sequences.';
  await clickNode(n=>n.nodeName==='INPUT'&&support.cdpAttribute(n,'aria-label')==='继续追问');await page.keyboard.press('Enter');await settled();assert.equal(report.aiRequests,count+1);
  await assertSourceSkipped();await revealSource();
  record('follow-up sends once and upward scrolling reveals the full source');
  nextAnswer=grammar;await menu();await clickNode(button('重新生成'));await settled();assert.equal(report.aiRequests,count+2);await assertSourceSkipped();record('regenerate is available on demand and restores compact annotations');
  await clickNode(button('翻译'));await clickNode(button('词性与句法'));await settled();assert.equal(report.aiRequests,count+2);record('returning from translation reuses the current explanation');
  await page.setViewportSize({width:390,height:800});await wait(200);report.narrow=await layout();assert.equal(report.narrow.overflow,false);assert(report.narrow.detailVisible);assert(report.narrow.labels.every(item=>item.visible&&!item.clipped));await shot('grammar-390');
  await patch({theme:'dark'});await shot('grammar-dark');await patch({uiLanguage:'en-US'});await wait(150);
  await clickNode(n=>n.nodeName==='SUMMARY'&&support.cdpAttribute(n,'aria-label')==='More actions');await clickNode(button('Regenerate'));await settled();
  assert(await ui(function(){return [...this.querySelectorAll('.fr-study-toolbar button')].every(button=>button.scrollWidth<=button.clientWidth+1)}),'English action labels are clipped');
  assert.equal(await ui(function(){return this.querySelector('.fr-study-toolbar button[aria-pressed=true]').textContent}),'Parts of speech & syntax');
  assert((await ui(function(){return this.querySelector('.fr-sentence-detail').textContent})).includes('adjective'));await shot('grammar-english-dark');record('390px, dark theme and English remain compact and localized');
  await patch({theme:'light',uiLanguage:'zh-CN'});await page.setViewportSize({width:1440,height:960});
  await menu();await clickNode(button('理解整句'));await settled();assert.equal(await ui(function(){return [...this.querySelector('.fr-sentence-tokens').children].map(element=>element.matches('button') ? element.querySelector('.fr-sentence-token-text').textContent : element.textContent).join('').trim()}),sentence+'.');record('sentence expansion remains available without a permanent toolbar row');
  await menu();await clickNode(n=>n.nodeName==='BUTTON'&&support.cdpAttribute(n,'aria-label')==='打开划词翻译设置');await until(async()=>context.pages().some(p=>p.url().includes('options.html')),'settings did not open');record('settings remain accessible through secondary actions');
  await helper.activateExtensionTabWithoutForeground(context,page);
  nextAnswer=grammar+'\n\n'+('Additional explanatory detail. '.repeat(90));await menu();await clickNode(button('重新生成'));await settled();
  const area=await ui(function(){const r=this.querySelector('.fr-reading-result').getBoundingClientRect();return{x:r.x+20,y:r.y+50}});await page.mouse.move(area.x,area.y);await page.mouse.wheel(0,600);await wait(200);
  assert((await ui(function(){return this.querySelector('.fr-reading-result').scrollTop}))>0);assert.equal(await page.evaluate(()=>scrollY),0);
  await page.mouse.wheel(0,5000);await wait(150);await page.mouse.wheel(0,500);await wait(150);assert.equal(await page.evaluate(()=>scrollY),0);record('long analysis scrolls internally and contains wheel movement at its boundary');
  assert.equal(report.consoleErrors.length,0);report.ok=true;
 }catch(error){report.error=error.stack;if(page&&!page.isClosed())await screenshot(page,'failure').catch(()=>{});throw error;}
 finally {
    report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (session) {
      try {await session.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    try {await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});}
    catch (error) {report.cleanupErrors.push(`server close: ${error.message}`);}
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
