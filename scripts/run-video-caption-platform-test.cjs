#!/usr/bin/env node
// 生产扩展平台字幕夹具：隔离 profile、后台可见窗口、可重复的原生轨道与确定性翻译响应。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };

async function main() {
    const extensionDir = path.resolve(arg('extension-dir', '.output/chrome-mv3'));
    const artifacts = path.resolve(arg('artifacts-dir', path.join(os.tmpdir(), 'fluentread-caption-platforms')));
    const helperPath = arg('focus-safe-helper');
    if (!helperPath || !fs.existsSync(helperPath)) throw new Error('必须提供已验证的 --focus-safe-helper');
    const helper = require(helperPath);
    const runtimeRequire = createRequire(path.join(path.resolve(arg('playwright-root')), 'fluentread-caption-fixture.cjs'));
    const {chromium} = runtimeRequire('playwright');
    fs.mkdirSync(artifacts, {recursive: true});
    const mediaFile = path.join(artifacts, 'fixture.mp4');
    const media = spawnSync(arg('ffmpeg', '/opt/homebrew/bin/ffmpeg'), ['-y', '-f', 'lavfi', '-i', 'color=c=#263a55:s=800x450:r=5', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaFile], {encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL'});
    if (media.status !== 0) throw new Error(media.stderr);
    const mediaUrl = `data:video/mp4;base64,${fs.readFileSync(mediaFile).toString('base64')}`;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-caption-platform-profile-'));
    let session;
    const results = [], errors = [];
    let bilingualDownload = false;
    const report = {results, errors};
    try {
        session = await helper.launchFocusSafePersistentContext({chromium, profileDir,
            browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
            headless: false, background: true, displayTarget: 'secondary', viewport: {width: 1280, height: 900},
            browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
        });
        const context = session.context;
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const extensionId = new URL(worker.url()).host;
        await worker.evaluate(() => {
            const native = globalThis.fetch.bind(globalThis);
            globalThis.__captionFixtureRequests = [];
            globalThis.fetch = async (input, init) => {
                const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
                if (url.startsWith('https://edge.microsoft.com/translate/translatetext')) {
                    const texts = JSON.parse(init.body); globalThis.__captionFixtureRequests.push(...texts.map(item => item.Text));
                    return new Response(JSON.stringify(texts.map(() => ({translations: [{text: '机器译文：会议或视频字幕', to: 'zh-Hans'}]}))), {headers: {'content-type': 'application/json'}});
                }
                if (/^https?:/.test(url)) throw new Error('字幕夹具阻止了外网请求');
                return native(input, init);
            };
        });
        const page = await helper.newPageWithoutForeground(context);
        page.on('pageerror', error => errors.push(error.message));
        const source = 'This is a caption about the meeting and the video.';
        const fixture = platform => {
            const captionAttributes = {meet: 'class="ygicle VbkSUe"', teams: 'data-tid="closed-caption-text"', zoom: 'class="live-transcription-subtitle__item"', udemy: 'data-purpose="captions-cue-text"', disney: 'class="dss-hls-subtitle-overlay"'}[platform];
            if (['meet', 'teams', 'zoom'].includes(platform)) return `<!doctype html><html><head><title>${platform} caption fixture</title><style>body{font:18px system-ui;background:#edf2f8;padding:45px}button{padding:12px}#meeting{height:400px;background:#263a55;color:white;padding:40px;border-radius:16px}</style></head><body><h1>${platform} 网页会议字幕</h1><button id="enable" aria-label="Turn on captions">Turn on captions</button><main id="meeting">网页会议原生字幕夹具</main><script>let count=0; document.getElementById('enable').onclick=()=>{count++;const on=document.getElementById('enable').getAttribute('aria-label')==='Turn on captions';document.getElementById('enable').setAttribute('aria-label',on?'Turn off captions':'Turn on captions');document.querySelector('#meeting span')?.remove();if(on){const span=document.createElement('span');span.setAttribute('${captionAttributes.split('=')[0]}',${JSON.stringify(captionAttributes.slice(captionAttributes.indexOf('=') + 1).replaceAll('"', ''))});span.textContent=${JSON.stringify(source)};document.getElementById('meeting').appendChild(span);}window.fixtureClicks=count;};</script></body></html>`;
            if (platform === 'youtube') return `<!doctype html><html><head><title>YouTube caption fixture</title><script>var ytInitialPlayerResponse=${JSON.stringify({videoDetails: {videoId: 'caption-fixture'}, captions: {playerCaptionsTracklistRenderer: {captionTracks: [
                {baseUrl: 'https://www.youtube.com/api/timedtext?v=caption-fixture&lang=en', languageCode: 'en'},
                {baseUrl: 'https://www.youtube.com/api/timedtext?v=caption-fixture&lang=zh-CN', languageCode: 'zh-CN'},
            ]}}})};</script></head><body><div id="movie_player" class="html5-video-player" style="position:relative;width:800px;height:450px;margin:80px auto"><video class="html5-main-video" src="${mediaUrl}" style="width:100%;height:100%"></video><div id="ytp-caption-window-container"><span class="ytp-caption-segment">${source}</span></div><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true">CC</button><button class="ytp-fullscreen-button">Full screen</button></div></div></body></html>`;
            return `<!doctype html><html><head><title>${platform} caption fixture</title><style>body{background:#edf2f8;font:18px system-ui}.video-player{position:relative;width:800px;height:450px;margin:80px auto}video{width:100%;height:100%}</style></head><body><h1>${platform} 视频字幕</h1><div class="video-player"><video src="${mediaUrl}"></video><div ${captionAttributes}>${source}</div></div><script>const video=document.querySelector('video');const en=video.addTextTrack('subtitles','English','en');en.addCue(new VTTCue(0,4,${JSON.stringify(source)}));en.mode='showing';const zh=video.addTextTrack('subtitles','中文人工字幕','zh-CN');zh.addCue(new VTTCue(0,4,'人工字幕：这是会议或视频的字幕。'));zh.mode='disabled';video.onloadedmetadata=()=>{video.currentTime=.5;};</script></body></html>`;
        };
        let currentPlatform = 'meet';
        const timedTextRequests = [];
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.protocol === 'chrome-extension:') return route.continue();
            if (url.pathname === '/api/timedtext') { timedTextRequests.push(url.href); return route.fulfill({contentType: 'application/json', body: JSON.stringify({events: [{tStartMs: 0, dDurationMs: 4000, segs: [{utf8: url.searchParams.get('lang') === 'zh-CN' ? '人工字幕：这是会议或视频的字幕。' : source}]}]})}); }
            if (route.request().isNavigationRequest()) return route.fulfill({contentType: 'text/html; charset=utf-8', body: fixture(currentPlatform)});
            return route.abort();
        });
        const control = await helper.newPageWithoutForeground(context);
        await control.goto(`chrome-extension://${extensionId}/popup.html`);
        let sequence = 0;
        const patch = async value => {
            const result = await control.evaluate(async ({value, sequence}) => {
                const read = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
                const config = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
                return chrome.runtime.sendMessage({type: 'persistConfig', config: {...config, ...value}, clientId: 'caption-platform-fixture', sequence,
                    ...(Number.isSafeInteger(config.__fluentConfigRevision) ? {baseRevision: config.__fluentConfigRevision} : {})});
            }, {value, sequence: ++sequence});
            assert.equal(result.success, true, JSON.stringify(result));
        };
        await patch({on: true, uiLanguageSetupCompleted: true, uiLanguage: 'zh-CN', to: 'zh-Hans', from: 'en', videoService: 'microsoft', useCache: false,
            videoTranslationEnabled: true, videoSubtitleVisible: true, videoSubtitleDisplayMode: 'bilingual', videoMeetingAutoEnabled: true, videoPreferHumanSubtitles: true});
        for (const [platform, url] of [['meet', 'https://meet.google.com/abc-defg-hij'], ['teams', 'https://teams.microsoft.com/v2/'], ['zoom', 'https://us02web.zoom.us/wc/123/join'], ['udemy', 'https://www.udemy.com/course/demo/learn/'], ['disney', 'https://www.disneyplus.com/video/demo'], ['youtube', 'https://www.youtube.com/watch?v=caption-fixture']]) {
            if (arg('platforms') && !arg('platforms').split(',').includes(platform)) continue;
            currentPlatform = platform;
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await helper.activateExtensionTabWithoutForeground(context, page);
            const human = ['udemy', 'disney', 'youtube'].includes(platform);
            const selector = platform === 'youtube' ? '#fluent-read-video-subtitle' : '#fluent-read-platform-captions .translation';
            try {
                await page.locator(selector).filter({hasText: human ? '人工字幕' : '机器译文'}).waitFor({timeout: 20000});
            } catch (error) {
                const diagnostics = await page.evaluate(() => ({host: document.getElementById('fluent-read-platform-captions')?.outerHTML,
                    overlay: document.getElementById('fluent-read-platform-captions')?.shadowRoot?.textContent,
                    youtube: document.getElementById('fluent-read-video-subtitle')?.textContent,
                    scripts: [...document.querySelectorAll('script')].map(script => script.textContent?.slice(0, 2000)),
                    videos: [...document.querySelectorAll('video')].map(video => ({readyState: video.readyState, error: video.error?.message, time: video.currentTime,
                        seeking: video.seeking, ended: video.ended, tracks: [...video.textTracks].map(track => ({kind: track.kind, label: track.label, language: track.language, mode: track.mode, cues: [...(track.cues || [])].map(cue => ({start: cue.startTime, end: cue.endTime, text: cue.text}))}))})), errors: []}));
                const read = await control.evaluate(() => chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'}));
                const stored = typeof read.value === 'string' ? JSON.parse(read.value) : read.value;
                fs.writeFileSync(path.join(artifacts, `${platform}-failure.json`), JSON.stringify({diagnostics, errors, timedTextRequests,
                    config: {to: stored.to, videoPreferHumanSubtitles: stored.videoPreferHumanSubtitles}}, null, 2));
                await page.screenshot({path: path.join(artifacts, `${platform}-failure.png`)});
                throw new Error(`${platform}: ${error.message}`);
            }
            assert.equal(await page.locator(selector).count(), 1);
            await page.screenshot({path: path.join(artifacts, `${platform}-bilingual.png`)});
            const before = await worker.evaluate(() => globalThis.__captionFixtureRequests.length);
            if (['meet', 'teams', 'zoom'].includes(platform)) {
                await page.locator('#enable').click();
                await page.waitForFunction(() => document.getElementById('fluent-read-platform-captions')?.hidden === true);
                assert.equal(await page.locator('#enable').getAttribute('aria-label'), 'Turn on captions');
                await page.locator('#enable').click();
                await page.locator(selector).filter({hasText: '机器译文'}).waitFor({timeout: 15000});
            }
            if (platform === 'youtube') {
                await page.locator('#fluent-read-video-subtitle-button').click();
                const downloaded = page.waitForEvent('download');
                await page.locator('#fluent-read-video-subtitle-menu [data-action="download-bilingual-subtitles"]').click();
                const file = await downloaded;
                const destination = path.join(artifacts, 'youtube-bilingual.srt');
                await file.saveAs(destination);
                const content = fs.readFileSync(destination, 'utf8');
                assert.ok(content.includes(source));
                assert.ok(content.includes('人工字幕：这是会议或视频的字幕。'));
                assert.ok(content.includes('00:00:00,000 --> 00:00:04,000'));
                bilingualDownload = true;
                await page.locator('#fluent-read-video-subtitle-button').click();
            }
            if (human) {
                await patch({videoPreferHumanSubtitles: false});
                await page.locator(selector).filter({hasText: '机器译文'}).waitFor({timeout: 15000});
                await patch({videoPreferHumanSubtitles: true});
                await page.locator(selector).filter({hasText: '人工字幕'}).waitFor({timeout: 15000});
            }
            if (platform !== 'youtube') {
                await patch({videoSubtitleVisible: false});
                await page.waitForFunction(() => document.getElementById('fluent-read-platform-captions')?.hidden === true);
                assert.equal(await page.locator('#fluent-read-platform-captions').isVisible(), false);
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('span, [data-purpose="captions-cue-text"], .dss-hls-subtitle-overlay')].some(node => node.style.visibility === 'hidden')), false);
                if (['meet', 'teams', 'zoom'].includes(platform)) assert.equal(await page.locator('#enable').getAttribute('aria-label'), 'Turn off captions');
                await patch({videoSubtitleVisible: true});
                await page.locator(selector).filter({hasText: human ? '人工字幕' : '机器译文'}).waitFor({timeout: 15000});
            }
            const requests = await worker.evaluate(() => globalThis.__captionFixtureRequests.length);
            results.push({platform, bilingual: true, humanPreference: human, translationRequestsBeforeToggle: before, translationRequests: requests, restored: platform !== 'youtube'});
        }
        await control.goto(`chrome-extension://${extensionId}/options.html#settings-video`);
        await helper.activateExtensionTabWithoutForeground(context, control);
        await control.locator('button[data-section="settings-video"]').click();
        const meetingSwitch = control.getByRole('switch', {name: '会议平台自动开启双语字幕', exact: true});
        const humanSwitch = control.getByRole('switch', {name: '优先使用人工字幕', exact: true});
        await meetingSwitch.waitFor({state: 'attached', timeout: 10000});
        assert.equal(await meetingSwitch.getAttribute('aria-checked'), 'true'); assert.equal(await humanSwitch.getAttribute('aria-checked'), 'true');
        await meetingSwitch.locator('xpath=ancestor::*[contains(@class, "el-switch")]').click();
        await humanSwitch.locator('xpath=ancestor::*[contains(@class, "el-switch")]').click();
        await control.waitForTimeout(800); await control.reload();
        await control.locator('button[data-section="settings-video"]').click();
        await meetingSwitch.waitFor({state: 'attached', timeout: 10000});
        assert.equal(await meetingSwitch.getAttribute('aria-checked'), 'false'); assert.equal(await humanSwitch.getAttribute('aria-checked'), 'false');
        await control.screenshot({path: path.join(artifacts, 'settings-persisted.png')});
        assert.deepEqual(errors, []);
        Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement,
            scope: 'production-extension controlled DOM and TextTrack fixtures; deterministic translation provider; no authenticated live meetings or subscription videos', results, settingsPersisted: true, bilingualDownload, errors});
    } catch (error) {
        report.failure = error.stack || String(error);
        console.error(error.stack || error);
        process.exitCode = 1;
    } finally {
        let sessionClosed = false;
        try { if (session) { await session.close(); sessionClosed = true; } }
        catch (error) { report.cleanupError = error.stack || String(error); process.exitCode = 1; }
        if (sessionClosed) {
            try { fs.rmSync(profileDir, {recursive: true, force: true}); }
            catch (error) { report.profileCleanupError = error.stack || String(error); process.exitCode = 1; }
        } else report.retainedProfile = profileDir;
        fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
