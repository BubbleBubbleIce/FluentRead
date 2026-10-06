'use strict';
/**
 * @file scripts/testing/run-request-headers-ui-test.cjs
 * 文件职责：在隔离 Edge 中验证 issue #763，服务器实际接收 Origin/Referer、DNR 发起者边界和设置保存。
 * 主要内容：创建不同域名的服务、启用与关闭移除、网页请求隔离、扩展重载及窄屏截图。
 * 模块边界：仅使用临时 profile 和本地模拟模型，不访问用户浏览器或真实付费服务；依赖 focus-safe helper。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-issue763-ui'));
const {chromium} = require(path.join(arg('playwright-root', ''), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', ''));
fs.mkdirSync(artifactsDir, {recursive: true});
const report = {extensionDir, providerEvidence: 'local-http-mock-model', cases: [], requests: [], consoleErrors: []};
let launched; let launchAttempted = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, {'content-type': 'text/html'});
      res.end('<!doctype html><html><head><title>FluentRead header fixture</title></head><body><p>Request header fixture.</p></body></html>');
      return;
    }
    let parsedBody;
    try {parsedBody = body ? JSON.parse(body) : null;}
    catch {res.writeHead(400, {'content-type': 'application/json', 'access-control-allow-origin': '*'}); res.end(JSON.stringify({error: {message: 'Invalid synthetic fixture JSON'}})); return;}
    report.requests.push({path: req.url, headers: req.headers, body: parsedBody});
    res.writeHead(200, {'content-type': 'application/json', 'access-control-allow-origin': '*'});
    res.end(JSON.stringify({id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{index: 0, message: {role: 'assistant', content: '连接成功'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
  });
});
let profileDir;
async function main() {
  await new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); reject(error);};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-issue763-'));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const otherEndpoint = `http://localhost:${server.address().port}/v1/chat/completions`;
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir,
    browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true,
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
    viewport: {width: 1440, height: 1000}, timeout: 30000,
  });
  Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
  const context = launched.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = new URL(worker.url()).origin;
  const url = `${origin === 'null' ? `chrome-extension://${new URL(worker.url()).host}` : origin}/options.html#settings-services`;
  let page;
  async function open() {
    page = await newPageWithoutForeground(context);
    page.on('pageerror', e => report.consoleErrors.push(e.message));
    await page.goto(url);
    await page.locator('.service-catalog').waitFor();
  }
  async function add(name, target = endpoint) {
    await page.getByTestId('custom-service-add').click();
    await page.getByTestId('custom-service-name').fill(name);
    await page.getByTestId('custom-service-endpoint').fill(target);
    await page.getByTestId('custom-service-api-key').fill('fixture-default-token');
    await page.getByTestId('custom-service-model').fill('fixture');
    await page.getByTestId('custom-service-save').click();
    await page.getByTestId('custom-service-dialog').waitFor({state: 'hidden'});
  }
  async function select(name) {
    await page.locator('[data-service-section="custom"] [data-service-value]').filter({hasText: name}).click();
    await page.locator('[id$="tab-custom-request"]').click();
    const customRequest = page.locator('[data-configuration-group="custom-request"]');
    return customRequest.getByTestId('custom-service-headers').locator('textarea');
  }
  async function check() {
    const before = report.requests.length;
    await page.locator('.detail-hero [data-connection-test-button]').last().click();
    await page.locator('[data-api-key-list] .api-key-state.is-success').waitFor({timeout: 30000});
    assert.equal(report.requests.length, before + 1);
    return report.requests.at(-1);
  }
  async function setHeader(row, name, enabled) {
    const checkbox = row.getByRole('checkbox', {name});
    if (await checkbox.isChecked() !== enabled) {
      await row.locator('label.el-checkbox').filter({hasText: name}).click();
    }
    assert.equal(await checkbox.isChecked(), enabled);
  }
  await open();
  await add('Issue 763 A');
  const input = await select('Issue 763 A');
  const value = JSON.stringify({'x-opencode-session': 'stable-ui-session', Authorization: 'Bearer fixture-header-token', 'X-Title': 'Fixture'});
  await input.fill(value);
  const first = await check();
  assert.equal(first.headers['x-opencode-session'], 'stable-ui-session');
  assert.equal(first.headers.authorization, 'Bearer fixture-header-token');
  assert(!JSON.stringify(first.body).includes('stable-ui-session'));
  report.cases.push('connection-test-sends-headers-separately-from-body');
  assert.match(first.headers.origin, /^chrome-extension:\/\//);
  const originalOrigin = first.headers.origin;
  report.cases.push('default-list-empty-server-receives-extension-origin');
  const ruleInput = page.getByTestId('request-header-domain');
  const addRule = page.getByTestId('request-header-add');
  await ruleInput.fill('*.example.com');
  assert(await addRule.isDisabled());
  await ruleInput.fill('127.0.0.1.example.com');
  await addRule.click();
  assert.equal((await check()).headers.origin, originalOrigin);
  await page.locator('[data-header-rule-domain="127.0.0.1.example.com"]').getByRole('button').click();
  report.cases.push('invalid-and-lookalike-domain-cannot-modify-target');
  await ruleInput.fill('127.0.0.1');
  await addRule.click();
  const active = await check();
  assert.equal(active.headers.origin, undefined);
  assert.equal(active.headers.authorization, 'Bearer fixture-header-token');
  assert.equal(active.headers['x-opencode-session'], 'stable-ui-session');
  report.cases.push('origin-removed-at-network-layer-authentication-preserved');
  const rule = page.locator('[data-header-rule-domain="127.0.0.1"]');
  await page.getByTestId('request-header-rules').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(artifactsDir, 'before-referer-check.png')});
  await setHeader(rule, '移除 Referer', true);
  await check();
  const installed = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  const networkRule = installed.find(item => item.id >= 2763000 && item.id < 2763100);
  assert.deepEqual(networkRule.action.requestHeaders.map(item => item.header.toLowerCase()).sort(), ['origin', 'referer']);
  report.cases.push('independent-referer-removal-rule-installed');
  // Browsers usually omit Referer from extension workers. Supply one using a lower-priority
  // fixture-only rule, then verify the user's explicit removal wins on the actual wire.
  await worker.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [2763200], addRules: [{
    id: 2763200, priority: 1, action: {type: 'modifyHeaders', requestHeaders: [{header: 'Referer', operation: 'set', value: 'https://fixture.example/'}]},
    condition: {regexFilter: '^http://127\\.0\\.0\\.1:', initiatorDomains: [new URL(location.href).hostname], resourceTypes: ['xmlhttprequest']},
  }]}));
  await setHeader(rule, '移除 Referer', false);
  assert.equal((await check()).headers.referer, 'https://fixture.example/');
  await setHeader(rule, '移除 Referer', true);
  assert.equal((await check()).headers.referer, undefined);
  await worker.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [2763200]}));
  report.cases.push('referer-removed-at-network-layer-when-present');
  // A website's real HTTP Origin remains intact despite matching the target domain.
  const hostPage = await newPageWithoutForeground(context);
  await hostPage.goto(`http://127.0.0.1:${server.address().port}/`);
  const beforeHost = report.requests.length;
  await hostPage.evaluate(async target => { await fetch(target, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}); }, endpoint);
  const hostRequest = report.requests.slice(beforeHost).find(item => item.path === '/v1/chat/completions');
  assert.equal(hostRequest.headers.origin, `http://127.0.0.1:${server.address().port}`);
  assert.match(hostRequest.headers.referer, /^http:\/\/127\.0\.0\.1:/);
  await hostPage.close();
  report.cases.push('website-origin-and-referer-unaffected');

  await page.close(); await open();
  const reopened = await select('Issue 763 A');
  assert.equal(await reopened.inputValue(), value);
  const reopenedRequest = await check();
  assert.equal(reopenedRequest.headers['x-opencode-session'], 'stable-ui-session');
  assert.equal(reopenedRequest.headers.origin, undefined);
  assert(await page.locator('[data-header-rule-domain="127.0.0.1"]').getByRole('checkbox', {name: '移除 Referer'}).isChecked());
  report.cases.push('close-reopen-persistence-and-stable-session');
  await reopened.scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(artifactsDir, 'custom-headers-persisted.png')});
  await add('Issue 763 B', otherEndpoint);
  assert.equal(await (await select('Issue 763 B')).inputValue(), '');
  const other = await check();
  assert.equal(other.headers['x-opencode-session'], undefined);
  assert.equal(other.headers.authorization, 'Bearer fixture-default-token');
  assert.equal(other.headers.origin, originalOrigin);
  report.cases.push('second-domain-isolated');
  const headers = await select('Issue 763 A');
  await headers.fill('{"x-invalid": 42}');
  await page.getByTestId('custom-service-headers').locator('.error-text').waitFor();
  const count = report.requests.length;
  await page.locator('.detail-hero [data-connection-test-button]').last().click();
  await page.locator('[data-api-key-list] .api-key-state.is-error').waitFor();
  assert.equal(report.requests.length, count);
  report.cases.push('invalid-header-blocks-network');
  await headers.fill('');
  assert.equal((await check()).headers.authorization, 'Bearer fixture-default-token');
  report.cases.push('clearing-restores-default-headers');
  await headers.fill(value);
  await check();
  const persisted = page.locator('[data-header-rule-domain="127.0.0.1"]');
  await persisted.scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(artifactsDir, 'request-header-rules.png')});
  await setHeader(persisted, '移除 Origin', false);
  assert.equal((await check()).headers.origin, originalOrigin);
  await setHeader(persisted, '移除 Origin', true);
  assert.equal((await check()).headers.origin, undefined);
  await persisted.getByRole('button').click();
  assert.equal((await check()).headers.origin, originalOrigin);
  report.cases.push('unchecking-and-deleting-restore-default-origin');
  await page.getByTestId('request-header-domain').fill('127.0.0.1');
  await page.getByTestId('request-header-add').click();
  assert.equal((await check()).headers.origin, undefined);
  const restart = context.waitForEvent('serviceworker', {timeout: 30000});
  await worker.evaluate(() => chrome.runtime.reload());
  await restart;
  await open();
  await select('Issue 763 A');
  assert.equal((await check()).headers.origin, undefined);
  report.cases.push('extension-restart-keeps-domain-setting-and-network-rule');
  await page.getByTestId('request-header-rules').scrollIntoViewIfNeeded();
  await page.setViewportSize({width: 820, height: 900});
  await page.getByTestId('request-header-rules').scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: path.join(artifactsDir, 'custom-headers-narrow.png')});
  report.cases.push('narrow-layout-no-page-overflow');
  assert.equal(report.consoleErrors.length, 0);
  report.status = 'passed';
}
main().catch(error => {report.status = 'failed'; report.error = error.stack; process.exitCode = 1;})
  .finally(async () => {
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
