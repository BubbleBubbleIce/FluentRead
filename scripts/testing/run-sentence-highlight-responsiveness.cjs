#!/usr/bin/env node
'use strict';
// 生产扩展经真实全文快捷键翻译原文，宿主追加空文本或深层空分支，再测量真实指针高亮。
// 使用临时后台 Edge、本地确定性 transport；测量阶段不运行构建或测试。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {startTranslationFixtureServer, installTranslationFixtureOnWorker} = require('../run-full-page-translation-test.cjs');
const arg = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-sentence-responsiveness'));
const baseline = process.argv.includes('--baseline');
const verifyActions = process.argv.includes('--verify-actions');
const {chromium} = require(path.join(arg('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(arg('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs')));
const cases = [{id: 'sparse', emptyNodes: 50_000, sentences: 200}, {id: 'deep', depth: 2000, sentences: 3}];
const report = {baseline, verifyActions, passed: false, evidence: 'Production extension, native keyboard and pointer; host inserts empty Text nodes or a deeply nested empty branch after translation without moving original Text; local deterministic Microsoft fixture',
  buildSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(extensionDir, 'content-scripts/content.js'))).digest('hex'), cases: [], consoleErrors: []};
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-sentence-responsiveness-'));
fs.mkdirSync(artifactsDir, {recursive: true});
const server = http.createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
  response.end('<!doctype html><meta charset="utf-8"><title>Sentence highlighting</title><style>body{margin:40px;font:18px/1.8 system-ui}#owner{max-width:900px}#probe{position:fixed;right:20px;top:20px}</style><button id="probe" translate="no">Host click</button><main><p id="owner"></p></main><script>window.hostClicks=0;document.querySelector("#probe").onclick=()=>window.hostClicks++;</script>');
});
async function main() {
  let launched, provider;
  const unexpectedNetwork = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    provider = await startTranslationFixtureServer(unexpectedNetwork);
    launched = await launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', viewport: {width: 1440, height: 960},
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    const {context} = launched;
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy,
      windowPlacement: {mode: launched.windowPlacement.mode, browserFrontmost: launched.windowPlacement.browserFrontmost}});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await installTranslationFixtureOnWorker(worker, {translationUrl: provider.translationUrl, blockedUrl: provider.blockedUrl});
    const setup = await newPageWithoutForeground(context);
    await setup.goto(`chrome-extension://${new URL(worker.url()).host}/icon/128.png`);
    await setup.evaluate(async () => {
      const saved = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      const patch = {on: true, service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false,
        translationScope: 'all', fullPageTranslationMode: 'all', floatingBallHotkey: 'Alt+T', bilingualSentenceHighlightEnabled: true,
        uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN', longParagraphLineBreak: false};
      const result = await chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: patch,
        expected: Object.fromEntries(Object.keys(patch).map(key => [key, saved.value[key]])),
        clientId: 'sentence-responsiveness-fixture', sequence: 1, baseRevision: saved.value.__fluentConfigRevision || 0});
      if (!result?.success) throw new Error('Fixture configuration failed');
    });
    for (const fixture of cases) {
      const page = await newPageWithoutForeground(context);
      page.on('pageerror', error => report.consoleErrors.push({case: fixture.id, message: error.message}));
      await page.goto(`http://127.0.0.1:${server.address().port}/${fixture.id}`, {waitUntil: 'domcontentloaded'});
      await page.locator('#fluent-read-page-styles').waitFor({state: 'attached'});
      const source = Array.from({length: fixture.sentences}, (_, i) => `Sentence ${i} keeps useful reading context.`).join(' ');
      await page.evaluate(source => {
        const owner = document.querySelector('#owner'); owner.textContent = source;
        window.sourceNode = owner.firstChild;
      }, source);
      await activateExtensionTabWithoutForeground(context, page); await page.waitForTimeout(300);
      const before = provider.requestCount();
      await page.keyboard.press('Alt+t');
      await page.locator('#owner > .fluent-read-bilingual-content').waitFor({state: 'attached'});
      await page.waitForTimeout(500);
      const translatedRequests = provider.requestCount();
      assert(translatedRequests > before, 'Native shortcut must reach the translation fixture');
      await page.mouse.move(5, 5);
      await page.evaluate(fixture => {
        const owner = document.querySelector('#owner');
        if (fixture.depth) {
          const tree = document.createElement('span'); let leaf = tree;
          for (let i = 1; i < fixture.depth; i++) {const child = document.createElement('span'); leaf.append(child); leaf = child;}
          owner.prepend(tree);
        } else {
          const nodes = document.createDocumentFragment();
          for (let i = 0; i < fixture.emptyNodes; i++) nodes.append(document.createTextNode(''));
          owner.prepend(nodes);
        }
      }, fixture);
      await page.waitForTimeout(600);
      assert.equal(await page.locator('#owner > .fluent-read-bilingual-content').count(), 1);
      const point = await page.evaluate(() => {
        const range = document.createRange(); range.setStart(window.sourceNode, 3); range.setEnd(window.sourceNode, 4);
        const rect = range.getClientRects()[0]; return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      });
      const expected = 'Sentence 0 keeps useful reading context.';
      await page.evaluate(() => {
        window.tasks = []; window.ticks = []; window.mutations = []; window.rangeCount = 0;
        window.taskObserver = new PerformanceObserver(list => window.tasks.push(...list.getEntries().map(entry => entry.duration)));
        window.taskObserver.observe({type: 'longtask', buffered: false});
        window.mutationObserver = new MutationObserver(records => window.mutations.push(...records.map(record => record.type)));
        window.mutationObserver.observe(document.querySelector('#owner'), {subtree: true, childList: true, characterData: true, attributes: true});
        let previous = performance.now();
        window.timer = setInterval(() => {const now = performance.now(); window.ticks.push(now - previous); previous = now;}, 20);
      });
      const started = Date.now();
      await page.mouse.move(point.x, point.y);
      let highlighted = false;
      try {
        await page.waitForFunction(expected => [...(CSS.highlights.get('fluentread-bilingual-sentence') || [])].map(range => range.toString()).join('') === expected + '测试译文：' + expected, expected, {timeout: 8000});
        highlighted = true;
      } catch (error) {if (!baseline) throw error;}
      const highlightLatencyMs = Date.now() - started;
      await page.waitForTimeout(850);
      const result = await page.evaluate(({fixture, source, highlighted, highlightLatencyMs}) => {
        window.taskObserver.disconnect(); window.mutationObserver.disconnect(); clearInterval(window.timer);
        const clone = document.querySelector('#owner').cloneNode(true);
        clone.querySelectorAll('[data-fr-translation-owned="true"]').forEach(node => node.remove());
        return {...fixture, highlighted, highlightLatencyMs, longTasksMs: window.tasks, maxHeartbeatGapMs: Math.max(0, ...window.ticks),
          hostMutations: window.mutations.length, originalPreserved: clone.textContent === source,
          originalTextIdentity: document.querySelector('#owner').contains(window.sourceNode),
          highlightedText: [...(CSS.highlights.get('fluentread-bilingual-sentence') || [])].map(range => range.toString()).join('')};
      }, {fixture, source, highlighted, highlightLatencyMs});
      report.cases.push(result);
      result.initialRequests = translatedRequests - before;
      assert.equal(result.hostMutations, 0); assert(result.originalPreserved && result.originalTextIdentity);
      assert.equal(provider.requestCount(), translatedRequests, 'Passive highlight must not request translation');
      await page.screenshot({path: path.join(artifactsDir, fixture.id + '.png')});
      if (verifyActions) {
        const actions = page.locator('#fluent-read-sentence-actions');
        const entry = actions.getByRole('button', {name: '句子操作', exact: true});
        await entry.waitFor({state: 'visible'}); assert.equal(await actions.getByRole('toolbar').count(), 0);
        await entry.click(); await actions.getByRole('button', {name: '播放原文', exact: true}).waitFor({state: 'visible'});
        const translatedPoint = await page.evaluate(() => {
          const wrapper = document.querySelector('#owner > .fluent-read-bilingual-content');
          wrapper.scrollIntoView({block: 'start'});
          const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT); let node;
          while ((node = walker.nextNode())) {
            if (!node.length) continue;
            const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2);
            const rect = range.getClientRects()[0]; if (rect?.width) return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
          }
          throw new Error('Translated text point unavailable');
        });
        // scroll 事件在下一帧交付，会按产品契约撤销高亮；稳定悬浮应在它结算后开始。
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.mouse.move(translatedPoint.x, translatedPoint.y);
        await page.waitForFunction(expected => [...(CSS.highlights.get('fluentread-bilingual-sentence') || [])].map(range => range.toString()).join('') === expected + '测试译文：' + expected, expected);
        await entry.waitFor({state: 'visible'}); assert.equal(await actions.getByRole('toolbar').count(), 0);
        await entry.click(); await actions.getByRole('button', {name: '播放译文', exact: true}).waitFor({state: 'visible'});
        await page.screenshot({path: path.join(artifactsDir, fixture.id + '-translation.png')});
        result.bothDirectionsAndCompactActions = true;
        assert.equal(provider.requestCount(), translatedRequests);
      }
      await page.locator('#probe').click(); assert.equal(await page.evaluate(() => window.hostClicks), 1);
      await page.keyboard.press('Alt+t');
      await page.waitForFunction(() => !document.querySelector('#owner .fluent-read-bilingual-content'));
      await page.waitForFunction(() => !CSS.highlights.get('fluentread-bilingual-sentence')?.size);
      result.restoredOriginal = await page.evaluate(source => {
        const owner = document.querySelector('#owner');
        return {textExact: owner.textContent === source, sameTextNode: owner.contains(window.sourceNode)};
      }, source);
      assert(result.restoredOriginal.textExact && result.restoredOriginal.sameTextNode);
      result.restoreClearedHighlight = true; result.extraRequests = provider.requestCount() - translatedRequests;
      await page.close();
    }
    report.passed = report.cases.every(result => result.highlighted) && report.consoleErrors.length === 0;
    report.unexpectedNetworkRequests = unexpectedNetwork.length; assert.equal(unexpectedNetwork.length, 0);
    if (!baseline) assert(report.passed);
  } catch (error) {report.error = error.stack; process.exitCode = 1;}
  finally {
    if (launched) await launched.close();
    if (provider) await provider.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(profileDir, {recursive: true, force: true});
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({passed: report.passed, baseline, cases: report.cases.map(({id, highlighted, highlightLatencyMs, longTasksMs, maxHeartbeatGapMs}) => ({id, highlighted, highlightLatencyMs, longTasksMs, maxHeartbeatGapMs})), error: report.error?.split('\n')[0]}));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
