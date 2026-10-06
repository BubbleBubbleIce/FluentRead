#!/usr/bin/env node
// 回答风格与关于页专项：真实生产扩展、独立后台 Edge，只验证布局、品牌区和赞赏码放大，不调用模型或外部赞赏服务。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
const artifactsDir = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-settings-preview-about'));
const suites = arg('suite', 'writing,about').split(',');
assert(suites.every(suite => ['writing', 'about'].includes(suite)), 'suite must be writing, about, or writing,about');
const {chromium} = require(path.join(arg('playwright-root'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper'));
const report = {ok: false, extensionDir, cases: [], screenshots: [], layout: [], consoleErrors: []};

(async () => {
  fs.mkdirSync(artifactsDir, {recursive: true});
  let profileDir; let launchAttempted = false;
  let launched;
  let page;
  try {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-preview-about-edge-'));
  launchAttempted = true;
    launched = await launchFocusSafePersistentContext({chromium, profileDir, browserPath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', background: true, headless: false, viewport: {width: 1440, height: 1000}, timeout: 30000, browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']});
    Object.assign(report, {launchMode: launched.launchMode, focusPolicy: launched.focusPolicy, windowPlacement: launched.windowPlacement});
    assert.equal(report.launchMode, 'macos-background-cdp');
    assert.equal(report.windowPlacement.browserFrontmost, false);
    const context = launched.context;
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30000});
    const origin = worker.url().split('/').slice(0, 3).join('/');
    page = await newPageWithoutForeground(context, 30000);
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    const patch = async changes => {
      const response = await page.evaluate(async changes => {
        const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        if (!read.success) throw Error(read.error);
        const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: changes, expected: Object.fromEntries(Object.keys(changes).map(key => [key, config[key]])), clientId: `preview-about-${crypto.randomUUID()}`, sequence: 1});
      }, changes);
      assert.equal(response.success, true, response.error);
    };
    const shot = async name => {
      await page.locator('.settings-app').evaluate(async root => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(root.getAnimations({subtree: true}).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      const file = path.join(artifactsDir, `${name}.png`);
      await page.screenshot({path: file}); report.screenshots.push(file);
    };
    if (suites.includes('writing')) {
      await page.goto(`${origin}/options.html#settings-writing`);
      await page.locator('.writing-settings').waitFor();
      await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, animations: false, theme: 'light'});
      await page.reload();
      const choices = page.locator('.writing-style-controls');
      const sample = page.locator('.style-preview');
      for (const width of [1440, 1024, 820, 390]) {
        await page.setViewportSize({width, height: 1000});
        await page.locator('.writing-default-style').scrollIntoViewIfNeeded();
        const settingsBox = await choices.boundingBox(); const previewBox = await sample.boundingBox();
        assert(settingsBox && previewBox);
        if (width > 1100) {
          assert(previewBox.x + previewBox.width < settingsBox.x, 'preview is on the left');
          assert(Math.abs(previewBox.y - settingsBox.y) < 2, 'columns align at the top');
          assert(settingsBox.width >= previewBox.width, 'choices retain their wider column');
        } else assert(previewBox.y + previewBox.height < settingsBox.y, 'preview precedes settings on narrow screens');
        assert(await page.locator('.writing-settings').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        report.layout.push({width, previewBox, settingsBox});
        await shot(`writing-${width}`);
      }
      await page.setViewportSize({width: 1440, height: 1000});
      const before = await sample.locator('.preview-body').innerText();
      await choices.getByRole('radiogroup', {name: '您的角色', exact: true}).getByRole('radio', {name: '维护者', exact: true}).click();
      await page.waitForFunction(previous => document.querySelector('.style-preview .preview-body')?.textContent.trim() !== previous, before);
      assert.notEqual(await sample.locator('.preview-body').innerText(), before);
      report.cases.push('left-preview-right-settings, narrow stacking and live preview');
    }

    if (suites.includes('about')) {
      await page.goto(`${origin}/options.html#settings-about`);
      await page.locator('.about-hero').waitFor();
      await patch({uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true, animations: false, theme: 'light'});
      assert.equal(await page.locator('.about-experience, .about-features, .about-feature').count(), 0);
      assert.equal(await page.locator('.about-links a').count(), 4);
      assert.equal(await page.locator('.about-support-method').count(), 2);
      for (const theme of ['light', 'dark']) {
        await patch({theme});
        for (const width of [1440, 1024, 820, 390]) {
          await page.setViewportSize({width, height: 1000});
          const layout = await page.locator('.about-hero').evaluate(hero => {
            const intro = hero.querySelector('.about-intro');
            const style = getComputedStyle(hero);
            const contact = document.querySelector('.about-wechat-contact').getBoundingClientRect();
            const project = document.querySelector('.about-links a:nth-of-type(3)').getBoundingClientRect();
            const links = document.querySelector('.about-links').getBoundingClientRect();
            const feedback = document.querySelector('.about-links a:nth-of-type(4)').getBoundingClientRect();
            return {
              contactWidth: contact.width, linksWidth: links.width, feedbackBottom: feedback.bottom, contactX: contact.x, projectX: project.x, contactY: contact.y, projectBottom: project.bottom,
              heroWidth: hero.clientWidth,
              introWidth: intro.clientWidth,
              contentWidth: hero.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
              pageOverflow: document.querySelector('.about-page').scrollWidth > document.querySelector('.about-page').clientWidth + 1,
            };
          });
          assert(Math.abs(layout.introWidth - layout.contentWidth) <= 1, 'brand intro fills the hero without an empty column');
          assert.equal(layout.horizontalOverflow, false);
          assert.equal(layout.pageOverflow, false);
          assert(Math.abs(layout.contactWidth - layout.linksWidth) <= 1, 'contact button spans the entire link grid');
          assert(Math.abs(layout.contactX - layout.projectX) <= 1, 'contact button aligns below the open-source card');
          assert(layout.contactY > Math.max(layout.projectBottom, layout.feedbackBottom), 'contact button follows open source and feedback');
          report.layout.push({section: 'about', theme, width, ...layout});
          await shot(`about-${width}-${theme}`);
        }
      }
      await patch({theme: 'light'});
      await page.setViewportSize({width: 1440, height: 1000});
      report.cases.push('removed experience card, full-width brand intro, four project links, two support entries, responsive light/dark layouts');

      const contactTrigger = page.locator('.about-wechat-contact');
      const contactDialog = page.locator('.about-wechat-contact-dialog');
      const openContact = async (keyboard = false) => {
        const count = context.pages().length;
        if (keyboard) { await contactTrigger.focus(); await page.keyboard.press('Enter'); }
        else await contactTrigger.click();
        await contactDialog.waitFor({state: 'visible'});
        await page.waitForFunction(() => !document.querySelector('.dialog-fade-enter-active'));
        const image = contactDialog.locator('img');
        await image.evaluate(image => image.decode());
        assert.deepEqual(await image.evaluate(image => [image.naturalWidth, image.naturalHeight]), [888, 1131]);
        assert.equal(await image.getAttribute('alt'), '作者微信二维码');
        assert.equal(context.pages().length, count);
        assert.equal(page.url(), `${origin}/options.html#settings-about`);
        const box = await image.boundingBox();
        const viewport = page.viewportSize();
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      };
      const contactClosed = async () => {
        await contactDialog.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement === document.querySelector('.about-wechat-contact'));
      };
      await openContact(true); await shot('wechat-contact-desktop');
      await page.keyboard.press('Tab');
      assert(await contactDialog.evaluate(el => el.contains(document.activeElement)));
      await page.keyboard.press('Escape'); await contactClosed();
      await openContact(); await contactDialog.locator('.el-dialog__headerbtn').click(); await contactClosed();
      await openContact(); await page.locator('.el-overlay-dialog').click({position: {x: 5, y: 5}}); await contactClosed();
      for (const theme of ['light', 'dark']) {
        await patch({theme}); await page.setViewportSize({width: 390, height: 844});
        await openContact(); await shot(`wechat-contact-mobile-${theme}`);
        await page.keyboard.press('Escape'); await contactClosed();
      }
      await patch({theme: 'light'}); await page.setViewportSize({width: 1440, height: 1000});
      report.cases.push('two-column WeChat contact button below open source and feedback, exact supplied QR dimensions, keyboard and click opening, close/focus return, mobile light/dark');

      const trigger = page.locator('.about-support-wechat');
      const dialog = page.locator('.about-approve-dialog');
      const open = async () => {
        const pageCount = context.pages().length;
        await trigger.click(); await dialog.waitFor({state: 'visible'});
        await page.waitForFunction(() => !document.querySelector('.dialog-fade-enter-active'));
        await dialog.locator('img').evaluate(image => image.decode());
        assert.equal(page.url(), `${origin}/options.html#settings-about`);
        assert.equal(context.pages().length, pageCount, 'opening the image does not create a tab');
        const bounds = await dialog.boundingBox();
        assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= (await page.viewportSize()).width + 1 && bounds.y + bounds.height <= (await page.viewportSize()).height + 1, 'dialog stays in the viewport');
        assert((await dialog.locator('img').boundingBox()).width > (await trigger.locator('img').boundingBox()).width, 'the preview enlarges the code');
      };
      const closed = async () => { await dialog.waitFor({state: 'hidden'}); await page.waitForFunction(() => document.activeElement === document.querySelector('.about-support-wechat')); };
      await open(); await shot('wechat-preview-desktop');
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'focus stays inside the dialog');
      await page.keyboard.press('Escape'); await closed();
      await open(); await dialog.locator('.el-dialog__headerbtn').click(); await closed();
      await open(); await page.locator('.el-overlay-dialog').click({position: {x: 5, y: 5}}); await closed();
      for (const theme of ['light', 'dark']) {
        await patch({theme}); await page.setViewportSize({width: 390, height: 844});
        await open(); await shot(`wechat-preview-mobile-${theme}`);
        await page.keyboard.press('Escape'); await closed();
      }
      await page.setViewportSize({width: 1440, height: 1000});
      for (const [locale, expected] of [['zh-CN', '放大微信赞赏码'], ['en-US', 'Enlarge the WeChat support code'], ['ja-JP', 'WeChat 支援コードを拡大'], ['ko-KR', 'WeChat 후원 코드 확대'], ['fr-FR', 'Agrandir le code de soutien WeChat'], ['ru-RU', 'Увеличить код поддержки WeChat'], ['es-ES', 'Ampliar el código de apoyo de WeChat']]) {
        await patch({uiLanguage: locale});
        await page.waitForFunction(expected => document.querySelector('.about-support-wechat')?.getAttribute('aria-label') === expected, expected);
        assert.equal(await page.locator('.about-experience, .about-features, .about-feature').count(), 0);
        const label = await trigger.getAttribute('aria-label');
        assert(label && (locale === 'zh-CN' || !/[\u4e00-\u9fff]/u.test(label) || locale === 'ja-JP'), `translated trigger ${locale}`);
        await open(); await page.keyboard.press('Escape'); await closed();
      }
      report.cases.push('in-page enlarged image, no new tab, focus trap and return, Escape/button/mask close, mobile light/dark, seven UI languages');
    }
    assert.equal(report.consoleErrors.length, 0, JSON.stringify(report.consoleErrors));
    report.ok = true;
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({path: path.join(artifactsDir, 'failure.png')}).catch(() => {});
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

    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
