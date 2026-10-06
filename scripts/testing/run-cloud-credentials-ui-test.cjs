'use strict';
/**
 * @file scripts/testing/run-cloud-credentials-ui-test.cjs
 * 文件职责：在生产扩展与隔离 Edge 中验证云服务文档、成对凭据的独立编辑和阿里云错误提示。
 * 主要内容：覆盖阿里云/百度/火山的已有 ID 更新、Secret 编辑、清空、立即关闭重开与跨服务保留，以及六家文档入口、400 停用密钥提示和再次检查成功。
 * 模块边界：仅使用合成凭据，并在本次临时 profile 的 worker 中替换阿里云响应；不连接真实翻译服务、不访问用户 profile，由 focus-safe helper 管理窗口与清理。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
function argument(name, fallback) {
 const index = process.argv.indexOf(`--${name}`);
 return index < 0 ? fallback : process.argv[index + 1];
}
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-cloud-credentials-ui'));
const playwrightRoot = argument('playwright-root', '');
const helperPath = argument('focus-safe-helper', '');
if (!playwrightRoot || !helperPath) throw new Error('必须提供 --playwright-root 和 --focus-safe-helper');
if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('扩展产物不存在');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(helperPath);
fs.mkdirSync(artifactsDir, {recursive: true});
const report = {ok: false, extensionDir, providerEvidence: 'synthetic-http-400-in-production-extension-worker', cases: [], consoleErrors: [], links: {}};
let profileDir; let launchAttempted = false;
let launched, page;
(async () => {
 try {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-aliyun-ui-'));
  launchAttempted = true;
  launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: false, background: true, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'], viewport: {width:1440,height:1100}, timeout:30000});
  Object.assign(report, {launchMode:launched.launchMode,focusPolicy:launched.focusPolicy,windowPlacement:launched.windowPlacement});
  const context = launched.context;
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // 仅此隔离 profile 使用合成响应，生产 provider 的签名、响应解析和消息/UI 链路照常执行。
  await worker.evaluate(() => {
   const originalFetch = globalThis.fetch;
   globalThis.__aliyunFixture = {code:'InvalidAccessKeyId.Inactive',status:400,calls:0};
   globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://mt.cn-hangzhou.aliyuncs.com/')) {
     const fixture = globalThis.__aliyunFixture;fixture.calls++;
     return new Response(JSON.stringify({Code:fixture.code,Message:'SYNTHETIC_RESPONSE_MUST_NOT_APPEAR',Data:fixture.status===200?{Translated:'你好'}:undefined}),{status:fixture.status,headers:{'Content-Type':'application/json'}});
    }
    return originalFetch(input, init);
   };
  });
  page = await newPageWithoutForeground(context);
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => {if (message.type() === 'warning' || message.type() === 'error') (report.consoleWarnings ||= []).push(message.text());});
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  await page.goto(`${origin}/options.html#settings-services`);
  await page.locator('.service-catalog').waitFor();
  const defaultService = await page.locator('.service-catalog').getAttribute('data-default-service');
  const expected = {
   tencent:['https://cloud.tencent.com/document/product/551/35017','额度与计费'],
   googleCloudTranslation:['https://cloud.google.com/products/translate/pricing','额度与计费'],
   azureTranslator:['https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate','接口文档'],
   aliyunTranslation:['https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translategeneral','接口文档'],
   baiduTranslation:['https://fanyi-api.baidu.com/doc/23','接口文档'],
   volcTranslation:['https://docs.volcengine.com/docs/4640/65067?lang=zh','接口文档'],
  };
  for(const [service,[href,label]] of Object.entries(expected)) {
   await page.locator(`[data-service-value="${service}"]`).click();
   const docs = page.locator('.service-detail a').filter({hasText:label});
   assert.equal(await docs.getAttribute('href'),href);
   assert.equal(await docs.getAttribute('target'),'_blank');
   report.links[service] = {href,label};
  }
  report.cases.push('all-six-cloud-doc-links-and-button-labels');
  async function select(service) {
   await page.locator(`[data-service-value="${service}"]`).click();
   await page.locator(`[data-service-configuration-service="${service}"]`).waitFor();
  }
  const idInput = () => page.locator('[data-cloud-credential="token"] input');
  const secretInput = () => page.locator('[data-cloud-credential="secret"] input');
  async function reopen() {
   const closed = page.waitForEvent('close');
   await page.close({runBeforeUnload:true});
   await closed;
   page = await newPageWithoutForeground(context);
   page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => {if (message.type() === 'warning' || message.type() === 'error') (report.consoleWarnings ||= []).push(message.text());});
   await page.goto(`${origin}/options.html#settings-services`);
   await page.locator('.service-catalog').waitFor();
  }
  const pairedServices = ['aliyunTranslation','baiduTranslation','volcTranslation'];
  for (const service of pairedServices) {
   await select(service);
   await idInput().fill(`fixture-${service}-old-id`);
   await secretInput().fill(`fixture-${service}-old-secret`);
   await idInput().fill(`fixture-${service}-new-id`);
   assert.equal(await secretInput().inputValue(),`fixture-${service}-old-secret`);
   await secretInput().fill(`fixture-${service}-new-secret`);
   assert.equal(await idInput().inputValue(),`fixture-${service}-new-id`,'editing Secret must preserve the newly edited ID');
   await idInput().fill('');
   assert.equal(await secretInput().inputValue(),`fixture-${service}-new-secret`);
   await idInput().fill(`fixture-${service}-new-id`);
   await secretInput().fill('');
   assert.equal(await idInput().inputValue(),`fixture-${service}-new-id`);
   await secretInput().fill(`fixture-${service}-new-secret`);
   // 不等待保存完成，立即关闭页面，覆盖短生命周期交接。
   await reopen();
   await select(service);
   await page.waitForFunction(service => {
    const id = document.querySelector('[data-cloud-credential="token"] input');
    const secret = document.querySelector('[data-cloud-credential="secret"] input');
    return id?.value === `fixture-${service}-new-id` && secret?.value === `fixture-${service}-new-secret`;
   }, service, {timeout:10000});
   assert.equal(await idInput().inputValue(),`fixture-${service}-new-id`);
   assert.equal(await secretInput().inputValue(),`fixture-${service}-new-secret`);
   report.cases.push(`${service}:independent-edit-clear-and-quick-close-persistence`);
  }
  for (const service of pairedServices) {
   await select(service);
   await page.waitForFunction(service => {
    const id = document.querySelector('[data-cloud-credential="token"] input');
    const secret = document.querySelector('[data-cloud-credential="secret"] input');
    return id?.value === `fixture-${service}-new-id` && secret?.value === `fixture-${service}-new-secret`;
   }, service, {timeout:10000});
   assert.equal(await idInput().inputValue(),`fixture-${service}-new-id`);
   assert.equal(await secretInput().inputValue(),`fixture-${service}-new-secret`);
  }
  report.cases.push('editing-one-cloud-service-preserves-other-services-credentials');
  await select('aliyunTranslation');
  await page.locator('.detail-hero [data-connection-test-button]').click();
  const result = page.locator('.connection-test-result.is-error');
  await result.waitFor();
  report.inactiveError = await result.innerText();
  assert.match(report.inactiveError,/400.*InvalidAccessKeyId\.Inactive.*AccessKey 已停用/su);
  assert.doesNotMatch(report.inactiveError,/SYNTHETIC_RESPONSE_MUST_NOT_APPEAR|fixture-/u);
  assert.equal(await page.locator('.service-catalog').getAttribute('data-default-service'),defaultService);
  await result.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifactsDir,'aliyun-inactive-key.png')});
  report.cases.push('inactive-key-400-shows-cause-and-does-not-expose-response-or-credentials');
  await worker.evaluate(() => Object.assign(globalThis.__aliyunFixture,{status:200,code:200}));
  await page.locator('.detail-hero [data-connection-test-button]').click();
  await page.locator('.connection-test-result.is-success').waitFor();
  report.cases.push('failed-connection-can-be-tested-again-and-succeed');
  report.requests = await worker.evaluate(() => globalThis.__aliyunFixture.calls);
  assert.equal(report.requests,2);
  assert.equal(report.consoleErrors.length,0);
  report.ok = true;
 } catch(error) {
  report.error = error.stack;
  report.assertion = {actual:error.actual,expected:error.expected};
  if (page) report.failedInputs = await page.locator('[data-cloud-credential] input').evaluateAll(inputs => inputs.map(input => ({label:input.getAttribute('aria-label'), value:input.value}))).catch(() => []);
  if(page) {await page.screenshot({path:path.join(artifactsDir,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(artifactsDir,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));}
  process.exitCode = 1;
 } finally {
  report.cleanupErrors = [];
    let closed = !launchAttempted;
    if (launched) {
      try {await launched.close(); closed = true;}
      catch (error) {report.cleanupErrors.push(`session close: ${error.message}`);}
    }
    if (profileDir) {
      if (closed) {
        try {fs.rmSync(profileDir, {recursive: true, force: true});}
        catch (error) {report.cleanupErrors.push(`profile removal: ${error.message}`); report.retainedProfile = profileDir;}
      } else report.retainedProfile = profileDir;
    }
    if (report.cleanupErrors.length) {report.ok = false; if ('status' in report) report.status = 'failed'; process.exitCode = 1;}
    try {fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));}
    catch (error) {console.error(error.stack || error); process.exitCode = 1;}

  console.log(JSON.stringify(report,null,2));
 }
})();
