#!/usr/bin/env node
'use strict';
// 全局翻译开关生产回归：临时配置、第二屏后台窗口、本地服务，验证请求取消、文档续译、翻译中心与网页入口。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const argument = (name, fallback) => {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];};
const subset = (actual, expected) => expected && typeof expected === 'object' && !Array.isArray(expected)
  ? actual && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  : JSON.stringify(actual) === JSON.stringify(expected);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SOURCE = 'Reading should feel calm and effortless. Colors and lines should follow the page you are reading.';
const TRANSLATION = '阅读应该轻松、自然。颜色和线条应当贴合你正在阅读的网页。';
const DEFAULT_APPEARANCE = {textColor: '', backgroundColor: '', lineColor: '', fillColor: '', fontScale: 100, fontWeight: 'default', fontFamily: 'default', opacity: 100, customCss: ''};

async function startFixture() {
  const requests = [];
  let hold = false;
  const pending = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {response.writeHead(204); response.end(); return;}
    if (request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body;
      try {body = JSON.parse(Buffer.concat(chunks).toString());}
      catch {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: {message: 'Invalid synthetic fixture JSON'}})); return;}
      if (body === null || !Array.isArray(body.messages) || body.messages.some(item => item === null)) {response.writeHead(400, {'Content-Type': 'application/json'}); response.end(JSON.stringify({error: {message: 'Invalid synthetic fixture request'}})); return;}
      const prompt = body.messages.filter(item => item.role === 'user').map(item => item.content).join('\n');
      const text = /SOURCE_BEGIN([\s\S]*?)SOURCE_END/u.exec(prompt)?.[1] || '';
      const observed = {source: text, aborted: false}; requests.push(observed);
      if (hold) {
        await new Promise(resolve => {pending.add(resolve); response.on('close', () => {observed.aborted = !response.writableEnded; pending.delete(resolve); resolve();});});
        if (response.destroyed) return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({id: 'global-toggle-fixture', object: 'chat.completion', created: 1, model: 'fixture',
        choices: [{index: 0, message: {role: 'assistant', content: text.replace(SOURCE, TRANSLATION)}, finish_reason: 'stop'}]}));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Translation style fixture</title><style>body{margin:0;padding:48px 8vw;font:18px/1.8 system-ui;color:#263044;background:#fff}main{max-width:900px}p{margin:28px 0}</style></head><body><main><h1 translate="no">Translation style fixture</h1><p id="primary">${SOURCE}</p></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); server.close(() => reject(error)); server.closeAllConnections();};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  return {url: `http://127.0.0.1:${server.address().port}`, requests, hold: value => {hold = value; if (!hold) {for (const resolve of pending) resolve(); pending.clear();}}, close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}

async function main() {
  const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
  const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-global-toggle'));
  const packages = argument('playwright-root'); const helperPath = argument('focus-safe-helper');
  assert(packages && helperPath, '需要 --playwright-root 与 --focus-safe-helper'); assert(fs.existsSync(path.join(extensionDir, 'manifest.json')));
  const {chromium} = require(require.resolve('playwright', {paths: [packages]}));
  const {launchFocusSafePersistentContext, newPageWithoutForeground, activateExtensionTabWithoutForeground} = require(helperPath);
  let profileDir; let launchAttempted = false;
  fs.mkdirSync(artifactsDir, {recursive: true});
  let fixture;
  const report = {ok: false, extensionDir, profileDir, artifactsDir, checks: [], consoleErrors: [], screenshots: [], metrics: {},
    evidenceBoundary: 'Local deterministic HTML/provider in an isolated Edge profile; no Firefox runtime or external provider claim.'};
  let launched;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-global-toggle-edge-'));
    report.profileDir = profileDir;
    fixture = await startFixture();
    launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, background: true, headless: false,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', viewport: {width: 1440, height: 960}, timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp'); assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = /^chrome-extension:\/\/[^/]+/u.exec(worker.url())[0];
    const createPage = async url => {
      const result = await newPageWithoutForeground(context, 30000);
      result.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
      result.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`console: ${message.text()}`); });
      await result.goto(url, {waitUntil: 'domcontentloaded'}); return result;
    };
    const shot = async (surface, name) => {
      const owner = typeof surface.page === 'function' ? surface.page() : surface;
      const viewport = owner.viewportSize();
      let expanded = false;
      if (surface !== owner) {
        // 设置页在内部容器中滚动；让整组真实进入视口再截图，避免截图把被裁剪的区域渲染成空白。
        const height = Math.ceil(await surface.evaluate(element => element.getBoundingClientRect().height));
        if (height + 100 > viewport.height) {
          await owner.setViewportSize({width: viewport.width, height: height + 100});
          expanded = true;
        }
        await surface.scrollIntoViewIfNeeded();
      }
      const file = path.join(artifactsDir, `${name}.png`);
      await surface.screenshot({path: file}); report.screenshots.push(file);
      if (expanded) await owner.setViewportSize(viewport);
    };
    const popup = await createPage(`${origin}/popup.html`);
    const readConfig = () => popup.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!result?.success) throw new Error(result?.error); return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    });
    const untilConfig = async (predicate, label = 'configuration') => {
      for (let i = 0; i < 200; i++) {const config = await readConfig(); if (config && predicate(config)) return config; await wait(50);}
      throw new Error(`${label} did not converge`);
    };
    await untilConfig(config => config.to && config.service);
    const patchConfig = async patch => {
      const current = await readConfig(); const initial = Object.hasOwn(patch, 'token');
      const expected = Object.fromEntries(Object.keys(patch).map(key => [key, current[key]]));
      const result = await popup.evaluate(({patch, current, expected, initial}) => chrome.runtime.sendMessage({
        type: 'persistConfig', mode: initial ? 'replace' : 'patch', config: initial ? {...current, ...patch} : patch, expected,
        baseRevision: initial ? current.__fluentConfigRevision : undefined, clientId: `global-toggle-${crypto.randomUUID()}`, sequence: 1,
      }), {patch, current, expected, initial});
      assert.equal(result?.success, true, result?.error);
      await untilConfig(config => Object.keys(patch).filter(key => key !== 'token').every(key => subset(config[key], patch[key])));
    };
    const service = 'custom:global-toggle-fixture';
    await patchConfig({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, theme: 'light', interfaceSkin: 'default',
      display: 1, style: 1, translationAppearance: DEFAULT_APPEARANCE, service, from: 'en', to: 'zh-Hans', useCache: false,
      autoTranslate: false, bilingualSentenceHighlightEnabled: false, translationBeforeOriginal: false,
      customOpenAIProviders: [{id: service, name: '本地翻译测试', endpoint: `${fixture.url}/v1/chat/completions`, models: ['fixture']}],
      token: {[service]: 'synthetic-local-fixture-not-a-secret'}, model: {[service]: 'fixture'},
      user_role: {[service]: 'SOURCE_BEGIN{{origin}}SOURCE_END'}, enableAIContext: false, enableAIMultiSegment: false,
      glossaryEnabled: false, hotkey: 'Control', floatingBallHotkey: 'Alt+T', mouseHoverTranslationDelay: 0,
      selectionTranslatorMode: 'disabled', disableSelectionTranslator: true, animations: false});

    await patchConfig({documentService: service, documentModel: {[service]: 'fixture'}, translationCenterServices: [service], translationCenterSourceLanguage: 'en', translationCenterTargetLanguage: 'zh-Hans'});
    const send = () => popup.evaluate(source => chrome.runtime.sendMessage({origin: source, context: 'Global toggle fixture', sourceLanguage: 'en', targetLanguage: 'zh-Hans', useCache: false}), SOURCE);
    const center = await createPage(`${origin}/options.html#settings-translation-center`);
    const documentPage = await createPage(`${origin}/document.html`);
    const sourceInput = center.locator('.translation-editor textarea');
    await sourceInput.fill(SOURCE);
    const centerButton = center.locator('.translate-primary-button');
    const until = async (predicate, label) => {
      for (let i = 0; i < 200; i++) {if (await predicate()) return; await wait(50);}
      throw new Error(`${label} did not converge`);
    };
    await patchConfig({on: false});
    await until(() => centerButton.isDisabled(), 'center pause');
    await documentPage.getByTestId('document-translation-paused').waitFor();
    await sourceInput.press('Control+Enter');
    const before = fixture.requests.length;
    const disabledResponse = await send();
    report.disabledResponse = disabledResponse; report.disabledProviderCalls = fixture.requests.length - before;
    assert.equal(report.disabledProviderCalls, 0, '全局关闭后后台仍调用翻译服务');
    assert.equal(disabledResponse.code, 'TRANSLATION_DISABLED');
    assert.equal(disabledResponse.retryable, false);
    report.checks.push('global off rejects direct runtime translation without provider calls');
    await patchConfig({on: true});
    assert.equal(await send(), TRANSLATION);
    fixture.hold(true);
    const startCount = fixture.requests.length;
    const inFlight = send();
    await until(() => fixture.requests.length > startCount, 'in-flight request');
    await patchConfig({on: false});
    const cancelledResponse = await inFlight;
    assert.equal(cancelledResponse.code, 'TRANSLATION_DISABLED');
    await until(() => fixture.requests.at(-1).aborted, 'provider transport abort');
    fixture.hold(false);
    report.checks.push('global off aborts real provider transport and returns a nonretryable response');

    await patchConfig({on: true});
    await until(async () => !await centerButton.isDisabled(), 'center reenable');
    await centerButton.click();
    await center.locator('.translation-result-content').waitFor({state: 'visible'});
    await patchConfig({on: false});
    assert.equal(await sourceInput.inputValue(), SOURCE);
    assert.match(await center.locator('.translation-results-panel').innerText(), /阅读应该轻松/);
    await shot(center, 'center-paused-with-result');
    await patchConfig({on: true});
    fixture.hold(true);
    const beforeCenter = fixture.requests.length;
    await until(async () => !await centerButton.isDisabled(), 'center ready');
    await centerButton.click();
    await until(() => fixture.requests.length > beforeCenter, 'center active request');
    await patchConfig({on: false});
    await until(async () => await centerButton.isDisabled() && !(await centerButton.innerText()).includes('翻译中'), 'center stops');
    assert.equal(await center.locator('.translation-result-card[data-status=cancelled]').count(), 1);
    assert.equal(await center.locator('.translation-result-error').count(), 0);
    await until(() => fixture.requests.at(-1).aborted, 'center provider cancelled');
    fixture.hold(false);
    const pausedCount = fixture.requests.length;
    await sourceInput.press('Control+Enter'); await wait(200);
    assert.equal(fixture.requests.length, pausedCount);
    await patchConfig({on: true}); await wait(200);
    assert.equal(fixture.requests.length, pausedCount, '恢复总开关不能自行重启旧任务');
    assert.equal(await sourceInput.inputValue(), SOURCE);
    report.checks.push('translation center disables button/shortcut, cancels active run, retains input and completed results, and does not auto restart');

    const fileInput = documentPage.locator('input[type=file]');
    await fileInput.setInputFiles({name: 'completed.txt', mimeType: 'text/plain', buffer: Buffer.from(SOURCE)});
    const docTranslate = documentPage.locator('.translation-actions .translate-document-button');
    await until(async () => await docTranslate.count() === 1 && !await docTranslate.isDisabled(), 'document ready');
    await docTranslate.click();
    await until(async () => !(await docTranslate.innerText()).includes('开始') && await documentPage.locator('.download-button').isEnabled(), 'document translated');
    await fileInput.setInputFiles({name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from(SOURCE + ' A second document.')});
    fixture.hold(true);
    const beforeDoc = fixture.requests.length;
    const batchStart = documentPage.getByRole('button', {name: '翻译剩余文件', exact: true});
    await batchStart.click();
    await until(() => fixture.requests.length > beforeDoc, 'document active request');
    await patchConfig({on: false});
    await documentPage.getByTestId('document-translation-paused').waitFor();
    await until(() => fixture.requests.at(-1).aborted, 'document provider cancelled');
    await until(() => batchStart.isDisabled(), 'batch disabled');
    assert.equal(await documentPage.locator('.batch-files .notice.error').count(), 0, '全局暂停不应显示红色失败提示');
    assert.match(await documentPage.locator('.batch-file').filter({hasText: 'pending.txt'}).innerText(), /已暂停/);
    fixture.hold(false);
    const completedFile = documentPage.locator('.batch-file').filter({hasText: 'completed.txt'});
    await completedFile.click();
    assert.equal(await documentPage.locator('.download-button').isEnabled(), true, '关闭后保留已完成译文与导出');
    assert.equal(await docTranslate.isDisabled(), true);
    await shot(documentPage, 'document-paused-with-results');
    await documentPage.locator('.batch-file').filter({hasText: 'pending.txt'}).click();
    assert.equal(await docTranslate.isDisabled(), true);
    await patchConfig({on: true});
    await until(async () => !await batchStart.isDisabled(), 'batch ready again');
    const resumedCount = fixture.requests.length;
    await wait(200); assert.equal(fixture.requests.length, resumedCount);
    await batchStart.click();
    await until(async () => await documentPage.locator('.download-button').isEnabled() && !await documentPage.getByRole('button', {name: '暂停全部', exact: true}).count(), 'document resumed');
    report.checks.push('document and batch translation stop, buttons disable, completed text/export survive, and pending files resume explicitly');
    await shot(documentPage, 'document-resumed');
    const article = await createPage(`${fixture.url}/article`);
    await activateExtensionTabWithoutForeground(context, article, 30000);
    await article.locator('#primary').hover(); await article.keyboard.down('Control'); await article.keyboard.up('Control');
    const translated = article.locator('#primary > .fluent-read-bilingual-content');
    await translated.waitFor({state: 'attached'});
    assert.match(await translated.innerText(), /阅读应该轻松/);
    await patchConfig({videoTranslationEnabled: true});
    const videos = [];
    for (const site of ['youtube', 'x']) {
      const url = site === 'youtube' ? 'https://www.youtube.com/watch?v=fluentread-global-switch' : 'https://x.com/FluentRead/status/123456/video/1';
      const container = site === 'youtube' ? 'id="movie_player" class="html5-video-player"' : 'data-testid="videoPlayer"';
      const controls = site === 'youtube' ? 'class="ytp-right-controls"' : 'class="fixture-controls"';
      const html = `<!doctype html><html><head><title>${site} fixture</title></head><body><article><div ${container} style="position:relative;width:800px;height:450px;background:#182434"><video muted controls style="width:100%;height:100%"></video><div ${controls} style="position:absolute;bottom:0;right:0;display:flex;height:40px"><button aria-label="Play">Play</button><button aria-label="Settings">Settings</button><button aria-label="Fullscreen">Fullscreen</button></div></div></article></body></html>`;
      await context.route(url, route => route.fulfill({status: 200, contentType: 'text/html', body: html}));
      const video = await createPage(url);
      await video.locator('.fluent-read-video-subtitle-button').waitFor();
      videos.push(video);
    }
    await center.goto(`${origin}/options.html#settings-general`);
    const master = center.getByTestId('plugin-master-setting').getByRole('switch');
    await master.click(); await untilConfig(config => !config.on);
    await translated.waitFor({state: 'detached'});
    for (const video of videos) {
      await video.locator('.fluent-read-video-subtitle-button').waitFor({state: 'detached'});
      await video.reload(); await wait(400);
      assert.equal(await video.locator('.fluent-read-video-ui').count(), 0);
    }
    await master.click(); await untilConfig(config => config.on);
    assert.equal((await readConfig()).videoTranslationEnabled, true);
    for (const video of videos) await video.locator('.fluent-read-video-subtitle-button').waitFor();
    await activateExtensionTabWithoutForeground(context, article, 30000);
    await article.locator('#primary').hover(); await article.keyboard.down('Control'); await article.keyboard.up('Control');
    await translated.waitFor({state: 'attached'});
    report.checks.push('actual General switch restores page source, removes YouTube/X fixture icons across reload, then restores preferences and supports translating again');
    report.requests = fixture.requests.length;
    assert.deepEqual(report.consoleErrors, []); report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); throw error;
  } finally {
    report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (launched) {
      try {await launched.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    try {fixture?.hold(false);} catch (error) {report.cleanupErrors.push(`release hold: ${error.message}`);}
    try {await fixture?.close();} catch (error) {report.cleanupErrors.push(`fixture close: ${error.message}`);}
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
