import {afterAll, describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Execute the original public tooling with controlled browser/package ports.
// These cases prove CLI resource ownership, not extension/browser interaction.
const sourceRoot = resolve(process.env.FLUENTREAD_AUDIT49J_SOURCE_ROOT || '.');
const workspaceRoot = resolve('.');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'fluentread-audit49j-'));
const evidenceRoot = process.env.FLUENTREAD_AUDIT49J_EVIDENCE;
let serial = 0;

afterAll(() => rmSync(fixtureRoot, {recursive: true, force: true}));

async function child(args: string[], env: NodeJS.ProcessEnv, cwd = sourceRoot) {
    const started = Date.now();
    return await new Promise<{code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean}>((resolveResult, reject) => {
        const task = spawn(process.execPath, args, {cwd, env: {...process.env, ...env}, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', stderr = '', timedOut = false, cancelled = false;
        const signal = (value: NodeJS.Signals) => {
            if (!task.pid) return;
            try {process.kill(process.platform === 'win32' ? task.pid : -task.pid, value);} catch { /* Already exited. */ }
        };
        let force: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            signal('SIGTERM');
            force = setTimeout(() => signal('SIGKILL'), 5000);
        }, 8000);
        task.stdout.on('data', data => {stdout += String(data); if (env.AUDIT_CANCEL_ON_MARKER && !cancelled && stdout.includes(env.AUDIT_CANCEL_ON_MARKER)) {cancelled = true; signal('SIGTERM');}});
        task.stderr.on('data', data => {stderr += String(data);});
        task.once('error', error => {clearTimeout(timer); if (force) clearTimeout(force); reject(error);});
        task.once('close', (code, exitSignal) => {
            clearTimeout(timer); if (force) clearTimeout(force);
            const result = {code, signal: exitSignal, stdout, stderr, timedOut};
            if (evidenceRoot) {
                mkdirSync(evidenceRoot, {recursive: true});
                writeFileSync(join(evidenceRoot, `child-${++serial}.json`), JSON.stringify({args, cwd, elapsedMs: Date.now() - started, ...result}, null, 2));
            }
            resolveResult(result);
        });
    });
}

async function browserFailure(script: string, mode: 'launch' | 'partial-launch' | 'ready' | 'close' | 'profile') {
    const root = mkdtempSync(join(fixtureRoot, 'browser-'));
    const temp = join(root, 'profiles'); mkdirSync(temp);
    const extension = join(root, 'chrome-mv3'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}));
    const helper = join(root, 'focus-safe.cjs');
    const packages = join(root, 'packages'); mkdirSync(join(packages, 'playwright'), {recursive: true});
    writeFileSync(join(packages, 'playwright/index.js'), 'module.exports = {chromium: {}};');
    mkdirSync(join(packages, 'node_modules/playwright'), {recursive: true});
    writeFileSync(join(packages, 'node_modules/playwright/index.js'), 'module.exports = {chromium: {}};');
    writeFileSync(helper, `
exports.launchFocusSafePersistentContext = async options => {
    console.log('PUBLIC_LAUNCH_REACHED', options.profileDir);
    if (process.env.AUDIT_BROWSER_FAILURE === 'partial-launch') {
        require('node:fs').writeFileSync(require('node:path').join(options.profileDir, 'uncertain-owner'), 'owned initialization sentinel');
        throw new Error('controlled launch failure');
    }
    if (process.env.AUDIT_BROWSER_FAILURE === 'launch') throw new Error('controlled launch failure');
    return {launchMode: 'macos-background-cdp', focusPolicy: 'launchservices-no-foreground',
        context: {on() {return this;}, off() {return this;}, serviceWorkers() {throw new Error('controlled readiness failure');}, browser() {throw new Error('controlled readiness failure');}},
        windowPlacement: {browserFrontmost: false}, close: async () => {
            console.log('OWNED_SESSION_CLOSED');
            if (process.env.AUDIT_BROWSER_FAILURE === 'close') throw new Error('controlled close failure');
        }};
};
exports.newPageWithoutForeground = async () => {throw new Error('controlled readiness failure');};
exports.activateExtensionTabWithoutForeground = async () => {};
`);
    const preload = join(root, 'loaded.cjs');
    writeFileSync(preload, `const Module = require('node:module'); const original = Module._extensions['.js'];
Module._extensions['.js'] = (mod, file) => { if (file === process.argv[1]) console.log('ORIGINAL_CLI_LOADED', file); return original(mod, file); };
const http = require('node:http'); const originalClose = http.Server.prototype.close;
http.Server.prototype.close = function (...args) { this.once('close', () => console.log('OWNED_HTTP_SERVER_CLOSED')); return originalClose.apply(this, args); };
const fs = require('node:fs'); const originalMkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) { if (process.env.AUDIT_BROWSER_FAILURE === 'profile' && String(prefix).startsWith(process.env.TMPDIR) && String(prefix).includes('fr-service-config-')) throw new Error('controlled profile allocation failure'); return originalMkdtemp.call(this, prefix, ...args); };`);
    const result = await child(['--require', preload, join(sourceRoot, script), '--playwright-root', packages, '--focus-safe-helper', helper,
        '--artifacts-dir', join(root, 'artifacts'), '--extension-dir', extension, '--extension-install', 'command-line'], {TMPDIR: temp, AUDIT_BROWSER_FAILURE: mode,
        NODE_PATH: [join(workspaceRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter)});
    const profiles = readdirSync(temp);
    const retainedMarkers = profiles.map(profile => {const marker = join(temp, profile, 'uncertain-owner'); return existsSync(marker) ? readFileSync(marker, 'utf8') : null;});
    if (evidenceRoot) writeFileSync(join(evidenceRoot, `profiles-${serial}.json`), JSON.stringify({script, mode, profiles, retainedMarkers}, null, 2));
    const reportPath = join(root, 'artifacts', 'report.json');
    const report: Record<string, unknown> | null = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    if (evidenceRoot) writeFileSync(join(evidenceRoot, `report-${serial}.json`), JSON.stringify({script, mode, report}, null, 2));
    return {result, profiles, retainedMarkers, report};
}

describe('audit49 J public browser tooling ownership', () => {
    for (const script of ['scripts/run-input-translation-test.cjs', 'scripts/run-rich-text-input-editors-test.cjs', 'scripts/testing/run-image-encoding-performance.cjs', 'scripts/run-video-subtitle-settings-test.cjs', 'scripts/testing/run-free-routing-browser-test.cjs', 'scripts/testing/run-service-configuration-ui-test.cjs']) {
        it(`${script}: rejected initialization removes the owned temporary profile`, async () => {
            const {result, profiles} = await browserFailure(script, 'launch');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled launch failure');
            expect(profiles).toEqual([]);
        });
        it(`${script}: rejected partial initialization retains its nonempty profile`, async () => {
            const {result, profiles, retainedMarkers} = await browserFailure(script, 'partial-launch');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled launch failure');
            expect(profiles).toHaveLength(1);
            expect(retainedMarkers).toEqual(['owned initialization sentinel']);
        });
        it(`${script}: readiness failure closes the acquired session and removes its profile`, async () => {
            const {result, profiles} = await browserFailure(script, 'ready');
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
            expect(result.code).toBe(1);
            expect(result.stdout + result.stderr).toContain('controlled readiness failure');
            expect(profiles).toEqual([]);
        });
    }
    it('free routing closes its local server when acquired browser closure rejects', async () => {
        const {result, profiles} = await browserFailure('scripts/testing/run-free-routing-browser-test.cjs', 'close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
        expect(result.stdout + result.stderr).toContain('controlled close failure');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    }, 12000);
    it('service configuration reports a profile allocation error before launch', async () => {
        const {result, profiles, report} = await browserFailure('scripts/testing/run-service-configuration-ui-test.cjs', 'profile');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).not.toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
        expect(report).toMatchObject({ok: false});
        expect(report?.error).toContain('controlled profile allocation failure');
    });
    it('service configuration retains its profile when the acquired browser cannot confirm closure', async () => {
        const {result, profiles} = await browserFailure('scripts/testing/run-service-configuration-ui-test.cjs', 'close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('OWNED_SESSION_CLOSED');
        expect(result.stdout + result.stderr).toContain('controlled readiness failure');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    });
});

async function planChild(command: string, args: string[]) {
    const entry = join(fixtureRoot, `plan-${++serial}.mjs`);
    writeFileSync(entry, `import {executePlan} from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/testing/run-full-regression.mjs')).href)};
console.log('ORIGINAL_PUBLIC_RUNNER_LOADED');
try {await executePlan({dryRun:false, steps:[{command:${JSON.stringify(command)},args:${JSON.stringify(args)},label:'controlled step'}]}); console.log('PLAN_FINISHED');}
catch (error) {console.error('PLAN_REJECTED', error.message); process.exitCode=17;}`);
    return child([entry], {});
}

describe('audit49 J public bounded regression orchestration', () => {
    it('rejects a child spawn error through executePlan instead of emitting an unhandled error', async () => {
        const result = await planChild(join(fixtureRoot, 'nonexistent-command'), []);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_PUBLIC_RUNNER_LOADED');
        expect(result.code).toBe(17);
        expect(result.stderr).toContain('PLAN_REJECTED');
        expect(result.stderr).toContain('ENOENT');
        expect(result.stderr).not.toContain("Unhandled 'error' event");
    });
    it('preserves a real child nonzero exit as step failure', async () => {
        const result = await planChild(process.execPath, ['-e', 'process.exitCode = 23;']);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(17);
        expect(result.stderr).toContain('退出码 23');
        expect(result.stdout).not.toContain('PLAN_FINISHED');
    });
    it('waits for a successful real child before completing the plan', async () => {
        const result = await planChild(process.execPath, ['-e', 'setTimeout(() => console.log("CONTROLLED_CHILD_FINISHED"), 30);']);
        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(0);
        expect(result.stdout.indexOf('CONTROLLED_CHILD_FINISHED')).toBeGreaterThan(-1);
        expect(result.stdout.indexOf('PLAN_FINISHED')).toBeGreaterThan(result.stdout.indexOf('CONTROLLED_CHILD_FINISHED'));
    });
});


// Continuation2 ports implement external browser/OS protocols only. The production
// CLI and its consumer callbacks execute unchanged; no native/product UI proof.
async function portCLI(script: string, mode: string, extra: string[] = []) {
    const root = mkdtempSync(join(fixtureRoot, 'continuation2-'));
    const temp = join(root, 'profiles'); mkdirSync(temp);
    const extension = join(root, 'chrome-mv3'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({name: 'FluentRead', version: '1.0', background: {service_worker: 'background.js'}, action: {default_popup: 'popup.html'}, options_ui: {page: 'options.html'}}));
    for (const file of ['localTtsWorker.js', 'videoTranscriptionWorker.js']) writeFileSync(join(extension, file), '// controlled fixture');
    const artifact = join(root, 'fixture.user.js'); writeFileSync(artifact, '// controlled fixture artifact, never executed');
    const packages = join(root, 'packages');
    const ports = join(root, 'ports.cjs');
    writeFileSync(ports, String.raw`
const {EventEmitter} = require('node:events'); const fs = require('node:fs'); const path = require('node:path');
const mode = process.env.AUDIT_PORT_MODE; const timer = global.__auditRealTimer || setTimeout; const pause = ms => new Promise(resolve => timer(resolve, ms));
let checks = 0, ready = false, scanned = false; const born = Date.now();
const worker = {url: () => 'chrome-extension://fixture/background.js', evaluate: async () => {checks++; if(mode==='worker-initial')await pause(20); return {action:{default_popup:'popup.html'},options_ui:{page:'options.html'}};}};
const context = new EventEmitter();
context.serviceWorkers = () => {
 if(mode === 'focus' && Date.now()-born < 1180) return [];
 if(mode==='worker-initial')return [worker,{url:()=> 'chrome-extension://fast/background.js',evaluate:async()=>{checks++;return {action:{default_popup:'popup.html'},options_ui:{page:'options.html'}};}}];
 if(mode.startsWith('worker')) {
  if(mode === 'worker-race' && !scanned){scanned=true;queueMicrotask(()=>{ready=true;context.emit('serviceworker', worker);});}
  return ready ? [worker] : [];
 }
 throw new Error('controlled readiness failure');
};
context.browser = () => ({newBrowserCDPSession:async()=>({send:async()=>({processInfo:[{type:'browser',id:888888}]}),detach:async()=>{}})});
const close = async () => {
 console.log('SESSION_CLOSE');
 if(mode.startsWith('worker')) {await pause(100); context.emit('serviceworker',worker); await pause(20); console.log('WORKER_FINAL',JSON.stringify({listeners:context.listenerCount('serviceworker'),checks}));}
 if(mode.endsWith('close')) throw new Error('controlled close failure');
};

let db, abortEnabled = false, writeTransactions = 0;
const state = {config:{service:'deeplx'}, service:'', source:'', status:'', sorted:false, order:0};
async function setupIDB() {
 const {IDBFactory,IDBDatabase} = require(process.env.AUDIT_WORKSPACE+'/node_modules/fake-indexeddb');
 global.indexedDB = new IDBFactory();
 db = await new Promise((resolve,reject)=>{const req=indexedDB.open('FluentReadTranslationStats',1);req.onupgradeneeded=()=>{for(const name of ['requests','rollups','routes'])req.result.createObjectStore(name,{keyPath:'id',autoIncrement:true});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 await new Promise((resolve,reject)=>{const tx=db.transaction(['requests','rollups'],'readwrite');for(let i=0;i<10;i++)tx.objectStore('requests').put({id:'record-'+i,serviceId:i<7?'deeplx':'custom:stats-fixture',model:i<7?'':'stats-model',source:'network',startedAt:Date.now()-i*1000,durationMs:1300-i*100});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
 const transact=IDBDatabase.prototype.transaction, closeDb=IDBDatabase.prototype.close;
 IDBDatabase.prototype.close=function(...args){if(abortEnabled)console.log('IDB_CLOSE');return closeDb.apply(this,args);};
 IDBDatabase.prototype.transaction=function(stores,kind,...args){
  const tx=transact.call(this,stores,kind,...args);
  if(kind!=='readwrite'||!abortEnabled)return tx;
  const number=++writeTransactions;
  if((mode==='idb-seed'&&number!==1)||(mode==='idb-paging'&&number!==2))return tx;
  const store=tx.objectStore;const wrapped=new WeakSet();let issued=0,completed=0,requestErrors=0;
  tx.addEventListener('error',()=>console.log('IDB_TX_ERROR'));
  tx.addEventListener('abort',()=>console.log('IDB_ABORT_ONLY',JSON.stringify({issued,completed,requestErrors})));
  tx.objectStore=function(...parameters){const object=store.apply(this,parameters);if(wrapped.has(object))return object;wrapped.add(object);const put=object.put;object.put=function(...values){const req=put.apply(this,values);issued++;req.addEventListener('error',()=>requestErrors++);req.addEventListener('success',()=>{if(++completed===issued)tx.abort();});return req;};return object;};
  return tx;
 };
}
const cache=new Map();
global.chrome={runtime:{sendMessage:async message=>{
 if(message.type==='configStorageRead')return {success:true,value:state.config};
 if(message.type==='persistConfig'){Object.assign(state.config,message.config);return {success:true};}
 if(Object.hasOwn(message,'origin')){
  const key=JSON.stringify(message.origin);if(cache.has(key))return cache.get(key);
  const text=Array.isArray(message.origin)?message.origin.join('\n'):message.origin;
  const ai=message.serviceOverride!=='deeplx';
  const url=ai?state.config.customOpenAIProviders[0].endpoint:state.config.deeplx;
  const task=fetch(url,{method:'POST',body:JSON.stringify(ai?{messages:[{role:'user',content:'SOURCE_BEGIN'+text+'SOURCE_END'}]}:{text})}).then(response=>response.status===429?{kind:'rate-limit',statusCode:429}:'controlled translation');cache.set(key,task);return task;
 }
 throw new Error('unsupported controlled runtime message');
}}};
function logRecords(){
 if(state.status==='失败')return [{text:'频率或额度受限 · HTTP 429',source:'network',duration:'300 毫秒'}];
 if(state.source==='部分缓存')return [{text:'Stats fixture 2 段',source:'is-partial',duration:'300 毫秒'}];
 const count=state.service==='Stats fixture'?3:state.service==='DeepLX'?7:10;
 return Array.from({length:count},(_,i)=>({text:'DeepLX controlled metadata',source:i===1?'is-cache':i===2?'is-partial':i===3?'is-shared':'network',duration:(1300-i*100)+' 毫秒'}));
}
function locator(selector,index=0){return {
 first(){return locator(selector,0);},last(){return locator(selector,99);},nth(n){return locator(selector,n);},locator(child){return locator(selector+' '+child,index);},filter(value){return locator(selector+' FILTER '+value.hasText,index);},
 getByRole(role,options){return locator(selector+' OPTION '+options.name,index);},
 async waitFor(){},async scrollIntoViewIfNeeded(){},async click(){
  const option=/OPTION (.+)$/.exec(selector);if(option){if(['失败','全部状态'].includes(option[1]))state.status=option[1];else state.source=option[1];}
  const service=/FILTER (.+)$/.exec(selector);if(service)state.service=state.service===service[1]?'':service[1];
  if(selector.includes('.stats-log .stats-toggle')&&index===1)state.sorted=true;
  if(selector.includes('.stats-service-table thead .stats-sort'))state.order++;
 },
 async count(){if(selector.includes('.stats-service-table tbody'))return 2;if(selector.includes('.stats-routes'))return state.service==='免费翻译'?1:0;if(selector.includes('.stats-route-table'))return 3;if(selector.includes('.stats-trend-bar'))return 24;throw new Error('unexpected fixture count '+selector);},
 async allTextContents(){return ['成功率 90%','300 毫秒','最长 1.3 秒','25%'];},
 async textContent(){if(selector.includes('[data-section='))return '翻译统计';if(selector.includes('.stats-failures'))return '频率或额度受限 1';if(selector.includes('.stats-summary .stats-card-value'))return '300 毫秒';if(selector.includes('.stats-route-table'))return index===2?'DeepLX':'微软翻译 83.3%';if(selector.includes('.stats-service-table'))return state.order?'Stats fixture stats-model':'DeepLX';throw new Error('unexpected fixture text '+selector);},
 async getAttribute(){return selector.includes('aria-pressed')?'true':selector.includes('.stats-trend .stats-toggle')?'true':'ascending';},
 async evaluateAll(){return logRecords();},async evaluate(){if(selector.includes('.stats-routes'))return true;throw new Error('unexpected fixture evaluate '+selector);}
};}
const page={on(){},async goto(){},async setViewportSize(){},async screenshot(){},locator,
 async waitForFunction(){},
 async evaluate(fn,arg){
  if(arg&&Array.isArray(arg.routes)&&Array.isArray(arg.freeRequests)){abortEnabled=true;console.log('PUBLIC_IDB_SEED_CALLBACK');}
  // The actual callback provided by the unchanged public CLI runs against the
  // controlled browser-global ports and real IndexedDB implementation.
  return await Reflect.apply(fn,undefined,[arg]);
 }
};
if(mode.startsWith('idb'))context.serviceWorkers=()=>[worker];

exports.chromium={};
exports.webkit={launch:async()=>{console.log('WEBKIT_LAUNCHED');return {newContext:async()=>{throw new Error('controlled newContext failure');},close};}};
exports.launchFocusSafePersistentContext = async options => {
 console.log('PUBLIC_LAUNCH_REACHED');
 if(mode==='scan-partial') {fs.writeFileSync(path.join(options.profileDir,'uncertain-owner'),'controlled active profile');throw new Error('controlled partial launch failure');}
 if(mode.startsWith('idb'))await setupIDB();
 if(mode === 'worker-event') timer(()=>{ready=true;context.emit('serviceworker',worker);},10);
 return {context,close,launchMode:'macos-background-cdp',focusPolicy:'launchservices-no-foreground',windowPlacement:{mode:'background-visible-no-focus',browserFrontmost:false}};
};
exports.newPageWithoutForeground = async () => {console.log('PUBLIC_AFTER_WORKER');if(mode.startsWith('idb'))return page;if(mode==='worker-initial')return {setViewportSize:async()=>{},goto:async url=>{console.log('SELECTED_WORKER_URL',url);throw new Error('controlled readiness failure');}};throw new Error('controlled readiness failure');};
exports.activateExtensionTabWithoutForeground=async()=>{};
`);
    for (const directory of [join(packages, 'playwright'), join(packages, 'node_modules/playwright')]) {
        mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'index.js'), `module.exports=require(${JSON.stringify(ports)});`);
    }
    const preload = join(root, 'preload.cjs');
    writeFileSync(preload, String.raw`
const Module = require('node:module'); const original = Module._extensions['.js'];
Module._extensions['.js']=(mod,file)=>{if(file===process.argv[1])console.log('ORIGINAL_CLI_LOADED',file);return original(mod,file);};
if(process.env.AUDIT_PORT_MODE.startsWith('scan-')) {
 const fs=require('node:fs'),path=require('node:path');
 const root=path.dirname(__filename),ports=path.join(root,'ports.cjs');
 const load=Module._load;
 Module._load=function(request,parent,...args){if(request==='playwright'||String(request).endsWith('/playwright')||String(request).endsWith('focus-safe-browser.cjs'))return load.call(this,ports,parent,...args);return load.call(this,request,parent,...args);};
 const mkdir=fs.mkdtempSync;fs.mkdtempSync=function(prefix,...args){if(String(prefix).startsWith('/private/tmp/'))prefix=path.join(process.env.TMPDIR,path.basename(prefix));return mkdir.call(this,prefix,...args);};
 const cp=require('node:child_process'),util=require('node:util');
 const fake=(file,args,options,callback)=>{console.log('CONTROLLED_FOCUS_PORT');queueMicrotask(()=>callback(null,JSON.stringify({pid:77,name:'controlled fixture'}),''));};
 fake[util.promisify.custom]=(...args)=>new Promise((resolve,reject)=>fake(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));cp.execFile=fake;
 const sync=(file,args,options)=>{console.log('CONTROLLED_NATIVE_SETUP_PORT',file);for(const value of args||[]){if(typeof value==='string'&&value.startsWith(root)&&/\.(?:mp4|wav|aiff|m4s|m3u8)$/.test(value)){fs.mkdirSync(path.dirname(value),{recursive:true});fs.writeFileSync(value,'controlled media fixture');}}return {status:0,stdout:JSON.stringify({format:{duration:'30'},streams:[{duration:'30'}]}),stderr:''};};
 cp.spawnSync=sync;cp.execFileSync=(file,args,options)=>sync(file,args,options).stdout;
}
const realResolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...args){try{return realResolve.call(this,request,parent,...args);}catch(error){if(request==='./local-model-browser-helpers.cjs')return process.env.AUDIT_WORKSPACE+'/scripts/testing/local-model-browser-helpers.cjs';throw error;}};
const mode=process.env.AUDIT_PORT_MODE; const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), cp=require('node:child_process'), util=require('node:util');
const close=http.Server.prototype.close;http.Server.prototype.close=function(...args){this.once('close',()=>console.log('OWNED_HTTP_SERVER_CLOSED'));return close.apply(this,args);};
const write=fs.writeFileSync;let failed=false;fs.writeFileSync=function(file,...args){if(mode.startsWith('report')&&!failed&&['report.json','firefox-config-persistence.json'].includes(path.basename(String(file)))){failed=true;console.log('REPORT_WRITE_FAILED');throw new Error('controlled report write failure');}return write.call(this,file,...args);};
if(mode==='scan-report'||mode==='scan-report-close'){fs.writeFileSync=function(file,...args){if(!failed&&['report.json','summary.json','result.json','browser-report.json'].includes(path.basename(String(file)))){failed=true;console.log('REPORT_WRITE_FAILED');throw new Error('controlled report write failure');}return write.call(this,file,...args);};}
const realTimer=setTimeout;global.__auditRealTimer=realTimer;if(mode.startsWith('worker'))global.setTimeout=(callback,ms,...args)=>realTimer(callback,ms===30000?60:ms,...args);
if(mode==='focus'||mode.startsWith('idb')){
 const fake=(file,args,options,callback)=>{console.log('MONITOR_STARTED');return realTimer(()=>{console.log('MONITOR_RESULT');callback(null,JSON.stringify({pid:mode==='focus'?888888:77,name:'fixture'}),'');},mode==='focus'?300:0);};
 fake[util.promisify.custom]=(...args)=>new Promise((resolve,reject)=>fake(...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));cp.execFile=fake;
}
if(mode.startsWith('native')) {
 const spawn=cp.spawn, sync=cp.execFileSync;
 const selected=file=>file==='/usr/bin/say'||file==='/usr/bin/afconvert';
 const cmdArgs=file=>['-e',mode==='native-convert'&&file==='/usr/bin/say'?'process.exit(0)':'process.on("SIGTERM",()=>console.log("NATIVE_TERM_RECEIVED"));console.log("NATIVE_CHILD_LOADED");setInterval(()=>{},1000)'];
 cp.spawn=function(file,args,options){if(!selected(file))return spawn.call(this,file,args,options);console.log('NATIVE_PORT_REACHED',file,JSON.stringify(args));return spawn.call(this,mode==='native-spawn-error'?'/controlled-nonexistent-native-command':process.execPath,cmdArgs(file),options);};
 cp.execFileSync=function(file,args,options){if(!selected(file))return sync.call(this,file,args,options);console.log('NATIVE_PORT_REACHED',file,JSON.stringify(args));return sync.call(this,mode==='native-spawn-error'?'/controlled-nonexistent-native-command':process.execPath,cmdArgs(file),{...options,stdio:'inherit'});};
}
`);
    const flags = script.endsWith('run-userscript-smoke-test.cjs')
        ? ['--artifact', artifact, '--engine', 'webkit', '--browser-path', process.execPath]
        : ['--extension-dir', extension, '--extension-install', 'command-line'];
    if (mode.startsWith('scan-')) {
        const media = join(root, 'controlled.mp4'); writeFileSync(media, 'controlled media fixture');
        flags.push('--browser-path', process.execPath, '--output-dir', join(root, 'artifacts'), '--output', join(root, 'artifacts'), '--out', join(root, 'artifacts'), '--video-file', media, '--media-file', media, '--fixture-video', media, '--url', 'http://127.0.0.1/controlled', '--allow-network', '--background', 'true', '--skip-native', 'true');
    }
    const result = await child(['--require', preload, join(sourceRoot, script), '--playwright-root', packages, '--focus-safe-helper', ports, '--artifacts-dir', join(root, 'artifacts'), ...flags, ...extra],
        {TMPDIR: temp, AUDIT_PORT_MODE: mode, AUDIT_WORKSPACE: workspaceRoot, ...(mode === 'native-cancel' ? {AUDIT_CANCEL_ON_MARKER: 'NATIVE_CHILD_LOADED'} : {}), NODE_PATH: join(workspaceRoot, 'node_modules')});
    const profiles = readdirSync(temp);
    const reportPath = join(root, 'artifacts/report.json');
    const report: Record<string, any> | null = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    if (evidenceRoot) writeFileSync(join(evidenceRoot, `port-${serial}.json`), JSON.stringify({script, mode, profiles, report}, null, 2));
    return {result, profiles, report, retainedMarkers: profiles.map(profile => existsSync(join(temp, profile, 'uncertain-owner')) ? readFileSync(join(temp, profile, 'uncertain-owner'), 'utf8') : null)};
}

describe('audit49 J continuation2 public consumer lifecycle', () => {
    for (const script of ['scripts/run-rich-text-input-editors-test.cjs', 'scripts/testing/run-free-routing-browser-test.cjs', 'scripts/testing/run-service-configuration-ui-test.cjs', 'scripts/testing/run-settings-center-ui-test.cjs', 'scripts/testing/run-popup-actions-service-ui-test.cjs', 'scripts/testing/run-startup-performance.cjs']) {
        for (const mode of ['report', 'report-close']) it(`${script}: ${mode} cannot bypass owned cleanup`, async () => {
            const {result, profiles} = await portCLI(script, mode);
            expect(result.timedOut).toBe(false);
            expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout).toContain('REPORT_WRITE_FAILED');
            expect(result.stdout).toContain('SESSION_CLOSE');
            if (script.includes('free-routing') || script.includes('popup-actions') || script.includes('startup-performance')) expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
            expect(result.code).toBe(1);
            expect(profiles).toHaveLength(mode === 'report' ? 0 : 1);
        }, 20000);
    }
    for (const mode of ['worker-race', 'worker-event', 'worker-timeout']) it(`video settings ${mode} releases its worker listener`, async () => {
        const {result} = await portCLI('scripts/run-video-subtitle-settings-test.cjs', mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        const final = /WORKER_FINAL (.+)/.exec(result.stdout);
        expect(final).not.toBeNull();
        expect(JSON.parse(final![1]).listeners).toBe(0);
        if (mode !== 'worker-timeout') {
            expect(result.stdout).toContain('PUBLIC_AFTER_WORKER');
            expect(JSON.parse(final![1]).checks).toBe(1);
        }
    }, 20000);
    for (const mode of ['ready', 'ready-close']) it(`userscript ${mode}: WebKit is owned before newContext`, async () => {
        const {result, profiles} = await portCLI('scripts/run-userscript-smoke-test.cjs', mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('WEBKIT_LAUNCHED');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(mode === 'ready' ? 0 : 1);
    }, 20000);
    it('popup finalization joins a late focus observation and closes its session once', async () => {
        const {result, profiles, report} = await portCLI('scripts/testing/run-popup-actions-service-ui-test.cjs', 'focus');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('MONITOR_STARTED');
        expect(result.stdout).toContain('MONITOR_RESULT');
        expect(result.stdout.indexOf('SESSION_CLOSE')).toBeGreaterThan(result.stdout.indexOf('MONITOR_RESULT'));
        expect(result.stdout.match(/SESSION_CLOSE/g)).toHaveLength(1);
        expect(report?.focusMonitor.samples).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
    for (const mode of ['native-say', 'native-convert']) it(`audio GPU ${mode}: native child has TERM then KILL bound and cleanup`, async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', mode, ['--native-timeout-ms', '250']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_PORT_REACHED');
        expect(result.stdout + result.stderr).toContain('NATIVE_CHILD_LOADED');
        expect(result.stdout + result.stderr).toContain('NATIVE_TERM_RECEIVED');
        expect(result.stdout + result.stderr).toContain('timed out');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});

async function rdpCLI(mode: 'wrong-id' | 'wrong-actor' | 'report') {
    const root = mkdtempSync(join(fixtureRoot, 'rdp-'));
    const artifacts = join(root, 'artifacts');mkdirSync(artifacts);
    const remote = join(workspaceRoot, 'node_modules/.pnpm/web-ext-run@0.2.4/node_modules/web-ext-run/lib/firefox/remote.js');
    const loader = join(root, 'loader.mjs');
    writeFileSync(loader, `import {pathToFileURL} from 'node:url';
export async function resolve(specifier,context,next){if(specifier.endsWith('/web-ext-run/lib/firefox/remote.js'))return next(${JSON.stringify(pathToFileURL(remote).href)},context);return next(specifier,context);}
export async function load(url,context,next){if(url===${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/run-firefox-config-persistence.mjs')).href)})console.log('ORIGINAL_CLI_LOADED');return next(url,context);}`);
    const preload = join(root, 'preload.mjs');
    writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';import {RemoteFirefox} from ${JSON.stringify(pathToFileURL(remote).href)};
const original=RemoteFirefox.prototype.disconnect;RemoteFirefox.prototype.disconnect=function(...args){console.log('RDP_DISCONNECT_REQUESTED');return original.apply(this,args);};
const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(${JSON.stringify(mode)}==='report'&&path.basename(file)==='firefox-config-persistence.json')throw new Error('controlled report write failure');return write.call(this,file,...args);};`);
    const packets: unknown[] = [];const sockets = new Set<import('node:net').Socket>();
    const server = createServer(socket => {
        sockets.add(socket);socket.once('close', () => sockets.delete(socket));let pending = Buffer.alloc(0), location = 'about:blank', sequence = 0;
        const send = (packet: unknown) => {const data = Buffer.from(JSON.stringify(packet));socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));};
        send({from: 'root', applicationType: 'browser'});
        socket.on('data', chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (true) {
                const colon = pending.indexOf(58);if (colon < 0) break;const length = Number(pending.subarray(0, colon).toString());if (pending.length < colon + 1 + length) break;
                const message = JSON.parse(pending.subarray(colon + 1, colon + 1 + length).toString());pending = pending.subarray(colon + 1 + length);packets.push(message);
                if (message.type === 'listTabs') send({from: 'root', tabs: [{actor: 'tab', selected: true}]});
                else if (message.type === 'getTarget') send({from: 'tab', frame: {actor: 'frame', consoleActor: 'console', url: location}});
                else if (message.type === 'listAddons') send({from: 'root', addons: [{id: '{3096bd53-3bda-4556-b076-ebf47442a5c1}', temporarilyInstalled: true, manifestURL: 'moz-extension://fixture/manifest.json'}]});
                else if (message.type === 'navigateTo') {
                    if (message.url.endsWith('options.html')) send({from: 'frame', error: 'fixture-end', message: 'controlled after popup'});
                    else {location = message.url;send({from: 'frame'});}
                } else if (message.type === 'evaluateJSAsync') {
                    const id = `evaluation-${++sequence}`;
                    const responses: unknown[] = [{from: 'console', resultID: id}, {from: 'console', type: 'evaluationResult', resultID: id, result: {value: JSON.stringify({correlated: true})}}];
                    if (mode !== 'report') responses.push({from: mode === 'wrong-actor' ? 'other-console' : 'console', type: 'evaluationResult', resultID: mode === 'wrong-id' ? `stale-${sequence}` : id, result: {value: JSON.stringify({correlated: false})}});
                    socket.write(Buffer.concat(responses.map(packet => {const data = Buffer.from(JSON.stringify(packet));return Buffer.concat([Buffer.from(`${data.length}:`), data]);})));
                } else send({from: message.to, error: 'unknown-fixture-request', message: message.type});
            }
        });
    });
    await new Promise<void>((resolveServer, reject) => {server.once('error', reject);server.listen(0, '127.0.0.1', resolveServer);});
    try {
        const address = server.address() as import('node:net').AddressInfo;
        const result = await child(['--loader', loader, '--import', preload, join(sourceRoot, 'scripts/run-firefox-config-persistence.mjs'), '--port', String(address.port), '--artifacts-dir', artifacts], {});
        const file = join(artifacts, 'firefox-config-persistence.json');
        const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        if (evidenceRoot) writeFileSync(join(evidenceRoot, `rdp-${serial}.json`), JSON.stringify({mode, packets, report}, null, 2));
        return {result, report};
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolveServer => server.close(() => resolveServer()));
    }
}

describe('audit49 J continuation2 actual RDP client and public CLI', () => {
    for (const mode of ['wrong-id', 'wrong-actor'] as const) it(`${mode}: pre-ack packets remain evaluation-owned`, async () => {
        const {result, report} = await rdpCLI(mode);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('RDP_DISCONNECT_REQUESTED');
        expect(report?.popup.correlated).toBe(true);
        expect(result.stderr).toContain('controlled after popup');
    }, 20000);
    it('Firefox report-write failure still disconnects its actual RDP client', async () => {
        const {result} = await rdpCLI('report');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('RDP_DISCONNECT_REQUESTED');
        expect(result.stderr).toContain('controlled report write failure');
    }, 20000);
});


describe('audit49 J continuation2 public stats callback and native error paths', () => {
    for (const mode of ['idb-seed', 'idb-paging']) it(`${mode}: abort after successful puts rejects and releases the public consumer`, async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-translation-stats-ui-test.cjs', mode);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_IDB_SEED_CALLBACK');
        expect(result.stdout).toContain('IDB_ABORT_ONLY');
        expect(result.stdout).not.toContain('IDB_TX_ERROR');
        expect(result.timedOut).toBe(false);
        const abort = JSON.parse(/IDB_ABORT_ONLY (.+)/.exec(result.stdout)![1]);
        expect(abort.completed).toBe(abort.issued);
        expect(abort.requestErrors).toBe(0);
        expect(abort.issued).toBe(mode === 'idb-seed' ? 10 : 53);
        expect(result.stdout).toContain('IDB_CLOSE');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.stderr).toContain('transaction aborted');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
    it('audio GPU failed native spawn waits for close and releases unlaunched fixture/profile', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', 'native-spawn-error', ['--native-timeout-ms', '250']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_PORT_REACHED');
        expect(result.stderr).toContain('ENOENT');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});


describe('audit49 J continuation2 native cancellation ownership', () => {
    it('audio GPU interruption kills and waits for its TERM-ignoring owned child before cleanup', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-local-audio-gpu-test.cjs', 'native-cancel', ['--native-timeout-ms', '10000']);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('NATIVE_CHILD_LOADED');
        expect(result.stdout).toContain('NATIVE_TERM_RECEIVED');
        expect(result.stderr).toContain('interrupted');
        expect(result.code).toBe(1);
        expect(profiles).toEqual([]);
    }, 20000);
});


describe('audit49 J continuation2 preserved worker scan order', () => {
    it('video settings stops at the first initially matching worker despite a faster later worker', async () => {
        const {result} = await portCLI('scripts/run-video-subtitle-settings-test.cjs', 'worker-initial');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('SELECTED_WORKER_URL chrome-extension://fixture/options.html');
        const state = JSON.parse(/WORKER_FINAL (.+)/.exec(result.stdout)![1]);
        expect(state).toEqual({listeners: 0, checks: 1});
    }, 20000);
});

describe('audit49 J continuation2 startup server ownership', () => {
    it('startup performance closes its owned server but retains profile on browser close failure', async () => {
        const {result, profiles} = await portCLI('scripts/testing/run-startup-performance.cjs', 'ready-close');
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toContain('ORIGINAL_CLI_LOADED');
        expect(result.stdout).toContain('PUBLIC_LAUNCH_REACHED');
        expect(result.stdout).toContain('SESSION_CLOSE');
        expect(result.stdout).toContain('OWNED_HTTP_SERVER_CLOSED');
        expect(result.stderr).toContain('controlled close failure');
        expect(result.code).toBe(1);
        expect(profiles).toHaveLength(1);
    }, 20000);
});


// Final manual-candidate scan: one parameterized case per distinct public CLI.
// All modes execute before assertions, so the raw captures each ownership path.
const continuation3Scripts = [
    "scripts/run-ai-context-ui-test.cjs",
    "scripts/run-cache-settings-test.cjs",
    "scripts/run-glossary-test.cjs",
    "scripts/run-input-translation-test.cjs",
    "scripts/run-privacy-boundary-test.cjs",
    "scripts/run-reading-progress-test.cjs",
    "scripts/run-selection-unified-test.cjs",
    "scripts/run-site-adaptation-test.cjs",
    "scripts/run-site-translation-test.cjs",
    "scripts/run-video-caption-prefetch-test.cjs",
    "scripts/run-video-performance-test.cjs",
    "scripts/run-vocabulary-study-test.cjs",
    "scripts/run-x-native-subtitle-test.cjs",
    "scripts/run-x-subtitle-sync-test.cjs",
    "scripts/run-youtube-subtitle-sync-test.cjs",
    "scripts/testing/run-bilingual-attribute-drift-test.cjs",
    "scripts/testing/run-changing-source-test.cjs",
    "scripts/testing/run-chrome-translation-ui-test.cjs",
    "scripts/testing/run-codeforces-translation-test.cjs",
    "scripts/testing/run-custom-base-url-ui-test.cjs",
    "scripts/testing/run-drive-version-compat-ui-test.cjs",
    "scripts/testing/run-github-release-test.cjs",
    "scripts/testing/run-github-task-list-test.cjs",
    "scripts/testing/run-google-drive-sync-ui-test.cjs",
    "scripts/testing/run-lazy-options-ui-test.cjs",
    "scripts/testing/run-manga-rendering-benchmark.cjs",
    "scripts/testing/run-modal-first-translation-test.cjs",
    "scripts/testing/run-multilingual-layout-ui-test.cjs",
    "scripts/testing/run-ocr-performance-test.cjs",
    "scripts/testing/run-ort-runtime-smoke.cjs",
    "scripts/testing/run-popup-onboarding-performance-test.cjs",
    "scripts/testing/run-popup-quick-settings-ui-test.cjs",
    "scripts/testing/run-reading-style-refresh-test.cjs",
    "scripts/testing/run-reported-fixes-test.cjs",
    "scripts/testing/run-select-ui-test.cjs",
    "scripts/testing/run-sentence-listening-test.cjs",
    "scripts/testing/run-service-library-ui-test.cjs",
    "scripts/testing/run-settings-hierarchy-ui-test.cjs",
    "scripts/testing/run-settings-reading-menu-ui-test.cjs",
    "scripts/testing/run-settings-viewport-ui-test.cjs",
    "scripts/testing/run-site-rules-ui-test.cjs",
    "scripts/testing/run-toolbar-status-test.cjs",
    "scripts/testing/run-translation-mutation-test.cjs",
    "scripts/testing/run-translation-viewport-test.cjs",
    "scripts/testing/run-ui-style-audit.cjs",
    "scripts/testing/run-webdav-backup-ui-test.cjs"
];
const continuation3ServerScripts = new Set([
    "scripts/run-ai-context-ui-test.cjs",
    "scripts/run-glossary-test.cjs",
    "scripts/run-privacy-boundary-test.cjs",
    "scripts/run-reading-progress-test.cjs",
    "scripts/run-selection-unified-test.cjs",
    "scripts/run-vocabulary-study-test.cjs",
    "scripts/testing/run-bilingual-attribute-drift-test.cjs",
    "scripts/testing/run-changing-source-test.cjs",
    "scripts/testing/run-custom-base-url-ui-test.cjs",
    "scripts/testing/run-modal-first-translation-test.cjs",
    "scripts/testing/run-reading-style-refresh-test.cjs",
    "scripts/testing/run-sentence-listening-test.cjs",
    "scripts/testing/run-site-rules-ui-test.cjs",
    "scripts/testing/run-webdav-backup-ui-test.cjs"
]);

describe('audit49 J continuation3 complete manual cleanup consumers', () => {
    for (const script of continuation3Scripts) it(`${script}: independent cleanup and uncertain profile ownership`, async () => {
        const modes = ['scan-report', 'scan-report-close', 'scan-partial'];
        const observations = [];
        for (const mode of modes) observations.push({mode, ...await portCLI(script, mode)});
        for (const observation of observations) {
            const {mode, result, profiles, retainedMarkers} = observation;
            expect(result.stdout, `${script} ${mode} original load`).toContain('ORIGINAL_CLI_LOADED');
            expect(result.stdout, `${script} ${mode} acquired external port`).toContain('PUBLIC_LAUNCH_REACHED');
            expect(result.timedOut, `${script} ${mode} finite consumer`).toBe(false);
            if (mode !== 'scan-partial') expect(result.stdout, `${script} ${mode} closes acquired browser`).toContain('SESSION_CLOSE');
            if (continuation3ServerScripts.has(script)) expect(result.stdout, `${script} ${mode} releases independent HTTP fixture`).toContain('OWNED_HTTP_SERVER_CLOSED');
            if (mode === 'scan-report') expect(profiles, `${script} confirmed closed profile`).toEqual([]);
            else if (mode === 'scan-partial') expect(retainedMarkers, `${script} unknown active profile retained`).toContain('controlled active profile');
            else expect(profiles.length, `${script} rejected close profile retained`).toBeGreaterThan(0);
        }
    }, 60000);
});
