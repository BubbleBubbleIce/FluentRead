import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

vi.mock('@/src/services/config/store', () => ({config: {uiLanguage:'zh-CN'}}));
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Execute actual public CLIs, controlling only filesystem/process faults and the external session port.
// No browser is launched and no SFC interaction or real OCR accuracy is claimed by this suite.
const project = process.cwd();
const sourceRoot = process.env.FLUENTREAD_AUDIT_I_SOURCE_ROOT || project;
const evidence = process.env.FLUENTREAD_AUDIT_I_EVIDENCE;
const capture = 'scripts/capture-product-assets.cjs';
const ocr = 'scripts/testing/run-ocr-diagnostics-smoke.cjs';
const group = 'scripts/testing/run-test-group.mjs';
const consistency = 'scripts/testing/run-ui-consistency-test.cjs';
const requestLimits = 'scripts/run-request-limits-ui-test.cjs';
const translationCenter = 'scripts/testing/run-translation-center-ui-test.cjs';
const freeSettings = 'scripts/testing/run-free-service-settings-browser-test.cjs';
const writing = 'scripts/testing/run-writing-assistant-test.cjs';
const kofi = 'scripts/run-kofi-tooltip-test.cjs';
const cloud = 'scripts/testing/run-cloud-credentials-ui-test.cjs';
const preview = 'scripts/testing/run-settings-preview-about-test.cjs';
const pageLoop = 'scripts/testing/run-page-loop-ui-test.cjs';
const customHeaders = 'scripts/testing/run-custom-headers-ui-test.cjs';
const requestHeaders = 'scripts/testing/run-request-headers-ui-test.cjs';
const apiKeys = 'scripts/testing/run-api-keys-ui-test.cjs';
const globalToggle = 'scripts/testing/run-global-translation-toggle-test.cjs';
const bilingual = 'scripts/testing/run-bilingual-sentence-highlight-test.cjs';
const translationStyle = 'scripts/testing/run-translation-style-ui-test.cjs';
const vocabulary = 'scripts/testing/run-vocabulary-reencounter-test.cjs';
const popupStartup = 'scripts/testing/run-popup-startup-ui-test.cjs';
const loadingMotion = 'scripts/testing/run-loading-motion-ui-test.cjs';
const siteDemo = 'scripts/testing/run-site-demo-loading-test.cjs';
const siteVideo = 'scripts/testing/run-site-video-fallback-test.cjs';
const cleanupTools = [kofi, cloud, preview, pageLoop, customHeaders, requestHeaders, apiKeys, globalToggle, bilingual, translationStyle, vocabulary];
const jsonTools = [customHeaders, requestHeaders, apiKeys, globalToggle, bilingual, translationStyle, vocabulary];
const nativeTools = ['scripts/run-x-subtitle-geometry-test.cjs', 'scripts/run-video-caption-platform-test.cjs', 'scripts/run-video-menu-state-test.cjs', 'scripts/run-x-home-audio-recovery-test.cjs'];
const fullPage = 'scripts/run-full-page-translation-test.cjs';
const documentTool = 'scripts/run-document-translation-test.cjs';
const videoFixture = 'scripts/run-video-subtitle-fixture-test.cjs';
const manga = 'scripts/testing/run-manga-translation-test.cjs';
const density = 'scripts/run-reading-density-test.cjs';
const wordFeedback = 'scripts/run-selection-word-feedback-test.cjs';
const readingHarness = 'scripts/run-harness-reading-test.cjs';
const selectionTrigger = 'scripts/run-selection-trigger-test.cjs';
const videoContract = 'scripts/run-video-subtitle-test.cjs';
type Event = {kind: string; [key: string]: any};
type Result = {code: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; events: Event[]; directories: {directory: string; exists: boolean}[]; report: any; fixture: string; scriptHash: string};
let suiteRoot: string;
let invocation = 0;

const preloadSource = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const cp = require('node:child_process');
const Module = require('node:module');
const mode = process.env.AUDIT_FAULT;
const log = (kind, value = {}) => fs.appendFileSync(process.env.AUDIT_EVENTS, JSON.stringify({kind, ...value}) + '\n');
global.__auditLog = log;
log('ports-ready', {pid: process.pid});
if(process.env.AUDIT_INTERVAL_PORT==='1') {
 const intervals=new Set(), nativeSet=setInterval,nativeClear=clearInterval;
 global.setInterval=(callback,delay,...args)=>{const handle=nativeSet(callback,delay,...args);if(delay===25){intervals.add(handle);global.__auditTracking=true;log('tracking-interval-start');}return handle;};
 global.clearInterval=handle=>{if(intervals.delete(handle)){log('tracking-interval-clear');global.__auditTracking=false;}return nativeClear(handle);};
}
if (process.env.AUDIT_PROVENANCE_PORT === '1' || mode === 'export-html-listen') {
 const path=require('node:path'), originalRoot=path.resolve(path.dirname(process.env.AUDIT_SCRIPT),'..');
 const translate=file=>{
  if(typeof file!=='string'||!file.startsWith(originalRoot+path.sep))return file;
  const relative=path.relative(originalRoot,file);
  return /^(tests\/fixtures\/unified-translation-fixture\.html$|src(?:\/|$)|entrypoints(?:\/|$)|package\.json$|pnpm-lock\.yaml$|wxt\.config\.ts$)/.test(relative)?path.join(process.env.AUDIT_PROJECT,relative):file;
 };
 for(const method of ['readFileSync','readdirSync']) {const original=fs[method];fs[method]=function(file,...args){return original.call(this,translate(file),...args);};}
}
const compile = Module.prototype._compile;
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'playwright') return load.call(this, process.env.AUDIT_PLAYWRIGHT_PORT, ...args);
  return load.call(this, name, ...args);
};
Module.prototype._compile = function (text, filename) {
  if (filename === process.env.AUDIT_SCRIPT) log('source-enter', {filename});
  return compile.call(this, text, filename);
};
let created = 0;
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  if (mode === 'first-temp') throw Error('CONTROLLED_FIRST_TEMP_FAILURE');
  if (mode === 'second-temp' && ++created === 2) throw Error('CONTROLLED_SECOND_TEMP_FAILURE');
  if (String(args[0]).startsWith('/private/tmp/fluentread-manga-profile-')) args[0] = require('node:path').join(process.env.TMPDIR, 'fluentread-manga-profile-');
  const directory = mkdtemp.apply(this, args);
  log('temporary-directory', {directory});
  return directory;
};
const copy = fs.copyFileSync;
fs.copyFileSync = function (...args) {
  if (mode === 'copy-language' && String(args[0]).endsWith('eng.traineddata')) throw Error('CONTROLLED_COPY_FAILURE');
  return copy.apply(this, args);
};
const write = fs.writeFileSync;
fs.writeFileSync = function (...args) {
  if (mode === 'report-write' && /(?:capture-report|browser-report|report)\.json$/.test(String(args[0]))) {
    log('report-write-failed');
    throw Error('CONTROLLED_REPORT_WRITE_FAILURE');
  }
  return write.apply(this, args);
};
const remove = fs.rmSync;
fs.rmSync = function (...args) {
  const directory = String(args[0]);
  log('remove-attempt', {directory});
  if (mode === 'remove-profile' && /(?:product-capture-|diagnostics-profile-)/.test(directory)) throw Error('CONTROLLED_REMOVE_FAILURE');
  return remove.apply(this, args);
};
const exec = cp.execFileSync;
const nativeSpawn = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (process.env.AUDIT_NATIVE_PORT === '1') {
    log('native-command-port', {command, args, options});
    if (process.env.AUDIT_VIDEO_MEDIA_SUCCESS === '1') {fs.writeFileSync(args.at(-1), 'controlled-media-input'); return {status:0, stderr:'',stdout:''};}
    return {status: null, signal: 'SIGKILL', error: Error('CONTROLLED_NATIVE_TIMEOUT'), stderr: 'CONTROLLED_NATIVE_TIMEOUT', stdout: ''};
  }
  return nativeSpawn.call(this, command, args, options);
};
cp.execFileSync = function (command, ...args) {
  if (command === '/usr/bin/osascript') {log('native-focus-port'); return JSON.stringify({pid:999999,name:'controlled foreground port'});}
  if (command === 'git') {
    log('revision-read');
    if (mode === 'git') throw Error('CONTROLLED_GIT_FAILURE');
    return '5c74dceca289162310563b17e8c4af9de36817a4\n';
  }
  return exec.call(this, command, ...args);
};
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  log('server-created');
  server.on('listening', () => {
    global.__auditBase = 'http://127.0.0.1:' + server.address().port;
    log('server-listening', {port: server.address().port});
  });
  server.on('close', () => log('server-closed'));
  const close = server.close;
  server.close = function (...values) { log('server-close-attempt'); return close.apply(this, values); };
  if (mode === 'listen' || mode === 'export-listen' || mode === 'export-html-listen') server.listen = function () { queueMicrotask(() => server.emit('error', Error('CONTROLLED_LISTEN_FAILURE'))); return server; };
  return server;
};
if (process.env.AUDIT_MANGA_SOCKET === '1') {
 global.WebSocket = class extends EventTarget {
  constructor(url) {super();this.readyState=0;log('websocket-created',{url});queueMicrotask(()=>{if(mode==='ws-open-error'){this.dispatchEvent(new Event('error'));}else{this.readyState=1;this.dispatchEvent(new Event('open'));}});}
  send(raw) {
   const message=JSON.parse(raw);log('websocket-command',{method:message.method});
   if(message.method==='Target.getTargets') {
    if(mode==='ws-send-error')throw Error('CONTROLLED_SOCKET_SEND_FAILURE');
    if(mode==='ws-close-pending'){queueMicrotask(()=>{this.readyState=3;this.dispatchEvent(new Event('close'));});return;}
    if(mode==='ws-error-pending'){queueMicrotask(()=>this.dispatchEvent(new Event('error')));return;}
    if(mode==='ws-malformed'){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:'{'})));return;}
   }
   const result=message.method==='Target.getTargets'?{targetInfos:mode==='ws-missing-target'?[]:[{url:'chrome-extension://audit-fixture/offscreen.html',targetId:'own-target'}]}:message.method==='Target.attachToTarget'?{sessionId:'own-session'}:{};
   queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:message.id,result})})));
  }
  close() {log('websocket-close');this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')));}
 };
}
`;

const helperSource = String.raw`
const http = require('node:http');
const log = (...args) => global.__auditLog(...args);
async function request(route, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(global.__auditBase + route, {method, agent: false}, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', value => data += value);
      res.on('end', () => {
        const response = {status: res.statusCode, body: data, contentType: res.headers['content-type']};
        log('http-response', {route, method, ...response});
        resolve(response);
      });
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(Error('CONTROLLED_HTTP_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}
exports.launchFocusSafePersistentContext = async options => {
  log('launch', {profileDir: options.profileDir, background: options.background, headless: options.headless});
  if (global.__auditBase && process.env.AUDIT_CAPTURE_PROBES === '1') {
    const probes = {
      article: await request('/reading'),
      preflight: await request('/translate', 'OPTIONS'),
      translations: await request('/translate', 'POST', JSON.stringify([' A little curiosity goes a long way. ', 'unmatched'])),
      empty: await request('/translate', 'POST', JSON.stringify({other: true})),
      malformed: await request('/translate', 'POST', '{'),
      tool: await request('/v1/chat/completions', 'POST', JSON.stringify({tools: [{}], messages: [{role: 'user'}]})),
      answer: await request('/v1/chat/completions', 'POST', JSON.stringify({tools: [{}], messages: [{role: 'tool'}]})),
    };
    log('http-probes', {probes});
  }
  if (global.__auditBase && process.env.AUDIT_CENTER_PROBES === '1') {
    log('center-http-probes', {probes: {
      preflight: await request('/a/v1/chat/completions', 'OPTIONS'),
      normal: await request('/a/v1/chat/completions', 'POST', JSON.stringify({model: 'fixture-a'})),
      failure: await request('/b/v1/chat/completions', 'POST', JSON.stringify({model: 'fixture-b'})),
      malformed: await request('/a/v1/chat/completions', 'POST', '{'),
      nullBody: await request('/a/v1/chat/completions', 'POST', 'null'),
      arrayBody: await request('/a/v1/chat/completions', 'POST', '[]'),
    }});
  }
  if (global.__auditBase && process.env.AUDIT_JSON_PROBES === '1') {
    const valid = JSON.stringify({model: 'fixture', stream: false, messages: [{role: 'user', content: 'SOURCE_BEGINbounded sourceSOURCE_END'}]});
    const before = await request('/v1/chat/completions', 'POST', valid);
    const malformed = await request('/v1/chat/completions', 'POST', '{');
    const after = await request('/v1/chat/completions', 'POST', valid);
    log('json-recovery-probes', {before, malformed, after});
  }
  if (global.__auditBase && process.env.AUDIT_SHAPE_PROBES === '1') {
    const valid=JSON.stringify({model:'fixture',stream:false,messages:[{role:'user',content:'SOURCE_BEGINbounded sourceSOURCE_END'}]});
    const before=await request('/v1/chat/completions','POST',valid), invalid=[];
    const values=process.env.AUDIT_VOCABULARY_SHAPES==='1'?[null,{stream:true,tools:[{}]},{stream:true,tools:[{}],messages:[null]}]:[null,{}, {messages:null}, {messages:[null]}];
    for(const value of values)invalid.push(await request('/v1/chat/completions','POST',JSON.stringify(value)));
    const after=await request('/v1/chat/completions','POST',valid), fallbacks=[];
    if(process.env.AUDIT_VOCABULARY_SHAPES==='1') for(const value of [{},[],1])fallbacks.push(await request('/v1/chat/completions','POST',JSON.stringify(value)));
    log('shape-recovery-probes',{before,invalid,after,fallbacks});
  }
  if (global.__auditBase && process.env.AUDIT_VOCABULARY_FALLBACKS === '1') {
    const replies=[];
    for(const input of [{},[],1])replies.push(await request('/v1/chat/completions','POST',JSON.stringify(input)));
    log('vocabulary-useful-fallback-probes',{replies});
  }
  if (global.__auditBase && process.env.AUDIT_URI_PROBES === '1') {
    const before = await request('/__audit_missing__');
    const malformed = await request('/%E0%A4%A');
    const after = await request('/__audit_missing__');
    log('uri-recovery-probes', {before, malformed, after});
  }
  if (process.env.AUDIT_FAULT === 'launch') throw Error('CONTROLLED_LAUNCH_FAILURE');
  if (process.env.AUDIT_MANGA_SOCKET === '1') {
    require('node:fs').writeFileSync(require('node:path').join(options.profileDir,'DevToolsActivePort'),'43111\n/devtools/browser/owned-fixture');
  }
  return {
    context: {on() {}, async route() {}, async close() { log('raw-context-close'); }, browser: () => ({version: () => 'controlled-version', newBrowserCDPSession: async () => ({send: async (method) => {log('native-browser-cdp-port', {method}); return {id:'audit-fixture'};}, detach: async () => {log('native-browser-cdp-detach');}})}), serviceWorkers: () => [{on() {}, url: () => 'chrome-extension://audit-fixture/background.js', evaluate: async () => {if (process.env.AUDIT_WORKER_FAILURE === '1') {log('worker-port-entered'); throw Error('CONTROLLED_WORKER_FAILURE');} return undefined;}}]},
    launchMode: process.env.AUDIT_VALID_SESSION === '1' ? 'macos-background-cdp' : 'controlled-external-session-port',
    focusPolicy: process.env.AUDIT_VALID_SESSION === '1' ? 'launchservices-no-foreground' : 'no-browser-launched',
    windowPlacement: process.env.AUDIT_VALID_SESSION === '1' ? {mode: 'background-visible-no-focus', browserFrontmost: false} : 'none',
    close: async () => {
      log('session-close');
      if (process.env.AUDIT_FAULT === 'close') throw Error('CONTROLLED_CLOSE_FAILURE');
    },
  };
};
exports.activateExtensionTabWithoutForeground = async () => { throw Error('UNEXPECTED_ACTIVATION'); };
exports.newPageWithoutForeground = async () => ({
  on() {}, setDefaultTimeout() {}, async setViewportSize() {},
  isClosed: () => false,
  evaluate: async () => ({title: 'controlled external page port', text: ''}),
  screenshot: async () => {log('failure-screenshot-port');},
  close: async () => {log('page-close-port');},
  clock: {install: async () => {}, pauseAt: async () => {}},
  goto: async () => {log('page-port-entered'); throw Error('CONTROLLED_PAGE_FAILURE');},
});
exports.headlessLaunch = async () => {
  const session = await exports.launchFocusSafePersistentContext({background: false, headless: true});
  return {close: session.close, newContext: async () => ({on() {}, route: async () => {}, newPage: exports.newPageWithoutForeground, close: async () => {log('context-close-port');}})};
};
`;

// Controlled browser/CDP transport: production scripts retain every UI assertion.
// These ports stop at a real command failure and prove acquisition/release, not a rendered client.
const lifecycleHelperSource = String.raw`
const base = require(process.env.AUDIT_BASE_HELPER);
const log = (...args)=>global.__auditLog(...args);
let config={__fluentConfigRevision:0, harness:{memoryEnabled:false}, token:{},model:{}};
global.chrome={runtime:{lastError:null,sendMessage:(message,callback)=>{
 let response;
 if(message.type==='persistConfig') {config={...config,...message.config,harness:{memoryEnabled:false,...message.config.harness},__fluentConfigRevision:config.__fluentConfigRevision+1};response={success:true,value:config,revision:config.__fluentConfigRevision};}
 else response={success:true,value:message.key==='local:config'?config:{}};
 if(callback)queueMicrotask(()=>callback(response)); return Promise.resolve(response);
}}};
let sessionCount=0,documentCount=0;
const attrs=['class','fr-selection-indicator fr-translation-tooltip fr-study-toolbar fr-word-meaning fr-word-support-loading fr-reading-answer fr-sentence-tokens fr-translation-result'];
const cdp = () => {const id=++sessionCount;log('cdp-created',{id}); return {
 on(){},detach:async()=>{log('cdp-detach',{id});},
 send:async(method,params)=>{
  log('cdp-command',{id,method,params});
  if(method==='SystemInfo.getProcessInfo') return {processInfo:[{type:'browser',id:111111}]};
  if(method==='DOM.getDocument') {
   documentCount++;
   if(process.env.AUDIT_LIFECYCLE_FILE==='harness') {if(documentCount>1)throw Error('CONTROLLED_CDP_DOCUMENT_FAILURE');return {root:{nodeId:1,nodeName:'HTML',children:[]}};}
   return {root:{nodeId:1,nodeName:'HTML',children:[{nodeId:2,nodeName:'DIV',attributes:attrs,children:[{nodeId:3,nodeName:'#text',nodeValue:'每一种语言，都带来一种看世界的新方式。 Every language'},{nodeId:4,nodeName:'BUTTON',children:[{nodeId:5,nodeName:'#text',nodeValue:'词性与句法'}]}]}]}};
  }
  if(method==='DOM.getBoxModel')return {model:{width:20,height:20,border:[0,0,20,0,20,20,0,20],content:[0,0,20,0,20,20,0,20]}};
  if(method==='DOM.resolveNode')return {object:{objectId:'owned-object'}};
  if(method==='Runtime.callFunctionOn') {if(process.env.AUDIT_FAULT==='cdp-exception')return {exceptionDetails:{text:'CONTROLLED_CDP_EXCEPTION'}};throw Error('CONTROLLED_CDP_CALL_FAILURE');}
  if(method==='Runtime.releaseObject')return {};
  return {};
 }
};};
const context={on(){},route:async()=>{},newCDPSession:async()=>cdp(),browser:()=>({newBrowserCDPSession:async()=>cdp()}),serviceWorkers:()=>[{on(){},url:()=> 'chrome-extension://audit-fixture/background.js',evaluate:async()=>undefined}],pages:()=>[popup,content]};
const locator={waitFor:async()=>{},first(){return this;},boundingBox:async()=>({x:0,y:0,width:400,height:30})};
const makePage=()=>({on(){},context:()=>context,isClosed:()=>false, url:()=> 'about:blank#fluentread-background-fixture',goto:async url=>{if(process.env.AUDIT_LIFECYCLE_FILE==='manga'&&!url.startsWith('chrome-extension://'))throw Error('CONTROLLED_PAGE_FAILURE');},reload:async()=>{},locator:()=>locator,waitForTimeout:async()=>{},
 mouse:{move:async()=>{},down:async()=>{},up:async()=>{},click:async()=>{},wheel:async()=>{}},keyboard:{press:async()=>{}},screenshot:async()=>{log('failure-screenshot-port');},
 evaluate:async(callback,value)=>{
  if(value?.type || (value && typeof value==='object' && ('on' in value)))return callback(value);
  if(process.env.AUDIT_LIFECYCLE_FILE==='manga')return callback(value);
  if(process.env.AUDIT_LIFECYCLE_FILE==='harness')return 'Although the task was difficult, she finished it on time.';
  return {start:{x:0,y:10},end:{x:20,y:10},x:0,y:10,endX:20,endY:10,right:10,bottom:0};
 }
});
const popup=makePage(),content=makePage();
exports.launchFocusSafePersistentContext=async options=>{const session=await base.launchFocusSafePersistentContext(options);return {...session,context};};
exports.newPageWithoutForeground=async()=>makePage();
exports.activateExtensionTabWithoutForeground=async()=>{};
`;

const selectionHelperSource = String.raw`
const base=require(process.env.AUDIT_BASE_HELPER),log=(...args)=>global.__auditLog(...args);
const {window}=require('linkedom').parseHTML('<html><body><div id="fluent-read-page-styles"></div><main id="target">controlled selection</main></body></html>');
for(const name of ['window','document','Node'])global[name]=name==='window'?window:window[name];
window.getSelection=()=>null;
let config={__fluentConfigRevision:0,harness:{enabled:false,memoryEnabled:false},on:true,selectionTranslatorMode:'bilingual',disableSelectionTranslator:false,selectionTranslatorDelay:300,selectionTranslatorTrigger:'icon',selectionTranslatorHotkey:'none'};
global.chrome={runtime:{lastError:null,sendMessage:(message,callback)=>{
 let result;
 if(message.type==='FLUENT_READ_BROWSER_FIXTURE_PING')result={success:false,error:'不支持的后台消息'};
 else if(message.type==='persistConfig'){config={...message.config,__fluentConfigRevision:config.__fluentConfigRevision+1};result={success:true,revision:config.__fluentConfigRevision};}
 else result={success:true,value:message.key==='local:config'?config:{}};
 if(callback)queueMicrotask(()=>callback(result));return Promise.resolve(result);
}}};
const locate=(selector='',role='',name='')=>({
 first(){return this;},last(){return this;},locator:next=>locate(next,role,name),getByRole:(next,opts={})=>locate(selector,next,opts.name),waitFor:async()=>{},
 click:async()=>{log('controlled-settings-click',{selector,role,name});if(role==='button'&&['双语显示','关闭','仅译文'].includes(name)){config.selectionTranslatorMode={'双语显示':'bilingual','关闭':'disabled','仅译文':'translation-only'}[name];config.disableSelectionTranslator=name==='关闭';}if(role==='option'){config.selectionTranslatorTrigger=name==='直接弹出'?'direct':'icon';config.selectionTranslatorHotkey='none';}},
 fill:async value=>{config.selectionTranslatorDelay=Number(value);},press:async()=>{},
 count:async()=>/input\[aria-label="划词翻译显示延迟"\]|selection-trigger-chips|custom-hotkey-dialog/.test(selector)?0:1,
 inputValue:async()=>String(config.selectionTranslatorDelay),getAttribute:async()=> 'true',allTextContents:async()=>['关闭','双语显示','仅译文'],
 textContent:async()=>selector.includes('drawer-settings-link')?'划词翻译设置':selector.includes('el-select__placeholder')?(config.selectionTranslatorTrigger==='direct'?'直接弹出':'显示图标'):'',
 evaluate:async callback=>callback({querySelector:next=>next==='.selection-preview-icon'&&config.selectionTranslatorTrigger==='icon'?{}:next==='kbd, strong'?{textContent:'直接弹出'}:null}),
 boundingBox:async()=>({x:0,y:0,width:400,height:30})
});
let serial=0;
const cdp={send:async method=>{log('selection-cdp-command',{method});if(method==='DOM.getDocument')return {root:{nodeId:1,nodeName:'HTML',children:[]}};return {};},detach:async()=>{log('selection-cdp-detach');}};
const context={on(){},serviceWorkers:()=>[{url:()=> 'chrome-extension://audit-fixture/background.js',on(){},evaluate:async()=>{}}],route:async()=>{},newCDPSession:async()=>cdp};
const page=()=>({on(){},context:()=>context,locator:selector=>locate(selector),getByRole:(role,opts={})=>locate('',role,opts.name),goto:async()=>{},reload:async()=>{},waitForTimeout:async()=>{},screenshot:async()=>{},
 mouse:{move:async()=>{},down:async()=>{},up:async()=>{},click:async()=>{}},keyboard:{press:async()=>{}},
 evaluate:async(callback,value)=>{if(global.__auditTracking){log('tracking-interaction-failed');throw Error('CONTROLLED_TRACKING_INTERACTION_FAILURE');}return callback(value);}
});
exports.launchFocusSafePersistentContext=async options=>{const session=await base.launchFocusSafePersistentContext(options);return {...session,context};};
exports.newPageWithoutForeground=async()=>{serial++;return page();};
exports.activateExtensionTabWithoutForeground=async()=>{};
`;

const videoContractHelperSource = String.raw`
const base=require(process.env.AUDIT_BASE_HELPER),fs=require('node:fs'),path=require('node:path'),log=(...args)=>global.__auditLog(...args);
const {parseHTML}=require('linkedom');
let config={__fluentConfigRevision:0,videoService:'microsoft',token:{},model:{}};
global.chrome={runtime:{sendMessage:async message=>{if(message.type==='persistConfig'){config={...config,...message.config,__fluentConfigRevision:config.__fluentConfigRevision+1};return {success:true};}return {success:true,value:message.key==='local:config'?config:{}};}}};
let serial=0;
const locator={first(){return this;},waitFor:async()=>{},click:async()=>{},count:async()=>0,getAttribute:async()=> 'true'};
const makePage=()=>{
 let ownWindow,currentUrl='about:blank';
 const use=()=>{global.window=ownWindow;global.document=ownWindow.document;global.HTMLElement=ownWindow.HTMLElement;};
 return {on(){},locator:()=>locator,getByRole:()=>locator,getByText:()=>locator,screenshot:async()=>{},close:async()=>{},waitForTimeout:async()=>{},waitForLoadState:async()=>{},url:()=>currentUrl,
  goto:async url=>{currentUrl=url;const html=url.includes('/popup.html')?'<div data-feature="video-subtitle" class="feature-card"></div><div class="feature-card">图片翻译</div>'+ '<div class="feature-card"></div>'.repeat(4):url.includes('/options.html')?'<div class="sidebar"><button class="active">视频字幕翻译</button></div><section id="settings-video"><select aria-label="视频字幕翻译服务"></select></section>':'<div class="ytp-right-controls"><button id="fluent-read-video-subtitle-button" aria-pressed="true"></button></div>'+fs.readFileSync(process.env.AUDIT_VIDEO_MENU,'utf8');ownWindow=parseHTML('<html><body>'+html+'</body></html>').window;ownWindow.location={origin:'https://controlled.invalid'};ownWindow.postMessage=()=>{};use();},
  reload:async()=>{},evaluate:async(callback,value)=>{use();const result=await callback(value);if(result?.modeCount!==undefined)log('actual-client-menu-consumed',result);return result;},
  waitForSelector:async()=>{},waitForFunction:async(callback,value,options)=>{use();const result=await callback(value);log('public-wait-function-port',{value,options,result});if(!result)throw Error('CONTROLLED_OVERLAY_TIMEOUT');},
  waitForEvent:async()=>{const file=path.join(process.env.TMPDIR,'controlled.srt');fs.writeFileSync(file,'1\n00:00:00,000 --> 00:00:01,200\nDownload test subtitle.\n');return {path:async()=>file,suggestedFilename:()=> 'fixture.srt'};}
 };
};
const context={on(){},serviceWorkers:()=>[{url:()=> 'chrome-extension://audit-fixture/background.js'}],waitForEvent:async()=>{const page=makePage();await page.goto('chrome-extension://audit-fixture/options.html#settings-video');return page;}};
exports.launchFocusSafePersistentContext=async options=>{const session=await base.launchFocusSafePersistentContext(options);return {...session,context};};
exports.newPageWithoutForeground=async()=>{serial++;return makePage();};
exports.activateExtensionTabWithoutForeground=async()=>{};
`;

beforeAll(() => {suiteRoot = mkdtempSync(path.join(tmpdir(), 'fluentread-audit49I-'));});
afterAll(() => {if (suiteRoot) rmSync(suiteRoot, {recursive: true, force: true});});

async function invoke(file: string, fault: string, extra: string[] = []): Promise<Result> {
    const fixture = path.join(suiteRoot, String(++invocation));
    const runtime = path.join(fixture, 'runtime/node_modules');
    const artifacts = path.join(fixture, 'artifacts/screenshots');
    const languages = path.join(fixture, 'languages');
    const source = path.join(fixture, 'extension');
    for (const directory of [runtime + '/playwright', artifacts, languages, source, fixture + '/temp']) mkdirSync(directory, {recursive: true});
    writeFileSync(runtime + '/playwright/index.js', 'exports.chromium = {launch: (...args) => require(process.env.AUDIT_HELPER_PORT).headlessLaunch(...args)};');
    writeFileSync(languages + '/chi_sim.traineddata', 'controlled-language-sentinel');
    writeFileSync(languages + '/eng.traineddata', 'controlled-language-sentinel');
    writeFileSync(source + '/manifest.json', JSON.stringify({name: 'controlled-copy-fixture', action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}));
    mkdirSync(source + '/content-scripts');
    writeFileSync(source + '/content-scripts/content.js', '// controlled artifact hash input; no production client behavior claim\n');
    const helper = path.join(fixture, 'helper.cjs');
    const lifecycleHelper = path.join(fixture, 'lifecycle-helper.cjs');
    const preload = path.join(fixture, 'preload.cjs');
    const eventsFile = path.join(fixture, 'events.jsonl');
    writeFileSync(helper, helperSource);
    writeFileSync(lifecycleHelper, file === selectionTrigger ? selectionHelperSource : file === videoContract ? videoContractHelperSource : lifecycleHelperSource);
    writeFileSync(preload, preloadSource);
    writeFileSync(eventsFile, '');
    if (file === videoContract) {
        const dom = parseHTML('<html><body></body></html>');
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', {value:dom.document,configurable:true});
        try {
            const {createVideoPlayerMenu} = await import('@/src/features/video-subtitle/content/playerMenu');
            const menu = createVideoPlayerMenu('zh-CN', false);
            expect([...menu.querySelectorAll('[data-mode]')].map(node=>node.getAttribute('data-mode'))).toEqual(['bilingual','translation-only','original-only','off']);
            menu.querySelector('[data-mode="bilingual"]')!.setAttribute('aria-checked','true');
            menu.querySelector('[data-service-label]')!.textContent='微软翻译';
            writeFileSync(path.join(fixture,'client-menu.html'),menu.outerHTML);
        } finally {if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
    }
    let script = path.join(sourceRoot, file);
    const scriptBytes = readFileSync(script);
    const sourceModule = script;
    if (file === fullPage) {
        script = path.join(fixture, 'public-export-driver.cjs');
        writeFileSync(script, `const production = require(process.env.AUDIT_SOURCE_MODULE);
(async () => {
  if (process.env.AUDIT_FAULT === 'export-fetch') {
    const calls = []; globalThis.location = {href: 'chrome-extension://audit-fixture/background.js'};
    globalThis.fetch = async input => {calls.push(String(input)); return {controlled: true};};
    const worker = {evaluate: async (callback, value) => callback(value)};
    await production.installTranslationFixtureOnWorker(worker, {translationUrl: 'http://127.0.0.1:43111/translate', blockedUrl: 'http://127.0.0.1:43111/blocked'});
    await fetch('http://[::1]:43111/resource'); await fetch('http://localhost:43111/resource');
    await fetch('https://provider.invalid/resource'); await fetch('https://edge.microsoft.com/translate/translatetext');
    console.log(JSON.stringify({calls}));
  } else if (process.env.AUDIT_FAULT === 'export-provider-normal') {
    const fixture = await production.startTranslationFixtureServer();
    const responses=[];
    for (const payload of [[' A little curiosity goes a long way. ','unmatched'],[],null]) {
      const response=await fetch(fixture.translationUrl,{method:'POST',body:JSON.stringify(payload)});
      responses.push({status:response.status,body:await response.text()});
    }
    await fixture.close();console.log(JSON.stringify({responses,requests:fixture.requestCount(),items:fixture.translatedItemCount(),payloads:fixture.requestPayloads()}));
  } else if (process.env.AUDIT_FAULT.startsWith('export-server')) {
    const fixture = await production.startTranslationFixtureServer([], 60000);
    const http=require('node:http');
    const request=http.request(fixture.translationUrl,{method:'POST',agent:false});
    request.on('error',error=>global.__auditLog('controlled-client-error',{message:error.message}));
    request.end(JSON.stringify(['bounded input']));
    while (!fixture.requestCount()) await new Promise(resolve=>setImmediate(resolve));
    await fixture.close(); global.__auditLog('public-fixture-closed',{requests:fixture.requestCount(),items:fixture.translatedItemCount(),payloads:fixture.requestPayloads()});
  } else if (process.env.AUDIT_FAULT === 'export-html-listen') {
    await production.startFixtureServer();
  } else if (process.env.AUDIT_FAULT === 'export-listen') {
    await production.startTranslationFixtureServer();
  } else console.log(JSON.stringify(production.parseArgs(process.argv.slice(2))));
})().catch(error => {console.error(error.stack); process.exitCode = 1;});`);
    }
    if (file === group && sourceRoot !== project) {
        // The original ESM CLI resolves its matrix from import.meta.url. Preserve its exact bytes and give it current dependencies.
        script = path.join(fixture, 'baseline-tree', file);
        mkdirSync(path.dirname(script), {recursive: true});
        mkdirSync(path.join(fixture, 'baseline-tree/tests'), {recursive: true});
        writeFileSync(script, scriptBytes);
        writeFileSync(path.join(fixture, 'baseline-tree/tests/test-matrix.json'), readFileSync(path.join(project, 'tests/test-matrix.json')));
    }
    let args: string[];
    if (file === capture) args = ['--runtime', runtime, '--helper', helper, '--output', artifacts];
    else if (file === ocr) args = ['--extension-dir', fault === 'missing-source' ? path.join(fixture, 'missing') : source, '--language-dir', languages, '--artifacts-dir', artifacts, '--playwright-root', runtime, '--focus-safe-helper', helper];
    else if (file === group) args = ['unit'];
    else args = ['--extension-dir', source, '--artifacts-dir', artifacts, '--playwright-root', runtime, '--focus-safe-helper', helper];
    if ([selectionTrigger,videoContract].includes(file)) {args[args.indexOf('--focus-safe-helper')+1]=lifecycleHelper;args.push('--browser-path',preload);}
    if (file === kofi) args.push('--url', 'https://ko-fi.com/thinkstu');
    if ([manga, density, wordFeedback, readingHarness].includes(file) && ['ws-open-error','ws-close-pending','ws-error-pending','ws-send-error','ws-malformed','ws-missing-target','ws-normal','cdp-call','cdp-exception'].includes(fault)) args[args.indexOf('--focus-safe-helper')+1] = lifecycleHelper;
    if ([siteDemo, siteVideo].includes(file)) args.push('--output', artifacts);
    let commandPath = '';
    if (file === group && fault !== 'missing-pnpm' && !extra.includes('--dry-run')) {
        commandPath = path.join(fixture, 'bin');
        mkdirSync(commandPath);
        writeFileSync(path.join(commandPath, 'pnpm'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.AUDIT_EVENTS, JSON.stringify({kind:'pnpm',args:process.argv.slice(2)})+'\\n');process.exit(${fault === 'child-exit' ? 7 : 0});\n`, {mode: 0o755});
    }
    const child = spawn(process.execPath, ['--require', preload, script, ...args, ...extra], {
        cwd: project, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, NODE_PATH: path.join(project, 'node_modules'), TMPDIR: fixture + '/temp', AUDIT_EVENTS: eventsFile, AUDIT_FAULT: fault, AUDIT_SCRIPT: sourceModule, AUDIT_SOURCE_MODULE: sourceModule,
            AUDIT_PLAYWRIGHT_PORT: runtime + '/playwright/index.js', AUDIT_HELPER_PORT: helper,
            AUDIT_BASE_HELPER: helper, AUDIT_VIDEO_MENU: path.join(fixture,'client-menu.html'), AUDIT_INTERVAL_PORT: file === selectionTrigger ? '1' : '0',
            AUDIT_PROJECT: project, AUDIT_PROVENANCE_PORT: file === readingHarness ? '1' : '0',
            AUDIT_LIFECYCLE_FILE: file === manga ? 'manga' : file === readingHarness ? 'harness' : 'reading',
            AUDIT_MANGA_SOCKET: file === manga ? '1' : '0',
            AUDIT_VIDEO_MEDIA_SUCCESS: [...nativeTools,videoFixture].includes(file) && fault !== 'native' ? '1' : '0',
            AUDIT_VOCABULARY_FALLBACKS: file === vocabulary && fault === 'http-fallbacks' ? '1' : '0',
            AUDIT_SHAPE_PROBES: fault === 'http-shapes' ? '1' : '0', AUDIT_VOCABULARY_SHAPES: file === vocabulary ? '1' : '0',
            AUDIT_JSON_PROBES: jsonTools.includes(file) && fault === 'http' ? '1' : '0',
            AUDIT_URI_PROBES: [siteDemo, siteVideo].includes(file) && fault === 'http' ? '1' : '0',
            AUDIT_NATIVE_PORT: [...nativeTools,videoFixture].includes(file) ? '1' : '0',
            AUDIT_WORKER_FAILURE: [...cleanupTools,...nativeTools].includes(file) ? '1' : '0',
            AUDIT_CAPTURE_PROBES: file === capture ? '1' : '0', AUDIT_CENTER_PROBES: file === translationCenter && fault === 'http' ? '1' : '0',
            AUDIT_VALID_SESSION: [requestLimits, translationCenter, freeSettings, writing, manga, videoFixture, ...cleanupTools,...nativeTools].includes(file) ? '1' : '0',
            ...(file === group ? {PATH: commandPath} : {})},
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout!.on('data', chunk => {stdout += chunk;});
    child.stderr!.on('data', chunk => {stderr += chunk;});
    const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);} catch {}
    };
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {timedOut = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 300);}, 7000);
    const {code, signal} = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({code, signal}));
    }).finally(() => {clearTimeout(deadline); if (forceTimer) clearTimeout(forceTimer);});
    const events: Event[] = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const directories = events.filter(e => e.kind === 'temporary-directory').map(e => ({directory: e.directory, exists: existsSync(e.directory)}));
    const reportPath = file === capture ? path.join(artifacts, '../capture-report.json') : path.join(artifacts, file === translationCenter ? 'browser-report.json' : 'report.json');
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined;
    const result = {code, signal, timedOut, stdout, stderr, events, directories, report, fixture, scriptHash: createHash('sha256').update(scriptBytes).digest('hex')};
    if (evidence) {
        mkdirSync(evidence, {recursive: true});
        writeFileSync(path.join(evidence, `${invocation}-${path.basename(file)}-${fault}.json`), JSON.stringify(result, null, 2));
    }
    expect(events[0]?.kind, 'controlled external ports loaded before the production CLI').toBe('ports-ready');
    if (file !== group) expect(events.some(e => e.kind === 'source-enter')).toBe(true);
    expect(timedOut, stderr).toBe(false);
    expect(signal, stderr).toBeNull();
    let processGroupGone = false;
    try {process.kill(process.platform === 'win32' ? events[0].pid : -events[0].pid, 0);}
    catch (error) {processGroupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';}
    expect(processGroupGone, 'the unique public CLI process group has exited after close/wait').toBe(true);
    return result;
}

const count = (result: Result, kind: string) => result.events.filter(e => e.kind === kind).length;
const removed = (result: Result, total: number) => {expect(result.directories).toHaveLength(total); expect(result.directories.every(d => !d.exists)).toBe(true);};
const failure = (result: Result, message: string) => {expect(result.code).toBe(1); expect(result.report?.ok).toBe(false); expect(result.report?.error || result.report?.failure).toContain(message);};

describe('product asset capture public CLI with real loopback fixture transport', () => {
    it('releases server and profile when revision initialization fails before launch', async () => {
        const result = await invoke(capture, 'git');
        failure(result, 'CONTROLLED_GIT_FAILURE'); removed(result, 1);
        expect(count(result, 'launch')).toBe(0); expect(count(result, 'server-closed')).toBe(1);
    });
    it('keeps translation fallback, malformed input and both SSE rounds unchanged while cleaning a rejected launch', async () => {
        const result = await invoke(capture, 'launch');
        failure(result, 'CONTROLLED_LAUNCH_FAILURE'); removed(result, 1);
        expect(count(result, 'server-closed')).toBe(1);
        const probes = result.events.find(e => e.kind === 'http-probes')!.probes;
        expect(probes.preflight.status).toBe(204);
        expect(JSON.parse(probes.translations.body)).toEqual([{translations: [{text: '一点好奇心，就能带你走很远。'}]}, {translations: [{text: 'unmatched'}]}]);
        expect(JSON.parse(probes.empty.body)).toEqual([]); expect(probes.malformed.status).toBe(400);
        expect(probes.article.body).toContain('A little curiosity goes a long way.');
        expect(probes.tool.contentType).toContain('text/event-stream');
        expect(probes.tool.body).toContain('"name":"read_context"'); expect(probes.tool.body).toContain('"finish_reason":"tool_calls"');
        expect(probes.answer.body).toContain('go a long way'); expect(probes.answer.body).toContain('"finish_reason":"stop"');
        expect(probes.tool.body.endsWith('data: [DONE]\n\n')).toBe(true); expect(probes.answer.body.endsWith('data: [DONE]\n\n')).toBe(true);
    });
    it('closes the acquired session and removes its profile even if the final report cannot be written', async () => {
        const result = await invoke(capture, 'report-write');
        expect(result.code).toBe(1); expect(result.stderr).toContain('CONTROLLED_PAGE_FAILURE'); expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
        expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1); removed(result, 1);
    });
    it('retains the exact profile on unconfirmed session closure and keeps the original failure in the report', async () => {
        const result = await invoke(capture, 'close');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); expect(result.report.cleanupError).toContain('CONTROLLED_CLOSE_FAILURE');
        expect(result.directories).toHaveLength(1); expect(result.directories[0].exists).toBe(true);
        expect(result.report.retainedProfile).toBe(result.directories[0].directory); expect(count(result, 'server-closed')).toBe(1);
    });
    it('records profile removal failure after releasing session and server', async () => {
        const result = await invoke(capture, 'remove-profile');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); expect(result.report.profileCleanupError).toContain('CONTROLLED_REMOVE_FAILURE');
        expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1);
    });
    it('handles an asynchronous listen failure without acquiring or leaking a profile', async () => {
        const result = await invoke(capture, 'listen');
        failure(result, 'CONTROLLED_LISTEN_FAILURE'); removed(result, 0); expect(count(result, 'launch')).toBe(0);
        expect(count(result, 'server-close-attempt')).toBe(1);
    });
    it('uses distinct owned profiles on repeated failed invocations and cleans both', async () => {
        const first = await invoke(capture, 'launch'); const second = await invoke(capture, 'launch');
        removed(first, 1); removed(second, 1); expect(first.directories[0].directory).not.toBe(second.directories[0].directory);
        expect(count(first, 'server-closed')).toBe(1); expect(count(second, 'server-closed')).toBe(1);
    });
});

describe('OCR diagnostic public CLI initialization and resource ownership', () => {
    it('cleans both temporary directories and records a missing extension before browser launch', async () => {
        const result = await invoke(ocr, 'missing-source');
        failure(result, 'ENOENT'); removed(result, 2); expect(count(result, 'launch')).toBe(0);
    });
    it('cleans partially copied fixtures when the second language copy fails', async () => {
        const result = await invoke(ocr, 'copy-language');
        failure(result, 'CONTROLLED_COPY_FAILURE'); removed(result, 2); expect(count(result, 'launch')).toBe(0);
    });
    it('cleans the first directory if creating the second directory fails', async () => {
        const result = await invoke(ocr, 'second-temp');
        failure(result, 'CONTROLLED_SECOND_TEMP_FAILURE'); removed(result, 1); expect(count(result, 'launch')).toBe(0);
    });
    it('keeps launch failure evidence and removes both copied directories', async () => {
        const result = await invoke(ocr, 'launch');
        failure(result, 'CONTROLLED_LAUNCH_FAILURE'); removed(result, 2); expect(count(result, 'session-close')).toBe(0);
    });
    it('closes the session and cleans both directories before a report write failure', async () => {
        const result = await invoke(ocr, 'report-write');
        expect(result.code).toBe(1); expect(count(result, 'session-close')).toBe(1); removed(result, 2);
        expect(result.stdout).toContain('CONTROLLED_PAGE_FAILURE'); expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
    });
    it('retains profile and loaded extension when session close fails without masking the primary failure', async () => {
        const result = await invoke(ocr, 'close');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); expect(result.report.cleanupError).toContain('CONTROLLED_CLOSE_FAILURE');
        expect(result.directories).toHaveLength(2); expect(result.directories.every(d => d.exists)).toBe(true);
        expect(result.report.retainedProfile).toBe(result.directories[0].directory); expect(result.report.retainedFixture).toBe(result.directories[1].directory);
    });
    it('still removes the extension copy when removing the profile fails', async () => {
        const result = await invoke(ocr, 'remove-profile');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); expect(result.report.directoryCleanupErrors).toHaveLength(1);
        expect(result.report.directoryCleanupErrors[0].error).toContain('CONTROLLED_REMOVE_FAILURE');
        expect(result.directories[0].exists).toBe(true); expect(result.directories[1].exists).toBe(false); expect(count(result, 'session-close')).toBe(1);
    });
});

describe('test group real CLI and controlled pnpm process', () => {
    it('reports spawn ENOENT through the CLI error protocol without an unhandled event', async () => {
        const result = await invoke(group, 'missing-pnpm');
        expect(result.code).toBe(1); expect(result.stderr).toContain('[test-group] spawn pnpm ENOENT');
        expect(result.stderr).not.toContain("Unhandled 'error' event");
    });
    it('passes the complete group and coverage flag to the child without filtering cases', async () => {
        const result = await invoke(group, 'success', ['--coverage']);
        const matrix = JSON.parse(readFileSync(path.join(project, 'tests/test-matrix.json'), 'utf8'));
        expect(result.code).toBe(0); expect(result.events.find(e => e.kind === 'pnpm')?.args).toEqual(['exec', 'vitest', 'run', '--coverage', ...matrix.groups.unit]);
    });
    it('preserves the actual child exit status instead of converting failed tests to success', async () => {
        const result = await invoke(group, 'child-exit'); expect(result.code).toBe(7);
    });
    it('prints the real matrix in dry run and does not spawn pnpm', async () => {
        const result = await invoke(group, 'success', ['--dry-run', '--coverage']);
        const matrix = JSON.parse(readFileSync(path.join(project, 'tests/test-matrix.json'), 'utf8'));
        expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({group: 'unit', coverage: true, files: matrix.groups.unit});
        expect(count(result, 'pnpm')).toBe(0);
    });
});

describe('UI consistency public CLI profile lifecycle', () => {
    it('removes its exact temporary profile after an external launch rejection', async () => {
        const result = await invoke(consistency, 'launch');
        failure(result, 'CONTROLLED_LAUNCH_FAILURE'); removed(result, 1); expect(count(result, 'session-close')).toBe(0);
    });
    it('closes its session and removes the profile before writing a failed report', async () => {
        const result = await invoke(consistency, 'report-write');
        expect(result.code).toBe(1); expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
        expect(result.stderr).toContain('CONTROLLED_PAGE_FAILURE'); expect(count(result, 'session-close')).toBe(1); removed(result, 1);
    });
    it('records both primary and cleanup failures and retains only its own unconfirmed profile', async () => {
        const result = await invoke(consistency, 'close');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); expect(result.report.cleanupError).toContain('CONTROLLED_CLOSE_FAILURE');
        expect(result.directories).toHaveLength(1); expect(result.directories[0].exists).toBe(true);
        expect(result.report.retainedProfile).toBe(result.directories[0].directory);
    });
});

for (const file of [requestLimits, translationCenter, freeSettings, writing]) {
    describe(`${path.basename(file)} public CLI resource ownership`, () => {
        it('closes the helper session and removes only its owned profile after a page port failure', async () => {
            const result = await invoke(file, 'page');
            failure(result, 'CONTROLLED_PAGE_FAILURE'); removed(result, 1);
            expect(count(result, 'session-close')).toBe(1); expect(count(result, 'raw-context-close')).toBe(0);
            if ([translationCenter, writing].includes(file)) expect(count(result, 'server-closed')).toBe(1);
        }, 12000);
        it('releases session, server and profile before a final report write failure', async () => {
            const result = await invoke(file, 'report-write');
            expect(result.code).toBe(1); expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
            expect(`${result.stdout}\n${result.stderr}`).toContain('CONTROLLED_PAGE_FAILURE');
            expect(count(result, 'session-close')).toBe(1); removed(result, 1);
            if ([translationCenter, writing].includes(file)) expect(count(result, 'server-closed')).toBe(1);
        }, 12000);
        it('records close rejection, preserves the primary failure and retains the exact unconfirmed profile', async () => {
            const result = await invoke(file, 'close');
            failure(result, 'CONTROLLED_PAGE_FAILURE');
            expect(result.report.cleanupErrors.join('\n')).toContain('CONTROLLED_CLOSE_FAILURE');
            expect(result.directories).toHaveLength(1); expect(result.directories[0].exists).toBe(true);
            expect(result.report.retainedProfile).toBe(result.directories[0].directory);
            expect(count(result, 'session-close')).toBe(1); expect(count(result, 'remove-attempt')).toBe(0);
            if ([translationCenter, writing].includes(file)) expect(count(result, 'server-closed')).toBe(1);
        }, 12000);
        it('retains a profile when launch rejects without a session ownership receipt', async () => {
            const result = await invoke(file, 'launch');
            failure(result, 'CONTROLLED_LAUNCH_FAILURE');
            expect(result.directories).toHaveLength(1); expect(result.directories[0].exists).toBe(true);
            expect(result.report.retainedProfile).toBe(result.directories[0].directory);
            expect(count(result, 'session-close')).toBe(0);
            if ([translationCenter, writing].includes(file)) expect(count(result, 'server-closed')).toBe(1);
        }, 12000);
        it('records initial profile creation failure and closes an already acquired fixture server', async () => {
            const result = await invoke(file, 'first-temp');
            failure(result, 'CONTROLLED_FIRST_TEMP_FAILURE'); removed(result, 0);
            expect(count(result, 'launch')).toBe(0);
            if ([translationCenter, writing].includes(file)) expect(count(result, 'server-closed')).toBe(1);
        }, 12000);
    });
}

describe('translation center public CLI real controlled HTTP fixture', () => {
    it('preserves preflight, model and failed-service responses and rejects malformed JSON without crashing', async () => {
        const result = await invoke(translationCenter, 'http');
        failure(result, 'CONTROLLED_PAGE_FAILURE'); removed(result, 1);
        const probes = result.events.find(e => e.kind === 'center-http-probes')!.probes;
        expect(probes.preflight.status).toBe(204);
        expect(probes.normal.status).toBe(200); expect(JSON.parse(probes.normal.body).model).toBe('fixture-a');
        expect(JSON.parse(probes.normal.body).choices[0].message.content).toBe('优秀的设计，让复杂的事变得简单。');
        expect(probes.failure.status).toBe(503); expect(JSON.parse(probes.failure.body).error.message).toBe('comparison fixture temporarily unavailable');
        expect(probes.malformed.status).toBe(400); expect(JSON.parse(probes.malformed.body).error.message).toBe('Invalid synthetic fixture request');
        for (const probe of [probes.nullBody, probes.arrayBody]) {
            expect(probe.status).toBe(400); expect(JSON.parse(probe.body).error.message).toBe('Invalid synthetic fixture request');
        }
        expect(count(result, 'server-closed')).toBe(1); expect(count(result, 'session-close')).toBe(1);
    }, 12000);
});

for (const file of [translationCenter, writing]) {
    it(`${path.basename(file)} reports asynchronous listen failure and releases the unstarted server`, async () => {
        const result = await invoke(file, 'listen');
        failure(result, 'CONTROLLED_LISTEN_FAILURE'); removed(result, 0);
        expect(count(result, 'launch')).toBe(0); expect(count(result, 'server-close-attempt')).toBe(1);
        expect(result.stderr).not.toContain("Unhandled 'error' event");
    }, 12000);
}

for (const file of cleanupTools.filter(file => file !== kofi)) {
    it(`${path.basename(file)} releases acquired resources before report write rejection`, async () => {
        const result = await invoke(file, 'report-write');
        expect(result.code).toBe(1); expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
        expect(count(result, 'session-close')).toBe(1);
        expect(result.directories.every(directory => !directory.exists)).toBe(true);
        if (count(result, 'server-listening')) expect(count(result, 'server-closed')).toBe(count(result, 'server-created'));
        expect(count(result, 'report-write-failed')).toBe(1);
    }, 12000);
}
for (const file of cleanupTools) {
    it(`${path.basename(file)} keeps primary failure and continues independent cleanup after close rejection`, async () => {
        const result = await invoke(file, 'close');
        expect(result.code).toBe(1); expect(count(result, 'session-close')).toBe(1);
        expect(JSON.stringify(result.report)).toMatch(/CONTROLLED_(?:PAGE|WORKER)_FAILURE/);
        expect(JSON.stringify(result.report)).toContain('CONTROLLED_CLOSE_FAILURE');
        expect(result.directories).toHaveLength(1); expect(result.directories[0].exists).toBe(true);
        expect(result.report.retainedProfile).toBe(result.directories[0].directory);
        if (count(result, 'server-listening')) expect(count(result, 'server-closed')).toBe(count(result, 'server-created'));
    }, 12000);
}
for (const file of [kofi, pageLoop, customHeaders, requestHeaders, apiKeys, globalToggle, bilingual, translationStyle, vocabulary]) {
    it(`${path.basename(file)} disposes partial ownership on asynchronous fixture listen rejection`, async () => {
        const result = await invoke(file, 'listen');
        expect(result.code).toBe(1); expect(count(result, 'launch')).toBe(0);
        expect(result.directories.every(directory => !directory.exists)).toBe(true);
        expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain('CONTROLLED_LISTEN_FAILURE');
        expect(result.stderr).not.toContain("Unhandled 'error' event");
        expect(count(result, 'server-close-attempt')).toBe(count(result, 'server-created'));
    }, 12000);
}
for (const file of jsonTools) {
    it(`${path.basename(file)} returns malformed-JSON failure through its real HTTP callback then serves the next valid request`, async () => {
        const result = await invoke(file, 'http');
        expect(result.code).toBe(1);
        const probes = result.events.find(event => event.kind === 'json-recovery-probes')!.before;
        const all = result.events.find(event => event.kind === 'json-recovery-probes')!;
        expect(probes.status).toBe(200); expect(all.malformed.status).toBe(400);
        expect(all.after).toEqual(probes);
        expect(JSON.parse(all.malformed.body).error).toBeTruthy();
        expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1);
        expect(result.directories.every(directory => !directory.exists)).toBe(true);
        expect(result.stderr).not.toContain('SyntaxError');
    }, 12000);
}
for (const file of [siteDemo, siteVideo]) {
    it(`${path.basename(file)} rejects malformed URL encoding without killing its actual fixture server`, async () => {
        const result = await invoke(file, 'http');
        const probes = result.events.find(event => event.kind === 'uri-recovery-probes')!;
        expect(probes.before.status).toBe(404); expect(probes.malformed.status).toBe(400); expect(probes.after).toEqual(probes.before);
        expect(result.code).toBe(1); expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1);
        expect(result.stderr).not.toContain('URIError');
    }, 12000);
    it(`${path.basename(file)} releases browser and server before report-write rejection`, async () => {
        const result = await invoke(file, 'report-write');
        expect(result.code).toBe(1); expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1);
        expect(count(result, 'report-write-failed')).toBe(1);
    }, 12000);
    it(`${path.basename(file)} closes server after browser close rejection and retains primary failure evidence`, async () => {
        const result = await invoke(file, 'close');
        expect(result.code).toBe(1); expect(count(result, 'session-close')).toBe(1); expect(count(result, 'server-closed')).toBe(1);
        expect(JSON.stringify(result.report)).toContain('CONTROLLED_CLOSE_FAILURE');
        expect(JSON.stringify(result.report)).toContain('CONTROLLED_PAGE_FAILURE');
    }, 12000);
}
for (const [file, argument, field] of [
    [popupStartup, '--opens', 'opens'], [popupStartup, '--config-delay-ms', 'config-delay-ms'],
    [loadingMotion, '--samples', 'samples'], [loadingMotion, '--sample-interval-ms', 'sample-interval-ms'],
]) {
    it(`${path.basename(file)} rejects nonfinite ${field} before acquiring a browser profile`, async () => {
        const result = await invoke(file, 'launch', [argument, 'Infinity']);
        expect(result.code).toBe(1); expect(result.stderr).toContain(field); expect(result.stderr).toMatch(/无效|finite/);
        removed(result, 0); expect(count(result, 'launch')).toBe(0);
    }, 12000);
}
for (const file of [popupStartup, loadingMotion]) {
    it(`${path.basename(file)} retains finite minimum/fallback arguments and reaches the external launch port`, async () => {
        const result = await invoke(file, 'launch', file === popupStartup ? ['--opens', '-1'] : ['--samples', '0']);
        expect(result.code).toBe(1); expect(count(result, 'launch')).toBe(1);
        expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain('CONTROLLED_LAUNCH_FAILURE');
    }, 12000);
}
for (const file of nativeTools) {
    it(`${path.basename(file)} gives its native subprocess a finite timeout and cleans acquired directories after timeout`, async () => {
        const result = await invoke(file, 'native');
        const operation = result.events.find(event => event.kind === 'native-command-port')!;
        expect(operation).toBeTruthy(); expect(Number.isFinite(operation.options.timeout)).toBe(true);
        expect(operation.options.timeout).toBeGreaterThan(0); expect(operation.options.killSignal).toBe('SIGKILL');
        expect(result.code).toBe(1); expect(count(result, 'launch')).toBe(0);
        expect(result.directories.every(directory => !directory.exists)).toBe(true);
        expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain('CONTROLLED_NATIVE_TIMEOUT');
    }, 12000);
}

for (const url of ['http://[::1]:43111/fixture', 'http://localhost:43111/fixture', 'http://127.0.0.1:43111/fixture']) {
    it(`full-page public parser accepts loopback ${url} without creating a browser or network request`, async () => {
        const result = await invoke(fullPage, 'export-parse', ['--url', url]);
        expect(result.code).toBe(0); expect(JSON.parse(result.stdout).url).toBe(url);
        expect(count(result, 'launch')).toBe(0); removed(result, 0);
    }, 12000);
}
for (const url of ['http://127.0.0.1.evil.invalid/fixture', 'http://127.0.0.1@example.invalid/fixture']) {
    it(`full-page public parser rejects deceptive loopback ${url}`, async () => {
        const result = await invoke(fullPage, 'export-parse', ['--url', url]);
        expect(result.code).toBe(1); expect(result.stderr).toContain('loopback URL'); expect(count(result, 'launch')).toBe(0);
    }, 12000);
}
it('full-page public worker fixture preserves IPv6/local traffic and blocks external providers through controlled fetch', async () => {
    const result = await invoke(fullPage, 'export-fetch');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).calls).toEqual(['http://[::1]:43111/resource', 'http://localhost:43111/resource', 'http://127.0.0.1:43111/blocked?url=https%3A%2F%2Fprovider.invalid%2Fresource', 'http://127.0.0.1:43111/translate']);
    removed(result, 0); expect(count(result, 'launch')).toBe(0);
}, 12000);

it('full-page public provider closes an active delayed request and cancels its owned delay before CLI exit', async () => {
    const result = await invoke(fullPage, 'export-server-close');
    expect(result.code).toBe(0); expect(count(result, 'public-fixture-closed')).toBe(1);
    expect(result.events.find(event => event.kind === 'public-fixture-closed')).toMatchObject({requests:1,items:1,payloads:[['bounded input']]});
    expect(count(result, 'server-closed')).toBe(1); expect(count(result, 'launch')).toBe(0);
}, 12000);
it('full-page public provider releases an unstarted server after asynchronous listen rejection', async () => {
    const result = await invoke(fullPage, 'export-listen');
    expect(result.code).toBe(1); expect(result.stderr).toContain('CONTROLLED_LISTEN_FAILURE');
    expect(count(result, 'server-close-attempt')).toBe(1); expect(count(result, 'launch')).toBe(0);
}, 12000);
for (const file of [documentTool, density, wordFeedback]) {
    for (const fault of ['report-write','listen']) {
        it(`${path.basename(file)} releases acquired resources on ${fault} through the actual CLI`, async () => {
            const result = await invoke(file, fault);
            expect(result.code).toBe(1); expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain(fault==='listen'?'CONTROLLED_LISTEN_FAILURE':'CONTROLLED_REPORT_WRITE_FAILURE');
            expect(result.directories.every(directory=>!directory.exists)).toBe(true);
            expect(count(result,'server-close-attempt')).toBe(count(result,'server-created'));
            if (fault === 'report-write') expect(count(result,'session-close')).toBe(1);
        },12000);
    }
}
for (const file of [density, wordFeedback]) {
    for (const fault of ['cdp-call','cdp-exception']) {
        it(`${path.basename(file)} releases its resolved object after ${fault} through public CLI polling`, async () => {
            const result = await invoke(file, fault);
            expect(result.code).toBe(1); expect(count(result,'cdp-command')).toBeGreaterThan(0);
            const commands=result.events.filter(event=>event.kind==='cdp-command');
            expect(commands.some(event=>event.method==='Runtime.callFunctionOn')).toBe(true);
            expect(commands.filter(event=>event.method==='Runtime.releaseObject')).toHaveLength(commands.filter(event=>event.method==='DOM.resolveNode').length);
            expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain(fault==='cdp-call'?'CONTROLLED_CDP_CALL_FAILURE':'CONTROLLED_CDP_EXCEPTION');
            expect(count(result,'session-close')).toBe(1); expect(count(result,'server-closed')).toBe(1);
        },12000);
    }
}
it('reading harness public CLI detaches a failed snapshot session without allocating polling sessions repeatedly', async () => {
    const result=await invoke(readingHarness,'cdp-call');
    expect(result.code).toBe(1); expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain('CONTROLLED_CDP_DOCUMENT_FAILURE');
    expect(count(result,'cdp-created')).toBeGreaterThan(0); expect(count(result,'cdp-detach')).toBe(count(result,'cdp-created'));
    expect(count(result,'cdp-created')).toBe(1);
    expect(count(result,'session-close')).toBe(1); expect(count(result,'server-closed')).toBe(1);
},12000);
for (const fault of ['native','launch','listen','close']) {
    it(`video subtitle fixture public CLI releases partial setup on ${fault} without running native commands`,async()=>{
        const result=await invoke(videoFixture,fault);
        expect(result.code).toBe(1);
        const native=result.events.find(event=>event.kind==='native-command-port')!;
        expect(native).toBeTruthy(); expect(Number.isFinite(native.options.timeout)).toBe(true); expect(native.options.timeout).toBeGreaterThan(0);
        expect(native.options.killSignal).toBe('SIGKILL');
        if(fault==='close' || fault==='launch'){expect(`${result.stderr}\n${JSON.stringify(result.report)}`).toContain(fault==='close'?'CONTROLLED_CLOSE_FAILURE':'CONTROLLED_LAUNCH_FAILURE');expect(result.directories[0].exists).toBe(true);}
        else expect(result.directories.every(directory=>!directory.exists)).toBe(true);
        if(fault==='listen')expect(count(result,'server-close-attempt')).toBe(1);
        if(fault==='close')expect(count(result,'server-closed')).toBe(1);
        if(fault==='native')expect(count(result,'launch')).toBe(0);
    },12000);
}
for (const fault of ['ws-open-error','ws-close-pending','ws-error-pending','ws-send-error','ws-malformed','ws-missing-target','ws-normal']) {
    it(`manga public CLI settles raw CDP ownership on ${fault} without native/model activity`,async()=>{
        const result=await invoke(manga,fault);
        expect(result.code).toBe(1);expect(count(result,'websocket-created')).toBe(1);expect(count(result,'websocket-close')).toBe(1);
        expect(count(result,'native-focus-port')).toBeGreaterThan(0);expect(count(result,'native-command-port')).toBe(0);
        expect(count(result,'session-close')).toBe(1);expect(result.directories).toHaveLength(1);expect(result.directories[0].exists).toBe(false);
        expect(JSON.stringify(result.report)).toContain(fault==='ws-normal'?'CONTROLLED_PAGE_FAILURE':fault==='ws-missing-target'?'Offscreen':fault==='ws-send-error'?'CONTROLLED_SOCKET_SEND_FAILURE':fault==='ws-malformed'?'JSON':'CDP');
    },12000);
}

it('selection public CLI clears its actual 25ms tracker after the next external interaction rejects',async()=>{
    const result=await invoke(selectionTrigger,'interval-interaction');
    expect(result.code).toBe(1);expect(count(result,'tracking-interval-start')).toBe(1);expect(count(result,'tracking-interaction-failed')).toBeGreaterThan(0);
    expect(count(result,'tracking-interval-clear')).toBe(1);expect(JSON.stringify(result.report)).toContain('CONTROLLED_TRACKING_INTERACTION_FAILURE');
    expect(count(result,'session-close')).toBe(1);expect(count(result,'server-closed')).toBe(1);
    expect(result.directories.every(directory=>!directory.exists)).toBe(true);
},12000);

it('video subtitle public CLI accepts all four actual client menu modes and passes the overlay timeout in the options position',async()=>{
    const result=await invoke(videoContract,'client-contract');
    expect(result.code).toBe(1);expect(result.stderr).toContain('CONTROLLED_OVERLAY_TIMEOUT');
    const menu=result.events.find(event=>event.kind==='actual-client-menu-consumed')!;
    expect(menu.modeCount).toBe(4);expect(menu.bilingualSelected).toBe(true);expect(menu.downloadPresent).toBe(true);
    const wait=result.events.filter(event=>event.kind==='public-wait-function-port').at(-1)!;
    expect(wait.result).toBe(false);expect(wait.value).toBeNull();expect(wait.options).toEqual({timeout:45000});
    expect(count(result,'session-close')).toBe(1);expect(result.directories.every(directory=>!directory.exists)).toBe(true);
},12000);

it('full-page public HTML fixture producer releases its server after asynchronous listen failure',async()=>{
    const result=await invoke(fullPage,'export-html-listen');
    expect(result.code).toBe(1);expect(result.stderr).toContain('CONTROLLED_LISTEN_FAILURE');
    expect(count(result,'server-close-attempt')).toBe(1);expect(count(result,'launch')).toBe(0);
},12000);

it('full-page public provider preserves bounded normal, empty and fallback response semantics while closing',async()=>{
    const result=await invoke(fullPage,'export-provider-normal');
    expect(result.code).toBe(0);const output=JSON.parse(result.stdout);
    expect(output.requests).toBe(3);expect(output.items).toBe(2);expect(output.payloads).toEqual([[' A little curiosity goes a long way. ','unmatched'],[],[]]);
    expect(output.responses.map((response:any)=>response.status)).toEqual([200,200,200]);
    const translated=JSON.parse(output.responses[0].body);expect(translated).toHaveLength(2);expect(translated[1].translations[0].text).toBe('测试译文：unmatched');
    expect(JSON.parse(output.responses[1].body)).toEqual([]);expect(JSON.parse(output.responses[2].body)).toEqual([]);
    expect(count(result,'server-closed')).toBe(1);expect(count(result,'launch')).toBe(0);
},12000);

for (const file of nativeTools) {
    it(`${path.basename(file)} closes owned sessions and directories before failure-report write rejection`,async()=>{
        const result=await invoke(file,'report-write');
        expect(result.code).toBe(1);expect(count(result,'native-command-port')).toBeGreaterThan(0);
        expect(count(result,'worker-port-entered')).toBe(1);expect(count(result,'session-close')).toBe(1);
        expect(count(result,'report-write-failed')).toBe(1);expect(result.stderr).toContain('CONTROLLED_REPORT_WRITE_FAILURE');
        expect(`${result.stdout}\n${result.stderr}`).toContain('CONTROLLED_WORKER_FAILURE');
        expect(result.directories.every(directory=>!directory.exists)).toBe(true);
    },12000);
    it(`${path.basename(file)} retains only its unconfirmed browser profile and persists primary plus close failure`,async()=>{
        const result=await invoke(file,'close');
        expect(result.code).toBe(1);expect(count(result,'worker-port-entered')).toBe(1);expect(count(result,'session-close')).toBe(1);
        expect(JSON.stringify(result.report)).toContain('CONTROLLED_WORKER_FAILURE');expect(JSON.stringify(result.report)).toContain('CONTROLLED_CLOSE_FAILURE');
        const profile=result.directories[0];expect(profile.exists).toBe(true);expect(result.report.retainedProfile).toBe(profile.directory);
        expect(result.directories.slice(1).every(directory=>!directory.exists)).toBe(true);
    },12000);
}

for (const file of [globalToggle,bilingual,translationStyle,vocabulary]) {
    it(`${path.basename(file)} rejects crashing valid-JSON shapes and preserves recovery plus useful fallback`,async()=>{
        const result=await invoke(file,'http-shapes');
        expect(result.code).toBe(1);const probes=result.events.find(event=>event.kind==='shape-recovery-probes')!;
        expect(probes.before.status).toBe(200);expect(probes.after).toEqual(probes.before);
        expect(probes.invalid.map((response:any)=>response.status)).toEqual(file===vocabulary?[400,400,400]:[400,400,400,400]);
        if(file===vocabulary)expect(probes.fallbacks).toEqual([probes.before,probes.before,probes.before]);
        expect(count(result,'session-close')).toBe(1);expect(count(result,'server-closed')).toBe(1);
        expect(result.stderr).not.toContain('TypeError');expect(result.directories.every(directory=>!directory.exists)).toBe(true);
    },12000);
}

it('vocabulary public CLI retains useful nonstream object, array and numeric fallbacks in an independent original/current probe',async()=>{
    const result=await invoke(vocabulary,'http-fallbacks');
    expect(result.code).toBe(1);const replies=result.events.find(event=>event.kind==='vocabulary-useful-fallback-probes')!.replies;
    expect(replies.map((reply:any)=>reply.status)).toEqual([200,200,200]);expect(replies[1]).toEqual(replies[0]);expect(replies[2]).toEqual(replies[0]);
    expect(JSON.parse(replies[0].body).choices[0].message.content).toBe('测试译文 bank');
    expect(count(result,'session-close')).toBe(1);expect(count(result,'server-closed')).toBe(1);expect(result.directories.every(directory=>!directory.exists)).toBe(true);
},12000);
