'use strict';

// 在独立扩展副本与临时 profile 中运行真实 Kokoro/Whisper；故障注入仅限测试 GPU API 或 q4 初始化调用。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');
function arg(name, fallback) {const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1];}
const root = path.resolve(__dirname, '../..');
const source = path.resolve(arg('extension-dir', path.join(root, '.output/chrome-mv3')));
const artifacts = path.resolve(arg('artifacts-dir', '/private/tmp/fluentread-local-audio-gpu'));
const kinds = arg('kinds', 'tts,whisper').split(',');
const installWithCdp = arg('extension-install', 'flags') === 'cdp';
const {chromium} = require(path.join(arg('playwright-root', '/Users/thinkstu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright'));
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(arg('focus-safe-helper', '/Users/thinkstu/.codex/skills/fluentread-browser-translation-test/scripts/focus-safe-browser.cjs'));
const {measureBrowser} = require('./local-model-browser-helpers.cjs');
const nativeTimeoutMs = Number(arg('native-timeout-ms', '30000'));
assert.ok(Number.isSafeInteger(nativeTimeoutMs) && nativeTimeoutMs > 0, 'native-timeout-ms must be a positive integer');
let fixture, profile;
async function runNative(command, args) {
  await new Promise((resolve, reject) => {
    let failure, stopReason, force;
    const child = spawn(command, args, {stdio: 'inherit', detached: process.platform !== 'win32'});
    const signal = value => {
      if (!child.pid) return;
      try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, value);} catch { /* Already exited. */ }
    };
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      signal('SIGTERM');
      force = setTimeout(() => signal('SIGKILL'), 5000);
    };
    const onInterrupt = () => stop('interrupted');
    const timer = setTimeout(() => stop('timed out'), nativeTimeoutMs);
    process.once('SIGTERM', onInterrupt);
    process.once('SIGINT', onInterrupt);
    child.once('error', error => {failure = error;});
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(force);
      process.off('SIGTERM', onInterrupt); process.off('SIGINT', onInterrupt);
      if (failure) reject(failure);
      else if (stopReason) reject(new Error(`${command} ${stopReason}${stopReason === 'timed out' ? ` after ${nativeTimeoutMs}ms` : ''}`));
      else if (code !== 0) reject(new Error(`${command} failed: ${exitSignal || code}`));
      else resolve();
    });
  });
}
const report = {source, cases: [], errors: [], injectedFaultErrors: [], workerSha256: {}, evidence: 'Real production Kokoro FP32 and Whisper Tiny q4/q8 workers; controlled synthesized speech, plus explicitly injected GPU initialization/device-loss or q4 initialization faults. Does not cover live website audio capture.'};

(async () => {
  let session;
  try {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-audio-gpu-extension-'));
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-audio-gpu-profile-'));
    fs.mkdirSync(artifacts, {recursive: true});
    fs.cpSync(source, fixture, {recursive: true});
    if (process.argv.includes('--cross-origin-isolated')) {
      const manifestPath = path.join(fixture, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.cross_origin_embedder_policy = {value: 'require-corp'};
      manifest.cross_origin_opener_policy = {value: 'same-origin'};
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    await runNative('/usr/bin/say', ['-v', 'Samantha', '-o', path.join(fixture, 'speech.aiff'), 'Hello world. This is a local speech test.']);
    await runNative('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', path.join(fixture, 'speech.aiff'), path.join(fixture, 'speech.wav')]);
    fs.writeFileSync(path.join(fixture, 'audio-probe.html'), '<!doctype html><meta charset="utf-8"><title>本地音频 GPU 验证</title><h1>本地音频 GPU 验证</h1><pre id="result">正在下载并验证模型…</pre>');
    for (const worker of ['localTtsWorker', 'videoTranscriptionWorker']) {
      report.workerSha256[worker] = createHash('sha256').update(fs.readFileSync(path.join(source, `${worker}.js`))).digest('hex');
      for (const fault of ['unavailable', 'init-failure', 'device-loss', 'q4-failure', 'thread-failure']) {
        if (fault === 'q4-failure') {
          if (worker !== 'videoTranscriptionWorker') continue;
          const code = fs.readFileSync(path.join(source, `${worker}.js`), 'utf8');
          const q4Call = /return await [A-Za-z_$][\w$]*\(["']q4["']\)/g;
          assert.equal([...code.matchAll(q4Call)].length, 1, 'Only the CPU q4 initialization call may be fault injected');
          fs.writeFileSync(path.join(fixture, `${worker}-q4-failure.js`), code.replace(q4Call, 'throw new Error("Injected q4 initialization failure")'));
        }
        fs.writeFileSync(path.join(fixture, `${worker}-${fault}.mjs`), `
const queuedMessages = [];
const queueEarlyMessage = event => queuedMessages.push(event);
self.addEventListener('message', queueEarlyMessage);
const fault = ${JSON.stringify(fault)};
const capabilities={crossOriginIsolated:self.crossOriginIsolated,cores:navigator.hardwareConcurrency,pthreads:0};
const NativeWorker=self.Worker;
self.Worker=class extends NativeWorker{constructor(url,options){if(options?.name==='em-pthread'){capabilities.pthreads++;if(fault==='thread-failure')throw new Error('Injected pthread creation failure');}super(url,options);}};
const gpu = navigator.gpu;
let probes = 0;
const devices = [];
if (fault === 'q4-failure' || fault === 'thread-failure') Object.defineProperty(navigator, 'gpu', {value: undefined});
else if (fault === 'unavailable') Object.defineProperty(navigator, 'gpu', {value: undefined});
else if (gpu) {
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  Object.defineProperty(gpu, 'requestAdapter', {value: async options => {
    if (fault === 'init-failure' && ++probes > 1) throw new Error('Injected GPU initialization failure');
    const adapter = await requestAdapter(options);
    if (adapter && fault === 'device-loss') {
      const requestDevice = adapter.requestDevice.bind(adapter);
      Object.defineProperty(adapter, 'requestDevice', {value: async options => {
        const device = await requestDevice(options); devices.push(device); return device;
      }});
    }
    return adapter;
  }});
}
const post = self.postMessage.bind(self);
self.postMessage = (message, ...args) => {
  message.capabilities={...capabilities};
  if (fault === 'device-loss' && message.requestId === 1 && message.backend === 'webgpu') {
    devices.forEach(device => device.destroy());
    message.injectedDeviceLoss = devices.length;
  }
  post(message, ...args);
};
await import('./${worker}${fault === 'q4-failure' ? '-q4-failure' : ''}.js');
self.removeEventListener('message', queueEarlyMessage);
for (const event of queuedMessages) self.onmessage?.(event);
self.postMessage({probeReady: true});`);
      }
    }
    await createRequire(require.resolve('vite'))('esbuild').build({stdin: {contents: `export {createSelectionTtsPlayer} from './src/app/offscreen/ttsPlayback'; export {cacheLocalTtsModelFiles} from './src/features/local-tts/offscreen/modelCache'; export {cacheVideoAiQ4ModelFiles} from './src/features/video-subtitle/offscreen/modelCache'; export {prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio, cancelLocalVideoTranscription} from './src/features/video-subtitle/offscreen/transcription';`, resolveDir: root}, alias: {'@': root}, bundle: true, platform: 'browser', format: 'esm', outfile: path.join(fixture, 'audio-cache.mjs')});
    session = await launchFocusSafePersistentContext({chromium, profileDir: profile,
      browserPath: arg('browser-path', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), headless: false, background: true,
      displayTarget: 'secondary', viewport: {width: 1100, height: 800},
      browserArgs: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...(installWithCdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`])]});
    Object.assign(report, {launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement});
    const {context} = session;
    const processSession = await context.browser().newBrowserCDPSession();
    const browserPid = (await processSession.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
    await processSession.detach();
    function focusGuard() {
      const current = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit');const a=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(a.processIdentifier)});"], {encoding:'utf8'}));
      assert.notEqual(current.pid, browserPid, 'Owned test browser must stay behind the user application');
      (report.focusChecks ??= []).push(current);
    }
    report.browserVersion = context.browser().version();
    let origin;
    if (installWithCdp) {
      const cdp = await context.browser().newBrowserCDPSession();
      const {id} = await cdp.send('Extensions.loadUnpacked', {path: fixture});
      await cdp.detach();
      origin = `chrome-extension://${id}`;
    } else {
      const isProduct = async w => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js')
        && await w.evaluate(() => chrome.runtime.getManifest().name).then(name=>name.includes('FluentRead')).catch(()=>false);
      let background;
      for(const candidate of context.serviceWorkers()) if(await isProduct(candidate)) {background=candidate;break;}
      background ||= await context.waitForEvent('serviceworker', {predicate:isProduct, timeout:30000});
      origin = background.url().match(/^chrome-extension:\/\/[^/]+/)[0];
    }
    const page = await newPageWithoutForeground(context);
    let activeCase = '';
    page.on('pageerror', e => {
      if (activeCase.endsWith('device-loss') && /device.*lost/i.test(e.message)) report.injectedFaultErrors.push({case:activeCase, message:e.message});
      else report.errors.push(e.message);
    });
    page.on('console', m => {if (m.type() === 'error') fs.appendFileSync(path.join(artifacts, 'console.log'), `${m.text()}\n`);});
    await page.goto(`${origin}/audio-probe.html`);
    report.adapter = await page.evaluate(async () => {const a = await navigator.gpu?.requestAdapter({powerPreference:'high-performance'}); return a ? {vendor:a.info?.vendor, architecture:a.info?.architecture, device:a.info?.device, description:a.info?.description} : null;});
    console.log(JSON.stringify({phase:'download', adapter:report.adapter}));
    await page.evaluate(async kinds => {const cache = await import('./audio-cache.mjs'); if(kinds.includes('tts'))await cache.cacheLocalTtsModelFiles(); if(kinds.includes('whisper'))await cache.cacheVideoAiQ4ModelFiles('tiny');}, kinds);
    console.log(JSON.stringify({phase:'models-ready'}));
    for (const mode of arg('modes', 'gpu,cpu,unavailable,init-failure,device-loss').split(',')) {
      for (const kind of kinds) {
        if (mode === 'q4-failure' && kind !== 'whisper') continue;
        const name = `${kind}-${mode}`;
        focusGuard();
        activeCase = name;
        console.log(JSON.stringify({phase:'inference', name}));
        const measured = await measureBrowser(context, name, artifacts, () => page.evaluate(async ({kind, mode, texts}) => {
          if (kind === 'whisper' && mode === 'device-loss') {
            // Run the actual owner source for a lost device: ORT may hang rather than reject.
            const owner = await import('./audio-cache.mjs');
            const NativeWorker = window.Worker;
            let workersCreated = 0;
            let injectedDeviceLoss = 0;
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                super(new URL('videoTranscriptionWorker-device-loss.mjs', location.href), options);
                workersCreated++;
                this.addEventListener('message', e => {injectedDeviceLoss += e.data.injectedDeviceLoss || 0;});
              }
            };
            try {
              const prepared = await owner.prepareLocalVideoTranscriptionModel('tiny', {keepWarm:true, streamId:'gpu-probe'});
              if (!injectedDeviceLoss) throw new Error('Owner GPU device-loss injection missing');
              const speech = window.audioProbeWav || await (await fetch('./speech.wav')).arrayBuffer();
              const decoded = await new OfflineAudioContext(1,16000,16000).decodeAudioData(speech.slice(0));
              const samples = decoded.getChannelData(0);
              const bytes = new Uint8Array(samples.length*2);
              const view = new DataView(bytes.buffer);
              for(let i=0;i<samples.length;i++)view.setInt16(i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
              let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
              const result = await owner.transcribeLocalVideoAudio({model:'tiny', sourceLanguage:'auto', streamId:'gpu-probe', audioPcm16Base64:btoa(binary)});
              return {prepared, outputs:[result], cpuRebuilds:workersCreated-1, injectedDeviceLoss, ownerSourceHarness:true};
            } finally {await owner.cancelLocalVideoTranscription('gpu-probe');window.Worker=NativeWorker;}
          }
          const base = kind === 'tts' ? 'localTtsWorker' : 'videoTranscriptionWorker';
          const suffix = ['gpu','cpu'].includes(mode) ? '.js' : `-${mode}.mjs`;
          let worker = new Worker(new URL(base + suffix, location.href), {type:'module'});
          let forceCpu = mode === 'cpu';
          let cpuRebuilds = 0;
          let seq = 0;
          function request(payload) {
            const requestId = ++seq;
            return new Promise((resolve,reject) => {
              const timer = setTimeout(() => {worker.terminate(); reject(new Error('audio worker timeout'));}, 120000);
              worker.onerror = e => {clearTimeout(timer); reject(new Error(e.message));};
              worker.onmessage = e => {
                if(e.data.requestId!==requestId)return; clearTimeout(timer);
                if(!e.data.success && e.data.retryWithCpu && !forceCpu) {
                  worker.terminate(); forceCpu=true; cpuRebuilds++;
                  worker=new Worker(new URL(base+'.js',location.href),{type:'module'});
                  resolve(request(payload)); return;
                }
                e.data.success ? resolve(e.data) : reject(new Error(e.data.error));
              };
              worker.postMessage({...payload, requestId, ...(forceCpu?{device:'wasm'}:{})});
            });
          }
          try {
            if (!['gpu','cpu'].includes(mode)) await new Promise((resolve,reject) => {
              const timer=setTimeout(()=>reject(new Error('GPU fault wrapper handshake timeout')),15000);
              worker.onmessage=e=>{if(e.data.probeReady){clearTimeout(timer);resolve();}};
              worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};
            });
            const prepared = await request({type:'prepare', model:'tiny'});
            if (mode==='device-loss' && !(prepared.injectedDeviceLoss > 0)) throw new Error('Device-loss fault was not injected into a GPU session');
            const outputs = [];
            for (const language of kind==='tts' ? ['en','zh'] : ['en']) {
              if (kind==='tts') {
                const result = await request({type:'synthesize', text:texts[language], voice:language==='zh'?'zf_001':'af_maple', speed:1});
                const view = new DataView(result.audio);
                const count = (result.audio.byteLength-44)/2;
                let peak = 0, power = 0; for(let i=0;i<count;i++){const sample=view.getInt16(44+i*2,true);peak=Math.max(peak, Math.abs(sample));power+=sample*sample;}
                if (language==='en' && mode==='gpu') window.audioProbeWav = result.audio.slice(0);
                const context = new OfflineAudioContext(1,1,result.samplingRate);
                const decoded = await context.decodeAudioData(result.audio.slice(0));
                const owner = await import('./audio-cache.mjs');
                const progress = [], states = [];
                let element;
                const player = owner.createSelectionTtsPlayer({
                  createAudio:()=>{element=new Audio();element.muted=true;return element;},
                  decodeBase64:()=>new Uint8Array(result.audio),
                  createObjectUrl:(bytes,type)=>URL.createObjectURL(new Blob([bytes],{type})),
                  revokeObjectUrl:url=>URL.revokeObjectURL(url),
                  notify:(_request,state)=>states.push(state),
                  notifyProgress:(_request,value)=>progress.push({time:element.currentTime,...value}),
                });
                try {
                  await player.play({tabId:0,clientRequestId:'clock-probe',audioBase64:'fixture',contentType:'audio/wav',text:texts[language],timings:result.timings});
                  const deadline=performance.now()+15000;
                  while(!states.includes('ended')&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
                  if(!states.includes('ended')||progress.length<2||!progress.some(p=>p.time>.2))throw new Error('Generated WAV did not advance the real Audio clock and end');
                  const count=progress.length;await new Promise(resolve=>setTimeout(resolve,220));
                  if(progress.length!==count)throw new Error('Ended audio left a follow-along timer alive');
                } finally {player.dispose();}
                outputs.push({backend:result.backend, language, text:texts[language], audioBytes:result.audio.byteLength, samples:count, peak, rms:Math.sqrt(power/count)/32768, duration:decoded.duration, samplingRate:result.samplingRate,timings:result.timings,playback:{muted:true,states,progress}});
              } else {
                const speech = window.audioProbeWav || await (await fetch('./speech.wav')).arrayBuffer();
                const audioContext = new OfflineAudioContext(1,16000,16000);
                const audio = await audioContext.decodeAudioData(speech.slice(0));
                const result = await request({type:'transcribe', model:'tiny', sourceLanguage:'auto', languageSessionKey:'probe', audio:audio.getChannelData(0)});
                outputs.push(result);
              }
            }
            return {prepared, outputs, cpuRebuilds};
          } finally {worker.terminate();}
        }, {kind,mode,texts:{en:arg('tts-en-text','Hello world. This is a local speech test.'),zh:arg('tts-zh-text','你好，欢迎使用流畅阅读。')}}));
        report.cases.push(measured);
        focusGuard();
        if(measured.error) {report.errors.push(`${name}: ${measured.error}`); continue;}
        if (mode === 'q4-failure' && kind === 'whisper') assert.equal(measured.result.prepared.dtype, 'q8');
        const expected = mode==='gpu'?'webgpu':'wasm';
        assert.equal(measured.result.outputs[0].backend, expected, name);
        for(const output of measured.result.outputs) {
          if(kind==='tts') assert.ok(output.audioBytes>1000 && output.peak>0, name);
          else assert.match(output.text, /hello|world|speech|test/i, name);
        }
      }
    }
    activeCase = '';
    report.ok = report.errors.length === 0;
    await page.evaluate(r => {document.getElementById('result').textContent=JSON.stringify(r,null,2);}, {adapter:report.adapter, cases:report.cases.map(c=>({name:c.name, result:c.result, error:c.error})), ok:report.ok});
    if (!process.argv.includes('--no-screenshots')) await page.screenshot({path:path.join(artifacts,'result.png'), fullPage:true});
    if (!process.argv.includes('--skip-settings')) {
    const options = await newPageWithoutForeground(context);
    await options.goto(`${origin}/options.html#settings-translation`, {waitUntil:'domcontentloaded'});
    const modelRow = options.locator('[data-testid="local-tts-model-row"]');
    await modelRow.waitFor({state:'visible',timeout:30000});
    if(kinds.includes('tts'))await modelRow.getByText(/可离线使用|Available offline/).waitFor({state:'visible',timeout:30000});
    report.settingsModelText = await modelRow.innerText();
    assert.match(report.settingsModelText, /343/);
    await modelRow.scrollIntoViewIfNeeded();
    if (!process.argv.includes('--no-screenshots')) await options.screenshot({path:path.join(artifacts,'settings-model.png')});
    }
    // 只读检查前台 PID；检查本身无需创建额外窗口。
    focusGuard();
    if(!report.ok)process.exitCode=1;
    console.log(JSON.stringify({ok:report.ok, cases:report.cases.map(c=>({name:c.name, elapsedMs:c.elapsedMs, error:c.error, result:c.result}))}));
  } catch(error) {report.ok=false; report.failure=error.stack; console.error(error); process.exitCode=1;}
  finally {
    try {
      fs.writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));
    } finally {
      let safeToRemoveFixture = false;
      if (session) {
        await session.close();
        if (profile) fs.rmSync(profile,{recursive:true,force:true});
        safeToRemoveFixture = true;
      } else if (profile) {
        try {fs.rmdirSync(profile); safeToRemoveFixture = true;} catch { /* Retain a possibly active partial launch. */ }
      } else safeToRemoveFixture = true;
      if (fixture && safeToRemoveFixture) fs.rmSync(fixture,{recursive:true,force:true});
    }
  }
})();
