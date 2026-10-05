import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {resolveNavigationItem, resolveRequestedSection} from '@/src/features/settings/model/navigation';

const PROJECT_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

describe('后台翻译夹具资源隔离', () => {
    it('保留扩展相对资源，仅把翻译与外部网络交给本地夹具', async () => {
        const {installTranslationFixtureOnWorker} = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs'));
        const nativeFetch = vi.fn(async (_input: unknown, _init?: unknown) => ({ok: true}));
        vi.stubGlobal('fetch', nativeFetch);
        vi.stubGlobal('location', {href: 'chrome-extension://fixture/background.js'});
        vi.stubGlobal('__fluentReadFullPageFixtureFetchInstalled', false);
        const worker = {evaluate: async (fn: (args: unknown) => unknown, args: unknown) => fn(args)};
        const urls = {translationUrl: 'http://127.0.0.1:1234/translate', blockedUrl: 'http://127.0.0.1:1234/blocked'};
        try {
            await installTranslationFixtureOnWorker(worker, urls);
            const installed = globalThis.fetch;
            await fetch('icon/16.png');
            expect(nativeFetch).toHaveBeenLastCalledWith('icon/16.png', undefined);
            await fetch('chrome-extension://fixture/icon/32.png');
            expect(nativeFetch).toHaveBeenLastCalledWith('chrome-extension://fixture/icon/32.png', undefined);
            const init = {method: 'POST', body: '["source"]'};
            await fetch('https://edge.microsoft.com/translate/translatetext', init);
            expect(nativeFetch).toHaveBeenLastCalledWith(urls.translationUrl, init);
            await fetch('https://external.example/resource');
            expect(nativeFetch).toHaveBeenLastCalledWith(urls.blockedUrl + '?url=https%3A%2F%2Fexternal.example%2Fresource', {method: 'GET'});
            await installTranslationFixtureOnWorker(worker, urls);
            expect(globalThis.fetch).toBe(installed);
        } finally {vi.unstubAllGlobals();}
    });
});
const FOCUS_SAFE_SCRIPTS = [
    'scripts/testing/run-manga-entry-ui-test.cjs',
    'scripts/testing/run-manga-translation-test.cjs',
    'scripts/testing/run-vocabulary-reencounter-test.cjs',
    'scripts/testing/run-sentence-highlight-responsiveness.cjs',
    'scripts/run-cache-settings-test.cjs',
    'scripts/run-selection-trigger-test.cjs',
    'scripts/run-full-page-translation-test.cjs',
    'scripts/run-video-subtitle-fixture-test.cjs',
    'scripts/run-document-translation-test.cjs',
    'scripts/testing/run-settings-center-ui-test.cjs',
    'scripts/testing/run-lazy-options-ui-test.cjs',
    'scripts/testing/run-popup-startup-ui-test.cjs',
    'scripts/testing/run-startup-performance.cjs',
    'scripts/testing/run-ort-runtime-smoke.cjs',
    'scripts/testing/run-loading-motion-ui-test.cjs',
    'scripts/testing/run-translation-style-ui-test.cjs',
    'scripts/testing/run-service-catalog-ui-test.cjs',
    'scripts/testing/run-service-library-ui-test.cjs',
    'scripts/run-privacy-boundary-test.cjs',
    'scripts/run-site-translation-test.cjs',
    'scripts/run-userscript-smoke-test.cjs',
    'scripts/run-video-subtitle-test.cjs',
    'scripts/run-video-performance-test.cjs',
    'scripts/run-x-subtitle-sync-test.cjs',
];

const ACTIVATED_EXTENSION_TAB_SCRIPTS = FOCUS_SAFE_SCRIPTS.filter(
    (path) => ![
        'scripts/testing/run-vocabulary-reencounter-test.cjs',
        'scripts/run-document-translation-test.cjs',
        'scripts/testing/run-settings-center-ui-test.cjs',
        'scripts/testing/run-lazy-options-ui-test.cjs',
        'scripts/testing/run-popup-startup-ui-test.cjs',
        'scripts/testing/run-startup-performance.cjs',
        'scripts/testing/run-ort-runtime-smoke.cjs',
        'scripts/testing/run-loading-motion-ui-test.cjs',
        'scripts/testing/run-service-catalog-ui-test.cjs',
        'scripts/testing/run-service-library-ui-test.cjs',
        'scripts/run-userscript-smoke-test.cjs',
    ].includes(path),
);

const RUNNER_CLI_CASES = [
    {
        path: 'scripts/run-userscript-smoke-test.cjs',
        requiredArgs: [
            '--artifact', '.output/userscript/fluent-read.user.js',
            '--playwright-root', '/tmp/playwright-runtime',
            '--artifacts-dir', '/tmp/userscript-artifacts',
        ],
    },
    {
        path: 'scripts/run-video-subtitle-test.cjs',
        requiredArgs: ['--playwright-root', '/tmp/playwright-runtime'],
    },
    {
        path: 'scripts/run-video-performance-test.cjs',
        requiredArgs: ['--playwright-root', '/tmp/playwright-runtime'],
    },
];

function readScript(path: string): string {
    return readFileSync(resolve(PROJECT_ROOT, path), 'utf8');
}

describe('browser regression focus safety', () => {
    it.each([
        {samples:[],error:'Explicit public URL subset'},
        {samples:{url:'https://example.test'},error:'Explicit public URL subset'},
        {samples:['file:///etc/hosts'],error:'HTTP(S) URLs without credentials'},
        {samples:['https://user:password@example.test'],error:'HTTP(S) URLs without credentials'},
        {samples:[{url:'https://example.test',openSelector:''}],error:'explicit selector'},
        {samples:[{url:'https://example.test',openSelector:null}],error:'explicit selector'},
        {samples:[{url:'https://example.test',openSelector:'x'.repeat(1025)}],error:'explicit selector'},
    ])('公开调查 CLI 在加载浏览器依赖及创建 profile 前拒绝不合法样本 $error', ({samples,error}) => {
        const directory=mkdtempSync(resolve(tmpdir(),'fluentread-inspection-cli-'));
        try {
            const urls=resolve(directory,'urls.json'),artifacts=resolve(directory,'artifacts');
            writeFileSync(urls,JSON.stringify(samples));
            const result=spawnSync(process.execPath,[resolve(PROJECT_ROOT,'scripts/testing/inspect-manga-readers.cjs'),
                '--urls-file',urls,'--artifacts-dir',artifacts,'--playwright-root',resolve(directory,'missing-runtime'),
                '--focus-safe-helper',resolve(directory,'missing-helper.cjs')],{encoding:'utf8',timeout:5000});
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(error);
            expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
            expect(existsSync(artifacts)).toBe(false);
        } finally {rmSync(directory,{recursive:true,force:true});}
    });
    it('实页入口在等待正文前保存 HTTP 状态，未预期的访问限制不能记为入口通过', () => {
        const source = readScript('scripts/testing/run-manga-entry-ui-test.cjs');
        const liveSource = source.slice(source.indexOf("const liveReadersFile=arg('reader-sites',null)"));
        expect(liveSource).toContain('(report.liveReaders??=[]).push(result)');
        expect(liveSource.indexOf('(report.liveReaders??=[]).push(result)')).toBeLessThan(liveSource.indexOf('if(sample.readerReadySelector)'));
        expect(liveSource.indexOf("result.result='access-restricted'")).toBeLessThan(liveSource.indexOf('if(sample.readerReadySelector)'));
        expect(liveSource).toContain('throw new Error(`Public reader access failed: HTTP');
        expect(liveSource).toContain("result.result='body-not-ready'");
        expect(liveSource).toContain('result.readerReadiness=');
    });
    it('公开正文调查的焦点或原生激活故障中止整批，创建与关闭页签均保留阶段校验', () => {
        const source = readScript('scripts/testing/inspect-manga-readers.cjs');
        expect(source).toContain("focusGuard('before-page-create')");
        expect(source).toContain("focusGuard('before-page-close')");
        expect(source).toContain("focusGuard('after-page-close')");
        expect(source).toContain("focusGuard('before-page-activation')");
        expect(source).toContain("focusGuard('after-page-activation')");
        expect(source).toMatch(/if \(error instanceof FocusSafetyError\) \{\s*report\.pages\.push\(result\);\s*throw error;/u);
        expect(source).toContain('throw new FocusSafetyError(`public-page-activation: ${error.message}`)');
        expect(source).toContain('throw new FocusSafetyError(`public-tab-state: ${error.message}`)');
        expect(source.indexOf("assert.ok(!activationExtension")).toBeLessThan(source.indexOf('fs.mkdtempSync('));
        expect(source).not.toContain('.bringToFront(');
    });
    it('全文配置读取复用隔离页并只在该页已关闭时重新创建', async () => {
        const {getConfigurationPage} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const context = {};
        const firstPage = {isClosed: vi.fn(() => false), close: vi.fn()};
        const replacement = {isClosed: vi.fn(() => false), close: vi.fn()};
        const createPage = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(replacement);

        await expect(getConfigurationPage(context, createPage)).resolves.toBe(firstPage);
        await expect(getConfigurationPage(context, createPage)).resolves.toBe(firstPage);
        expect(createPage).toHaveBeenCalledOnce();
        expect(firstPage.close).not.toHaveBeenCalled();
        firstPage.isClosed.mockReturnValue(true);
        await expect(getConfigurationPage(context, createPage)).resolves.toBe(replacement);
        expect(createPage).toHaveBeenCalledTimes(2);
        const otherCreatePage = vi.fn(async () => ({isClosed: () => false}));
        await getConfigurationPage({}, otherCreatePage);
        expect(otherCreatePage).toHaveBeenCalledOnce();
    });

    it('悬浮取消证据拒绝取消期间的新请求、短暂译文和无法恢复的新手势', () => {
        const {assertCancelledHoverGesture} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {
            initialRequests: 0,
            stages: Array.from({length: 3}, () => ({requests: 0, wrapperCount: 0, htmlStable: true})),
            freshGesture: {wrapperCount: 1, neighborCount: 0},
            restored: {wrapperCount: 0, htmlStable: true},
            urlBefore: 'http://127.0.0.1/fixture',
            urlAfter: 'http://127.0.0.1/fixture',
        };
        expect(() => assertCancelledHoverGesture(evidence)).not.toThrow();
        for (const stage of [
            {requests: 1, wrapperCount: 0, htmlStable: true},
            {requests: 0, wrapperCount: 1, htmlStable: true},
            {requests: 0, wrapperCount: 0, htmlStable: false},
        ]) {
            expect(() => assertCancelledHoverGesture({...evidence, stages: [stage, ...evidence.stages.slice(1)]}))
                .toThrow('已取消的悬浮组合键重新触发翻译');
        }
        expect(() => assertCancelledHoverGesture({
            ...evidence, freshGesture: {wrapperCount: 0, neighborCount: 0},
        })).toThrow('新悬浮手势没有正常恢复');
        expect(() => assertCancelledHoverGesture({...evidence, urlAfter: 'http://127.0.0.1/unexpected'}))
            .toThrow('新悬浮手势没有正常恢复');
    });

    it('同值属性证据同时拒绝短暂原文、缓存掩盖的 DOM 重建和几何跳动', () => {
        const {assertUnchangedAttributeStability} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const target = {sameOwner: true, sameSlots: true, htmlStable: true, domMutations: 0,
            invalidPaintFrames: 0, maxGeometryDelta: 0};
        const evidence = {beforeRequests: 5, afterRequests: 5, paintFrames: 24, targets: [target, target]};
        expect(() => assertUnchangedAttributeStability(evidence)).not.toThrow();
        for (const failure of [
            {sameOwner: false}, {sameSlots: false}, {htmlStable: false}, {domMutations: 2},
            {invalidPaintFrames: 1}, {maxGeometryDelta: 1},
        ]) {
            expect(() => assertUnchangedAttributeStability({...evidence, targets: [{...target, ...failure}, target]}))
                .toThrow('同值属性写入重建了已完成的单译文或控件');
        }
        expect(() => assertUnchangedAttributeStability({...evidence, afterRequests: 6}))
            .toThrow('同值属性写入重建了已完成的单译文或控件');
        expect(() => assertUnchangedAttributeStability({...evidence, paintFrames: 0}))
            .toThrow('同值属性写入重建了已完成的单译文或控件');
    });

    it('仅译文保护区证据要求原 Text 保留且只有剩余来源仍有译文', () => {
        const {assertSingleSourceProtection} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {beforeSlots: 2, afterSlots: 1, protectedSlots: 0,
            protectedSourcePreserved: true, sameProtectedSource: true, remainingTranslated: true,
            loadingCount: 0, retryCount: 0};
        expect(() => assertSingleSourceProtection(evidence)).not.toThrow();
        for (const failure of [{afterSlots: 2}, {afterSlots: 0}, {protectedSlots: 1},
            {protectedSourcePreserved: false}, {sameProtectedSource: false}, {remainingTranslated: false}]) {
            expect(() => assertSingleSourceProtection({...evidence, ...failure}))
                .toThrow('仅译文的后代保护边界变化没有重建正确来源');
        }
    });

    it('仅译文克隆证据拒绝丢失原文、沿用无 ShadowRoot 的克隆槽与错误恢复节点', () => {
        const {assertSingleCloneRestoration} = require(resolve(
            PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs',
        ));
        const evidence = {sameOwner: true, sourceTextPreserved: true, sameClonedSource: true,
            rebuiltSlot: true, translated: true, slotCount: 1, restoredTextPreserved: true,
            restoredClonedSource: true, restoredSlotCount: 0};
        expect(() => assertSingleCloneRestoration(evidence)).not.toThrow();
        for (const failure of [{sourceTextPreserved: false}, {sameClonedSource: false}, {rebuiltSlot: false},
            {slotCount: 2}, {restoredTextPreserved: false}, {restoredClonedSource: false}]) {
            expect(() => assertSingleCloneRestoration({...evidence, ...failure}))
                .toThrow('仅译文宿主克隆丢失原文或无法恢复');
        }
    });

    it('全文回归内建 fixture handler 只提供预期页面并禁用缓存', () => {
        const {
            assertDeterministicFixtureTraffic,
            assertNoRuntimeErrors,
            buildFixtureMicrosoftResponseBody,
            createFixtureRequestHandler,
            parseArgs,
        } = require(resolve(PROJECT_ROOT, 'scripts/run-full-page-translation-test.cjs'));
        const handler = createFixtureRequestHandler(Buffer.from('fixture html'));
        const okResponse = {writeHead: vi.fn(), end: vi.fn()};
        const missingResponse = {writeHead: vi.fn(), end: vi.fn()};

        handler({url: '/unified-translation-fixture.html'}, okResponse);
        expect(okResponse.writeHead).toHaveBeenCalledWith(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
        });
        expect(okResponse.end).toHaveBeenCalledWith(Buffer.from('fixture html'));

        handler({url: '/unexpected'}, missingResponse);
        expect(missingResponse.writeHead).toHaveBeenCalledWith(404, {
            'content-type': 'text/plain; charset=utf-8',
        });
        expect(missingResponse.end).toHaveBeenCalledWith('Not found');

        expect(JSON.parse(buildFixtureMicrosoftResponseBody(['one', '<b>two</b>']))).toEqual([
            {translations: [{text: '测试译文：one'}]},
            {translations: [{text: '测试译文：<b>two</b>'}]},
        ]);
        expect(JSON.parse(buildFixtureMicrosoftResponseBody({text: 'invalid'}))).toEqual([]);
        expect(() => assertNoRuntimeErrors([])).not.toThrow();
        expect(() => assertNoRuntimeErrors(['pageerror: fixture failed'])).toThrow(
            '全文翻译浏览器回归出现运行时错误：["pageerror: fixture failed"]',
        );
        expect(() => assertDeterministicFixtureTraffic(12, [])).not.toThrow();
        expect(() => assertDeterministicFixtureTraffic(0, [])).toThrow('未命中确定性微软翻译路由');
        expect(() => assertDeterministicFixtureTraffic(12, ['https://translate.googleapis.com/translate_a/single']))
            .toThrow('尝试访问未授权网络');

        const requiredArgs = [
            '--extension-dir', '.output/chrome-mv3',
            '--playwright-root', '/tmp/playwright-runtime',
            '--focus-safe-helper', '/tmp/focus-safe-browser.cjs',
        ];
        expect(parseArgs(requiredArgs).service).toBe('freeTranslation');
        expect(parseArgs([...requiredArgs, '--verify-loading-style-isolation']).verifyLoadingStyleIsolation).toBe(true);
        expect(() => parseArgs([...requiredArgs, '--service', 'google'])).toThrow('只允许 freeTranslation');
        expect(() => parseArgs([...requiredArgs, '--configure-service', 'google'])).toThrow('只允许 freeTranslation');
        expect(() => parseArgs([...requiredArgs, '--url', 'https://example.com/fixture'])).toThrow(
            '只允许 loopback URL',
        );
        for (const script of [
            'scripts/run-selection-trigger-test.cjs',
            'scripts/run-full-page-translation-test.cjs',
            'scripts/run-video-subtitle-fixture-test.cjs',
        ]) {
            expect(readScript(script)).toContain("'report.json'");
        }
        const selectionSource = readScript('scripts/run-selection-trigger-test.cjs');
        expect(selectionSource).toContain('if (!result.ok) throw new Error');
        const selectionHash = selectionSource.match(/\/options\.html(#[a-z-]+)/u)?.[1];
        expect(selectionHash).toBe('#settings-selection');
        const selectionSection = resolveRequestedSection(selectionHash!);
        expect(resolveNavigationItem(selectionSection).label).toBe('划词翻译');
        expect(readScript('src/features/settings/ui/SettingsSections.vue'))
            .toMatch(new RegExp(`id="${selectionSection}"[^>]*>\\s*<SelectionSettings`, 'u'));
        expect(selectionSource).not.toContain('/options.html#settings-shortcuts');
        const fullPageSource = readScript('scripts/run-full-page-translation-test.cjs');
        expect(fullPageSource).toContain("matches(':hover') === true");
        expect(fullPageSource).toContain('悬浮翻译可信手势未落到预期失败态');
        expect(fullPageSource).toContain('HOST PAGE');
        expect(fullPageSource).toContain('动态注入 hostile CSS 后');
        expect(fullPageSource).toContain('开放 ShadowRoot 动态注入 hostile CSS 后');
        expect(fullPageSource).toContain("emulateMedia({reducedMotion: 'no-preference'})");
        expect(fullPageSource).toContain("emulateMedia({reducedMotion: 'reduce'})");
        expect(fullPageSource).not.toContain(':is(span.fluent-read-loading, span[data-fr-translation-owned="true"])');
        expect(fullPageSource).toContain('full-page-loading-style-isolation.png');
        const userscriptSource = readScript('scripts/run-userscript-smoke-test.cjs');
        expect(userscriptSource).toContain("emulateMedia({reducedMotion: 'no-preference'})");
        expect(userscriptSource).toContain('}, 1000);');
        const videoSource = readScript('scripts/run-video-subtitle-fixture-test.cjs');
        expect(videoSource).toContain("const navigationMode = 'offline-youtube-fixture'");
        expect(videoSource).not.toContain('live-youtube');
        expect(videoSource).toContain("await context.route('**/*'");
        expect(videoSource).toContain('unexpectedNetworkRequests.length === 0');
        expect(videoSource).toContain('if (!evidence.ok)');
        const privacySource = readScript('scripts/run-privacy-boundary-test.cjs');
        expect(privacySource).toContain('configurePrivacySurfaces(optionsPage');
        expect(privacySource).toContain("type: 'persistConfig'");
        expect(privacySource).toContain('baseRevision');
        expect(privacySource).toContain('exportCompleteBackupViaOptionsUi');
        expect(privacySource).toContain("name: '导出备份'");
        expect(privacySource).toContain("name: '不包含并导出'");
        expect(privacySource).toContain("waitForEvent('download'");
        expect(privacySource).toContain('includesPrivateVocabularyContext');
        expect(privacySource).toContain(
            "document.querySelectorAll('[data-service-configuration-service=\"openai\"] input[type=\"password\"]')",
        );
        expect(privacySource).not.toContain('input[placeholder="\u8bf7\u8f93\u5165API\u8bbf\u95ee\u4ee4\u724c"]');
        expect(privacySource).not.toContain("name: '导出配置'");
        expect(privacySource).not.toContain('config-transfer-dialog');
        expect(privacySource).not.toContain('configurePrivacySurfaces(worker');
        expect(privacySource).not.toContain('chrome.storage.local.set({ config: next })');
    });

    it('userscript 后台 smoke 不复用 helper 可能关闭的启动页', async () => {
        const {selectUserscriptTestPage} = require(resolve(
            PROJECT_ROOT,
            'scripts/run-userscript-smoke-test.cjs',
        ));
        const startupPage = {id: 'startup'};
        const isolatedPage = {id: 'isolated'};
        const context = {pages: vi.fn(() => [startupPage])};
        const createIsolatedPage = vi.fn(async () => isolatedPage);

        await expect(selectUserscriptTestPage(true, context, createIsolatedPage)).resolves.toBe(isolatedPage);
        expect(context.pages).not.toHaveBeenCalled();
        expect(createIsolatedPage).toHaveBeenCalledOnce();

        createIsolatedPage.mockClear();
        await expect(selectUserscriptTestPage(false, context, createIsolatedPage)).resolves.toBe(startupPage);
        expect(context.pages).toHaveBeenCalledOnce();
        expect(createIsolatedPage).not.toHaveBeenCalled();
    });

    it('设置中心浏览器回归锁定完整备份与恢复契约', () => {
        const source = readScript('scripts/testing/run-settings-center-ui-test.cjs');

        expect(source).toContain("['settings-data', '备份与恢复']");
        expect(source).toContain("name: '自动设置快照'");
        expect(source).toContain("name: '导出备份'");
        expect(source).toContain("name: '从备份恢复'");
        expect(source).toContain("getByText('是否包含单词上下文？'");
        expect(source).toContain("page.waitForEvent('download'");
        expect(source).toContain("page.waitForEvent('filechooser'");
        expect(source).toContain("getByTestId('restore-source-dialog')");
        expect(source).toContain("getByTestId('local-data-import-dialog')");
        expect(source).toContain("filter({hasText: /^凭据安全/u})");
        expect(source).toContain('const hiddenCredentialSentinels = [');
        expect(source).toContain('importPreviewText.includes(sentinels.proxy)');
        expect(source).toContain("value.format !== 'fluentread-data-backup'");
        expect(source).toContain("value.configCredentialMode !== 'exact-replace'");
        expect(source).toContain("['服务 / 模型', '输入', '缓存', '输出', '次数', '总计']");
        expect(source).toContain('index % 5 === 0');
        expect(source).toContain('index % 5 === 2');
        expect(source).toContain('FluentRead 译文缓存或配置历史');
        expect(source).toContain("getByText('缓存读取未上报'");
        expect(source).toContain("getByText('暂时无法拆分输入与缓存构成'");
        expect(source).toContain("mode: 'patch'");
        expect(source).toContain('expected: {vocabularyBookEnabled: previousBetaEnabled}');
        expect(source).toContain('vocabularyBookEnabled: true');
        expect(source).not.toContain("['settings-data', '配置管理']");
        expect(source).not.toContain("name: '定时备份'");
        expect(source).not.toContain("getByRole('button', {name: '导出配置'");
        expect(source).not.toContain("getByRole('button', {name: '导入配置'");
        expect(source).not.toContain("getByTestId('config-transfer-dialog')");
    });

    it('按需设置页专项覆盖未访问分区、缓存返回、深链接与 Popup 基本交互', () => {
        const source = readScript('scripts/testing/run-lazy-options-ui-test.cjs');

        expect(source).toContain('first-general-mount-excludes-unvisited-sections');
        expect(source).toContain('interface-deep-link-mounts-target-section-first');
        expect(source).toContain('visited-sections-remain-mounted-after-return');
        expect(source).toContain('about-is-the-only-visible-content-branch');
        expect(source).toContain('boolean-setting-survives-immediate-options-close-and-reopen');
        expect(source).toContain('rapid-consecutive-setting-writes-retain-final-value');
        expect(source).toContain('options-setting-is-visible-in-reopened-popup');
        expect(source).toContain('popup-service-picker-opens-and-closes-with-escape');
        expect(source).toContain('popup-selection-drawer-opens-and-closes');
        expect(source).toContain('report.consoleErrors');
    });

    it('界面回归夹具跟随当前 Popup 快捷抽屉与服务目录结构', () => {
        const selectionSource = readScript('scripts/run-selection-trigger-test.cjs');
        expect(selectionSource).toContain('input[aria-label="划词翻译触发方式"]');
        expect(selectionSource).toContain("getByRole('group', { name: '划词翻译模式' })");
        expect(selectionSource).toContain("service: 'microsoft'");
        expect(selectionSource).not.toContain("getByText('触发方式'");
        expect(selectionSource).not.toContain('.chips.two button');

        const popupStartupSource = readScript('scripts/testing/run-popup-startup-ui-test.cjs');
        expect(popupStartupSource).toContain('Debugger.getScriptSource');
        expect(popupStartupSource).toContain("const editorMarker = 'custom-hotkey-dialog'");
        expect(popupStartupSource).not.toContain("getByRole('button', {name: '自定义', exact: true})");

        const settingsSource = readScript('scripts/testing/run-settings-center-ui-test.cjs');
        expect(settingsSource).toContain(
            "['基础配置', ['settings-general', 'settings-services', 'settings-translation', 'settings-interface']]",
        );
        expect(settingsSource).toContain("[data-service-value^=\"custom:\"]");
        for (const staleSelector of ['data-service-subgroup', '.custom-service-group', 'data-service-section-toggle', '.service-item']) {
            expect(settingsSource).not.toContain(staleSelector);
        }

        const librarySource = readScript('scripts/testing/run-service-library-ui-test.cjs');
        expect(librarySource).toContain("first-use-complete-directory");
        expect(librarySource).not.toContain("viewButton('custom')");

        const catalogSource = readScript('scripts/testing/run-service-catalog-ui-test.cjs');
        expect(catalogSource).toContain("'machine-services', 'cloud-services', 'ai-providers', 'ai-platforms'");
        expect(catalogSource).toContain('[data-free-translation-settings]');
        expect(catalogSource).not.toContain('[data-service-section="machine"]');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 的后台路径强制使用焦点安全 helper', (path) => {
        const source = readScript(path);

        expect(source).toContain('focus-safe-helper');
        expect(source).toContain('launchFocusSafePersistentContext');
        expect(source).toContain('newPageWithoutForeground');
    });

    it.each(ACTIVATED_EXTENSION_TAB_SCRIPTS)('%s 激活扩展页时不抢前台焦点', (path) => {
        const source = readScript(path);

        expect(source).toContain('activateExtensionTabWithoutForeground');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 不再使用最小化窗口或 bringToFront 伪装后台安全', (path) => {
        const source = readScript(path);

        expect(source).not.toContain('--start-minimized');
        expect(source).not.toContain('--window-position=-10000');
        expect(source).not.toContain('.bringToFront(');
        expect(source).not.toContain('playwright-minimized-fallback');
        expect(source).not.toContain('best-effort-minimized');
    });

    it.each(FOCUS_SAFE_SCRIPTS)('%s 输出可审计的启动与焦点策略', (path) => {
        const source = readScript(path);

        expect(source).toContain('launchMode');
        expect(source).toContain('focusPolicy');
        expect(source).toContain('windowPlacement');
    });

    it.each(RUNNER_CLI_CASES)('$path 默认后台模式缺少 helper 时失败即停', ({path, requiredArgs}) => {
        const {parseArgs} = require(resolve(PROJECT_ROOT, path));

        expect(() => parseArgs(requiredArgs, {})).toThrow(/--focus-safe-helper|FLUENTREAD_FOCUS_SAFE_HELPER/);
    });

    it.each(RUNNER_CLI_CASES)('$path 接受显式 helper 或环境变量，且 headed 不伪装后台', ({path, requiredArgs}) => {
        const {parseArgs} = require(resolve(PROJECT_ROOT, path));
        const explicit = parseArgs([...requiredArgs, '--focus-safe-helper', '/tmp/focus-safe-browser.cjs'], {});
        const fromEnv = parseArgs(requiredArgs, {FLUENTREAD_FOCUS_SAFE_HELPER: '/tmp/focus-safe-browser.cjs'});
        const headed = parseArgs([...requiredArgs, '--headed'], {});

        expect(explicit.background).toBe(true);
        expect(explicit.focusSafeHelper).toBe('/tmp/focus-safe-browser.cjs');
        expect(fromEnv.background).toBe(true);
        expect(fromEnv.focusSafeHelper).toBe('/tmp/focus-safe-browser.cjs');
        expect(headed.background).toBe(false);
        expect(headed.focusSafeHelper).toBe('');
    });

    it('WebKit userscript 回归只运行无窗口模式，且不需要前台浏览器 helper', () => {
        const {parseArgs} = require(resolve(PROJECT_ROOT, 'scripts/run-userscript-smoke-test.cjs'));
        const args = [...RUNNER_CLI_CASES[0].requiredArgs, '--engine', 'webkit'];

        expect(parseArgs(args, {}).engine).toBe('webkit');
        expect(() => parseArgs([...args, '--headed'], {})).toThrow('WebKit 回归只允许无窗口的后台模式');
    });

    it('站点矩阵把后台 helper、独立证据目录和网络授权传给每个子进程', () => {
        const source = readScript('scripts/run-site-translation-matrix.cjs');

        expect(source).toContain('--focus-safe-helper');
        expect(source).toContain('--artifacts-dir');
        expect(source).toContain('--allow-network');
        expect(source).toContain('--background');
        expect(source).not.toContain('--start-minimized');
        expect(source).not.toContain('.bringToFront(');
    });
});
