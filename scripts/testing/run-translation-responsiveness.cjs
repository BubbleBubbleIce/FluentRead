#!/usr/bin/env node
'use strict';

// 生产扩展的主线程响应性基准：隔离 profile、本地确定性译文、真实按键、宿主点击、整批重挂与恢复。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-responsiveness'));
const paragraphs = Number(arg('paragraphs', '500'));
const github = process.argv.includes('--github');
const compare = process.argv.includes('--compare');
const remount = process.argv.includes('--remount');
const remountMiddle = process.argv.includes('--remount-middle');
const remountRoot = process.argv.includes('--remount-root');
const translationBefore = process.argv.includes('--translation-before');
const repeated = process.argv.includes('--repeated-source');
const allowChineseBaseline = process.argv.includes('--allow-chinese-baseline');
const cpuRate = Number(arg('cpu-rate', '1'));
const {chromium} = require(path.join(arg('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs')));
assert.ok(Number.isInteger(paragraphs) && paragraphs>0, '--paragraphs must be a positive integer');
assert.ok(Number.isFinite(cpuRate) && cpuRate>=1, '--cpu-rate must be at least 1');
assert.ok(!remountMiddle || remount, '--remount-middle requires --remount');
assert.ok(!remountRoot || remount, '--remount-root requires --remount');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-responsiveness-'));
fs.mkdirSync(artifactsDir, {recursive: true});
const chinese = 'FluentRead 支持在原网页中对照阅读原文与译文，并提供划词翻译、AI 阅读辅助、图片翻译、文档翻译和视频双语字幕。翻译卡片接入了 <strong>DeepSeek Harness 会话内核的浏览器适配</strong>，支持结合上下文解释选中文字并连续追问。';
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Responsiveness fixture</title><style>body{font:16px/1.7 system-ui;margin:40px}main{max-width:900px}#probe{position:fixed;right:24px;top:24px;z-index:100000}p{margin:20px 0}</style><button id="probe" translate="no">Host click</button><main><p id="chinese">' + chinese + '</p>' + Array.from({length: paragraphs}, (_, i) => `<section><p id="p${i}">The browser should remain responsive while this paragraph number ${repeated ? 0 : i} is translated. Readers can click the controls and scroll through the document without waiting for every translation to finish.</p></section>`).join('') + '</main><script>window.probeClicks=0;document.querySelector("#probe").onclick=()=>window.probeClicks++;</script></html>';
const server = http.createServer((_req, res) => {res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});res.end(html);});
const report = {extensionDir, paragraphs, remount, remountMiddle, remountRoot, translationBefore, repeated, evidence: 'Production extension and real browser; local deterministic Microsoft transport, no live provider claims', consoleErrors: [], phases: []};

async function startPhase(page, name) {
  await page.evaluate(name => {
    window.__phase = {name, started: performance.now(), longTasks: [], ticks: [], clicks: window.probeClicks || 0};
    window.__observer?.disconnect(); clearInterval(window.__timer);
    window.__observer = new PerformanceObserver(list => window.__phase.longTasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration}))));
    window.__observer.observe({type: 'longtask'});
    let last = performance.now();
    window.__timer = setInterval(() => {const now = performance.now();window.__phase.ticks.push(now - last);last = now;}, 20);
  }, name);
}
async function finishPhase(page) {
  const phase = await page.evaluate(() => {
    clearInterval(window.__timer); window.__observer.disconnect();
    const p = window.__phase;
    const ticks = [...p.ticks].sort((a,b) => a-b);
    return {name:p.name, elapsedMs:performance.now()-p.started, longTasks:p.longTasks,
      maxHeartbeatGapMs:Math.max(0,...ticks), p95HeartbeatGapMs:ticks[Math.floor(ticks.length*.95)] || 0,
      totalBlockingMs:p.longTasks.reduce((sum,t)=>sum+Math.max(0,t.duration-50),0),
      wrappers:document.querySelectorAll('.fluent-read-bilingual-content').length,
      chineseWrappers:document.querySelectorAll('#chinese .fluent-read-bilingual-content').length,
      hostClicks:(window.probeClicks||0)-p.clicks};
  });
  report.phases.push(phase); fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));
  return phase;
}

async function translateUntilComplete(page, provider, name) {
  await startPhase(page, name);
  await page.keyboard.press('Alt+t');
  const deadline=Date.now()+120000;
  do {
    await page.locator('#probe').click({timeout:15000});
    await page.waitForTimeout(120);
    if(await page.locator('p[id^="p"] > .fluent-read-bilingual-content').count()===paragraphs) break;
    if(Date.now()>deadline) {await finishPhase(page);await page.screenshot({path:path.join(artifactsDir,'failure.png')});throw new Error(`Translation did not complete: ${provider.translatedItemCount()} items`);}
  } while(true);
  await page.waitForTimeout(300);
  await finishPhase(page);
}

async function remountTranslatedParagraphs(page, provider, cdp) {
  const initialItems = provider.translatedItemCount();
  await page.evaluate(({middle, count}) => {
    window.__remountAnchorId = `p${middle ? Math.floor(count / 2) : 0}`;
    if (middle) document.getElementById(window.__remountAnchorId).scrollIntoView({block: 'center'});
  }, {middle: remountMiddle, count: paragraphs});
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.__remountOutputs = [...document.querySelectorAll('p[id^="p"]')].map(owner => ({
      id: owner.id, html: owner.querySelector('.fluent-read-bilingual-content').outerHTML,
      beforeSource: owner.querySelector('.fluent-read-bilingual-content') === owner.firstChild,
    }));
  });
  report.remountChecks = [];
  for (let round = 0; round < 3; round++) {
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    await startPhase(page, `remount-${round + 1}`);
    const check = await page.evaluate(replaceRoot => new Promise(resolve => {
      const anchorBefore = document.getElementById(window.__remountAnchorId).getBoundingClientRect().top;
      const scrollBefore = window.scrollY;
      const started = performance.now();
      const main = document.querySelector('main');
      if (replaceRoot) main.outerHTML = '<main>' + window.__remountSourceHTML + '</main>';
      else main.innerHTML = window.__remountSourceHTML;
      const hostWriteMs = performance.now() - started;
      requestAnimationFrame(() => resolve({hostWriteMs,
        anchorShiftPx: document.getElementById(window.__remountAnchorId).getBoundingClientRect().top - anchorBefore,
        scrollShiftPx: window.scrollY - scrollBefore,
        firstFrameMs: performance.now() - started,
        wrappers: document.querySelectorAll('p[id^="p"] > .fluent-read-bilingual-content').length,
        nested: document.querySelectorAll('.fluent-read-bilingual-content .fluent-read-bilingual-content').length,
        exactOutputs: window.__remountOutputs.every(({id, html}) =>
          document.getElementById(id)?.querySelector('.fluent-read-bilingual-content')?.outerHTML === html),
        exactPositions: window.__remountOutputs.every(({id, beforeSource}) => {
          const owner = document.getElementById(id);
          return (owner.querySelector('.fluent-read-bilingual-content') === owner.firstChild) === beforeSource;
        }),
      }));
    }), remountRoot);
    assert.equal(check.wrappers, paragraphs, '下一帧前必须接管全部已提交段落');
    assert.equal(check.nested, 0, '重挂不得嵌套双语译文');
    assert.equal(check.exactOutputs, true, '重挂必须保留已提交的精确译文');
    assert.equal(check.exactPositions, true, '重挂必须保留已提交译文的前后位置');
    assert.ok(Math.abs(check.anchorShiftPx) <= 1, '重挂前后正在阅读的段落位置必须稳定');
    assert.ok(Math.abs(check.scrollShiftPx) <= 1, '重挂前后页面滚动位置必须稳定');
    await page.locator('#probe').click();
    await page.waitForTimeout(200);
    const phase = await finishPhase(page);
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    check.metrics = Object.fromEntries(['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, after[key] - before[key]]));
    assert.equal(phase.hostClicks, 1);
    assert.equal(provider.translatedItemCount(), initialItems, '等价重挂不得重新发送原文');
    report.remountChecks.push(check);
  }
}

async function runCompare(context, setup, provider) {
  const url=arg('page-url','https://github.com/openai/codex/compare/rust-v0.160.0-alpha.3...main');
  report.cpuRate=cpuRate;
  report.compare={url,modes:[]};
  for(const enabled of [false,true]) {
    await setup.evaluate(async enabled=>{
      const current=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
      const result=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:{on:enabled},expected:{on:current.value.on},clientId:'responsiveness-fixture',sequence:enabled?3:2,baseRevision:current.value.__fluentConfigRevision||0});
      if(!result?.success) throw new Error('Failed to set extension activation');
    },enabled);
    const page=await newPageWithoutForeground(context);
    page.on('pageerror',e=>report.consoleErrors.push(e.message));
    const cdp=await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('Profiler.enable');
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
    await cdp.send('Profiler.start');
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    if(enabled) await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
    await activateExtensionTabWithoutForeground(context,page);
    await page.waitForTimeout(8000);
    const startup=await cdp.send('Profiler.stop');
    fs.writeFileSync(path.join(artifactsDir,`compare-${enabled?'on':'off'}-startup.cpuprofile`),JSON.stringify(startup.profile));
    const state=await page.evaluate(()=>({title:document.title,nodes:document.querySelectorAll('*').length,textLength:document.body.textContent.length,bodyPreview:document.body.innerText.slice(0,2500),buttons:[...document.querySelectorAll('button')].slice(0,35).map(b=>({text:b.innerText,aria:b.getAttribute('aria-label')})),href:location.href}));
    console.log('Compare loaded',enabled,state.title,state.nodes,state.textLength);
    report.compare.modes.push({enabled,...state});
    await page.evaluate(()=>{
      const probe=document.createElement('button');probe.id='probe';probe.translate=false;probe.textContent='Host click';
      probe.style.cssText='position:fixed;right:20px;top:20px;z-index:2147483647';
      window.probeClicks=0;probe.onclick=()=>window.probeClicks++;document.body.append(probe);
    });
    const probeRect=await page.locator('#probe').boundingBox();
    assert.ok(probeRect);
    await page.evaluate(()=>{window.__protectedCode=[...document.querySelectorAll('.blob-code')].map(node=>({node,text:node.textContent}));});
    const phases=enabled?['idle-enabled','translate','scroll-translated','restore']:['idle-disabled'];
    if(enabled&&process.argv.includes('--repeat')) phases.push('retranslate','restore-repeat');
    for(const phase of phases) {
      const before=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
      await cdp.send('Profiler.start'); await startPhase(page,phase);
      if(['translate','retranslate','restore','restore-repeat'].includes(phase)) await page.keyboard.press('Alt+t');
      const until=Date.now()+(['translate','retranslate'].includes(phase)?Number(arg('measure-ms','15000')):3000);
      const clickMs=[];
      while(Date.now()<until) {
        if(phase==='scroll-translated') await page.mouse.wheel(0,400);
        // 固定坐标的原生输入不反复运行 Playwright 的全页 selector/actionability 检查。
        const began=Date.now();await page.mouse.click(probeRect.x+probeRect.width/2,probeRect.y+probeRect.height/2);clickMs.push(Date.now()-began);
        await page.waitForTimeout(100);
      }
      const result=await finishPhase(page);
      assert.equal(result.hostClicks,clickMs.length,`${phase}: every host click must be handled`);
      if(['translate','retranslate'].includes(phase)) assert.ok(result.wrappers>0,`${phase}: no translation appeared`);
      if(phase.startsWith('restore')) assert.equal(result.wrappers,0,`${phase}: stale translations remain`);
      const after=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
      const profile=await cdp.send('Profiler.stop');
      fs.writeFileSync(path.join(artifactsDir,`compare-${phase}.cpuprofile`),JSON.stringify(profile.profile));
      const protectedCode=await page.evaluate(()=>{
        const current=window.__protectedCode.filter(({node})=>node.isConnected);
        return {checked:current.length,changed:current.filter(({node,text})=>node.textContent!==text).length};
      });
      result.protectedCode=protectedCode;
      if(process.argv.includes('--check-code')) {
        assert.ok(protectedCode.checked>100,'Expected an actual code diff');
        assert.equal(protectedCode.changed,0,'Code lines must stay unchanged');
      }
      Object.assign(result,{metrics:Object.fromEntries(['ScriptDuration','LayoutDuration','RecalcStyleDuration','TaskDuration','LayoutCount','RecalcStyleCount'].map(k=>[k,after[k]-before[k]])),clickMaxMs:Math.max(...clickMs),items:provider.translatedItemCount()});
      fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));
      console.log('Compare phase',phase,JSON.stringify({wrappers:result.wrappers,blockingMs:result.totalBlockingMs,heartbeatMaxMs:result.maxHeartbeatGapMs,clickMaxMs:result.clickMaxMs,items:result.items}));
    }
    if(!enabled&&process.argv.includes('--boundary-benchmark')) report.compare.boundaryBenchmark=await page.evaluate(()=>{
      const elements=[...document.querySelectorAll('*')];
      const className='immersive-translate-target-wrapper';
      const results={};
      const checks={
        descendantCollection:el=>{const matches=el.getElementsByClassName(className);for(let i=0;i<matches.length;i++)if(matches[i].parentElement===el)return true;return false;},
        directSelector:el=>Boolean(el.querySelector(':scope > .'+className)),
        hasSelector:el=>el.matches(':has(> .'+className+')'),
        liveRootThenDirect:el=>document.getElementsByClassName(className).length>0 && Boolean(el.querySelector(':scope > .'+className)),
      };
      for(const [name,check] of Object.entries(checks)) {
        const began=performance.now();let hits=0;for(const el of elements)if(check(el))hits++;
        results[name]={elapsedMs:performance.now()-began,hits,elements:elements.length};
      }
      const ancestors=[...document.querySelectorAll('main, main > *, main > * > *')];
      const probe=document.getElementById('probe');
      results.afterMutation={};
      for(const [name,check] of Object.entries(checks)) {
        const began=performance.now();let hits=0;
        for(let i=0;i<100;i++) {
          probe.classList.toggle('benchmark-change');
          for(const el of ancestors)if(check(el))hits++;
        }
        results.afterMutation[name]={elapsedMs:performance.now()-began,hits,elements:ancestors.length};
      }
      return results;
    });
    await page.screenshot({path:path.join(artifactsDir,`compare-${enabled?'on':'off'}.png`)});
    fs.writeFileSync(path.join(artifactsDir,`compare-${enabled?'on':'off'}.html`),await page.content());
    await page.close();
  }
  assert.deepEqual(report.consoleErrors, [], 'Compare page must not produce script errors');
  report.ok=true;
}

async function runGithub(context, provider) {
  report.sites = [];
  for (const [name, url] of [
    ['readme', 'https://github.com/FluentRead/FluentRead/blob/main/misc/README_ZH.md'],
    ['issues', 'https://github.com/FluentRead/FluentRead/issues'],
  ]) {
    const page = await newPageWithoutForeground(context);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto(url, {waitUntil:'domcontentloaded', timeout:60000});
    await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
    await activateExtensionTabWithoutForeground(context, page);
    const source = name === 'readme' ? page.locator('p').filter({hasText:'FluentRead 支持在原网页中对照阅读原文与译文'}).first() : null;
    if (source) await source.waitFor();
    const original = source ? await source.innerHTML() : null;
    // 宿主侧独立探针：原生 button 监听器由网页拥有，用真实 CDP 点击验证主线程可交互。
    await page.evaluate(() => {
      const probe = document.createElement('button'); probe.id='fr-perf-probe'; probe.translate=false;
      probe.textContent='Host probe'; probe.style.cssText='position:fixed;right:20px;top:20px;z-index:2147483647';
      window.probeClicks=0; probe.onclick=()=>window.probeClicks++; document.body.append(probe);
    });
    await page.keyboard.press('Alt+t');
    const deadline = Date.now()+60000;
    let lastItems = -1, stable = 0;
    while (Date.now()<deadline) {
      await page.locator('#fr-perf-probe').click({timeout:10000});
      await page.waitForTimeout(500);
      const count=provider.translatedItemCount();
      stable=count===lastItems ? stable+1 : 0; lastItems=count;
      if(stable>=4 && await page.locator('.fluent-read-bilingual-content').count()>0) break;
    }
    const translated = await page.locator('.fluent-read-bilingual-content').count();
    assert.ok(translated>0, `${name}: no English content translated`);
    if(source) assert.equal(await source.innerHTML(), original, 'Chinese README paragraph must be untouched');
    const clicks=await page.evaluate(()=>window.probeClicks); assert.ok(clicks>0);
    await page.screenshot({path:path.join(artifactsDir, `${name}-translated.png`)});
    fs.writeFileSync(path.join(artifactsDir,`${name}-translated.html`),await page.content());
    await page.keyboard.press('Alt+t');
    await page.waitForFunction(()=>!document.querySelector('.fluent-read-bilingual-content'));
    if(source) assert.equal(await source.innerHTML(), original);
    await page.keyboard.press('Alt+t');
    await page.waitForFunction(()=>document.querySelector('.fluent-read-bilingual-content'));
    await page.waitForTimeout(1000);
    if(source) assert.equal(await source.innerHTML(), original);
    await page.keyboard.press('Alt+t');
    await page.waitForFunction(()=>!document.querySelector('.fluent-read-bilingual-content'));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.fluent-read-bilingual-content').count(),0,'late results after restore');
    report.sites.push({name,url,translated,hostClicks:clicks,sameLanguageUnchanged:source ? true : null,restoreRetranslate:true});
    await page.close();
  }
  report.submittedChinese=provider.requestPayloads().flat().filter(text=>String(text).includes('支持在原网页'));
  assert.deepEqual(report.submittedChinese,[]);
}

(async () => {
  let launched, provider;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    provider = await startTranslationFixtureServer([], 5);
    launched = await launchFocusSafePersistentContext({chromium,profileDir,
      browserPath:arg('browser-path','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),headless:false,background:true,viewport:{width:1280,height:900},
      browserArgs:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-first-run','--no-default-browser-check']});
    const {context}=launched;
    Object.assign(report,{launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:Object.fromEntries(['mode','visible','hidden','windowState','displayTarget','browserFrontmost'].map(key=>[key,launched.windowPlacement?.[key]]))});
    const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) || await context.waitForEvent('serviceworker');
    await installTranslationFixtureOnWorker(worker,{translationUrl:provider.translationUrl,blockedUrl:provider.blockedUrl});
    const origin=`chrome-extension://${new URL(worker.url()).host}`;
    const setup=await newPageWithoutForeground(context);
    await setup.goto(`${origin}/icon/128.png`);
    await setup.evaluate(async translationBefore => {
      const current=await chrome.runtime.sendMessage({type:'configStorageRead',key:'local:config'});
      const patch={service:'microsoft',to:'zh-Hans',from:'auto',display:1,translationBeforeOriginal:translationBefore,fullPageTranslationMode:'all',translationScope:'all',maxConcurrentTranslations:10,translationRequestsPerSecond:0,translationRequestsPerMinute:0,uiLanguageSetupCompleted:true,uiLanguage:'zh-CN'};
      const saved=await chrome.runtime.sendMessage({type:'persistConfig',mode:'patch',config:patch,expected:Object.fromEntries(Object.keys(patch).map(k=>[k,current.value[k]])),clientId:'responsiveness-fixture',sequence:1,baseRevision:current.value.__fluentConfigRevision||0});
      if(!saved?.success) throw new Error('Unable to prepare fixture config');
    }, translationBefore);
    if(compare) { await runCompare(context,setup,provider); await setup.close(); return; }
    await setup.close();
    if (github) {
      await runGithub(context, provider);
      assert.deepEqual(report.consoleErrors, []); report.ok=true;
      console.log(JSON.stringify(report.sites,null,2)); return;
    }
    const page=await newPageWithoutForeground(context);
    page.on('pageerror',e=>report.consoleErrors.push(e.message));
    const cdp=await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate}); report.cpuRate=cpuRate;
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'domcontentloaded'});
    await page.locator('#fluent-read-page-styles').waitFor({state:'attached'});
    await activateExtensionTabWithoutForeground(context,page);
    await page.waitForTimeout(500);
    if (remount) await page.evaluate(() => {window.__remountSourceHTML = document.querySelector('main').innerHTML;});
    console.log('Fixture ready; starting translation');
    const before=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
    await translateUntilComplete(page, provider, 'translate');
    console.log('Translation completed');
    const after=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    report.metrics=Object.fromEntries(['ScriptDuration','LayoutDuration','RecalcStyleDuration','TaskDuration','LayoutCount','RecalcStyleCount'].map(k=>[k,after[k]-before[k]]));
    const {profile}=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(artifactsDir,'translate.cpuprofile'),JSON.stringify(profile));
    if (remount) {
      await cdp.send('Profiler.start');
      await remountTranslatedParagraphs(page, provider, cdp);
      const profile = await cdp.send('Profiler.stop');
      fs.writeFileSync(path.join(artifactsDir, 'remount.cpuprofile'), JSON.stringify(profile.profile));
    }
    await startPhase(page,'scroll-translated');
    for(let i=0;i<12;i++){await page.mouse.wheel(0,600);await page.waitForTimeout(40);await page.locator('#probe').click();}
    await page.waitForTimeout(350);await finishPhase(page);
    await page.screenshot({path:path.join(artifactsDir,'translated.png')});
    await cdp.send('Profiler.start');
    await startPhase(page,'restore');await page.keyboard.press('Alt+t');
    await page.waitForFunction(()=>!document.querySelector('.fluent-read-bilingual-content'));
    await page.locator('#probe').click();await page.waitForTimeout(100);await finishPhase(page);
    const restoreProfile=await cdp.send('Profiler.stop');
    fs.writeFileSync(path.join(artifactsDir,'restore.cpuprofile'),JSON.stringify(restoreProfile.profile));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.fluent-read-bilingual-content').count(),0);
    assert.equal(await page.locator('p[id^=p]').count(),paragraphs);
    assert.equal(await page.locator('#chinese').innerHTML(),chinese);
    if(!allowChineseBaseline) {
      assert.equal(report.phases[0].chineseWrappers,0);
      assert.equal(report.phases[0].wrappers,paragraphs);
    }
    if(process.argv.includes('--repeat')) {
      await translateUntilComplete(page, provider, 'retranslate-cached');
      await page.keyboard.press('Alt+t');
      await page.waitForFunction(()=>!document.querySelector('.fluent-read-bilingual-content'));
      await page.waitForTimeout(300);
    }
    assert.equal(await page.locator('#chinese').innerHTML(),chinese);
    assert.equal(await page.locator('.fluent-read-bilingual-content').count(),0);
    report.requests=provider.requestCount();report.items=provider.translatedItemCount();
    report.submittedChinese=provider.requestPayloads().flat().filter(t=>String(t).includes('支持在原网页'));
    if(!allowChineseBaseline) assert.deepEqual(report.submittedChinese,[]);
    assert.equal(report.consoleErrors.length,0);report.ok=true;
    console.log(JSON.stringify({ok:report.ok,phases:report.phases.map(({longTasks,...p})=>({...p,longTaskCount:longTasks.length,maxLongTaskMs:Math.max(0,...longTasks.map(t=>t.duration))})),metrics:report.metrics,items:report.items},null,2));
  }catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1;}
  finally{fs.writeFileSync(path.join(artifactsDir,'report.json'),JSON.stringify(report,null,2));await launched?.close();await provider?.close();server.close();fs.rmSync(profileDir,{recursive:true,force:true});}
})();
