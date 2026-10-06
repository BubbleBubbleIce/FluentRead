import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const project = process.cwd();
const scanner = process.env.FLUENTREAD_AUDIT_INVENTORY_SCANNER ?? path.join(project, 'scripts/testing/inventory-implementation-audit.mjs');
type FunctionRecord = {name: string; kind: string; start: number; end: number; bodyHash: string};
type ModuleRecord = {file: string; hash: string; lines: number; functions: FunctionRecord[]; imports: string[]; exports: string[]; manualReview: string};
type Inventory = {baseCommit: string; scope: string; summary: {files: number; functions: number; groups: Record<string, unknown>}; files: ModuleRecord[]};
type Candidates = {detached: {file: string; exports: string[]}[]; duplicates: {file: string; name: string; start: number; end: number}[][]};
type RuntimeIndex = {revision: string; files: number; functions: number; parseErrors: unknown[]; excluded: {path: string; reason: string}[]; modules: {file: string; sha256: string; functions: {name: string; line: number; end: number; loops: number; awaits: number; operations: Record<string, {name: string; line: number}[]>}[]}[]};

describe('real implementation inventory CLI preserves source provenance and line coordinates', () => {
    let fixture: string;
    let inventory: Inventory;
    let candidates: Candidates;
    let runtimeIndex: RuntimeIndex;
    let prefixSplitCalls: number;
    let vueParseCalls: number;
    let fixtureHead: string;
    const sources: Record<string, string> = {
        'src/cases.ts': [
            '// Unicode context: 中文 😀',
            'export interface Declared { unused(): void }',
            'export function declared(value: number): number;',
            'export function declared(value: number) { return value + 1; }',
            'export class Box {',
            '    constructor(public value = 0) {}',
            '    get current() { return this.value; }',
            '    set current(value: number) { this.value = value; }',
            '    method() { return () => this.value; }',
            '}',
            'export const callback = () => 3;',
            'export const expression = function named() { return 4; };',
        ].join('\n'),
        'src/crlf.ts': '// CRLF\r\nexport function first() {\r\n    return 1;\r\n}\r\nexport const last = () => 2;',
        'src/standalone-cr.ts': '// Standalone CR is preserved by the original LF coordinate contract\nexport function lone() {\r return 1;\r}',
        'src/consumer.ts': "import {declared} from '@/cases';\nexport {duplicate} from './duplicated';\nexport const consume = () => declared(1);",
        'src/duplicated.ts': 'export function duplicate() { const first = 1; const second = first + 2; const third = second + 3; const fourth = third + 4; return fourth; }',
        'src/detached.ts': 'export function detached() { const first = 1; const second = first + 2; const third = second + 3; const fourth = third + 4; return fourth; }',
        'src/lifecycle.ts': [
            'export async function attach(element: Element) {',
            "    element.addEventListener('click', () => { element.querySelector('span'); });",
            '    for (let count = 0; count < 2; count++) await Promise.resolve();',
            "    return () => { element.removeEventListener('click', () => {}); };",
            '}',
        ].join('\n'),
        'src/multi.vue': [
            '<template><div>😀 中文 <button @click="setupAction">Click</button></div></template>',
            '<script lang="ts">',
            "import './cases';",
            'export const normalAction = () => 1;',
            '</script>',
            '<style scoped>div { color: red; }</style>',
            '<script setup lang="ts">',
            "import {ref} from 'vue';",
            'const state = ref(0);',
            'const setupAction = () => {',
            '    state.value++;',
            '};',
            '</script>',
        ].join('\n'),
        'src/template-only.vue': '<template><button @click="() => 1">Template only</button></template>',
        'src/declared.d.ts': 'export declare function signature(): void;\nexport interface TypeOnly { method(): void }',
        'entrypoints/content.ts': "import '../src/cases';\nexport const entry = () => true;",
        'userscript/runtime.js': 'export const userCallback = function () { return false; };',
        'integrations/adapter.mjs': 'export const adapter = { read() { return 1; } };',
    };

    beforeAll(() => {
        fixture = mkdtempSync(path.join(tmpdir(), 'fluentread-inventory-49-'));
        for (const directory of ['src', 'entrypoints', 'userscript', 'integrations']) mkdirSync(path.join(fixture, directory));
        symlinkSync(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
        writeFileSync(path.join(fixture, 'package.json'), '{"private":true}');
        sources['src/dense.ts'] = '// AUDIT_DENSE\n' + Array.from({length: 1000}, (_, index) => [
            `export function dense${index}() {`,
            `    const initial = ${index};`,
            '    const next = initial + 1;',
            '    return next;',
            '}',
            '',
        ].join('\n')).join('\n');
        for (const [file, source] of Object.entries(sources)) writeFileSync(path.join(fixture, file), source);
        execFileSync('git', ['init', '--quiet'], {cwd: fixture, timeout: 10000});
        execFileSync('git', ['-c', 'user.name=Inventory fixture', '-c', 'user.email=inventory@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], {
            cwd: fixture, timeout: 10000,
            env: {...process.env, GIT_AUTHOR_DATE: '2026-10-06T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-10-06T00:00:00+00:00'},
        });
        fixtureHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fixture, encoding: 'utf8', timeout: 10000}).trim();
        const preload = path.join(fixture, 'count-prefix-splits.cjs');
        writeFileSync(preload, [
            "const fs = require('node:fs');",
            'const original = String.prototype.split;',
            'let count = 0;',
            'let vueParses = 0;',
            "const Module = require('node:module');",
            'const load = Module._load;',
            'Module._load = function (request, ...rest) {',
            '    const actual = load.call(this, request, ...rest);',
            "    if (request !== 'vue/compiler-sfc') return actual;",
            '    return {...actual, parse(...args) { vueParses++; return actual.parse(...args); }};',
            '};',
            'String.prototype.split = function (separator, ...rest) {',
            "    if (separator === '\\n' && String(this).startsWith('// AUDIT_DENSE')) count++;",
            '    return original.call(this, separator, ...rest);',
            '};',
            "process.on('exit', () => fs.writeFileSync(process.env.FLUENTREAD_AUDIT_OP_COUNT_FILE, JSON.stringify({count, vueParses})));",
        ].join('\n'));
        const output = path.join(fixture, 'report');
        const operations = path.join(fixture, 'operations.json');
        const started = performance.now();
        execFileSync(process.execPath, ['--require', preload, scanner, fixture, output], {
            cwd: project, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
            env: {...process.env, FLUENTREAD_AUDIT_OP_COUNT_FILE: operations},
        });
        const elapsedMs = performance.now() - started;
        inventory = JSON.parse(readFileSync(path.join(output, 'inventory.json'), 'utf8'));
        candidates = JSON.parse(readFileSync(path.join(output, 'candidates.json'), 'utf8'));
        prefixSplitCalls = JSON.parse(readFileSync(operations, 'utf8')).count;
        vueParseCalls = JSON.parse(readFileSync(operations, 'utf8')).vueParses;
        // Execute an unchanged byte-for-byte real CLI in a fixture tree because its root follows import.meta.url.
        const runtimeScanner = path.join(fixture, 'scripts/testing/inventory-runtime-functions.mjs');
        mkdirSync(path.dirname(runtimeScanner), {recursive: true});
        const runtimeSource = readFileSync(path.join(project, 'scripts/testing/inventory-runtime-functions.mjs'));
        writeFileSync(runtimeScanner, runtimeSource);
        mkdirSync(path.join(fixture, 'userscript/resources'));
        writeFileSync(path.join(fixture, 'userscript/resources/generated.js'), 'export const generated = () => true;');
        const runtimeOutput = path.join(fixture, 'runtime-index.json');
        execFileSync(process.execPath, [runtimeScanner, runtimeOutput], {cwd: project, timeout: 30000, maxBuffer: 16 * 1024 * 1024});
        runtimeIndex = JSON.parse(readFileSync(runtimeOutput, 'utf8'));
        if (process.env.FLUENTREAD_AUDIT_OPERATIONS_EVIDENCE) {
            const directory = process.env.FLUENTREAD_AUDIT_OPERATIONS_EVIDENCE;
            mkdirSync(directory, {recursive: true});
            for (const file of ['inventory.json', 'candidates.json']) writeFileSync(path.join(directory, file), readFileSync(path.join(output, file)));
            writeFileSync(path.join(directory, 'runtime-index.json'), readFileSync(runtimeOutput));
            writeFileSync(path.join(directory, 'probe.json'), JSON.stringify({scanner, scannerSha256: createHash('sha256').update(readFileSync(scanner)).digest('hex'), runtimeScannerSha256: createHash('sha256').update(runtimeSource).digest('hex'), fixtureHead, denseFunctions: 1000, prefixSplitCalls, vueParseCalls, elapsedMs, inputHashes: Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, createHash('sha256').update(source).digest('hex')]))}, null, 2));
        }
    }, 60000);

    afterAll(() => { if (fixture) rmSync(fixture, {recursive: true, force: true}); });

    const module = (file: string) => inventory.files.find(entry => entry.file === file)!;

    it('records the actual fixture Git revision without claiming manual review', () => {
        expect(inventory.baseCommit).toBe(fixtureHead);
        expect(inventory.scope).toContain('自动清单不是人工验证');
        expect(inventory.files.every(entry => entry.manualReview === 'pending')).toBe(true);
    });
    it('enumerates exactly the supported source roots in stable file order', () => {
        expect(inventory.files.map(entry => entry.file)).toEqual(Object.keys(sources).sort());
        expect(inventory.summary.files).toBe(14);
    });
    it('records exact original bytes in source hashes and source LF line totals', () => {
        for (const [file, source] of Object.entries(sources)) {
            expect(module(file).hash).toBe(createHash('sha256').update(source).digest('hex'));
            expect(module(file).lines).toBe(source.split('\n').length);
        }
    });
    it('does not count declaration-only overloads, signatures or interfaces', () => {
        expect(module('src/declared.d.ts').functions).toEqual([]);
        expect(module('src/cases.ts').functions.filter(fn => fn.name === 'declared')).toHaveLength(1);
    });
    it('keeps real constructors, getters, setters, methods and nested callbacks', () => {
        expect(module('src/cases.ts').functions.map(fn => fn.kind)).toEqual([
            'FunctionDeclaration', 'Constructor', 'GetAccessor', 'SetAccessor', 'MethodDeclaration',
            'ArrowFunction', 'ArrowFunction', 'FunctionExpression',
        ]);
    });
    it('preserves source coordinates after astral Unicode and before EOF', () => {
        expect(module('src/cases.ts').functions.find(fn => fn.name === 'declared')).toMatchObject({start: 4, end: 4});
        expect(module('src/cases.ts').functions.at(-1)).toMatchObject({name: 'named', start: 12, end: 12});
    });
    it('preserves CRLF function start and exclusive-end line coordinates', () => {
        expect(module('src/crlf.ts').functions).toMatchObject([{name: 'first', start: 2, end: 4}, {name: 'last', start: 5, end: 5}]);
    });
    it('keeps standalone CR under the existing LF coordinate contract', () => {
        expect(module('src/standalone-cr.ts').functions).toMatchObject([{name: 'lone', start: 2, end: 2}]);
    });
    it('maps both Vue script blocks to original source lines across template and style', () => {
        expect(module('src/multi.vue').functions).toMatchObject([
            {name: 'normalAction', start: 4, end: 4},
            {name: 'setupAction', start: 10, end: 12},
        ]);
    });
    it('keeps Vue template expressions separate from real script functions', () => {
        expect(module('src/template-only.vue').functions).toEqual([]);
        expect(module('src/multi.vue').functions).toHaveLength(2);
    });
    it('retains alias imports, relative re-exports and bare-package provenance', () => {
        expect(module('src/consumer.ts').imports).toEqual(['@/cases', './duplicated']);
        expect(module('src/multi.vue').imports).toEqual(['./cases', 'vue']);
        expect(module('src/cases.ts').exports).toContain('callback');
    });
    it('marks genuinely unreferenced modules as candidates without treating them as dead', () => {
        expect(candidates.detached.map(entry => entry.file)).toContain('src/detached.ts');
        expect(candidates.detached.map(entry => entry.file)).not.toContain('src/cases.ts');
        expect(candidates.detached.map(entry => entry.file)).not.toContain('src/duplicated.ts');
    });
    it('retains duplicate body identities, owners and source ranges', () => {
        expect(candidates.duplicates).toContainEqual([
            {file: 'src/detached.ts', name: 'detached', start: 1, end: 1},
            {file: 'src/duplicated.ts', name: 'duplicate', start: 1, end: 1},
        ]);
        expect(module('src/detached.ts').functions[0].bodyHash).toBe(module('src/duplicated.ts').functions[0].bodyHash);
    });
    it('visits all 1000 callbacks with exact line coordinates rather than sampling', () => {
        const dense = module('src/dense.ts');
        expect(dense.functions).toHaveLength(1000);
        for (let index = 0; index < 1000; index++) expect(dense.functions[index]).toMatchObject({name: `dense${index}`, start: 2 + index * 6, end: 6 + index * 6});
    });
    it('avoids splitting each dense source prefix while retaining the one whole-file line total', () => {
        expect(prefixSplitCalls).toBe(1);
    });
    it('parses each actual Vue source exactly once even when both script blocks are present', () => {
        expect(vueParseCalls).toBe(2);
    });
    it('keeps source groups and body totals consistent with all recorded modules', () => {
        expect(inventory.summary.functions).toBe(inventory.files.reduce((count, entry) => count + entry.functions.length, 0));
        expect(Object.keys(inventory.summary.groups).sort()).toEqual(['entrypoints/content.ts', 'integrations/adapter.mjs', 'src/cases.ts', 'src/consumer.ts', 'src/crlf.ts', 'src/declared.d.ts', 'src/dense.ts', 'src/detached.ts', 'src/duplicated.ts', 'src/lifecycle.ts', 'src/multi.vue', 'src/standalone-cr.ts', 'src/template-only.vue', 'userscript/runtime.js'].sort());
    });
    it('runs the real runtime index with exact original source hashes and no parse diagnostics', () => {
        expect(runtimeIndex.revision).toBe(fixtureHead);
        expect(runtimeIndex.parseErrors).toEqual([]);
        expect(runtimeIndex.files).toBe(13);
        for (const entry of runtimeIndex.modules) expect(entry.sha256).toBe(module(entry.file).hash);
    });
    it('records declaration and generated-resource exclusions explicitly without calling them reviewed', () => {
        expect(runtimeIndex.modules.some(entry => entry.file.endsWith('.d.ts'))).toBe(false);
        expect(runtimeIndex.modules.some(entry => entry.file.startsWith('userscript/resources/'))).toBe(false);
        expect(runtimeIndex.excluded).toMatchObject([{path: 'userscript/resources'}]);
        expect(runtimeIndex).not.toHaveProperty('reviewed');
    });
    it('retains real Vue source coordinates while excluding template-only callbacks', () => {
        expect(runtimeIndex.modules.find(entry => entry.file === 'src/multi.vue')!.functions).toMatchObject([{name: 'normalAction', line: 4, end: 4}, {name: 'setupAction', line: 10, end: 12}]);
        expect(runtimeIndex.modules.find(entry => entry.file === 'src/template-only.vue')!.functions).toEqual([]);
    });
    it('assigns asynchronous loops and subscriptions to their actual enclosing function', () => {
        const functions = runtimeIndex.modules.find(entry => entry.file === 'src/lifecycle.ts')!.functions;
        expect(functions[0]).toMatchObject({name: 'attach', loops: 1, awaits: 1, operations: {subscription: [{name: 'addEventListener', line: 2}]}});
        expect(functions[0].operations).not.toHaveProperty('domRead');
        expect(functions[0].operations).not.toHaveProperty('cleanup');
    });
    it('keeps child DOM reads and nested cleanup callbacks distinct from their parent', () => {
        const functions = runtimeIndex.modules.find(entry => entry.file === 'src/lifecycle.ts')!.functions;
        expect(functions).toHaveLength(4);
        expect(functions[1]).toMatchObject({line: 2, loops: 0, awaits: 0, operations: {domRead: [{name: 'querySelector', line: 2}]}});
        expect(functions[2]).toMatchObject({line: 4, operations: {cleanup: [{name: 'removeEventListener', line: 4}]}});
        expect(functions[3]).toMatchObject({line: 4, operations: {}, loops: 0, awaits: 0});
    });
});

describe('real resource runner CLI in encoded filesystem paths', () => {
    const runnerSource = process.env.FLUENTREAD_AUDIT_RESOURCE_RUNNER ?? path.join(project, 'scripts/testing/run-resource-safe.mjs');

    it.each(['ordinary', 'runner space', 'runner 中文', 'runner%percent', 'runner#fragment'])('executes and waits for the actual child in %s', async name => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'fluentread-runner-path-49-'));
        const script = path.join(fixture, name, 'scripts/testing/run-resource-safe.mjs');
        const locks = path.join(fixture, 'locks');
        mkdirSync(path.dirname(script), {recursive: true});
        const source = readFileSync(runnerSource);
        writeFileSync(script, source);
        expect(readFileSync(script).equals(source)).toBe(true);
        const preload = path.join(fixture, 'loaded.mjs');
        writeFileSync(preload, 'import {pathToFileURL} from "node:url";\n' +
            'const actual = await import(pathToFileURL(process.argv[1]).href);\n' +
            'if (typeof actual.parseArgs !== "function") throw new Error("Public runner entry not loaded");\n' +
            'console.log("ACTUAL_PUBLIC_RESOURCE_RUNNER_LOADED");\n');
        try {
            const result = await new Promise<{code: number | null; timedOut: boolean; stdout: string; stderr: string}>((done, fail) => {
                const child = spawn(process.execPath, ['--import', preload, script, '--concurrency', '1', '--wait-ms', '1000', '--', process.execPath, '-e',
                    'setTimeout(() => console.log("ACTUAL_OWNED_CHILD_FINISHED"), 20);'], {
                    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
                    env: {...process.env, FLUENTREAD_RESOURCE_LOCK_DIR: locks, FLUENTREAD_RESOURCE_LOCK_HELD: '', FLUENTREAD_RESOURCE_LOCK_TOKEN: '', FLUENTREAD_RESOURCE_LOCK_SLOT: ''},
                });
                let stdout = '', stderr = '', timedOut = false;
                let force: ReturnType<typeof setTimeout> | undefined;
                const signal = (value: NodeJS.Signals) => {
                    if (!child.pid) return;
                    try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, value);} catch { /* Already exited. */ }
                };
                const timer = setTimeout(() => {timedOut = true; signal('SIGTERM'); force = setTimeout(() => signal('SIGKILL'), 5000);}, 5000);
                child.stdout.on('data', data => {stdout += String(data);});
                child.stderr.on('data', data => {stderr += String(data);});
                child.once('error', error => {clearTimeout(timer); if (force) clearTimeout(force); fail(error);});
                child.once('close', code => {clearTimeout(timer); if (force) clearTimeout(force); done({code, timedOut, stdout, stderr});});
            });
            expect(result.timedOut).toBe(false);
            expect(result.code, result.stderr).toBe(0);
            expect(result.stderr).toBe('');
            expect(result.stdout.split(/\r?\n/u).filter(line => line === 'ACTUAL_PUBLIC_RESOURCE_RUNNER_LOADED')).toHaveLength(1);
            expect(result.stdout.split(/\r?\n/u).filter(line => line === 'ACTUAL_OWNED_CHILD_FINISHED')).toHaveLength(1);
            expect(readdirSync(locks)).toEqual([]);
        } finally {rmSync(fixture, {recursive: true, force: true});}
    }, 15000);
});
