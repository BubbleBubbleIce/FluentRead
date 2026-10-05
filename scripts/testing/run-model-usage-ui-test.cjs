'use strict';

// Production-only focused regression. The temporary Edge profile is launched with
// the shared macOS focus-safe helper; no user browser or network provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const playwrightRoot = path.resolve(argument('playwright-root', ''));
const focusHelper = path.resolve(argument('focus-safe-helper', ''));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-model-usage-ui'));
const browserPath = argument('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
const timeout = Number(argument('timeout', '30000'));
const dashboardSelector = '#settings-model-usage';

assert.equal(process.platform, 'darwin', '本专项仅使用 macOS 隔离 Edge 防抢焦点流程');
assert.ok(fs.existsSync(focusHelper), `防抢焦点 helper 不存在：${focusHelper}`);
assert.ok(fs.existsSync(path.join(extensionDir, 'manifest.json')), `扩展产物不存在：${extensionDir}`);
assert.ok(!extensionDir.endsWith('-dev'), '本专项必须使用 production 扩展产物');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.ok(!manifest.name.includes('DEV'), '不接受开发扩展作为 production 验证');
const optionsPath = manifest.options_page || manifest.options_ui?.page;
assert.ok(optionsPath, '清单必须声明 options 页面');
const {chromium} = require(path.join(playwrightRoot, 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(focusHelper);

async function assertBackground(context, label) {
  const session = await context.browser().newBrowserCDPSession();
  try {
    const {processInfo} = await session.send('SystemInfo.getProcessInfo');
    const browserPid = processInfo.find(process => process.type === 'browser')?.id;
    assert.ok(Number.isInteger(browserPid), '无法读取测试浏览器精确 PID');
    const {stdout} = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', [
      "ObjC.import('AppKit');",
      'const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;',
      'JSON.stringify({pid: Number(app.processIdentifier), name: ObjC.unwrap(app.localizedName)});',
    ].join('\n')], {timeout: 5000});
    const frontmost = JSON.parse(stdout.trim());
    assert.ok(Number.isInteger(frontmost.pid), '无法读取 macOS 前台应用');
    assert.notEqual(frontmost.pid, browserPid, `测试 Edge 成为了前台应用：${label}`);
    return {label, browserPid, frontmost, browserFrontmost: false};
  } finally {
    await session.detach().catch(() => {});
  }
}

function fixtures() {
  const now = Date.now();
  const localDay = daysAgo => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(12, 0, 0, 0);
    return date.getTime();
  };
  const base = {schemaVersion: 1, durationMs: 420, purpose: 'translation', outcome: 'success', usageAvailability: 'reported', statusCode: 200};
  const event = (id, daysAgo, serviceId, model, extra = {}) => ({
    ...base, id, startedAt: daysAgo ? localDay(daysAgo) : now - 1000,
    serviceId, configuredModel: model, actualModel: model, model, ...extra,
  });
  const events = [
    event('usage-ui-kimi-today', 0, 'moonshot', 'kimi-k2.6', {inputTokens: 120, outputTokens: 80, totalTokens: 200, cachedInputTokens: 20, cacheWriteTokens: 10, reasoningTokens: 30}),
    event('usage-ui-kimi-yesterday', 1, 'moonshot', 'kimi-k2.6', {inputTokens: 180, outputTokens: 120, totalTokens: 300}),
    event('usage-ui-openai-five-days', 5, 'openai', 'gpt-5.6-luna', {inputTokens: 100, outputTokens: 50, totalTokens: 150}),
    event('usage-ui-kimi-ten-days', 10, 'moonshot', 'kimi-k3', {inputTokens: 420, outputTokens: 180, totalTokens: 600}),
    event('usage-ui-kimi-unreported', 0, 'moonshot', 'kimi-k2.6', {startedAt: now - 500, usageAvailability: 'unreported'}),
    event('usage-ui-deepseek-error', 0, 'deepseek', 'deepseek-chat', {startedAt: now - 250, outcome: 'error', usageAvailability: 'unreported', statusCode: 429}),
  ];
  return {events, event};
}

async function seed(page, events) {
  await page.evaluate(async items => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('FluentReadModelUsage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('events')) throw new Error('模型用量 events 表未创建');
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('events', 'readwrite');
        const store = transaction.objectStore('events');
        store.clear();
        for (const item of items) store.put(item);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, events);
  await page.locator(`${dashboardSelector} .usage-refresh-button`).click();
}

async function waitTotals(page, tokens, requests) {
  await page.waitForFunction(({tokens, requests}) => {
    const number = selector => Number((document.querySelector(selector)?.textContent || '').replace(/[^0-9]/g, ''));
    const total = document.querySelector('#settings-model-usage .usage-token-card .usage-card-heading strong');
    return Number((total?.getAttribute('aria-label') || total?.textContent || '').replace(/[^0-9]/g, '')) === tokens
      && number('#settings-model-usage .usage-compact-card strong') === requests
      && document.querySelector('#settings-model-usage .usage-summary-grid')?.getAttribute('aria-busy') === 'false';
  }, {tokens, requests}, {timeout});
}

async function selectFilter(page, label, optionText) {
  const input = page.locator(`input[aria-label="${label}"]`);
  await input.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")][1]').click();
  const dropdown = page.locator('.el-select-dropdown:visible').first();
  await dropdown.waitFor({state: 'visible', timeout});
  await dropdown.getByRole('option', {name: optionText, exact: true}).click();
  await dropdown.waitFor({state: 'hidden', timeout});
}

async function capture(page, report, name) {
  const file = path.join(artifactsDir, `${name}.png`);
  await page.screenshot({path: file, fullPage: false});
  report.screenshots.push(file);
}

async function layout(page) {
  return page.evaluate(() => {
    const dashboard = document.querySelector('#settings-model-usage');
    const root = document.documentElement;
    const rect = dashboard.getBoundingClientRect();
    const selectors = ['.usage-toolbar', '.usage-trend-plot', '.usage-trend-inspector', '.usage-composition-card'];
    const children = selectors.map(selector => {
      const element = dashboard.querySelector(selector);
      const bounds = element?.getBoundingClientRect();
      return {selector, visible: Boolean(bounds?.width && bounds?.height), left: bounds?.left, right: bounds?.right,
        overflow: Boolean(element && element.scrollWidth > element.clientWidth + 1)};
    });
    const axisLabels = [...dashboard.querySelectorAll('.usage-trend-plot > li > span:not(.muted)')].map(element => ({
      text: element.textContent, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    return {width: innerWidth, height: innerHeight, documentOverflow: root.scrollWidth > root.clientWidth + 1,
      dashboardLeft: rect.left, dashboardRight: rect.right, children, axisLabels,
      coverageBackground: getComputedStyle(dashboard.querySelector('.usage-coverage-note')).backgroundColor};
  });
}

function assertLayout(metrics) {
  assert.equal(metrics.documentOverflow, false, `${metrics.width}px 页面横向溢出`);
  assert.ok(metrics.dashboardLeft >= -1 && metrics.dashboardRight <= metrics.width + 1, '用量页超出视口');
  for (const child of metrics.children) {
    assert.ok(child.visible, `${child.selector} 缺失`);
    assert.ok(child.left >= metrics.dashboardLeft - 1 && child.right <= metrics.dashboardRight + 1, `${child.selector} 超出用量页`);
    assert.equal(child.overflow, false, `${metrics.width}px ${child.selector} 内部横向溢出`);
  }
  assert.ok(metrics.axisLabels.length >= 2, '趋势图至少显示首尾日期');
  for (const label of metrics.axisLabels) {
    assert.notEqual(label.textOverflow, 'ellipsis', `趋势日期不应省略：${label.text}`);
    assert.ok(label.scrollWidth <= label.clientWidth + 1, `趋势日期裁切：${JSON.stringify(label)}`);
  }
}

async function main() {
  fs.mkdirSync(artifactsDir, {recursive: true});
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-model-usage-profile-'));
  const profileIdentity = fs.lstatSync(profileDir);
  const ownerFile = path.join(profileDir, '.fluentread-ui-test-owner');
  const owner = `${process.pid}-${Date.now()}`;
  fs.writeFileSync(ownerFile, owner, {flag: 'wx'});
  const report = {ok: false, suite: 'model-usage', artifactType: 'production', extensionDir, artifactsDir,
    browser: 'isolated Microsoft Edge', manifest: {version: manifest.version, optionsPath},
    launchMode: null, focusPolicy: null, windowPlacement: null, assertions: {}, caseCoverage: [],
    responsive: [], focusChecks: [], consoleErrors: [], contextConsoleErrors: [], screenshots: []};
  let launched;
  let page;
  try {
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath, headless: false, background: true,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
      viewport: {width: 1440, height: 1000}, timeout});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.focusPolicy, 'launchservices-no-foreground');
    assert.equal(report.windowPlacement.mode, 'background-visible-no-focus');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const {context} = launched;
    const worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', {timeout});
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    context.on('console', message => {
      if (message.type() === 'error') report.contextConsoleErrors.push(message.text());
    });
    page = await newPageWithoutForeground(context, timeout);
    page.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {if (message.type() === 'error') report.consoleErrors.push(message.text());});
    await page.goto(`${extensionOrigin}/${optionsPath}#settings-model-usage`, {waitUntil: 'domcontentloaded', timeout});
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator(dashboardSelector).waitFor({state: 'visible', timeout});
    await page.waitForFunction(() => document.querySelector('#settings-model-usage .usage-summary-grid'), undefined, {timeout});
    report.focusChecks.push(await assertBackground(context, 'initial options'));

    const {events, event} = fixtures();
    await seed(page, events);
    await waitTotals(page, 1250, 6);
    const dashboard = page.locator(dashboardSelector);
    const compact = await dashboard.locator('.usage-summary-grid .usage-compact-card').allTextContents();
    assert.equal(compact.length, 3, '首屏必须有请求、耗时和缓存读取三张简洁统计卡');
    assert.match(compact[1], /255\.95/, '输出速度使用四次可计算成功请求的总输出除以总耗时');
    assert.match(compact[1], /token\/s/);
    assert.match(compact[1], /420\s*ms/, '平均耗时必须按全部请求计算');
    assert.match(compact[2], /16\.7%/, '缓存读取比率分母必须是已报告缓存的输入 Token');
    const composition = await dashboard.locator('.usage-composition-row').evaluateAll(rows => Object.fromEntries(rows.map(row => [
      row.getAttribute('data-segment'), Number(row.querySelector('.usage-composition-value')?.textContent?.replace(/[^0-9]/g, '') || 0),
    ])));
    assert.deepEqual(composition, {'uncached-input': 100, 'cached-input': 20, 'unknown-cache-input': 700, output: 430});
    assert.equal(Object.values(composition).reduce((sum, value) => sum + value, 0), 1250, '缓存创建与推理不得重复加到总量');
    assert.match(await dashboard.locator('.usage-coverage-note').textContent(), /66\.7%/, '覆盖率必须包含失败的调用');
    const averages = dashboard.locator('section.usage-average-card');
    assert.equal(await averages.isVisible(), true, '平均构成常驻展示');
    assert.deepEqual((await averages.locator('.usage-average-value strong').allTextContents()).map(text => text.trim()), ['100', '20', '80']);
    const requests = dashboard.locator('section.usage-request-log-card');
    assert.equal(await requests.isVisible(), true, '模型调用记录常驻展示且只保留一个标题');
    assert.equal(await dashboard.locator('.usage-breakdown-speed').count(), 4);
    assert.match(await dashboard.locator('.usage-breakdown-speed').first().textContent(), /token\/s/);
    await requests.locator('.usage-request-table tbody tr').first().waitFor({state: 'visible', timeout});
    assert.equal(await requests.locator('.usage-request-table tbody tr').count(), 6);
    const speeds = await requests.locator('td[data-label="输出速度"]').allTextContents();
    assert.equal(speeds.filter(value => value.trim() === '— token/s').length, 2);
    assert.ok(speeds.some(value => /190\.48.*token\/s/.test(value)));
    await selectFilter(page, '按调用状态筛选请求记录', '错误');
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 1, undefined, {timeout});
    assert.match(await requests.locator('.usage-request-table tbody').textContent(), /DeepSeek/);
    await selectFilter(page, '按调用状态筛选请求记录', '全部状态');
    await selectFilter(page, '按模型缓存状态筛选请求记录', '已命中');
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 1, undefined, {timeout});
    assert.match(await requests.locator('.usage-request-table tbody').textContent(), /缓存创建（服务商上报）10 Token/);
    assert.match(await requests.locator('.usage-request-table tbody').textContent(), /推理 30/);
    await requests.locator('.usage-request-table tbody tr').first().scrollIntoViewIfNeeded();
    await capture(page, report, 'usage-request-cache-details');
    await selectFilter(page, '按模型缓存状态筛选请求记录', '全部缓存状态');
    await dashboard.locator('.usage-help-button').scrollIntoViewIfNeeded();
    const beforeHelp = await dashboard.locator('.usage-summary-grid').boundingBox();
    await dashboard.locator('.usage-help-button').click();
    await page.locator('.usage-statistics-popover:visible').waitFor({state: 'visible', timeout});
    const afterHelp = await dashboard.locator('.usage-summary-grid').boundingBox();
    assert.equal(afterHelp.y, beforeHelp.y, '统计说明开关不得移动概览');
    assert.equal(afterHelp.height, beforeHelp.height);
    await capture(page, report, 'usage-statistics-help');
    await dashboard.locator('.usage-help-button').click();
    await dashboard.locator('.usage-local-badge').hover();
    await page.getByRole('tooltip').filter({hasText: '仅统计当前浏览器保留的最近 1,000 次模型调用'}).waitFor({state: 'visible', timeout});
    report.assertions.helpOverlayKeepsLayoutAndLocalTooltip = true;
    const modelRow = dashboard.locator('.usage-breakdown-list > button').filter({hasText: 'kimi-k3'});
    await modelRow.click();
    await waitTotals(page, 600, 1);
    await modelRow.click();
    await waitTotals(page, 1250, 6);
    report.assertions.repeatModelClickClearsFilter = true;
    report.assertions.overview = {tokens: 1250, requests: 6, averageDurationMs: 420, cacheInputRate: '16.7%', composition};
    report.assertions.cacheAndReasoningNotDoubleCounted = true;
    report.assertions.alwaysVisibleAveragesAndRequestFilters = true;

    // Delay the delivery of one real background response to exercise request-list
    // invalidation. The extension still queries its actual IndexedDB repository.
    await dashboard.locator('.usage-refresh-button').click();
    await waitTotals(page, 1250, 6);
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      const gate = {held: false, released: false, restore: () => {chrome.runtime.sendMessage = original;}};
      const delay = new Promise(resolve => {gate.release = resolve;});
      chrome.runtime.sendMessage = function(message, ...args) {
        const response = original.call(chrome.runtime, message, ...args);
        if (message?.type !== 'modelUsage' || message.action !== 'list' || gate.held) return response;
        gate.held = true;
        return Promise.resolve(response).then(async result => {
          await delay;
          gate.released = true;
          return result;
        });
      };
      window.__modelUsageResponseGate = gate;
    });
    try {
      await dashboard.locator('.usage-refresh-button').click();
      await page.waitForFunction(() => window.__modelUsageResponseGate.held, undefined, {timeout});
      await selectFilter(page, '模型用量服务', 'DeepSeek');
      await waitTotals(page, 0, 1);
      await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 1, undefined, {timeout});
      assert.match(await requests.locator('.usage-request-table tbody').textContent(), /DeepSeek/);
      await page.evaluate(() => window.__modelUsageResponseGate.release());
      await page.waitForFunction(() => window.__modelUsageResponseGate.released, undefined, {timeout});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await requests.locator('.usage-request-table tbody tr').count(), 1, '较旧请求记录覆盖了新筛选');
      assert.match(await requests.locator('.usage-request-table tbody').textContent(), /DeepSeek/);
    } finally {
      await page.evaluate(() => {window.__modelUsageResponseGate.release(); window.__modelUsageResponseGate.restore(); delete window.__modelUsageResponseGate;});
    }
    await dashboard.getByRole('button', {name: '重置筛选', exact: true}).click();
    await waitTotals(page, 1250, 6);
    report.assertions.delayedListCannotOverwriteNewFilter = true;

    const metric = dashboard.getByLabel('趋势指标', {exact: true});
    const tokenButton = metric.getByRole('button', {name: 'Token', exact: true});
    const requestButton = metric.getByRole('button', {name: '请求次数', exact: true});
    assert.equal(await tokenButton.getAttribute('aria-pressed'), 'true');
    const points = dashboard.locator('.usage-trend-point');
    assert.equal(await points.count(), 30);
    const lastPoint = points.last();
    assert.match(await lastPoint.getAttribute('aria-label'), /200/);
    await lastPoint.click();
    const inspector = dashboard.locator('.usage-trend-inspector');
    assert.match(await inspector.textContent(), /200/);
    await points.first().focus();
    await points.first().press('Enter');
    assert.match(await inspector.textContent(), /0/);
    await points.first().press('End');
    assert.equal(await lastPoint.evaluate(button => button === document.activeElement), true);
    assert.match(await inspector.textContent(), /200/);
    await lastPoint.press('ArrowLeft');
    assert.equal(await points.nth(28).evaluate(button => button === document.activeElement), true);
    await points.nth(28).press('ArrowRight');
    assert.equal(await lastPoint.evaluate(button => button === document.activeElement), true);
    await requestButton.click();
    assert.equal(await requestButton.getAttribute('aria-pressed'), 'true');
    assert.equal(await tokenButton.getAttribute('aria-pressed'), 'false');
    await lastPoint.focus();
    assert.match(await lastPoint.getAttribute('aria-label'), /3/);
    assert.match(await inspector.textContent(), /3/);
    await capture(page, report, 'usage-trend-requests');
    await tokenButton.click();
    report.assertions.trendMetricsKeyboardAndExactInspector = true;

    await selectFilter(page, '模型用量服务', '月之暗面/Kimi');
    await selectFilter(page, '模型用量模型', 'kimi-k3');
    const rangeGroup = dashboard.getByRole('radiogroup', {name: '模型用量时间范围'});
    await rangeGroup.getByRole('radio', {name: '30 天', exact: true}).focus();
    await rangeGroup.getByRole('radio', {name: '30 天', exact: true}).press('Home');
    await waitTotals(page, 0, 0);
    await dashboard.getByText('当前筛选还没有调用记录', {exact: true}).waitFor({state: 'visible', timeout});
    await capture(page, report, 'usage-filtered-empty');
    await dashboard.getByRole('button', {name: '查看全部用量', exact: true}).click();
    await waitTotals(page, 1250, 6);
    assert.equal(await rangeGroup.getByRole('radio', {name: '30 天', exact: true}).getAttribute('aria-checked'), 'true');
    assert.deepEqual((await dashboard.locator('.usage-select-shell .el-select__placeholder').allTextContents()).map(text => text.trim()), ['全部 AI 服务', '全部模型']);
    report.assertions.filterEmptyResetAndRangeKeyboard = true;

    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      for (const width of [1440, 820, 390]) {
        await page.setViewportSize({width, height: 1000});
        await dashboard.scrollIntoViewIfNeeded();
        await page.evaluate(() => {const panel = document.querySelector('.settings-card'); if (panel) panel.scrollTop = 0;});
        const metrics = await layout(page);
        assertLayout(metrics);
        if (theme === 'dark') {
          const light = report.responsive.find(item => item.theme === 'light' && item.width === width);
          assert.notEqual(metrics.coverageBackground, light.coverageBackground, '暗色上报率提示条没有切换背景');
          const channels = metrics.coverageBackground.match(/[\d.]+/g)?.slice(0, 3).map(Number);
          assert.ok(channels?.length === 3 && Math.max(...channels) < 120, `暗色上报率提示背景过亮：${metrics.coverageBackground}`);
        }
        const modelSpeedLayout = await dashboard.locator('.usage-breakdown-speed').evaluateAll(rows => rows.map(row => ({text: row.textContent, scroll: row.scrollWidth, client: row.clientWidth, whitespace: getComputedStyle(row).whiteSpace})));
        assert.ok(modelSpeedLayout.every(row => row.scroll <= row.client + 1 && row.whitespace === 'normal'), `逐模型速度在窄屏也必须完整显示: ${width} ${JSON.stringify(modelSpeedLayout)}`);
        report.responsive.push({theme, ...metrics});
        report.focusChecks.push(await assertBackground(context, `${theme} ${width}px`));
        await capture(page, report, `usage-overview-${theme}-${width}`);
        if (width === 390) {
          for (const [selector, name] of [['.usage-trend-card', 'trend'], ['.usage-composition-card', 'composition'], ['.usage-breakdown-card', 'models']]) {
            await dashboard.locator(selector).scrollIntoViewIfNeeded();
            await capture(page, report, `usage-${name}-${theme}-${width}`);
          }
                await requests.locator('.usage-request-log-header').scrollIntoViewIfNeeded();
          await capture(page, report, `usage-request-records-${theme}-${width}`);
          await requests.locator('.usage-request-table tbody tr').first().scrollIntoViewIfNeeded();
          const requestOverflow = await requests.evaluate(element => element.scrollWidth > element.clientWidth + 1);
          assert.equal(requestOverflow, false, `${theme} ${width}px 展开的请求记录横向溢出`);
          await capture(page, report, `usage-request-row-${theme}-${width}`);
              }
      }
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await seed(page, [event('usage-ui-unreported', 0, 'deepseek', 'deepseek-chat', {usageAvailability: 'unreported'})]);
    await waitTotals(page, 0, 1);
    assert.equal((await dashboard.locator('.usage-token-card .usage-card-heading strong').textContent()).trim(), '—');
    assert.match(await dashboard.locator('.usage-coverage-note').textContent(), /0%/);
    assert.match(await dashboard.locator('.usage-composition-card').textContent(), /未上报/);
    assert.equal(await dashboard.locator('.usage-composition-row').count(), 0, '未上报不能伪装成零值构成');
    await capture(page, report, 'usage-unreported');
    // Failed requests can report tokens: they must stay in both sides of the coverage calculation.
    await seed(page, [
      event('usage-ui-reported-error', 0, 'deepseek', 'deepseek-chat', {outcome: 'error', inputTokens: 10, outputTokens: 0, totalTokens: 10, statusCode: 500}),
      event('usage-ui-unreported-success', 0, 'deepseek', 'deepseek-chat', {usageAvailability: 'unreported'}),
    ]);
    await waitTotals(page, 10, 2);
    assert.match(await dashboard.locator('.usage-coverage-note').textContent(), /50%/);
    report.assertions.reportedFailureCoverageAndUnreportedBoundary = true;

    await seed(page, [event('usage-ui-reported-zero', 0, 'openai', 'gpt-5.6-luna', {inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0})]);
    await waitTotals(page, 0, 1);
    assert.equal((await dashboard.locator('.usage-token-card .usage-card-heading strong').textContent()).trim(), '0');
    assert.match(await dashboard.locator('.usage-composition-card').textContent(), /已上报用量为 0 Token/);
    assert.equal(await dashboard.locator('.usage-coverage-note').count(), 0);
    await seed(page, [event('usage-ui-exact-large', 0, 'openai', 'gpt-5.6-luna', {inputTokens: 123456, outputTokens: 6543, totalTokens: 129999, cachedInputTokens: 1234})]);
    await waitTotals(page, 129999, 1);
    assert.match(await points.last().getAttribute('aria-label'), /共 129,999 Token/);
    await points.last().focus();
    assert.match(await inspector.textContent(), /129,999/);
    assert.match(await inspector.textContent(), /122,222/);
    assert.match(await inspector.textContent(), /1,234/);
    report.assertions.reportedZeroAndExactLargeNumbers = true;

    await seed(page, [
      event('usage-writing', 0, 'openai', 'purpose-model', {purpose: 'writing', inputTokens: 1, outputTokens: 1, totalTokens: 2}),
      event('usage-reading', 0, 'openai', 'purpose-model', {purpose: 'reading', inputTokens: 1, outputTokens: 1, totalTokens: 2}),
    ]);
    await waitTotals(page, 4, 2);
    for (const purpose of ['写作助手', '阅读理解']) {
      await selectFilter(page, '按调用场景筛选请求记录', purpose);
      await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 1, undefined, {timeout});
      assert.match(await requests.locator('tbody').textContent(), new RegExp(purpose));
      assert.equal(await requests.locator('.usage-request-log-error').count(), 0);
    }
    await requests.getByRole('button', {name: '重置筛选', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 2, undefined, {timeout});
    assert.deepEqual((await requests.locator('.usage-request-filters .el-select__placeholder').allTextContents()).map(text => text.trim()), ['全部场景', '全部状态', '全部缓存状态']);
    report.assertions.writingReadingAndResetFilters = true;
    const paging = Array.from({length: 63}, (_, index) => event(`usage-ui-page-${index}`, 0, 'openai', `paging-model-${String(index).padStart(2, '0')}`, {
      startedAt: Date.now() - index * 1000, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0,
    }));
    await seed(page, paging);
    await waitTotals(page, 126, 63);
    await selectFilter(page, '每页请求记录数量', '20 条');
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 20, undefined, {timeout});
    await requests.getByRole('spinbutton', {name: '跳转到页码', exact: true}).fill('4');
    await requests.getByRole('spinbutton', {name: '跳转到页码', exact: true}).press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 3, undefined, {timeout});
    assert.match(await requests.locator('.usage-request-pagination').textContent(), /第 4 \/ 4 页/);
    assert.equal(await requests.getByRole('button', {name: '下一页', exact: true}).isDisabled(), true);
    await requests.locator('.usage-request-log-footer').scrollIntoViewIfNeeded();
    await capture(page, report, 'usage-request-page-jump');
    const lastPageModels = await requests.locator('.usage-request-service small').allTextContents();
    assert.deepEqual(lastPageModels, ['paging-model-60', 'paging-model-61', 'paging-model-62']);
    await requests.getByRole('button', {name: '上一页', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('.usage-request-table tbody tr').length === 20, undefined, {timeout});
    report.assertions.requestPagination = {events: 63, pageSize: 20, finalPageModels: lastPageModels};

    await seed(page, []);
    await waitTotals(page, 0, 0);
    await dashboard.getByText('还没有模型调用记录', {exact: true}).waitFor({state: 'visible', timeout});
    await capture(page, report, 'usage-empty');
    await seed(page, events);
    await waitTotals(page, 1250, 6);
    report.assertions.refreshAndEmpty = true;
    await dashboard.locator('.usage-reset-button').click();
    const resetDialog = page.getByRole('alertdialog');
    await resetDialog.waitFor({state: 'visible', timeout});
    assert.equal(await page.locator('.settings-app').getAttribute('inert'), '');
    const cancelReset = resetDialog.getByRole('button', {name: '取消', exact: true});
    const confirmReset = resetDialog.getByRole('button', {name: '确认清除统计', exact: true});
    assert.equal(await cancelReset.evaluate(button => button === document.activeElement), true);
    await cancelReset.press('Shift+Tab');
    assert.equal(await confirmReset.evaluate(button => button === document.activeElement), true);
    await confirmReset.press('Tab');
    assert.equal(await cancelReset.evaluate(button => button === document.activeElement), true);
    await cancelReset.press('Escape');
    await resetDialog.waitFor({state: 'hidden', timeout});
    assert.equal(await page.locator('.settings-app').getAttribute('inert'), null);
    await dashboard.locator('.usage-reset-button').click();
    await confirmReset.click();
    await waitTotals(page, 0, 0);
    await resetDialog.waitFor({state: 'hidden', timeout});
    assert.equal(await page.locator('.settings-app').getAttribute('inert'), null);
    assert.equal(await dashboard.locator('.usage-reset-button').evaluate(button => button === document.activeElement), true);
    report.assertions.resetFocusTrapCancelAndClear = true;
    await seed(page, events);
    await waitTotals(page, 1250, 6);
    await page.evaluate(async () => {
      const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      if (!stored?.success || !stored.value) throw new Error(stored?.error || '读取英文 UI 测试配置基线失败');
      const response = await chrome.runtime.sendMessage({
        type: 'persistConfig', mode: 'patch', config: {uiLanguage: 'en-US', uiLanguageSetupCompleted: true},
        expected: {uiLanguage: stored.value.uiLanguage, uiLanguageSetupCompleted: stored.value.uiLanguageSetupCompleted},
        clientId: 'model-usage-ui-language-fixture', sequence: 1,
      });
      if (!response?.success) throw new Error(response?.error || '保存英文 UI 测试配置失败');
    });
    await page.reload({waitUntil: 'domcontentloaded', timeout});
    await dashboard.waitFor({state: 'visible', timeout});
    await waitTotals(page, 1250, 6);
    for (const label of ['Token usage', 'Model requests', 'Average duration', 'Cache read ratio', 'Usage trend', 'Usage breakdown']) {
      await dashboard.getByText(label, {exact: true}).waitFor({state: 'visible', timeout});
    }
    assert.equal((await dashboard.locator('.usage-refresh-button').textContent()).trim(), 'Refresh');
    await capture(page, report, 'usage-overview-en-US-1440');
    report.assertions.englishOverview = true;
    report.focusChecks.push(await assertBackground(context, 'completed'));
    assert.equal(report.consoleErrors.length, 0, '页面控制台有错误');
    assert.equal(report.contextConsoleErrors.length, 0, '浏览器上下文控制台有错误');
    report.caseCoverage = Object.keys(report.assertions).map(name => ({name, ok: true}));
    report.ok = true;
  } catch (error) {
    report.failure = {message: error.message, stack: error.stack};
    if (/测试 Edge 成为了前台应用/.test(error.message) && report.windowPlacement) report.windowPlacement.browserFrontmost = true;
    if (page && !page.isClosed()) await capture(page, report, 'failure').catch(() => {});
    throw error;
  } finally {
    try {
      await launched?.close();
      report.cleanup = {browserClosed: Boolean(launched)};
      assert.equal(fs.readFileSync(ownerFile, 'utf8'), owner);
      const current = fs.lstatSync(profileDir);
      assert.ok(current.dev === profileIdentity.dev && current.ino === profileIdentity.ino && !current.isSymbolicLink());
      fs.rmSync(profileDir, {recursive: true});
      report.cleanup.profileRemoved = !fs.existsSync(profileDir);
    } catch (error) {
      report.cleanupError = error.message;
      throw error;
    } finally {
      fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
