// 输入框翻译专项：生产扩展、隔离 Edge、真实按键和本地确定性供应商响应。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const argument = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const {chromium} = require(path.join(argument('playwright-root', path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')), 'playwright'));
const helper = require(argument('focus-safe-helper', path.join(os.homedir(), '.codex/skills/fluentread-extension-ui-test/scripts/focus-safe-browser.cjs')));
const extensionDir = path.resolve(argument('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(argument('artifacts-dir', '/private/tmp/fluentread-input-translation'));
fs.mkdirSync(artifactsDir, {recursive: true});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-input-translation-'));
const report = {extensionDir, profileDir, evidence: 'Production extension; real browser input; deterministic mock provider, no external provider certification', cases: [], consoleErrors: []};
let session;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>输入框翻译 · 交互验证</title><style>
body{margin:0;padding:48px;background:#f5f3f7;color:#292337;font:16px/1.7 system-ui}main{max-width:820px;margin:auto;background:white;border-radius:20px;padding:32px}h1{margin:0;font-size:26px}p{color:#696275}label{display:block;margin:24px 0}input,textarea,[contenteditable]{box-sizing:border-box;width:100%;padding:14px;border:1px solid #cfc8da;border-radius:10px;font:18px/1.6 system-ui}textarea{min-height:130px}small{color:#81758b}
</style></head><body><main><h1>输入框翻译</h1><p>输入、触发、继续编辑与恢复原文</p><label>消息<textarea id="message">明天下午见面。</textarea></label><label>另一输入框<input id="other" value="请帮我确认时间。"></label><label>密码<input id="password" type="password" value="private"></label><label>富文本编辑区<div id="rich" contenteditable="true"><b>这段格式需要保留。</b></div></label><label>模型驱动编辑器<div id="model" contenteditable="true"></div></label><label>纯文本编辑区<div id="plain" contenteditable="plaintext-only">你好</div></label><label>代码编辑器<div class="cm-editor"><div id="code" class="cm-content" contenteditable="true">const a = 1;</div></div></label><small>本页使用本地测试响应，验证扩展交互。</small></main><script>
// 模拟 Lexical/Draft.js：拦截 beforeinput 与 paste，只在 selectionchange 事件里同步模型选区，再由模型重新渲染 DOM。
(() => {
  const root = document.getElementById('model');
  const model = {text: '模型编辑器原文。', start: 0, end: 0};
  const log = window.modelEditorLog = [];
  const render = () => {
    root.textContent = model.text;
    if (document.activeElement !== root || !root.firstChild) return;
    const range = document.createRange();
    range.setStart(root.firstChild, model.start);
    range.setEnd(root.firstChild, model.end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  };
  const offset = (node, value) => node === root ? (value === 0 ? 0 : model.text.length) : value;
  document.addEventListener('selectionchange', () => {
    const selection = getSelection();
    if (!selection.rangeCount || !root.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    model.start = offset(range.startContainer, range.startOffset);
    model.end = offset(range.endContainer, range.endOffset);
  });
  const replace = (text, source) => {
    log.push({source, start: model.start, end: model.end, length: model.text.length, text});
    model.text = model.text.slice(0, model.start) + text + model.text.slice(model.end);
    model.start = model.end = model.start + text.length;
    render();
  };
  root.addEventListener('beforeinput', event => {
    if (event.inputType !== 'insertText') return;
    event.preventDefault();
    replace(event.data || '', 'beforeinput');
  });
  root.addEventListener('paste', event => {
    event.preventDefault();
    replace(event.clipboardData.getData('text/plain'), 'paste');
  });
  document.getElementById('message').addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter') window.pageSawCtrlEnter = true;
  });
  render();
})();
</script></body></html>`;

async function main() {
  try {
    session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
      browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true,
      headless: false, viewport: {width: 1280, height: 900}, displayTarget: 'secondary', timeout: 30000,
      browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking']});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    const context = session.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(() => {
      globalThis.inputTest = {mode: 'success', requests: [], pending: [], result: 'Let us meet tomorrow afternoon.'};
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        if (url.protocol === 'chrome-extension:') return originalFetch(input, init);
        const state = globalThis.inputTest;
        const body = JSON.parse(init?.body || '{}');
        state.requests.push({url: url.href, body});
        if (state.mode === 'pending') await new Promise(resolve => state.pending.push(resolve));
        if (state.mode === 'failure') return new Response('simulated failure', {status: 503});
        const payload = Array.isArray(body)
          ? body.map(() => ({translations: [{text: state.result}]}))
          : {id: 'input-fixture', object: 'chat.completion', created: 1, model: body.model,
            choices: [{index: 0, message: {role: 'assistant', content: state.result}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 12, completion_tokens: 8, total_tokens: 20}};
        return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
      };
    });
    const options = await helper.newPageWithoutForeground(context);
    options.on('pageerror', error => report.consoleErrors.push(error.message));
    await options.goto(`chrome-extension://${extensionId}/options.html#settings-translation`);
    await options.locator('.settings-section').first().waitFor({state: 'attached'});
    let sequence = 0;
    async function readConfig() {
      return options.evaluate(async () => {
        const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      });
    }
    async function patch(updates) {
      const result = await options.evaluate(async ({updates, sequence}) => {
        const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        const current = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
          expected: Object.fromEntries(Object.keys(updates).map(key => [key, current[key]])),
          clientId: 'input-translation-browser-test', sequence, baseRevision: current.__fluentConfigRevision});
      }, {updates, sequence: ++sequence});
      assert.equal(result.success, true, JSON.stringify(result));
      await pause(400);
    }
    async function snap(name, page = options) {
      await pause(350); // Let dialog and theme transitions settle before capturing evidence.
      const file = `${name}.png`;
      await page.screenshot({path: path.join(artifactsDir, file), animations: 'disabled'});
      for (const dialog of await page.locator('.input-translation-dialog.el-dialog').all()) {
        if (!await dialog.isVisible()) continue;
        const bounds = await dialog.boundingBox();
        const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
        report.dialogComputed ||= {};
        report.dialogComputed[name] = await dialog.evaluate(el => ({panel: {height: getComputedStyle(el).height, maxHeight: getComputedStyle(el).maxHeight, display: getComputedStyle(el).display}, body: {height: getComputedStyle(el.querySelector('.el-dialog__body')).height, overflow: getComputedStyle(el.querySelector('.el-dialog__body')).overflowY}}));
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, `dialog stays inside viewport: ${name} ${JSON.stringify(bounds)}`);
        report.dialogGeometry ||= {};
        report.dialogGeometry[name] = bounds;
      }
      return file;
    }
    async function selectTestId(testId, label) {
      await options.getByTestId(testId).click();
      await options.locator('.el-select-dropdown:visible').getByRole('option', {name: label, exact: true}).click();
      await pause(400); // Settings persist asynchronously through the background page.
    }
    const defaults = await readConfig();
    assert.equal(defaults.inputBoxTranslationInterval, 1000);
    assert.equal(defaults.inputBoxTranslationService, '', 'new input profiles follow the configured default service');
    await patch({on: true, uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, useCache: false,
      inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationTarget: 'en',
      inputBoxTranslationInterval: 600, inputBoxTranslationService: 'microsoft',
      hotkey: 'disabled', selectionTranslatorMode: 'disabled', floatingBallPosition: 'disabled',
      translationMaxRetries: 0});
    await options.reload();
    const group = options.getByTestId('input-translation-settings');
    const profileEditor = options.getByTestId('input-translation-profile-editor');
    const promptEditor = options.getByTestId('input-translation-prompts');
    async function openProfile() {
      await profileEditor.waitFor({state: 'visible'});
    }
    async function openPrompts() {
      await openProfile();
      const toggle = options.getByTestId('input-translation-prompt-toggle');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await promptEditor.waitFor({state: 'visible'});
    }
    await group.waitFor({state: 'visible'});
    await group.scrollIntoViewIfNeeded();
    assert.equal(await group.locator('.input-translation-connection-link').count(), 0);
    assert.equal(await group.getByText('选择已配置且当前可用的翻译服务。', {exact: true}).count(), 0);
    assert.equal(defaults.inputBoxTranslationOutputMode, 'replace');
    const closingOptions = await helper.newPageWithoutForeground(context);
    closingOptions.on('pageerror', error => report.consoleErrors.push(error.message));
    await closingOptions.goto(`chrome-extension://${extensionId}/options.html#settings-translation`);
    await closingOptions.getByTestId('input-translation-output-mode').click();
    await closingOptions.locator('.el-select-dropdown:visible').getByRole('option', {name: '原文在前，译文在后', exact: true}).click();
    await closingOptions.close();
    await options.reload();
    await group.waitFor({state: 'visible'});
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    assert.ok((await group.textContent()).includes('保留原文并换行追加'));
    await snap('00-bilingual-output-settings');
    report.quickClose = {field: 'inputBoxTranslationOutputMode', reopened: 'append', passed: true};
    await selectTestId('input-translation-output-mode', '替换原文');
    await selectTestId('input-translation-output-mode', '原文在前，译文在后');
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    report.latestWriteWins = {field: 'inputBoxTranslationOutputMode', finalValue: 'append', passed: true};
    await selectTestId('input-translation-output-mode', '替换原文');
    report.cases.push({name: 'output mode quick-close persistence and latest write wins; redundant service text removed', passed: true});
    report.initialConfig = Object.fromEntries(Object.entries(await readConfig()).filter(([key]) => key.startsWith('inputBoxTranslation') || key === 'on'));
    await snap('00-initial-settings');
    await options.getByTestId('input-translation-timing-toggle').click();
    const interval = options.getByTestId('input-translation-interval').locator('input');
    await interval.fill('750');
    await interval.press('Tab');
    await options.waitForFunction(async () => {
      const r = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
      return (typeof r.value === 'string' ? JSON.parse(r.value) : r.value).inputBoxTranslationInterval === 750;
    });
    await options.reload();
    await group.scrollIntoViewIfNeeded();
    assert.equal((await readConfig()).inputBoxTranslationInterval, 750);
    report.quickClose.interval = {value: 750, persistedAfterReload: true};
    await options.getByTestId('input-translation-timing-toggle').click();
    await options.getByTestId('input-translation-interval-reset').click();
    await pause(350);
    assert.equal((await readConfig()).inputBoxTranslationInterval, 1000);
    report.cases.push({name: 'interval edit and restore default', passed: true});
    await snap('01-timing-panel');
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await options.getByTestId('input-translation-timing-panel').waitFor({state: 'hidden'});
    await snap('01-settings-machine');

    const saved = await readConfig();
    await patch({service: 'microsoft', requireApiKey: {...saved.requireApiKey, 'v2:["openai","gpt-4.1-nano"]': false, 'v2:["openai","gpt-4.1-mini"]': false}, proxy: {...saved.proxy, openai: 'http://127.0.0.1:11434/v1/chat/completions'},
      model: {...saved.model, openai: 'gpt-4.1-mini'},
      user_role: {...saved.user_role, openai: 'GLOBAL PROMPT {{origin}} {{to}}'},
      system_role: {...saved.system_role, openai: 'GLOBAL SYSTEM'},
      inputBoxTranslationService: 'microsoft', inputBoxTranslationModel: '',
      inputBoxTranslationPrompt: '', inputBoxTranslationSystemPrompt: ''});
    const globalBefore = await readConfig();
    await options.reload();
    await group.scrollIntoViewIfNeeded();
    await selectTestId('input-translation-trigger', '已关闭');
    assert.ok((await group.textContent()).includes('选择一个快捷键'));
    await openProfile();
    await selectTestId('input-translation-service', 'OpenAI');
    await selectTestId('input-translation-model', 'gpt-4.1-nano');
    assert.equal((await readConfig()).inputBoxTranslationModel, 'gpt-4.1-nano', 'selecting a model updates the independent input translation profile');
    await openPrompts();
    await options.getByTestId('input-translation-system-default').click();
    await options.getByTestId('input-translation-user-default').click();
    assert.ok((await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue()).includes('professional translation assistant'));
    assert.ok((await promptEditor.locator('[data-prompt-role="user"] textarea').inputValue()).includes('{{origin}}'));
    await pause(400);
    await options.reload();
    await openPrompts();
    assert.ok((await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue()).includes('professional translation assistant'));
    await promptEditor.getByRole('button', {name: '重置此提示词，不影响其他提示词', exact: true}).first().click();
    await promptEditor.getByRole('button', {name: '重置此提示词，不影响其他提示词', exact: true}).first().click();
    assert.equal(await promptEditor.locator('[data-prompt-role="system"] textarea').inputValue(), '');
    assert.equal(await promptEditor.locator('[data-prompt-role="user"] textarea').inputValue(), '');
    await promptEditor.locator('[data-prompt-role="system"] textarea').fill('   ');
    await promptEditor.locator('[data-prompt-role="user"] textarea').fill('\n  ');
    assert.ok((await options.getByTestId('input-translation-prompt-toggle').textContent()).includes('当前使用独立默认提示词'));
    assert.equal(await promptEditor.getByRole('alert').count(), 0);
    report.cases.push({name: 'default prompts can be loaded, edited, persisted and reset; whitespace uses default semantics', passed: true});
    await promptEditor.locator('[data-prompt-role="system"] textarea').fill('Keep the message polite. Return only translated text.');
    await promptEditor.locator('[data-prompt-role="user"] textarea').fill('Translate this input into {{to}}: {{origin}}');
    await pause(500);
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationService, 'openai');
    assert.equal((await readConfig()).inputBoxTranslationModel, 'gpt-4.1-nano');
    assert.equal((await readConfig()).inputBoxTranslationSystemPrompt, 'Keep the message polite. Return only translated text.');
    await group.scrollIntoViewIfNeeded();
    assert.equal((await readConfig()).inputBoxTranslationTrigger, 'disabled', 'editing a profile must not enable translation');
    await selectTestId('input-translation-trigger', '连按三下等号(=)');
    assert.ok((await group.textContent()).includes('输入文字后，连按三下等号(=)，即可替换为英语'));
    assert.equal(await promptEditor.count(), 0, 'prompt editor is opened on demand');
    const desktopBounds = await group.boundingBox();
    assert.ok(desktopBounds.height < 600, `AI settings including bilingual output order fit one desktop screen: ${desktopBounds.height}`);
    report.settingsLayout = {desktopCardHeight: desktopBounds.height, promptEditorInitiallyClosed: true};
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await options.mouse.move(20, 20);
    await snap('02-settings-ai');
    await group.screenshot({path: path.join(artifactsDir, '02-settings-card.png'), animations: 'disabled'});
    await openProfile();
    await snap('02a-profile');
    await openPrompts();
    await promptEditor.waitFor({state: 'visible'});
    await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
    await snap('02b-prompts');
    for (const width of [820, 390]) {
      await options.setViewportSize({width, height: 900});
      await group.scrollIntoViewIfNeeded();
      const overflow = await options.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await snap(`03-settings-${width}`);
      if (width === 390) {
        await openProfile();
        await snap('03-profile-390');
        await openPrompts();
        await promptEditor.waitFor({state: 'visible'});
        const bounds = await profileEditor.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'inline input translation settings fit narrow viewport');
        await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
        await snap('03-prompts-390');
        await options.keyboard.press('Escape');
      }
    }
    await options.setViewportSize({width: 1280, height: 600});
    await openPrompts();
    await promptEditor.locator('[data-prompt-role="user"]').scrollIntoViewIfNeeded();
    await snap('03-prompts-short');
    await options.setViewportSize({width: 1280, height: 900});
    await patch({theme: 'dark'});
    await group.scrollIntoViewIfNeeded();
    await group.getByRole('heading', {name: '输入框翻译', exact: true}).click();
    await snap('04-settings-dark');
    await openProfile();
    await snap('04-profile-dark');
    await openPrompts();
    await snap('04-prompts-dark');
    await patch({theme: 'light', inputBoxTranslationInterval: 400});
    assert.equal((await readConfig()).service, 'microsoft');
    assert.deepEqual((await readConfig()).model, globalBefore.model);
    assert.deepEqual((await readConfig()).customModel, globalBefore.customModel);
    assert.equal((await readConfig()).user_role.openai, 'GLOBAL PROMPT {{origin}} {{to}}');
    report.cases.push({name: 'independent AI config, responsive layout, preserved global config', passed: true});

    await context.route('https://input-translation.example/**', route => route.fulfill({status: 200, contentType: 'text/html', body: html}));
    const page = await helper.newPageWithoutForeground(context);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    await page.goto('https://input-translation.example/test');
    await page.waitForSelector('#fluent-read-page-styles', {state: 'attached'});
    await helper.activateExtensionTabWithoutForeground(context, page);
    const textarea = page.locator('#message');
    const requests = () => worker.evaluate(() => globalThis.inputTest.requests);
    const mode = value => worker.evaluate(value => globalThis.inputTest.mode = value, value);
    const release = () => worker.evaluate(() => {
      globalThis.inputTest.mode = 'success';
      globalThis.inputTest.pending.splice(0).forEach(resolve => resolve());
    });
    async function triple(symbol = '=', gap = 60) {
      for (let i = 0; i < 3; i++) {await page.keyboard.press(symbol); if (i < 2) await pause(gap);}
    }
    async function expectValue(value) {
      try { await page.waitForFunction(value => document.querySelector('#message').value === value, value, {timeout: 15000}); }
      catch (error) {
        report.failedInput = {expected: value, actual: await textarea.inputValue(), active: await page.evaluate(() => document.activeElement?.id)};
        report.runtimeRequests = await requests();
        await snap('failed-input', page);
        throw error;
      }
    }
    await textarea.fill('明天下午见面。=');
    await triple();
    await expectValue('Let us meet tomorrow afternoon.');
    const first = (await requests()).at(-1);
    assert.equal(first.body.model, 'gpt-4.1-nano');
    assert.ok(JSON.stringify(first.body).includes('明天下午见面。='));
    assert.ok(JSON.stringify(first.body).includes('Keep the message polite.'));
    assert.ok(!JSON.stringify(first.body).includes('GLOBAL PROMPT'));
    report.cases.push({name: 'triple equal uses independent model and prompts, preserves original equals', passed: true});
    const domSession = await context.newCDPSession(page);
    const tree = await domSession.send('DOM.getDocument', {depth: -1, pierce: true});
    const findRestore = node => {
      if (node.nodeName === 'BUTTON' && (node.children || []).some(child => child.nodeValue === '恢复原文')) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = findRestore(child); if (found) return found;
      }
    };
    const restoreNode = findRestore(tree.root);
    assert.ok(restoreNode, 'successful translation offers restore original');
    const box = await domSession.send('DOM.getBoxModel', {nodeId: restoreNode.nodeId});
    const quad = box.model.content;
    await pause(250);
    const style = await domSession.send('DOM.resolveNode', {nodeId: restoreNode.nodeId});
    const visibility = await domSession.send('Runtime.callFunctionOn', {
      objectId: style.object.objectId,
      functionDeclaration: 'function() { const parent = getComputedStyle(this.parentElement); return {opacity: parent.opacity, display: parent.display, visibility: parent.visibility}; }',
      returnByValue: true,
    });
    assert.deepEqual(visibility.result.value, {opacity: '1', display: 'block', visibility: 'visible'});
    report.successTooltipVisibility = visibility.result.value;
    await snap('05-translated-input', page);
    await page.mouse.click((quad[0] + quad[4]) / 2, (quad[1] + quad[5]) / 2);
    await expectValue('明天下午见面。=');
    await textarea.focus(); await page.keyboard.press('End'); await triple();
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'restore original and translate again', passed: true});

    let before = (await requests()).length;
    await textarea.fill('间隔太慢');
    await triple('=', 550);
    await pause(500);
    assert.equal((await requests()).length, before);
    assert.equal(await textarea.inputValue(), '间隔太慢===');
    report.cases.push({name: 'slow triple does not translate', passed: true});
    await pause(450);
    await textarea.fill('这是原始消息');
    await mode('pending');
    await triple();
    await pause(500);
    await textarea.fill('这是新编辑的消息');
    await release();
    await pause(600);
    assert.equal(await textarea.inputValue(), '这是新编辑的消息');
    report.cases.push({name: 'editing while pending preserves new content', passed: true});

    await mode('pending');
    await textarea.fill('失焦后仍完成翻译');
    await triple();
    await pause(400);
    await page.locator('#other').click();
    await release();
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'blur without another edit still allows translation', passed: true});

    await mode('pending');
    await textarea.fill('取消这次翻译');
    await triple();
    await pause(400);
    await page.keyboard.press('Escape');
    const cancelledValue = await textarea.inputValue();
    await release();
    await pause(500);
    assert.equal(await textarea.inputValue(), cancelledValue);
    report.cases.push({name: 'Escape cancels late writeback', passed: true});

    await mode('failure');
    await textarea.fill('服务失败时保留我');
    await triple();
    await pause(1500);
    assert.ok((await textarea.inputValue()).startsWith('服务失败时保留我'));
    await mode('success');
    await triple();
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'failure retains text and next trigger succeeds', passed: true});

    const editorText = selector => page.locator(selector).evaluate(element => element.textContent);
    async function expectEditor(selector, value) {
      try { await page.waitForFunction(({selector, value}) => document.querySelector(selector).textContent === value, {selector, value}, {timeout: 15000}); }
      catch (error) {
        report.failedEditor = {selector, expected: value, actual: await editorText(selector)};
        await snap('failed-editor', page);
        throw error;
      }
    }
    const lastSourceText = async () => JSON.stringify((await requests()).at(-1).body);

    // 聚焦编辑宿主时光标位于开头：触发符插在原文之前，同样不能进入原文。
    await page.locator('#rich').focus(); await triple();
    await expectEditor('#rich', 'Let us meet tomorrow afternoon.');
    assert.ok((await lastSourceText()).includes('这段格式需要保留。'));
    assert.ok(!(await lastSourceText()).includes('这段格式需要保留。='), 'trigger symbols are removed from rich text source');
    await snap('06-rich-editor-translated', page);
    // macOS 撤销是 Meta+Z，其他平台是 Control+Z。
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => document.querySelector('#rich').innerHTML === '<b>==这段格式需要保留。</b>');
    report.cases.push({name: 'native rich editor translates via undoable native editing; undo restores bold formatting', passed: true});

    await page.locator('#model').focus(); await triple();
    await expectEditor('#model', 'Let us meet tomorrow afternoon.');
    const modelLog = await page.evaluate(() => window.modelEditorLog);
    const modelWrite = modelLog.at(-1);
    assert.deepEqual({source: modelWrite.source, start: modelWrite.start, end: modelWrite.end}, {source: 'paste', start: 0, end: modelWrite.length},
      `model-driven editor receives a whole-document paste after selection sync: ${JSON.stringify(modelLog)}`);
    assert.ok((await lastSourceText()).includes('模型编辑器原文。') && !(await lastSourceText()).includes('模型编辑器原文。='));
    // 上一个编辑器的提示有 300ms 淡出动画，取 DOM 中最后挂载的恢复按钮。
    await pause(400);
    const restoreButtons = [];
    const collectRestore = node => {
      if (node.nodeName === 'BUTTON' && (node.children || []).some(child => child.nodeValue === '恢复原文')) restoreButtons.push(node);
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) collectRestore(child);
    };
    collectRestore((await domSession.send('DOM.getDocument', {depth: -1, pierce: true})).root);
    report.modelRestoreCandidates = restoreButtons.length;
    const modelRestore = restoreButtons.at(-1);
    assert.ok(modelRestore, 'rich editor translation offers restore original');
    const modelQuad = (await domSession.send('DOM.getBoxModel', {nodeId: modelRestore.nodeId})).model.content;
    await pause(250);
    await page.mouse.click((modelQuad[0] + modelQuad[4]) / 2, (modelQuad[1] + modelQuad[5]) / 2);
    await expectEditor('#model', '模型编辑器原文。');
    report.modelEditorLog = await page.evaluate(() => window.modelEditorLog);
    report.cases.push({name: 'model-driven editor gets whole-content paste after selection sync, restore original', passed: true});

    await page.locator('#plain').focus(); await triple();
    await expectEditor('#plain', 'Let us meet tomorrow afternoon.');
    report.cases.push({name: 'plaintext-only editor supports triple trigger', passed: true});

    before = (await requests()).length;
    await page.locator('#password').focus(); await triple();
    await page.locator('#code').focus(); await triple();
    await pause(500);
    assert.equal((await requests()).length, before);
    const passwordValue = await page.locator('#password').inputValue();
    assert.equal(passwordValue.replace(/=/g, ''), 'private');
    assert.equal(passwordValue.length, 'private'.length + 3, 'all three password keys stay with the host input');
    assert.equal(await editorText('#code'), '===const a = 1;');
    report.cases.push({name: 'password and code editor excluded', passed: true});
    await snap('06-host-inputs-preserved', page);
    for (const [trigger, symbol] of [['triple_space', 'Space'], ['triple_dash', '-']]) {
      await patch({inputBoxTranslationTrigger: trigger});
      await textarea.fill('请保留原来的结尾-'); await triple(symbol);
      await expectValue('Let us meet tomorrow afternoon.');
    }
    await patch({inputBoxTranslationTrigger: 'ctrl_enter'});
    assert.ok((await options.getByTestId('input-translation-trigger').textContent()).includes('Ctrl+Enter'), 'saved legacy shortcut retains its readable label');
    await textarea.fill('普通快捷键翻译'); await page.keyboard.press('Control+Enter');
    await expectValue('Let us meet tomorrow afternoon.');
    assert.equal(await page.evaluate(() => window.pageSawCtrlEnter === true), false, 'consumed Control+Enter does not reach page send shortcuts');
    report.cases.push({name: 'Space, dash and Control+Enter triggers', passed: true});
    await patch({inputBoxTranslationTrigger: 'triple_equal', inputBoxTranslationInterval: 1200});
    await textarea.fill('间隔设置立即生效'); await triple('=', 650);
    await expectValue('Let us meet tomorrow afternoon.');
    report.cases.push({name: 'interval change applies without page reload', passed: true});
    await patch({inputBoxTranslationOutputMode: 'append', animations: false});
    const bilingualOriginal = '  明天下午见面。\n请确认时间。  ';
    await textarea.fill(bilingualOriginal); await triple();
    await expectValue(`${bilingualOriginal}\nLet us meet tomorrow afternoon.`);
    await snap('07-bilingual-textarea', page);
    await pause(400);
    const bilingualRestore = findRestore((await domSession.send('DOM.getDocument', {depth: -1, pierce: true})).root);
    assert.ok(bilingualRestore);
    const restoreQuad = (await domSession.send('DOM.getBoxModel', {nodeId: bilingualRestore.nodeId})).model.content;
    await page.mouse.click((restoreQuad[0] + restoreQuad[4]) / 2, (restoreQuad[1] + restoreQuad[5]) / 2);
    await expectValue(bilingualOriginal);
    await textarea.focus(); await page.keyboard.press('End'); await triple();
    await expectValue(`${bilingualOriginal}\nLet us meet tomorrow afternoon.`);
    report.cases.push({name: 'bilingual textarea preserves whitespace and paragraphs, restores and translates again', passed: true});

    await mode('pending');
    await textarea.fill('继续编辑时不要追加'); await triple(); await pause(400);
    await textarea.fill('新的回复'); await release(); await pause(500);
    assert.equal(await textarea.inputValue(), '新的回复');
    await mode('pending');
    await textarea.fill('取消追加'); await triple(); await pause(400);
    await page.keyboard.press('Escape'); await release(); await pause(500);
    assert.equal(await textarea.inputValue(), '取消追加');
    await mode('failure');
    await textarea.fill('失败保留原文'); await triple(); await pause(1000);
    assert.equal(await textarea.inputValue(), '失败保留原文');
    await mode('success');
    report.cases.push({name: 'bilingual late edit, Escape and failure preserve the original without trigger symbols', passed: true});

    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<p><b>中文原文。</b><a href="https://example.test/keep">链接</a></p><p>第二段</p>';
      window.originalBold = rich.querySelector('b');
      window.originalLink = rich.querySelector('a');
    });
    const originalRichText = await page.locator('#rich').innerText();
    await page.locator('#rich').focus(); await triple();
    await page.waitForFunction(() => document.querySelector('#rich').innerText.includes('Let us meet tomorrow afternoon.'), null, {timeout: 15000});
    const richEvidence = await page.locator('#rich').evaluate(element => ({text: element.innerText, html: element.innerHTML,
      sameBold: element.querySelector('b') === window.originalBold,
      sameLink: element.querySelector('a') === window.originalLink,
      href: element.querySelector('a')?.getAttribute('href')}));
    assert.ok(richEvidence.text.startsWith(originalRichText), 'rich original keeps its existing paragraph breaks');
    assert.match(richEvidence.text.slice(originalRichText.length), /^\n+Let us meet tomorrow afternoon\.$/, 'translation is separated by the native editor paragraph boundary');
    assert.equal(richEvidence.sameBold, true); assert.equal(richEvidence.sameLink, true);
    assert.equal(richEvidence.href, 'https://example.test/keep');
    report.bilingualRich = richEvidence;
    await snap('08-bilingual-rich-formatting', page);
    report.cases.push({name: 'bilingual rich text preserves original DOM, paragraphs, bold and link; trigger removed at starting caret', passed: true});

    await page.locator('#model').focus(); await triple();
    await expectEditor('#model', '模型编辑器原文。\nLet us meet tomorrow afternoon.');
    report.cases.push({name: 'bilingual model editor removes trigger through model and appends after selection sync', passed: true});
    before = (await requests()).length;
    await page.locator('#other').fill('单行保持原文'); await triple(); await pause(500);
    assert.equal(await page.locator('#other').inputValue(), '单行保持原文');
    assert.equal((await requests()).length, before);
    report.cases.push({name: 'single-line input keeps original and avoids flattened bilingual output', passed: true});
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'append');
    await group.scrollIntoViewIfNeeded();
    await snap('09-bilingual-settings-reopened');
    await options.setViewportSize({width: 390, height: 900});
    await group.scrollIntoViewIfNeeded();
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await snap('10-bilingual-settings-390');
    await selectTestId('input-translation-output-mode', '译文在前，原文在后');
    await options.reload();
    assert.equal((await readConfig()).inputBoxTranslationOutputMode, 'prepend');
    await group.scrollIntoViewIfNeeded();
    await snap('11-translation-first-settings');
    await textarea.fill(bilingualOriginal); await triple();
    await expectValue(`Let us meet tomorrow afternoon.\n${bilingualOriginal}`);
    await snap('12-translation-first-textarea', page);
    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<b>原文保持格式</b><a href="https://example.test/keep">链接</a>';
      window.originalBold = rich.querySelector('b');
      window.originalLink = rich.querySelector('a');
    });
    await page.locator('#rich').focus(); await triple();
    await page.waitForFunction(() => document.querySelector('#rich').innerText === 'Let us meet tomorrow afternoon.\n原文保持格式链接', null, {timeout: 15000});
    report.translationFirstRich = await page.locator('#rich').evaluate(element => ({text: element.innerText, html: element.innerHTML,
      boldTexts: [...element.querySelectorAll('b')].map(node => node.textContent),
      links: [...element.querySelectorAll('a')].map(node => ({text: node.textContent, href: node.getAttribute('href')}))}));
    assert.ok(report.translationFirstRich.boldTexts.includes('原文保持格式'), 'native prefix editing preserves original bold text even when the browser splits inline nodes');
    assert.deepEqual(report.translationFirstRich.links, [{text: '链接', href: 'https://example.test/keep'}]);
    await snap('13-translation-first-rich', page);
    report.cases.push({name: 'translation first persists and prefixes translation to textarea and rich editor while keeping original text and formatting', passed: true});
    await patch({inputBoxTranslationTrigger: 'triple_space'});
    await page.evaluate(() => {
      const rich = document.querySelector('#rich');
      rich.innerHTML = '<b>空格回复</b>';
      window.originalBold = rich.querySelector('b');
    });
    await page.locator('#rich').focus(); await triple('Space');
    await page.waitForFunction(() => document.querySelector('#rich').innerText === 'Let us meet tomorrow afternoon.\n空格回复', null, {timeout: 15000});
    assert.ok(await page.locator('#rich').evaluate(element => [...element.querySelectorAll('b')].some(node => node.textContent === '空格回复')));
    report.cases.push({name: 'rich triple-space handles browser non-breaking trigger spaces without altering original formatting', passed: true});
    assert.deepEqual(report.consoleErrors, []);
    report.runtimeRequests = await requests();
    report.persistenceCases = report.cases.filter(item => /config|interval/.test(item.name));
    report.completed = true;
  } finally {
    fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      await session.close();
      fs.rmSync(profileDir, {recursive: true, force: true});
    } else {
      try {fs.rmdirSync(profileDir);} catch { /* Retain nonempty profiles after uncertain initialization. */ }
    }
  }
}
main().catch(error => {
  report.fatal = error.stack;
  fs.writeFileSync(path.join(artifactsDir, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error);
  process.exitCode = 1;
});
