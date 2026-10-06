/** Resource measurements and offscreen diagnostics for an owned test browser only. */
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');

async function attachOffscreen(context) {
  const cdp = await context.browser().newBrowserCDPSession();
  let sessionId;
  let disposed = false;
  let seq = 0;
  const pending = new Map();
  const events = [];
  const receive = event => {
    if (disposed || event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id) { events.push(message); return; }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error ? call.reject(message.error) : call.resolve(message.result);
  };
  async function dispose() {
    if (disposed) return;
    disposed = true;
    cdp.off('Target.receivedMessageFromTarget', receive);
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Offscreen CDP session disposed'));
    }
    pending.clear();
    try {
      if (sessionId) await cdp.send('Target.detachFromTarget', {sessionId});
    } finally { await cdp.detach(); }
  }
  try {
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url.endsWith('/offscreen.html'));
  if (!target) throw new Error('No offscreen document in the isolated test browser');
  ({sessionId} = await cdp.send('Target.attachToTarget', {targetId: target.targetId, flatten: false}));
  cdp.on('Target.receivedMessageFromTarget', receive);
  function rpc(method, params = {}) {
    if (disposed) return Promise.reject(new Error('Offscreen CDP session disposed'));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, {resolve, reject, timer});
      cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})}).catch(error => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  await rpc('Network.enable');
  await rpc('Runtime.enable');
  return {rpc, events, dispose};
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}

async function measureBrowser(context, name, evidenceDir, action) {
  const cdp = await context.browser().newBrowserCDPSession();
  const samples = [];
  let inFlight;
  function sample() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
      const pids = processInfo.map(p => p.id);
      const rows = execFileSync('/bin/ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {encoding: 'utf8'}).trim().split('\n');
      const rss = Object.fromEntries(rows.map(row => row.trim().split(/\s+/).map(Number)));
      samples.push({at: Date.now(), processes: processInfo.map(p => ({...p, rssBytes: (rss[p.id] || 0) * 1024}))});
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  const started = Date.now();
  let interval;
  let result;
  let error;
  const measurementErrors = [];
  try {
    await sample();
    interval = setInterval(() => { void sample().catch(reason => measurementErrors.push(String(reason))); }, 250);
    try { result = await action(); } catch (reason) { error = String(reason); }
    clearInterval(interval);
    // 等待已发出的采样结束，不能在 CDP 请求尚未完成时 detach 或写下不完整的报告。
    if (inFlight) await inFlight.catch(reason => measurementErrors.push(String(reason)));
    await sample().catch(reason => measurementErrors.push(String(reason)));
  } finally {
    clearInterval(interval);
    await cdp.detach();
  }
  const report = {name, elapsedMs: Date.now() - started, result, error, measurementErrors, samples};
  fs.writeFileSync(`${evidenceDir}/${name}.json`, JSON.stringify(report, null, 2));
  return {name, elapsedMs: report.elapsedMs, result, error,
    baselineRssBytes: samples[0].processes.reduce((n, p) => n + p.rssBytes, 0),
    peakRssBytes: Math.max(...samples.map(s => s.processes.reduce((n, p) => n + p.rssBytes, 0)))};
}
const bambuParagraph = 'When switching between different filaments for printing on a single nozzle (hotend) printer, it is necessary to use a certain amount of new material to flush the residual material in the hotend, to avoid color mixing during printing. The flushing values vary between different materials, and the specific values can be viewed on the filament page of Bambu Studio. You can refer to the wiki to learn more: Reduce Waste during Filament Change';
async function translateCase(context, page, evidenceDir, name, model, text, targetLanguage) {
  return measureBrowser(context, name, evidenceDir, () => page.evaluate(async payload => {
    const started = performance.now();
    const response = await chrome.runtime.sendMessage({type:'fluentReadTryLocalTranslation', requestId:crypto.randomUUID(), ...payload});
    return {text: payload.text, targetLanguage: payload.targetLanguage, response, milliseconds:performance.now()-started};
  }, {model, text, targetLanguage}));
}
async function capturedTranslationError(context, page) {
  const cdp = await context.newCDPSession(page);
  try {
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', event => contexts.push(event.context));
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    const world = contexts.find(item => item.origin.startsWith('chrome-extension://'));
    const {result} = await cdp.send('Runtime.evaluate', {expression:"document.querySelector('.fluent-read-reason')", contextId:world?.id});
    if (!result.objectId) return null;
    const {listeners} = await cdp.send('DOMDebugger.getEventListeners', {objectId:result.objectId});
    for (const listener of listeners.filter(item => item.type === 'click')) {
      if (!listener.handler) {
        const {breakpointId} = await cdp.send('Debugger.setBreakpoint', {location:{scriptId:listener.scriptId, lineNumber:listener.lineNumber, columnNumber:listener.columnNumber}});
        let timer;
        let paused;
        const captured = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('No failure click breakpoint')), 10000);
          paused = async event => {
            const strings = [];
            try {
              for (const scope of event.callFrames[0].scopeChain.filter(s => ['local','closure'].includes(s.type)).slice(0,2)) {
                const values = await cdp.send('Runtime.getProperties',{objectId:scope.object.objectId, ownProperties:true});
                strings.push(...values.result.filter(p => p.value?.type === 'string').map(p => p.value.value));
              }
              resolve(strings);
            } catch (error) { reject(error); }
            finally { clearTimeout(timer); await cdp.send('Debugger.resume').catch(() => undefined); }
          };
          cdp.once('Debugger.paused', paused);
        });
        try {
          const click = page.locator('.fluent-read-reason').first().click();
          const [values] = await Promise.all([captured, click]);
          return values;
        } finally {
          clearTimeout(timer);
          cdp.off('Debugger.paused', paused);
          await cdp.send('Debugger.removeBreakpoint',{breakpointId});
        }
      }
      const handler = await cdp.send('Runtime.getProperties', {objectId:listener.handler.objectId, ownProperties:true});
      const scopes = handler.internalProperties?.find(p => p.name === '[[Scopes]]')?.value?.objectId;
      if (!scopes) continue;
      const list = await cdp.send('Runtime.getProperties', {objectId:scopes, ownProperties:true});
      for (const scope of list.result.filter(p => p.value?.description?.startsWith('Closure'))) {
        const values = await cdp.send('Runtime.getProperties', {objectId:scope.value.objectId, ownProperties:true});
        const strings = values.result.filter(p => p.value?.type === 'string').map(p => p.value.value);
        if (strings.length) return strings;
      }
    }
    return null;
  } finally { await cdp.detach(); }
}
async function toggleParagraph(page, locator, evidenceDir, name) {
  const original = await locator.innerHTML();
  const url = page.url();
  const counts = [];
  const neighbors = [];
  const outputs = [];
  for (const count of [1, 0, 1]) {
    await locator.scrollIntoViewIfNeeded();
    await locator.click({position: {x: 100, y: 12}});
    await page.keyboard.down('Control');
    await page.keyboard.up('Control');
    await locator.locator('.fluent-read-bilingual-content').waitFor({state: count ? 'attached' : 'detached', timeout: 90_000});
    const state = await locator.evaluate(n => ({
      count: n.querySelectorAll('.fluent-read-bilingual-content').length,
      neighbor: n.nextElementSibling?.querySelectorAll('.fluent-read-bilingual-content').length || 0,
      retries: n.querySelectorAll('.fluent-read-retry').length,
      translation: n.querySelector('.fluent-read-bilingual-content')?.textContent || '',
      links: [...n.querySelectorAll('a')].map(a => a.getAttribute('href')),
    }));
    if (state.count !== count || state.neighbor || state.retries || page.url() !== url) throw new Error(JSON.stringify(state));
    if (!count && await locator.innerHTML() !== original) throw new Error('Restored source DOM changed');
    if (count && !/[\u4e00-\u9fff]/u.test(state.translation)) throw new Error('No Chinese output');
    counts.push(state.count); neighbors.push(state.neighbor); outputs.push(state);
  }
  await page.screenshot({path: `${evidenceDir}/${name}.png`});
  const report = {url, counts, neighbors, restoredDomMatches: true, outputs};
  fs.writeFileSync(`${evidenceDir}/${name}.json`, JSON.stringify(report, null, 2));
  return report;
}
module.exports = {attachOffscreen, measureBrowser, translateCase, bambuParagraph, capturedTranslationError, toggleParagraph};
