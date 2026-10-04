#!/usr/bin/env node
'use strict';

// 隔离后台 Edge 中用真实 Control 手势验证悬浮局部窗口、连续触发、原文恢复和重新翻译。
// 使用本地确定性 Microsoft transport；不连接日常 profile，不验证实时服务质量。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const arg = (name, fallback) => {const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-hover-window'));
const baseline = process.argv.includes('--baseline');
const profileCPU = process.argv.includes('--cpu-profile');
const gestureLifecycle = process.argv.includes('--gesture-lifecycle');
const gestureOnly = process.argv.includes('--gesture-only');
if(gestureOnly && !gestureLifecycle)throw new Error('--gesture-only requires --gesture-lifecycle');
const nestedViewport = process.argv.includes('--nested-viewport');
const nestedOnly = process.argv.includes('--nested-only');
if(nestedOnly && !nestedViewport)throw new Error('--nested-only requires --nested-viewport');
const nestedCycles = Number(arg('nested-cycles','5'));
assert.ok(Number.isInteger(nestedCycles) && nestedCycles>0 && nestedCycles<=20,'Nested cycles must be an integer from 1 to 20');
const cpuSessions = new WeakMap();
const {chromium} = require(path.join(arg('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs')));
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-hover-window-'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cases = [
  {id:'giant-tail', value:'Earlier sentence supplies ordinary readable context. '.repeat(2400) + 'Tailmarker keeps the hovered reading position and nearby context. '.repeat(120), marker:'Tailmarker'},
  {id:'empty-nodes', value:'Readable sentence keeps the nearby reading context. '.repeat(120), offset:2000, emptyNodes:20000},
  {id:'long-token', value:'a'.repeat(2500) + ' Nearby context preserves the hovered word and source. '.repeat(120), offset:500},
];
const html = '<!doctype html><meta charset="utf-8"><title>Hover range fixture</title><style>body{font:16px/1.7 system-ui;margin:40px}#target{max-width:740px;overflow-wrap:anywhere}#probe{position:fixed;right:20px;top:20px;z-index:100000}</style><button id="probe" translate="no">Host click</button><main><div id="target"></div></main><script>window.probeClicks=0;document.querySelector("#probe").onclick=()=>window.probeClicks++;</script>';
const server = http.createServer((_request, response) => {response.writeHead(200, {'content-type':'text/html;charset=utf-8'}); response.end(html);});
const report = {baseline, profileCPU, gestureLifecycle, nestedViewport, evidence:'Production extension; local deterministic transport, temporary background-visible Edge',
  buildSha256:sha256(path.join(extensionDir,'content-scripts/content.js')),
  cachePolicy:'Microsoft hover disables persistent cache; continuous hover reuses its active request',
  cases:[], consoleErrors:[]};
fs.mkdirSync(artifactsDir,{recursive:true});

async function startPhase(page) {
  if(profileCPU) {
    const session=await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval',{interval:1000});
    await session.send('Profiler.start');
    cpuSessions.set(page,session);
  }
  await page.evaluate(() => {
    window.__hoverTasks=[]; window.__hoverTicks=[];
    window.__hoverObserver=new PerformanceObserver(list=>window.__hoverTasks.push(...list.getEntries().map(entry=>entry.duration)));
    window.__hoverObserver.observe({type:'longtask',buffered:false});
    let previous=performance.now();
    window.__hoverTimer=setInterval(()=>{const now=performance.now();window.__hoverTicks.push(now-previous);previous=now;},20);
  });
}

async function finishPhase(page, name) {
  const result=await page.evaluate(name=>{
    window.__hoverObserver.disconnect(); clearInterval(window.__hoverTimer);
    return {name, longTasksMs:window.__hoverTasks, maxHeartbeatGapMs:Math.max(0,...window.__hoverTicks)};
  },name);
  const session=cpuSessions.get(page);
  if(session) {
    const {profile}=await session.send('Profiler.stop');
    const fixtureId=new URL(page.url()).pathname.slice(1);
    fs.writeFileSync(path.join(artifactsDir,fixtureId+'-'+name+'.cpuprofile'),JSON.stringify(profile));
    await session.detach();cpuSessions.delete(page);
    result.cpuProfileSaved=true;
  }
  return result;
}

async function sourcePoint(page, offset) {
  return page.evaluate(offset=>{
    const owner=document.getElementById('target');
    const walker=document.createTreeWalker(owner,4);
    let node, remaining=offset;
    while ((node=walker.nextNode())) {
      if(node.parentElement.closest('[data-fr-translation-owned="true"]'))continue;
      if(remaining>=node.length){remaining-=node.length;continue;}
      const range=document.createRange();range.setStart(node,remaining);range.setEnd(node,remaining+1);
      let rect=range.getBoundingClientRect();window.scrollBy(0,rect.top-innerHeight*0.45);
      rect=range.getBoundingClientRect();return {x:rect.left+Math.min(3,rect.width/2),y:rect.top+Math.min(8,rect.height/2),top:rect.top};
    }
    throw new Error('Source offset unavailable');
  },offset);
}

async function gesture(page, offset) {
  const point=await sourcePoint(page,offset);
  await page.mouse.move(0,0); await page.mouse.move(point.x,point.y,{steps:4});
  await page.waitForTimeout(50);
  await page.keyboard.down('Control'); await page.keyboard.up('Control');
}

async function originalSource(page) {
  return page.evaluate(()=>{
    const clone=document.getElementById('target').cloneNode(true);
    clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node=>node.remove());
    return clone.textContent;
  });
}

async function patchFixtureConfig(setup, patch, sequence) {
  await setup.evaluate(async({patch,sequence})=>{
    const current=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
    const saved=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:patch,
      expected:Object.fromEntries(Object.keys(patch).map(key=>[key,current.value[key]])),
      clientId:'hover-window-fixture',sequence,baseRevision:current.value.__fluentConfigRevision||0});
    if(!saved?.success)throw new Error('Fixture configuration failed');
  },{patch,sequence});
}

async function runNestedViewport(context, setup, provider, port) {
  await patchFixtureConfig(setup,{hotkey:'Control',floatingBallHotkey:'Alt+T',fullPageTranslationMode:'all',
    mouseHoverTranslationDelay:0,useCache:true,quickTranslationProfiles:[]},6);
  const page=await newPageWithoutForeground(context);
  page.on('pageerror',error=>report.consoleErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/nested-viewport`,{waitUntil:'domcontentloaded'});
  await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
  const value='This paragraph above the reading position gains a bilingual translation while its scroll container keeps the reader steady. '.repeat(8);
  await page.evaluate(value=>{
    const target=document.getElementById('target');
    target.innerHTML='<div id="scroller" style="height:650px;overflow-y:auto;overflow-anchor:none;border:3px solid #555">'+
      '<p id="above"></p><div id="reading-gap" translate="no" style="height:500px"></div>'+
      '<p id="reading" translate="no" style="height:100px;margin:0">Stable reading anchor</p>'+
      '<p id="visible">This visible paragraph translates without compensating content below the reading anchor.</p>'+
      '<div translate="no" style="height:700px"></div></div>';
    document.getElementById('above').textContent=value;
    const scroller=document.getElementById('scroller'),reading=document.getElementById('reading');
    scroller.scrollTop=reading.getBoundingClientRect().top-420;
    window.scrollTo(0,0);
  },value);
  await activateExtensionTabWithoutForeground(context,page);await page.waitForTimeout(500);
  const result={cycles:nestedCycles,phases:[]};report.nestedViewportChecks=result;
  const requestStart=provider.requestCount();
  const before=await page.evaluate(()=>({top:document.getElementById('reading').getBoundingClientRect().top,
    scrollTop:document.getElementById('scroller').scrollTop,windowY:scrollY,
    aboveBottom:document.getElementById('above').getBoundingClientRect().bottom,
    viewportTop:document.getElementById('scroller').getBoundingClientRect().top+document.getElementById('scroller').clientTop}));
  result.initialScrollTop=before.scrollTop;
  assert.ok(before.scrollTop>0 && before.aboveBottom<before.viewportTop,'Fixture change must be entirely above the nested viewport');
  const phases=Array.from({length:nestedCycles},(_unused,index)=>
    index===0?['translate','restore']:['retranslate-'+index,'restore-'+index]).flat();
  for(const name of phases) {
    const translate=name==='translate'||name.startsWith('retranslate-');
    const readBefore=await page.evaluate(()=>{
      const scroller=document.getElementById('scroller'),top=scroller.getBoundingClientRect().top+scroller.clientTop;
      return {scrollTop:scroller.scrollTop,readingRelativeTop:document.getElementById('reading').getBoundingClientRect().top-top,
        gapRelativeTop:document.getElementById('reading-gap').getBoundingClientRect().top-top,
        sourceHeight:document.getElementById('above').getBoundingClientRect().height};
    });
    await page.evaluate(top=>{
      window.__readingSamples=[];window.__readingActive=true;window.__readingReference=top;
      const sample=()=>{if(!window.__readingActive)return;
        window.__readingSamples.push({shift:document.getElementById('reading').getBoundingClientRect().top-top,windowY:scrollY});
        window.__readingFrame=requestAnimationFrame(sample);};window.__readingFrame=requestAnimationFrame(sample);
    },before.top);
    await startPhase(page);await page.keyboard.press('Alt+t');
    await page.waitForFunction(translate=>{
      const count=document.querySelectorAll('#target .fluent-read-bilingual-content').length;
      return translate?count===2:count===0;
    },translate,{timeout:15000});
    await page.waitForTimeout(500);
    const reading=await page.evaluate(()=>{
      window.__readingActive=false;cancelAnimationFrame(window.__readingFrame);
      return {maxReadingShiftPx:Math.max(0,...window.__readingSamples.map(s=>Math.abs(s.shift))),
        maxDocumentScrollPx:Math.max(0,...window.__readingSamples.map(s=>Math.abs(s.windowY))),
        samples:window.__readingSamples.length,scrollTop:document.getElementById('scroller').scrollTop,
        readingRelativeTop:document.getElementById('reading').getBoundingClientRect().top-
          document.getElementById('scroller').getBoundingClientRect().top-document.getElementById('scroller').clientTop,
        gapRelativeTop:document.getElementById('reading-gap').getBoundingClientRect().top-
          document.getElementById('scroller').getBoundingClientRect().top-document.getElementById('scroller').clientTop,
        sourceHeight:document.getElementById('above').getBoundingClientRect().height};
    });
    const phase={...(await finishPhase(page,name)),readBefore,...reading};
    result.phases.push(phase);
    await page.screenshot({path:path.join(artifactsDir,'nested-viewport-'+name+'.png')});
    assert.ok(reading.samples>0,'Reading-position sampling ran');
    assert.ok(reading.maxReadingShiftPx<=0.5,`Nested reading anchor moved during ${name}`);
    assert.equal(reading.maxDocumentScrollPx,0,'Nested compensation must not scroll the document');
    assert.equal(await page.locator('#target .fluent-read-bilingual-content .fluent-read-bilingual-content').count(),0);
    const original=await page.evaluate(()=>{
      const node=document.getElementById('above'),walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
      let source='',text;while((text=walker.nextNode()))if(!text.parentElement.closest('.fluent-read-bilingual-content,[data-fr-translation-owned="true"]'))source+=text.data;
      return source;
    });
    assert.equal(original,value,'Above-viewport source remains exact');
    if(translate)assert.ok(Math.abs(reading.scrollTop-before.scrollTop)>1,'Nested scroll offset actually compensates added translation height');
    else assert.ok(Math.abs(reading.scrollTop-before.scrollTop)<=0.5,'Restore returns the original nested offset');
    if(name==='translate')result.initialRequests=provider.requestCount()-requestStart;
  }
  result.requests=provider.requestCount()-requestStart;
  assert.equal(result.requests,result.initialRequests,'Full-page retranslation reuses settled results');
  result.originalPreserved=true;result.readingPositionPreserved=true;result.restoreAndRetranslate=true;
  await page.close();
}

(async()=>{
  let launched,provider;
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    provider=await startTranslationFixtureServer([],5);
    launched=await launchFocusSafePersistentContext({chromium,profileDir,
      browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      headless:false,background:true,viewport:{width:1280,height:900},
      browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
    const {context}=launched;
    report.launchMode=launched.launchMode;report.focusPolicy=launched.focusPolicy;
    report.windowPlacement=Object.fromEntries(['mode','visible','hidden','windowState','displayTarget','browserFrontmost'].map(key=>[key,launched.windowPlacement?.[key]]));
    const worker=context.serviceWorkers().find(worker=>worker.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
    await installTranslationFixtureOnWorker(worker,{translationUrl:provider.translationUrl,blockedUrl:provider.blockedUrl});
    const setup=await newPageWithoutForeground(context);
    await setup.goto(`chrome-extension://${new URL(worker.url()).host}/icon/128.png`);
    await patchFixtureConfig(setup,{on:true,hotkey:'Control',customHotkey:'',mouseHoverTranslationDelay:0,
      service:'microsoft',from:'auto',to:'zh-Hans',display:1,translationScope:'content',longParagraphLineBreak:false,
      uiLanguageSetupCompleted:true,uiLanguage:'zh-CN'},1);
    for(const fixture of gestureOnly || nestedOnly ? [] : cases) {
      const page=await newPageWithoutForeground(context);
      page.on('pageerror',error=>report.consoleErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/${fixture.id}`,{waitUntil:'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
      await page.evaluate(fixture=>{
        const owner=document.getElementById('target');owner.textContent=fixture.value;
        for(let index=0;index<(fixture.emptyNodes||0);index++)owner.append(document.createTextNode(''));
      },fixture);
      await activateExtensionTabWithoutForeground(context,page); await page.waitForTimeout(500);
      const offset=fixture.offset ?? fixture.value.indexOf(fixture.marker)+8;
      const requestsBefore=provider.requestCount();
      const result={id:fixture.id,originalCharacters:fixture.value.length,emptyNodes:fixture.emptyNodes||0,phases:[]};
      report.cases.push(result);
      await sourcePoint(page,offset); await page.waitForTimeout(150);
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'),undefined,{timeout:15000});
      await page.waitForTimeout(300); await page.locator('#probe').click();
      result.phases.push(await finishPhase(page,'translate'));
      const sourceChunk=await page.evaluate(({offset,marker})=>{
        const chunk=document.querySelector('#target [data-fr-translation-manual="true"]');
        const owner=document.getElementById('target');
        const clone=(chunk||owner).cloneNode(true);
        clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node=>node.remove());
        const walker=document.createTreeWalker(owner,4);
        let node,remaining=offset,hitInSourceChunk=false;
        while((node=walker.nextNode())){
          if(node.parentElement.closest('[data-fr-translation-owned="true"]'))continue;
          if(remaining>=node.length){remaining-=node.length;continue;}
          hitInSourceChunk=!chunk||chunk.contains(node);break;
        }
        return {characters:clone.textContent.length,hitInSourceChunk,markerPreserved:!marker||clone.textContent.includes(marker)};
      },{offset,marker:fixture.marker});
      result.sourceChunkCharacters=sourceChunk.characters;
      result.hitInSourceChunk=sourceChunk.hitInSourceChunk;
      result.markerPreserved=sourceChunk.markerPreserved;
      assert.ok(result.hitInSourceChunk && result.markerPreserved,fixture.id+': hovered source preserved');
      if(!baseline)assert.ok(result.sourceChunkCharacters>0 && result.sourceChunkCharacters<=1600,fixture.id+': bounded source');
      assert.equal(await originalSource(page),fixture.value,fixture.id+': original text');
      const translatedRequests=provider.requestCount();
      assert.equal(translatedRequests,requestsBefore+1,fixture.id+': one initial upstream request');
      const point=await sourcePoint(page,offset);
      await startPhase(page); await page.keyboard.down('Control');
      try {for(let index=0;index<12;index++){await page.mouse.move(point.x+(index%2),point.y);await page.waitForTimeout(30);}}
      finally {await page.keyboard.up('Control');}
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'continuous-hover'));
      assert.equal(provider.requestCount(),translatedRequests,fixture.id+': no repeated upstream work');
      assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(),1);
      assert.equal(await page.locator('#target .fluent-read-bilingual-content .fluent-read-bilingual-content').count(),0);
      await page.screenshot({path:path.join(artifactsDir,fixture.id+'.png')});
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'restore'));
      assert.equal(await originalSource(page),fixture.value,fixture.id+': restored text');
      await startPhase(page); await gesture(page,offset);
      await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150); result.phases.push(await finishPhase(page,'retranslate'));
      assert.equal(provider.requestCount(),translatedRequests+1,fixture.id+': one request after explicit restore');
      assert.deepEqual(provider.requestPayloads()[translatedRequests],provider.requestPayloads()[requestsBefore],
        fixture.id+': same source after restore');
      await gesture(page,offset); await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await page.waitForTimeout(150);
      assert.equal(await originalSource(page),fixture.value);
      result.requests=provider.requestCount()-requestsBefore;result.hostClicks=await page.evaluate(()=>window.probeClicks);
      result.originalPreserved=true; result.restoreAndRetranslate=true; result.continuousHoverNoRepeatedRequests=true;
      await page.close();
    }
    if(gestureLifecycle) {
      await patchFixtureConfig(setup,{hotkey:'LongPress',quickTranslationProfiles:[{
        id:'hover-arbitration',enabled:true,action:'hover',hotkey:'Ctrl+Shift+Y',service:'microsoft',model:'',
        targetLanguage:'zh-Hans',displayMode:'bilingual',fullPageMode:'inherit',
      }]},2);
      const page=await newPageWithoutForeground(context);
      page.on('pageerror',error=>report.consoleErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/long-press-arbitration`,{waitUntil:'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
      const value='This paragraph keeps a stable source while an exclusive quick shortcut cancels the pending long press.';
      await page.evaluate(value=>{document.getElementById('target').textContent=value;},value);
      await activateExtensionTabWithoutForeground(context,page);await page.waitForTimeout(500);
      const result={phases:[]};report.gestureChecks=result;
      const before=provider.requestCount();
      const point=await sourcePoint(page,25);
      await page.mouse.move(point.x,point.y);await startPhase(page);
      const started=Date.now();
      await page.mouse.down();
      try {
        await page.keyboard.press('Control+Shift+Y');
        result.arbitrationDispatchMs=Date.now()-started;
        assert.ok(result.arbitrationDispatchMs<450,'Gesture arbitration reached the long-press deadline');
        await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'),undefined,{timeout:15000});
        await page.waitForTimeout(750);
      } finally {await page.mouse.up();}
      result.phases.push(await finishPhase(page,'long-press-arbitration'));
      result.wrappersAfterLongPressDeadline=await page.locator('#target .fluent-read-bilingual-content').count();
      result.arbitrationRequests=provider.requestCount()-before;
      await page.screenshot({path:path.join(artifactsDir,'long-press-arbitration.png')});
      assert.equal(result.wrappersAfterLongPressDeadline,1,'Pending long press must not toggle away the quick translation');
      assert.equal(result.arbitrationRequests,1,'Quick shortcut owns the only request');
      assert.equal(await originalSource(page),value);
      await page.keyboard.press('Control+Shift+Y');
      await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      await patchFixtureConfig(setup,{hotkey:'Control',mouseHoverTranslationDelay:250,quickTranslationProfiles:[]},3);
      await page.waitForTimeout(100);
      const pendingBefore=provider.requestCount();
      const hoverPoint=await sourcePoint(page,25);
      await page.mouse.move(hoverPoint.x,hoverPoint.y);
      await startPhase(page);await page.keyboard.down('Control');
      const queued=Date.now();
      await page.mouse.move(hoverPoint.x+1,hoverPoint.y);
      await patchFixtureConfig(setup,{on:false},4);
      result.disableDispatchMs=Date.now()-queued;
      assert.ok(result.disableDispatchMs<250,'Disable happened after the hover delay');
      await page.waitForTimeout(400);await page.keyboard.up('Control');
      result.phases.push(await finishPhase(page,'delayed-hover-abort'));
      result.requestsWhileDisabled=provider.requestCount()-pendingBefore;
      assert.equal(result.requestsWhileDisabled,0,'Aborted gesture must not start upstream work');
      assert.equal(await page.locator('#target .fluent-read-bilingual-content').count(),0);
      assert.equal(await originalSource(page),value);
      await patchFixtureConfig(setup,{on:true,mouseHoverTranslationDelay:0},5);
      await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});await page.waitForTimeout(250);
      await gesture(page,25);
      await page.waitForFunction(()=>document.querySelector('#target .fluent-read-bilingual-content'));
      await gesture(page,25);
      await page.waitForFunction(()=>!document.querySelector('#target .fluent-read-bilingual-content'));
      assert.equal(await originalSource(page),value);
      result.reenabledGestureWorks=true;result.originalPreserved=true;
      await page.close();
    }
    if(nestedViewport)await runNestedViewport(context,setup,provider,server.address().port);
    await setup.close();
    assert.deepEqual(report.consoleErrors,[]);report.ok=true;
    assert.equal(report.buildSha256,sha256(path.join(extensionDir,'content-scripts/content.js')),'Build changed during browser evidence');
    console.log(JSON.stringify(report,null,2));
  } catch(error) {report.ok=false;report.failure=error.stack;console.error(error);process.exitCode=1;}
  finally {
    report.requestPayloads=provider?.requestPayloads().map(payload=>payload.map(value=>({
      characters:value.length,sha256:crypto.createHash('sha256').update(value).digest('hex'),
    })));
    fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));
    await launched?.close();await provider?.close();server.close();fs.rmSync(profileDir,{recursive:true,force:true});
  }
})();
