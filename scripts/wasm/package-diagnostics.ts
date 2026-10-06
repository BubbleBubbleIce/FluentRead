import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// 原始 vendor 仍保留在 public/。只修正已逐入口复现的固定版本发布副本；升级必须重新审查。
const OCR_CORE_SHA256 = '9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7';
const OCR_WORKER_SHA256 = '38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842';

function requirePinnedSource(source: string, digest: string, name: string): void {
    if (createHash('sha256').update(source).digest('hex') !== digest) {
        throw new Error(`Unsupported ${name} source: review OCR packaging before upgrading`);
    }
}

function replaceOnce(source: string, before: string, after: string): string {
    if (source.split(before).length !== 2) throw new Error('Missing or ambiguous pinned OCR patch match');
    return source.replace(before, after);
}

/** 保留仓库中的原始 vendor 文件；扩展产物将内嵌 Base64 还原为同字节的本地 WASM。 */
export function splitTesseractWasm(source: string): {code: string; wasm: Buffer} {
    const embedded = [...source.matchAll(/"data:application\/octet-stream;base64,([A-Za-z0-9+/]+={0,2})"/g)];
    const factory = 'function(TesseractCore = {})  {';
    if (embedded.length !== 1 || source.split(factory).length !== 2) {
        throw new Error('Unsupported embedded Tesseract WASM format');
    }
    const wasm = Buffer.from(embedded[0][1], 'base64');
    if (wasm.toString('base64') !== embedded[0][1]
        || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
        throw new Error('Invalid embedded Tesseract WASM binary');
    }
    const fileName = 'tesseract-core-simd-lstm.wasm';
    // importScripts 不设置 document.currentScript，Emscripten 默认会相对于 worker/ 查找内核。
    // 扩展固定从自有 worker/worker.min.js 启动，明确使用兄弟 core/ 路径；保留调用方的 locateFile。
    const locate = `TesseractCore.locateFile ||= (file, prefix) => file === ${JSON.stringify(fileName)}
        ? new URL('../core/' + file, self.location.href).href : prefix + file;`;
    const code = source.replace(embedded[0][0], JSON.stringify(fileName))
        .replace(factory, `${factory}\n${locate}\n`);
    return {code, wasm};
}

/** 把拆分出的二进制与诊断适配后的 glue 一起登记给 WXT，保持已有 corePath 不变。 */
export function packageTesseractWasm(root: string, sourcePath: string): {glue: string; wasm: string} {
    const source = fs.readFileSync(sourcePath, 'utf8');
    requirePinnedSource(source, OCR_CORE_SHA256, 'tesseract.js-core 6.1.2');
    // FS.writeFile 已取得 stream 后，数据校验或写入失败仍必须 close；不改变编码、flags 或原生字节。
    const corrected = replaceOnce(source,
        'a=B.open(a,d.flags,d.mode);if("string"==typeof c)',
        'a=B.open(a,d.flags,d.mode);try{if("string"==typeof c)');
    const split = splitTesseractWasm(replaceOnce(corrected,
        'else throw Error("Unsupported data type");B.close(a)},cwd:',
        'else throw Error("Unsupported data type")}finally{B.close(a)}},cwd:'));
    const outputDirectory = path.resolve(root, '.wxt/packaged-wasm');
    const glue = path.join(outputDirectory, 'tesseract-core-simd-lstm.wasm.js');
    const wasm = path.join(outputDirectory, 'tesseract-core-simd-lstm.wasm');
    const adapter = fs.readFileSync(path.resolve(root, 'scripts/wasm/diagnostics.js'), 'utf8');
    fs.mkdirSync(outputDirectory, {recursive: true});
    fs.writeFileSync(glue, instrumentWasmDiagnostics(split.code, 'tesseract', adapter));
    fs.writeFileSync(wasm, split.wasm);
    return {glue, wasm};
}

/** 生成扩展实际加载的 worker，保留完整 vendor 和 LICENSE 说明，不修改原始锁定资源。 */
export function packageTesseractWorker(root: string, sourcePath: string): string {
    let source = fs.readFileSync(sourcePath, 'utf8');
    requirePinnedSource(source, OCR_WORKER_SHA256, 'tesseract.js 6.0.1 worker');
    // 让 dispatch 的 Promise 错误出口观察到异步 Core 工厂失败，保留 worker/job 身份。
    source = replaceOnce(source,
        'c=t.sent,r.progress({workerId:n,status:f,progress:0}),c({TesseractProgress:function(t){p.progress({workerId:n,jobId:i,status:"recognizing text",progress:Math.max(0,(t-30)/70)})}}).then((function(t){l=t,r.progress({workerId:n,status:f,progress:1}),r.resolve({loaded:!0})})),t.next=12;break;case 11:',
        'return c=t.sent,r.progress({workerId:n,status:f,progress:0}),t.abrupt("return",c({TesseractProgress:function(t){p.progress({workerId:n,jobId:i,status:"recognizing text",progress:Math.max(0,(t-30)/70)})}}).then((function(t){l=t,r.progress({workerId:n,status:f,progress:1}),r.resolve({loaded:!0})})));case 11:');
    source = replaceOnce(source,
        'case 30:-1===b&&r.reject("initialization failed"),r.progress',
        'case 30:if(-1===b){r.reject("initialization failed");t.next=38;break}r.progress');
    // 保存成功后才取得还原责任；在输出转换、SetVariable、图片/原生识别失败时也还原，先还原再发终态。
    source = replaceOnce(source,
        'n=e.payload,o=n.image,a=n.options,s=n.output;try{if(u={}',
        'n=e.payload,o=n.image,a=n.options,s=n.output;var fluentReadParametersSaved=!1,fluentReadRecognitionFailed=!1;try{try{if(u={}');
    source = replaceOnce(source, 'for(O.SaveParameters(),y=0,d=Object.keys(u);',
        'for(O.SaveParameters(),fluentReadParametersSaved=!0,y=0,d=Object.keys(u);');
    source = replaceOnce(source, ',Object.keys(u).length>0&&O.RestoreParameters(),r.resolve(j)}catch(t)',
        '}catch(fluentReadRecognitionError){fluentReadRecognitionFailed=!0;throw fluentReadRecognitionError}finally{if(fluentReadParametersSaved){if(fluentReadRecognitionFailed){try{O.RestoreParameters()}catch(fluentReadRestoreError){}}else O.RestoreParameters()}}r.resolve(j)}catch(t)');
    // palette/mask 的读取位置与像素位置不同。保留 bitfield mask 读取，随后按 BMP 声明的偏移解码。
    source = replaceOnce(source, 'i.prototype.parseRGBA=function(){var t=',
        'i.prototype.parseRGBA=function(){3!==this.compress&&(this.pos=this.offset);var t=');
    source = replaceOnce(source, 'this.pos+=4);for(var e=[0,0,0],r=0;r<16;r++)',
        'this.pos+=4);this.pos=this.offset;for(var e=[0,0,0],r=0;r<16;r++)');
    source = replaceOnce(source, 'this.pos+=4;for(var t=this.height-1;t>=0;t--)for(var e=this.bottom_up?',
        'this.pos+=4;this.pos=this.offset;for(var t=this.height-1;t>=0;t--)for(var e=this.bottom_up?');
    const output = path.resolve(root, '.wxt/packaged-wasm/worker.min.js');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, source);
    return output;
}

/** 仅适配锁定依赖的浏览器 stderr 出口，保留 vendor 文件和 WASM 二进制原样。 */
export function instrumentWasmDiagnostics(source: string, runtime: 'onnx' | 'tesseract', adapter: string): string {
    const factory = runtime === 'onnx'
        ? /(?:async function\(moduleArg = \{\}\) \{|async function ortWasmThreaded\(moduleArg=\{\}\)\{)/g
        : /function\(TesseractCore = \{\}\)  \{/g;
    const stderr = runtime === 'onnx' ? 'console.error.bind(console)' : 'console.warn.bind(console)';
    // 格式变化必须在构建时失败，避免升级后静默失去分级或替换错误位置。
    if ([...source.matchAll(factory)].length !== 1 || source.split(stderr).length !== 2) {
        throw new Error(`Unsupported ${runtime} WASM diagnostic glue`);
    }
    const result = source.replace(factory, match => `${match}\n${adapter}\n`).replace(stderr, 'fluentReadWasmStderr');
    // ORT 的 pthread 分支还有单独的 stderr 转发；只改 vendor 源中的出口，不能改适配器本身。
    return runtime === 'onnx'
        ? result.replace(/console\.error\(([a-z])\)/g, 'fluentReadWasmStderr($1)')
        : result;
}

export function packageWasmDiagnostics(root: string, sourcePath: string, fileName: string, runtime: 'onnx' | 'tesseract'): string {
    const adapter = fs.readFileSync(path.resolve(root, 'scripts/wasm/diagnostics.js'), 'utf8');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const output = path.resolve(root, '.wxt/packaged-wasm', fileName);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, instrumentWasmDiagnostics(source, runtime, adapter));
    return output;
}
