/**
 * @file scripts/testing/run-translation-center-ui-test.cjs
 * 文件职责：在独立后台可见 Edge 中验证翻译中心的完整操作链，不连接用户浏览器或真实翻译账号。
 * 主要内容：使用本机 OpenAI-compatible 服务夹具覆盖渐进结果、失败、独立重试、取消与迟到响应、旧结果和服务配置跳转；检查快速关闭持久化、七语言布局、窄屏和深色截图。
 * 模块边界：浏览器通过技能 focus-safe helper 启动，仅写本次证据目录与临时 profile；剪贴板使用页内夹具避免覆盖用户系统剪贴板，报告不记录密钥或原文。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const arg = (key, fallback) => {const index = process.argv.indexOf('--' + key); return index < 0 ? fallback : process.argv[index + 1];};
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-translation-center'));
const {chromium} = require(path.join(arg('playwright-root', ''), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', ''));
const report = {ok: false, extensionDir, providerEvidence: 'local-http-fixture', clipboardEvidence: 'page-fixture-not-system-clipboard', cases: [], requests: [], screenshots: [], layouts: [], consoleErrors: [], persistenceCases: [], quickClose: false, crossPageSync: false, latestWriteWins: false};
let launched, page, profileDir, mode = 'normal', failedB = true;
let launchAttempted = false;
fs.mkdirSync(artifactsDir, {recursive: true});
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {res.writeHead(204, {'access-control-allow-origin': '*', 'access-control-allow-headers': '*'}); res.end(); return;}
  let raw = ''; req.on('data', chunk => {raw += chunk;});
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request body');
    }
    catch {
      res.writeHead(400, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
      res.end(JSON.stringify({error: {message: 'Invalid synthetic fixture request'}}));
      return;
    }
    const isB = req.url.startsWith('/b/'), fail = isB && failedB, delayed = isB && mode === 'delay';
    report.requests.push({path: req.url, model: body.model, mode, fail});
    const reply = () => {
      if (res.destroyed) return;
      res.writeHead(fail ? 503 : 200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
      res.end(JSON.stringify(fail ? {error: {message: 'comparison fixture temporarily unavailable'}} : {
        id: 'center-fixture', object: 'chat.completion', created: 1, model: body.model,
        choices: [{index: 0, message: {role: 'assistant', content: isB ? '好的设计让复杂的事情变得简单。' : '优秀的设计，让复杂的事变得简单。'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20},
      }));
    };
    if (delayed) {
      const timer = setTimeout(reply, 1600);
      res.once('close', () => clearTimeout(timer));
    } else reply();
  });
});
const record = name => report.cases.push(name);
async function settleAnimations() {
  await page.evaluate(async () => {await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation => animation.finished.catch(() => {})));});
}
async function shot(name) {await settleAnimations(); const file = path.join(artifactsDir, name + '.png'); await page.screenshot({path: file}); report.screenshots.push(file);}
function contrastRatio(foreground, background) {
  const luminance = value => {
    const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return channels.reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  };
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a); return (high + .05) / (low + .05);
}
async function checkContrast(theme) {
  await settleAnimations();
  const colors = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return {selectText: style('.translation-center .el-select__selected-item').color, selectBackground: style('.translation-center .el-select__wrapper').backgroundColor, buttonText: style('.translate-primary-button').color, buttonBackground: style('.translate-primary-button').backgroundColor};
  });
  const result = {theme, select: contrastRatio(colors.selectText, colors.selectBackground), primary: contrastRatio(colors.buttonText, colors.buttonBackground), colors};
  assert.ok(result.select >= 4.5, 'Language selector contrast: ' + JSON.stringify(result)); assert.ok(result.primary >= 4.5, 'Primary button contrast: ' + JSON.stringify(result));
  (report.contrast ||= []).push(result);
}
async function main() {
  await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); reject(error);};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  const host = 'http://127.0.0.1:' + server.address().port;
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-translation-center-'));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false,
    browserArgs: ['--disable-extensions-except=' + extensionDir, '--load-extension=' + extensionDir, '--no-first-run'], viewport: {width: 1440, height: 1000}, timeout: 30000});
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  const open = async () => {
    page = await newPageWithoutForeground(context); page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto(origin + '/options.html#settings-translation-center'); await page.locator('.translation-center').waitFor();
    await page.locator('.translation-result-card').first().waitFor();
  };
  await open();
  const readConfig = () => page.evaluate(async () => (await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'})).value);
  const patch = async value => {
    const result = await page.evaluate(async value => {
      const current = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: value, expected: Object.fromEntries(Object.keys(value).map(key => [key, current.value[key]])), clientId: 'translation-center-browser-test', sequence: Date.now(), baseRevision: 0});
    }, value);
    assert.equal(result.success, true);
  };
  await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, on: true, translationMaxRetries: 0});
  await page.reload(); await page.getByRole('button', {name: '试试示例', exact: true}).waitFor();
  assert.ok(await page.locator('.translation-result-card').count() <= 3); assert.equal(await page.locator('.needs-configuration').count(), 0);
  assert.equal(report.requests.length, 0); record('first-use-small-no-key-selection'); await shot('first-use');
  await patch({customOpenAIProviders: [{id: 'custom:center-a', name: '对比服务 A', endpoint: host + '/a/v1', models: ['fixture-a']}, {id: 'custom:center-b', name: '对比服务 B', endpoint: host + '/b/v1', models: ['fixture-b']}],
    model: {...(await readConfig()).model, 'custom:center-a': 'fixture-a', 'custom:center-b': 'fixture-b'},
    requireApiKey: {'v2:["custom:center-a","fixture-a"]': false, 'v2:["custom:center-b","fixture-b"]': false},
    translationCenterServices: ['custom:center-a', 'custom:center-b', 'openai'], translationCenterSourceLanguage: 'en', translationCenterTargetLanguage: 'zh-Hans'});
  await page.locator('.translation-result-card[data-service="custom:center-a"]').waitFor();
  const cardA = () => page.locator('.translation-result-card[data-service="custom:center-a"]'), cardB = () => page.locator('.translation-result-card[data-service="custom:center-b"]');
  await page.getByRole('button', {name: '试试示例', exact: true}).click();
  await checkContrast('light');
  await page.getByRole('button', {name: '开始翻译', exact: false}).click();
  await cardA().locator('.translation-result-content').waitFor(); await cardB().locator('.translation-result-error').waitFor();
  assert.equal(report.requests.length, 2); assert.equal(await page.locator('[data-service="openai"] .needs-configuration').count(), 1);
  assert.equal(await page.locator('.translation-result-card[data-service="openai"]').getAttribute('data-status'), 'idle');
  record('real-background-client-requests-only-configured-items'); await shot('partial-failure');
  failedB = false;
  await cardB().getByRole('button', {name: '重试此项', exact: true}).click(); await cardB().locator('.translation-result-content').waitFor();
  assert.equal(report.requests.length, 3); assert.equal(report.requests[2].model, 'fixture-b'); record('retry-one-preserves-completed-neighbor');
  await page.evaluate(() => {navigator.clipboard.writeText = async value => {window.fixtureCopied = value;};});
  await page.getByRole('button', {name: '复制本次结果', exact: true}).click();
  assert.ok((await page.evaluate(() => window.fixtureCopied)).includes('对比服务 A')); record('copy-current-results');
  const sourceText = await page.locator('.translation-editor textarea').inputValue();
  await page.locator('.translation-editor textarea').fill('Good design makes complex things feel simple. A revised source.');
  await page.locator('.results-stale-notice').waitFor(); assert.equal(await page.locator('.copy-all-button').isDisabled(), true);
  assert.equal(await cardA().getAttribute('data-stale'), 'true'); record('stale-results-excluded-from-copy'); await shot('stale-results');
  await page.locator('.translation-editor textarea').fill(sourceText); await page.getByRole('button', {name: '并排', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.translation-result-list').classList.contains('is-grid'));
  await shot('comparison-grid');
  await cardA().locator('.drag-handle').press('Alt+ArrowDown');
  assert.equal(await page.locator('.translation-result-card').first().getAttribute('data-service'), 'custom:center-b');
  assert.equal(await cardA().locator('.translation-result-content p').innerText(), '优秀的设计，让复杂的事变得简单。'); record('keyboard-reorder-retains-results');
  await page.getByRole('button', {name: '管理服务', exact: true}).click();
  assert.equal(await page.locator('.service-picker-search input').evaluate(el => el === document.activeElement), true);
  await page.locator('.service-picker-search input').fill('fixture-b');
  assert.equal(await page.locator('.service-picker-option').count(), 1);
  assert.equal(await page.locator('.service-picker-search').evaluate(el => el.getBoundingClientRect().height), 44);
  await shot('service-picker'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.add-service-button').evaluate(el => el === document.activeElement), true); record('model-search-escape-focus-return');
  const previousDefault = (await readConfig()).service;
  const previousHash = await page.evaluate(() => location.hash);
  await cardA().locator('.card-connection-footer button').click(); await page.locator('.service-catalog').waitFor();
  assert.equal(await page.locator('.service-catalog').getAttribute('data-editing-service'), 'custom:center-a');
  assert.equal((await readConfig()).service, previousDefault);
  assert.match(await page.evaluate(() => location.hash), /^#settings-services/);
  assert.equal(await page.locator('.service-catalog.compact, .service-configuration-dialog').count(), 0); await shot('configure-workspace');
  await page.evaluate(hash => {location.hash = hash;}, previousHash);
  await page.locator('.translation-editor textarea').waitFor({state: 'visible'});
  assert.equal(await page.locator('.translation-editor textarea').inputValue(), sourceText); assert.equal(await cardA().getAttribute('data-status'), 'success');
  record('configure-service-and-return-retains-work');
  const syncPage = await newPageWithoutForeground(context); syncPage.on('pageerror', error => report.consoleErrors.push(error.message));
  await syncPage.goto(origin + '/options.html#settings-translation-center'); await syncPage.locator('.translation-result-card').first().waitFor();
  await syncPage.getByRole('button', {name: '列表', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('.translation-result-list').classList.contains('is-grid'));
  assert.equal(await page.locator('.translation-editor textarea').inputValue(), sourceText); assert.equal(await cardA().getAttribute('data-status'), 'success');
  await syncPage.close(); await page.getByRole('button', {name: '并排', exact: true}).click();
  report.crossPageSync = true; record('cross-page-layout-sync-retains-work');
  mode = 'delay'; await page.getByRole('button', {name: '重新翻译', exact: false}).click();
  await cardA().locator('.translation-result-content').waitFor(); await cardB().locator('.loading-placeholder').waitFor();
  await page.locator('.translate-stop-button').click(); assert.equal(await cardB().getAttribute('data-status'), 'cancelled');
  assert.equal(await cardA().getAttribute('data-status'), 'success');
  await page.waitForTimeout(1800); assert.equal(await cardB().getAttribute('data-status'), 'cancelled'); record('stop-retains-success-and-rejects-late-response'); await shot('stopped');
  mode = 'normal'; await page.getByRole('button', {name: '重试未完成项', exact: true}).click(); await cardB().locator('.translation-result-content').waitFor();
  const before = report.requests.length;
  await page.getByRole('button', {name: '管理服务', exact: true}).click(); await page.locator('.service-picker-search input').fill('DeepSeek');
  await page.locator('.service-picker-option').filter({has: page.getByText('DeepSeek', {exact: true})}).click(); assert.equal(report.requests.length, before);
  await page.keyboard.press('Escape'); await page.locator('.translation-result-card[data-service="deepseek"]').waitFor(); record('add-does-not-spend-provider-requests');
  await page.getByRole('button', {name: '列表', exact: true}).click(); await page.getByRole('button', {name: '并排', exact: true}).click();
  await page.getByRole('combobox', {name: '目标语言', exact: true}).press('Enter');
  await page.getByRole('option').filter({hasText: '日本語'}).click();
  await page.close(); await open();
  await page.waitForFunction(() => document.querySelector('.translation-result-list').classList.contains('is-grid'));
  const reopened = await readConfig(); assert.equal(reopened.translationCenterLayout, 'grid'); assert.equal(reopened.translationCenterTargetLanguage, 'ja'); assert.ok(reopened.translationCenterServices.includes('deepseek'));
  assert.equal(await page.locator('.translation-editor textarea').inputValue(), '');
  report.quickClose = true; report.latestWriteWins = true; report.persistenceCases.push('language-layout-latest-write-and-selected-order-survive-immediate-close'); record('quick-close-persistence-no-text-storage'); await shot('persisted-reopen');
  for (const [width, height] of [[1440, 1000], [1024, 900], [820, 900], [390, 844]]) {
    await page.setViewportSize({width, height});
    const metrics = await page.evaluate(() => ({width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, centerOverflow: document.querySelector('.translation-center').scrollWidth > document.querySelector('.translation-center').clientWidth + 1, editorWidth: document.querySelector('textarea').getBoundingClientRect().width}));
    assert.equal(metrics.overflow, false); assert.equal(metrics.centerOverflow, false); assert.ok(metrics.editorWidth > 180);
    report.layouts.push(metrics); await shot('layout-' + width);
  }
  await page.setViewportSize({width: 1440, height: 1000}); await patch({darkMode: true}); await page.emulateMedia({colorScheme: 'dark'});
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await checkContrast('dark'); await shot('dark');
  for (const [locale, inputTitle] of [['en-US', 'Source text'], ['ja-JP', '翻訳するテキスト'], ['ko-KR', '번역할 텍스트'], ['fr-FR', 'Texte à traduire'], ['ru-RU', 'Исходный текст'], ['es-ES', 'Texto original']]) {
    await patch({uiLanguage: locale});
    await page.waitForFunction(title => document.querySelector('#translation-input-title').textContent.trim() === title, inputTitle);
    assert.equal(await page.locator('.translation-center').innerText().then(text => text.includes('translationCenter.')), false);
    await shot('locale-' + locale);
    if (locale === 'en-US') {await shot('english'); await page.setViewportSize({width: 390, height: 844}); await shot('english-mobile'); await page.setViewportSize({width: 1440, height: 1000});}
  }
  record('six-translated-locales-and-dark-mode'); assert.equal(report.consoleErrors.length, 0); report.ok = true;
}
main().catch(async error => {report.error = error.stack || String(error); process.exitCode = 1; if (page && !page.isClosed()) {report.failurePage = await page.evaluate(() => ({title: document.title, text: document.body.innerText.slice(0, 1500)})).catch(() => null); await shot('failure').catch(() => {});}}).finally(async () => {
  report.cleanupErrors = [];
  let browserClosed = !launchAttempted;
  if (launched) {
    try {await launched.close(); browserClosed = true;}
    catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
  }
  try {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  } catch (error) {report.cleanupErrors.push(`server close: ${error.message}`);}
  if (profileDir) {
    if (browserClosed) {
      try {fs.rmSync(profileDir, {recursive: true, force: true}); report.profileRemoved = true;}
      catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
    } else report.retainedProfile = profileDir;
  }
  if (report.cleanupErrors.length) {report.ok = false; process.exitCode = 1;}
  try {fs.writeFileSync(path.join(artifactsDir, 'browser-report.json'), JSON.stringify(report, null, 2));}
  catch (error) {console.error(`translation center report write: ${error.stack || error}`); process.exitCode = 1;}
  console.log(JSON.stringify({ok: report.ok, cases: report.cases.length, screenshots: report.screenshots.length, error: report.error}));
});
