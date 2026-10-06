/** Interactive, isolated local-model verification. Only opens an owned temporary profile. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const {chromium} = require(process.env.PLAYWRIGHT_ROOT + '/playwright');
const {launchFocusSafePersistentContext, newPageWithoutForeground} = require(process.env.FOCUS_SAFE_HELPER);

async function main() {
  const extensionDir = path.resolve(process.argv[2]);
  const browserPath = process.argv[3];
  const evidenceDir = process.argv[4];
  fs.mkdirSync(evidenceDir, {recursive: true});
  const profileDir = process.env.FR_PROFILE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-local-v2-'));
  if (!fs.realpathSync(profileDir).startsWith(fs.realpathSync(os.tmpdir()) + '/fluentread-local-v2-')) throw new Error('Only owned temporary profiles are allowed');
  const session = await launchFocusSafePersistentContext({chromium, profileDir, browserPath,
    background: process.env.FR_FOREGROUND !== '1', headless: false, viewport: {width: 1440, height: 1000}, displayTarget: 'secondary',
    browserArgs: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check'],
  });
  const errors = [];
  let operationFailed = false;
  try {
  const context = session.context;
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 30_000});
  const extensionId = new URL(worker.url()).host;
  const url = `chrome-extension://${extensionId}/options.html#settings-services`;
  let page = await newPageWithoutForeground(context);
  await page.goto(url);
  await page.locator('[data-service-view="all"]').click();
  await page.locator('[data-directory-view] [data-service-value="localTranslation"]').click();
  const initial = {extensionId, profileDir, launchMode: session.launchMode, focusPolicy: session.focusPolicy, windowPlacement: session.windowPlacement};
  fs.writeFileSync(path.join(evidenceDir, 'session.json'), JSON.stringify(initial, null, 2));
  console.log('READY', JSON.stringify(initial));
  const input = readline.createInterface({input: process.stdin, terminal: false});
  for await (const line of input) {
    if (line === 'exit') break;
    fs.appendFileSync(path.join(evidenceDir, 'commands.jsonl'), JSON.stringify({at:Date.now(), line}) + '\n');
    try {
      const result = await eval(`(async () => { ${line} })()`);
      console.log('RESULT', JSON.stringify(result));
    } catch (error) { console.log('ERROR', error.stack); }
  }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { fs.writeFileSync(path.join(evidenceDir, 'errors.json'), JSON.stringify(errors, null, 2)); }
    catch (error) { cleanupErrors.push(error); }
    try { await session.close(); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      if (operationFailed) console.error('Session cleanup failed:', ...cleanupErrors);
      else throw cleanupErrors[0];
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
