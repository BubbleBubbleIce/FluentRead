'use strict';
/**
 * @file scripts/testing/run-api-keys-ui-test.cjs
 * 文件职责：在生产 MV3 扩展与隔离 Edge 中验证多 API Key 设置和逐 Key 连接检查。
 * 主要内容：本地 HTTP fixture 对 A 返回 401、对 B/C 返回成功，覆盖顺序检查、无 fallback、单项重测、删除、持久化、十行 Key、窄屏与明暗截图。
 * 模块边界：脚本只使用合成凭据和本地服务，不连接真实供应商；浏览器启动、窗口位置和 profile 由 focus-safe helper 管理。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

function arg(name, fallback) { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; }
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(arg('playwright-root', ''));
const helperPath = path.resolve(arg('focus-safe-helper', ''));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-api-keys-ui'));
if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error(`扩展产物不存在：${extensionDir}`);
if (!playwrightRoot || !helperPath) throw new Error('必须提供 --playwright-root 和 --focus-safe-helper');
fs.mkdirSync(artifactsDir, {recursive: true});
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
const report = {extensionDir, providerEvidence: 'local-http-401-fixture', cases: [], requests: [], screenshots: [], consoleErrors: []};
let launched; let launchAttempted = false;
let profileDir;
let activePage;
let fixtureDelayMs = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/u, '');
    let parsedBody;
    try {parsedBody = body ? JSON.parse(body) : null;}
    catch {res.writeHead(400, {'content-type': 'application/json', 'access-control-allow-origin': '*'}); res.end(JSON.stringify({error: {message: 'Invalid synthetic fixture JSON'}})); return;}
    report.requests.push({key, path: req.url, body: parsedBody});
    const respond = () => {
      if (key === 'fixture-A') {
        res.writeHead(401, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
        res.end(JSON.stringify({error: {message: 'fixture key A rejected'}}));
        return;
      }
      res.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
      res.end(JSON.stringify({id: 'api-key-fixture', choices: [{message: {content: 'fixture translation'}}]}));
    };
    if (fixtureDelayMs > 0) setTimeout(respond, fixtureDelayMs); else respond();
  });
});

async function main() {
  await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); reject(error);};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-api-keys-'));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width: 1440, height: 1000}, timeout: 30000});
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const url = `${origin}/options.html#settings-services`;
  let page;
  async function open() {
    page = await newPageWithoutForeground(context);
    activePage = page;
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto(url);
    await page.locator('.service-catalog').waitFor();
  }
  async function addService() {
    await page.getByTestId('custom-service-add').click();
    await page.getByTestId('custom-service-name').fill('API Key Fixture');
    await page.getByTestId('custom-service-endpoint').fill(endpoint);
    await page.getByTestId('custom-service-api-key').fill('fixture-A');
    await page.getByTestId('custom-service-model').fill('fixture');
    await page.getByTestId('custom-service-save').click();
    await page.getByTestId('custom-service-dialog').waitFor({state: 'hidden'});
  }
  async function keys() { return page.locator('[data-api-key-list] [data-api-key-index]'); }
  async function enableKeyRotation() {
    const control = page.locator('[data-api-key-rotation-setting] input[value="rotation"]');
    if (await control.count()) await control.check();
  }
  async function checkAll() {
    const before = report.requests.length;
    const button = page.locator('.detail-hero [data-connection-test-button]');
    await button.click();
    await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
    await page.locator('[data-api-key-summary]').waitFor();
    return report.requests.slice(before);
  }
  await open(); await addService();
  assert.equal(await page.locator('.detail-hero [data-connection-test-button]').count(), 1);
  assert.equal(await page.locator('[data-api-key-list] [data-connection-test-button]').count(), 0);
  report.cases.push('check-all-lives-inside-service-header');
  const list = await keys();
  assert.equal(await list.count(), 1);
  assert.equal(await page.locator('[data-api-key-rotation-setting]').count(), 0, 'One key needs no usage selector');
  assert.equal(await page.locator('[data-api-key-list] .el-switch').count(), 0, 'Credential input must not depend on ambiguous switches');
  assert.equal(await page.locator('[data-api-key-remove]').count(), 0, 'A single row keeps the plain input');
  // 空密钥不阻止继续添加：新增的行获得焦点，多余的行可以逐个删除。
  await page.locator('[data-api-key-list] .api-key-row input').first().fill('');
  await page.locator('[data-api-key-add]').click();
  await (await keys()).nth(1).waitFor({state: 'visible'});
  await page.waitForFunction(() => document.activeElement === document.querySelectorAll('.api-key-entry input')[1]);
  await page.locator('[data-api-key-add]').click();
  assert.equal(await (await keys()).count(), 3, 'Empty keys must not block adding rows');
  assert.equal(await page.locator('[data-api-key-rotation-setting]').count(), 0, 'Usage only matters once two keys are filled');
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-empty-initial.png')}); report.screenshots.push('api-keys-empty-initial.png');
  await (await keys()).nth(2).locator('[data-api-key-remove]').click();
  await (await keys()).nth(1).locator('[data-api-key-remove]').click();
  assert.equal(await (await keys()).count(), 1);
  assert.equal(await page.locator('[data-api-key-list] .api-key-row input').first().isVisible(), true);
  report.cases.push('empty-rows-can-be-added-and-removed');
  await page.locator('[data-api-key-list] .api-key-row input').first().fill('  fixture-A  ');
  await page.locator('[data-api-key-add]').click();
  const rows = await keys();
  await rows.nth(1).waitFor({state: 'visible'});
  const firstInputBox = await page.locator('.api-key-entry input').first().boundingBox();
  const addBox = await page.locator('[data-api-key-add]').boundingBox();
  assert(firstInputBox && addBox && addBox.y >= firstInputBox.y + firstInputBox.height, 'Adding keys belongs below the input');
  await rows.nth(1).locator('input').fill('fixture-B');
  await page.locator('[data-api-key-rotation-setting] input[value="rotation"]').waitFor();
  assert.equal(await page.locator('[data-api-key-rotation-setting] input[value="rotation"]').isChecked(), true, 'Two usable keys rotate by default');
  report.cases.push('second-usable-key-reveals-usage-and-rotates-by-default');
  await page.locator('[data-api-key-add]').click();
  await rows.nth(2).waitFor({state: 'visible'});
  assert.equal(await rows.count(), 3);
  await rows.nth(2).locator('input').fill('fixture-C');
  await page.locator('[data-api-key-add]').click();
  await rows.nth(3).waitFor({state: 'visible'});
  const duplicateRow = (await keys()).nth(3);
  await duplicateRow.locator('input').fill('fixture-B');
  await duplicateRow.locator('.api-key-state.is-duplicate').waitFor();
  const duplicateBefore = report.requests.length;
  const duplicateResults = await checkAll();
  assert.deepEqual(duplicateResults.map(item => item.key), ['fixture-A', 'fixture-B', 'fixture-C']);
  assert.equal(report.requests.slice(duplicateBefore).some(item => item.key === 'fixture-B' && item === duplicateResults.at(-1)), false);
  await duplicateRow.locator('input').fill('fixture-D');
  report.cases.push('duplicate-row-skipped-without-duplicate-request');
  async function translateOnce(text, modelOverride = 'fixture') {
    const serviceId = await page.locator('[data-service-configuration-service]').getAttribute('data-service-configuration-service');
    assert.ok(serviceId, 'selected fixture service is visible');
    return page.evaluate(async ({text, serviceId, modelOverride}) => chrome.runtime.sendMessage({
      origin: text,
      targetLanguage: 'zh-Hans',
      sourceLanguage: 'en',
      serviceOverride: serviceId,
      modelOverride,
      useCache: false,
      clientRequestId: `api-key-ui-${text}`,
    }), {text, serviceId, modelOverride});
  }
  const translationRequestsBefore = report.requests.length;
  const firstTranslation = await translateOnce('rotation-fixture-one', 'fixture-rotation');
  assert.equal(firstTranslation, 'fixture translation');
  const firstTranslationKeys = report.requests.slice(translationRequestsBefore).map(item => item.key);
  assert.deepEqual(firstTranslationKeys, ['fixture-A', 'fixture-B']);
  const secondTranslationStart = report.requests.length;
  const secondTranslation = await translateOnce('rotation-fixture-two', 'fixture-rotation');
  assert.equal(secondTranslation, 'fixture translation');
  const secondTranslationKeys = report.requests.slice(secondTranslationStart).map(item => item.key);
  assert.ok(secondTranslationKeys.includes('fixture-B') || secondTranslationKeys.includes('fixture-C'));
  report.cases.push('translation-broker-fails-A-then-uses-B-or-C');
  const requests = await checkAll();
  assert.deepEqual(requests.map(item => item.key), ['fixture-A', 'fixture-B', 'fixture-C', 'fixture-D']);
  assert.equal(await rows.nth(0).locator('.api-key-state.is-error').count(), 1);
  assert.equal(await rows.nth(1).locator('.api-key-state.is-success').count(), 1);
  assert.equal(await rows.nth(2).locator('.api-key-state.is-success').count(), 1);
  const errorToggle = rows.nth(0).locator('.api-key-error-toggle');
  await errorToggle.press('Enter');
  await rows.nth(0).locator('.api-key-error').waitFor();
  assert.match(await rows.nth(0).locator('.api-key-error').innerText(), /401/u);
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-error-expanded.png')}); report.screenshots.push('api-keys-error-expanded.png');
  await errorToggle.press('Enter');
  assert.equal(await rows.nth(0).locator('.api-key-error').count(), 0);
  report.cases.push('error-details-expand-collapse-with-keyboard');
  report.cases.push('sequential-401-and-success-per-key-without-fallback');
  await page.locator('[data-api-key-list]').scrollIntoViewIfNeeded();
  await page.locator('.api-key-heading strong').click();
  await page.locator('[data-api-key-list]').screenshot({path: path.join(artifactsDir, 'api-keys-panel.png')}); report.screenshots.push('api-keys-panel.png');
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-results.png')}); report.screenshots.push('api-keys-results.png');
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-light.png')}); report.screenshots.push('api-keys-light.png');
  fixtureDelayMs = 200;
  await rows.nth(0).locator('.api-key-retest').click();
  await page.locator('[data-api-key-list][data-api-key-busy="true"]').waitFor();
  assert.equal(await page.locator('[data-api-key-list] .api-key-progress-count').count(), 0);
  await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
  await rows.nth(0).locator('.api-key-state.is-error').waitFor();
  fixtureDelayMs = 0;
  report.cases.push('independent-single-key-retest');
  await rows.nth(0).locator('.api-key-remove').click();
  await page.locator('[data-api-key-index="3"]').waitFor({state: 'detached'});
  assert.equal(await (await keys()).count(), 3);
  const afterRemoval = await keys();
  assert.equal(await afterRemoval.nth(0).locator('input').inputValue(), 'fixture-B');
  report.cases.push('remove-first-key-keeps-other-keys');
  fixtureDelayMs = 350;
  await page.locator('.detail-hero [data-connection-test-button]').click();
  await page.locator('.api-key-progress').waitFor();
  await page.locator('.detail-hero [data-connection-test-button]').click();
  await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
  assert.equal(await page.locator('.api-key-progress').count(), 0);
  report.cases.push('stop-prevents-later-key-checks');
  await page.locator('[data-api-key-list] .api-key-row input').nth(0).fill('fixture-B-edited');
  await page.locator('[data-api-key-list] .api-key-row input').nth(0).fill('fixture-B');
  fixtureDelayMs = 350;
  await page.locator('.detail-hero [data-connection-test-button]').click();
  await page.locator('.api-key-progress').waitFor();
  await page.locator('[data-api-key-list] .api-key-row input').nth(1).fill('fixture-C-edited');
  await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
  assert.equal(await page.locator('[data-api-key-summary]').count(), 0);
  report.cases.push('edit-during-check-clears-stale-row-results');
  fixtureDelayMs = 0;
  const hasEmptyRow = await page.locator('[data-api-key-list] .api-key-row input').evaluateAll(inputs => inputs.some(input => !input.value.trim()));
  if (!hasEmptyRow) {
    const beforeAdd = await (await keys()).count();
    await page.locator('[data-api-key-add]').click();
    await (await keys()).nth(beforeAdd).waitFor({state: 'visible'});
  }
  const currentRows = await keys();
  const emptyIndex = await currentRows.count() - 1;
  await currentRows.nth(emptyIndex).locator('input').fill('fixture-K3');
  for (let index = 0; index < 6; index++) {
    const beforeAdd = await (await keys()).count();
    await page.locator('[data-api-key-add]').click();
    const addedRows = await keys();
    await addedRows.nth(beforeAdd).waitFor({state: 'visible'});
    await addedRows.nth(beforeAdd).locator('input').fill(`fixture-K${beforeAdd}`);
  }
  const tenRows = await keys();
  for (let index = 0; index < await tenRows.count(); index++) await tenRows.nth(index).locator('input').fill(index === 0 ? 'fixture-B' : `fixture-K${index}`);
  assert.equal(await (await keys()).count(), 10);
  await page.locator('[data-api-key-add]').click();
  await (await keys()).nth(10).waitFor({state: 'visible'});
  assert.equal(await (await keys()).count(), 11);
  report.cases.push('ten-filled-key-list-plus-empty-row');
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-ten.png')}); report.screenshots.push('api-keys-ten.png');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(500);
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-dark.png')}); report.screenshots.push('api-keys-dark.png');
  await page.setViewportSize({width: 820, height: 900});
  await page.locator('[data-api-key-list] .api-key-row').first().scrollIntoViewIfNeeded();
  assert((await page.locator('[data-api-key-list] .api-key-row .el-input__wrapper').first().boundingBox()).width >= 200);
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-820.png')}); report.screenshots.push('api-keys-820.png');
  await page.setViewportSize({width: 390, height: 900});
  const railBox = await page.locator('.service-rail').boundingBox();
  const detailBox = await page.locator('.service-detail').boundingBox();
  assert(detailBox && detailBox.width >= 340, 'narrow service detail must keep nearly full viewport width');
  assert(railBox && detailBox && detailBox.y >= railBox.y + railBox.height - 1, 'narrow service detail must be below the service rail');
  const firstKeyRow = page.locator('[data-api-key-list] .api-key-row').first();
  await firstKeyRow.scrollIntoViewIfNeeded();
  const firstKeyBox = await firstKeyRow.boundingBox();
  assert(firstKeyBox && firstKeyBox.y >= 0 && firstKeyBox.y + firstKeyBox.height <= 900, 'first key row must be fully visible on narrow viewport');
  const firstKeyInputBox = await page.locator('[data-api-key-list] .api-key-row .el-input__wrapper').first().boundingBox();
  assert(firstKeyInputBox && firstKeyInputBox.width >= 200, 'narrow API Key input must remain usable');
  await page.locator('[data-api-key-list] .api-key-row input').nth(9).evaluate(element => element.scrollIntoView({block: 'center', inline: 'nearest'}));
  await page.waitForTimeout(250);
  const lastKeyBox = await page.locator('[data-api-key-list] .api-key-row').nth(9).boundingBox();
  assert(lastKeyBox && lastKeyBox.y >= 0 && lastKeyBox.y + lastKeyBox.height <= 900, 'last filled key row must be fully visible on narrow viewport');
  const detailViewport = await page.locator('.service-configuration-slot').boundingBox();
  assert(detailViewport && lastKeyBox && lastKeyBox.y >= detailViewport.y && lastKeyBox.y + lastKeyBox.height <= detailViewport.y + detailViewport.height, 'last filled row must be inside the detail scroll viewport');
  const lastKeyInput = page.locator('[data-api-key-list] .api-key-row input').nth(9);
  const lastKeyInputBox = await lastKeyInput.boundingBox();
  assert(lastKeyInputBox && lastKeyInputBox.y >= 0 && lastKeyInputBox.y + lastKeyInputBox.height <= 900, 'last filled key input must be fully visible on narrow viewport');
  assert((await lastKeyInput.inputValue()).startsWith('fixture-'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(artifactsDir, 'api-keys-narrow.png')}); report.screenshots.push('api-keys-narrow.png');
  report.cases.push('dark-narrow-no-horizontal-overflow');
  await page.close(); await open();
  const directoryToggle = page.locator('.mobile-directory-toggle');
  if (await directoryToggle.isVisible() && await directoryToggle.getAttribute('aria-expanded') !== 'true') await directoryToggle.click();
  await page.locator('[data-service-value]').filter({hasText: 'API Key Fixture'}).click();
  assert.equal(await (await keys()).count(), 11);
  report.cases.push('reopen-persistence');
  assert.equal(await page.locator('[data-api-key-auth-policy]').count(), 1);
  assert.equal(await page.locator('[data-api-key-list] [data-api-key-auth-policy]').count(), 0, 'Key requirement belongs to the compatibility tab');
  assert.equal(await page.getByTestId('custom-service-delete').count(), 1);
  assert.equal(await page.locator('.detail-hero [data-testid="custom-service-delete"]').count(), 0);
  const allKeyInputs = page.locator('[data-api-key-list] .api-key-row input');
  for (let index = 0; index < await allKeyInputs.count(); index++) {
    await allKeyInputs.nth(index).fill('');
    await page.waitForFunction(row => {
      const inputs = [...document.querySelectorAll('[data-api-key-list] .api-key-row input')];
      return inputs[row]?.value === '' || (!inputs[row] && inputs.every(input => input.value === ''));
    }, index);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('[data-api-key-list] .api-key-row input')].every(input => input.value === ''));
  await page.locator('[data-service-settings-tabs] [id$="tab-custom-request"]').click();
  const authControl = page.locator('[data-api-key-requirement-row] [data-api-key-auth-policy]');
  await authControl.getByRole('radio', {name: '允许留空', exact: true}).click();
  assert(await allKeyInputs.evaluateAll(inputs => inputs.every(input => input.value === '')), 'cleared keys must stay empty after changing authentication policy');
  const anonymousButton = page.locator('.detail-hero [data-connection-test-button]');
  assert.equal(await anonymousButton.isDisabled(), false);
  const anonymousBefore = report.requests.length;
  await anonymousButton.click();
  await page.locator('[data-api-key-list][data-api-key-busy="false"]').waitFor();
  assert.equal(report.requests.length, anonymousBefore + 1);
  assert.equal(report.requests.at(-1).key, '');
  await authControl.getByRole('radio', {name: '密钥必填', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('[data-connection-test-button]')?.disabled === true);
  assert.equal(await anonymousButton.isDisabled(), true);
  report.cases.push('advanced-anonymous-key-policy-remains-editable');
  report.cases.push('empty-required-key-disables-check-and-delete-stays-outside-header');
  await page.goto(`${origin}/options.html#settings-advanced`);
  const recoverySetting = page.getByTestId('api-key-recovery-setting');
  await recoverySetting.waitFor();
  const recoveryInput = recoverySetting.locator('input');
  const recoveryInputBox = await recoverySetting.locator('.el-input__wrapper').boundingBox();
  const recoveryUnitBox = await recoverySetting.locator('.settings-number-unit').boundingBox();
  assert(recoveryInputBox && recoveryUnitBox, 'recovery duration control must render its input and unit');
  assert(recoveryUnitBox.x >= recoveryInputBox.x && recoveryUnitBox.x + recoveryUnitBox.width <= recoveryInputBox.x + recoveryInputBox.width, 'recovery unit must stay inside the input frame');
  assert.equal(await recoveryInput.inputValue(), '1');
  await recoveryInput.fill('3');
  await recoveryInput.press('Tab');
  await page.waitForTimeout(300);
  await page.close();
  await open();
  await page.goto(`${origin}/options.html#settings-advanced`);
  await page.getByTestId('api-key-recovery-setting').waitFor();
  assert.equal(await page.getByTestId('api-key-recovery-setting').locator('input').inputValue(), '3');
  await page.getByTestId('api-key-recovery-setting').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(artifactsDir, 'api-key-recovery-setting.png')}); report.screenshots.push('api-key-recovery-setting.png');
  report.cases.push('api-key-recovery-default-one-minute-and-persistence');
  await page.goto(url);
  await page.locator('.service-catalog').waitFor();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('[data-service-value="aliyunTranslation"]').click();
  assert.equal(await page.locator('[data-cloud-credential="token"] input').count(), 1);
  assert.equal(await page.locator('[data-cloud-credential="secret"] input').count(), 1);
  assert.equal(await page.locator('[data-api-key-list]').count(), 0);
  assert.match(await page.locator('[data-connection-test-button]').innerText(), /检查连接/u);
  report.cases.push('paired-cloud-credentials-remain-a-single-pair');
  await page.locator('[data-service-value="azureTranslator"]').click();
  assert.equal(await page.locator('[data-cloud-credential="token"][data-api-key-list]').count(), 1);
  assert.equal(await page.locator('[data-cloud-credential="secret"]').count(), 0);
  assert.match(await page.locator('.api-key-heading strong').innerText(), /密钥/u);
  await page.locator('[data-api-key-list] .api-key-entry input').first().fill('fixture-azure-first');
  await enableKeyRotation();
  await page.locator('[data-api-key-add]').click();
  await (await keys()).nth(1).waitFor({state: 'visible'});
  assert.equal(await (await keys()).count(), 2);
  report.cases.push('single-key-cloud-services-support-key-lists');
  assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
  report.status = 'passed';
}
main().catch(async error => {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  try {
    if (activePage) {
      await activePage.screenshot({path: path.join(artifactsDir, 'failure.png')});
      report.failureDom = await activePage.locator('body').innerText();
    }
  } catch (captureError) { report.failureCaptureError = String(captureError); }
}).finally(async () => {
  report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (launched) {
      try {await launched.close(); closed = true;}
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
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}
  console.log(JSON.stringify({status: report.status, cases: report.cases, error: report.error, artifactsDir}, null, 2));
});
