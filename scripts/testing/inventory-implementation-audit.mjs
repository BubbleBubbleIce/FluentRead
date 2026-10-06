import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

// 生产函数与依赖清单；只记录自动发现，不把清单生成当成人工审查完成。
// 用法：node scripts/testing/inventory-implementation-audit.mjs [项目目录] [输出目录]
const root = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const {parse} = require('vue/compiler-sfc');
const output = path.resolve(process.argv[3] ?? path.join(root, 'docs/reports/implementation-audit-20261005'));
const candidates = execFileSync('rg', ['--files', 'src', 'entrypoints', 'userscript', 'integrations'], {cwd: root, encoding: 'utf8'})
    .trim().split('\n').filter(file => /\.(?:[cm]?[jt]sx?|vue)$/.test(file)).sort();
const functionKinds = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor, ts.SyntaxKind.Constructor]);
const inventory = [];
const bodies = new Map();
for (const file of candidates) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const descriptor = file.endsWith('.vue') ? parse(source, {filename: file}).descriptor : null;
    const blocks = descriptor
        ? [descriptor.script, descriptor.scriptSetup].filter(Boolean)
        : [{content: source, loc: {start: {offset: 0}}}];
    const lineStarts = [0];
    for (let offset = source.indexOf('\n'); offset !== -1; offset = source.indexOf('\n', offset + 1)) {
        lineStarts.push(offset + 1);
    }
    const functions = [];
    const imports = [];
    const exports = [];
    for (const block of blocks) {
        const ast = ts.createSourceFile(file + '.ts', block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const line = position => {
            const offset = block.loc.start.offset + position;
            let lower = 0;
            let upper = lineStarts.length;
            while (lower < upper) {
                const middle = lower + Math.floor((upper - lower) / 2);
                if (lineStarts[middle] <= offset) lower = middle + 1;
                else upper = middle;
            }
            return lower;
        };
        function visit(node) {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                imports.push(node.moduleSpecifier.text);
            }
            if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
                && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require')) imports.push(node.arguments[0].text);
            if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && node.name) exports.push(node.name.getText(ast));
            if (ts.isVariableStatement(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
                exports.push(...node.declarationList.declarations.map(declaration => declaration.name.getText(ast)));
            }
            if (functionKinds.has(node.kind) && node.body) {
                const name = node.name?.getText(ast) ?? (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) ? node.parent.name.getText(ast) : '<callback>');
                const start = line(node.getStart(ast));
                const end = line(node.end);
                const body = node.body.getText(ast).replace(/\s+/g, ' ');
                const hash = crypto.createHash('sha256').update(body).digest('hex');
                functions.push({name, kind: ts.SyntaxKind[node.kind], start, end, bodyHash: hash});
                if (body.length >= 100 && !/^(?:\{|return )?(?:undefined|true|false|Promise\.resolve\b)/.test(body)) {
                    const group = bodies.get(hash) ?? [];
                    group.push({file, name, start, end});
                    bodies.set(hash, group);
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
    inventory.push({file, hash: crypto.createHash('sha256').update(source).digest('hex'), lines: source.split('\n').length,
        functions, imports: [...new Set(imports)], exports: [...new Set(exports)], manualReview: 'pending'});
}
const existing = new Map(candidates.map(file => [file, file]));
function resolve(from, specifier) {
    const base = specifier.startsWith('@/') ? specifier.slice(2) : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : '';
    if (!base) return null;
    for (const file of [base, ...['.ts', '.tsx', '.js', '.mjs', '.vue', '/index.ts', '/index.js'].map(suffix => base + suffix)]) if (existing.has(file)) return file;
    return null;
}
const incoming = new Map();
for (const entry of inventory) for (const specifier of entry.imports) {
    const target = resolve(entry.file, specifier);
    if (target) incoming.set(target, [...(incoming.get(target) ?? []), entry.file]);
}
const detached = inventory.filter(entry => entry.file.startsWith('src/') && !incoming.has(entry.file));
const groups = {};
for (const entry of inventory) {
    const module = entry.file.split('/').slice(0, entry.file.startsWith('src/features/') || entry.file.startsWith('src/core/') ? 3 : 2).join('/');
    const group = groups[module] ??= {files: 0, functions: 0, lines: 0};
    group.files += 1;
    group.functions += entry.functions.length;
    group.lines += entry.lines;
}
fs.mkdirSync(output, {recursive: true});
const report = {baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    scope: '生产 TS/JS/Vue：src、entrypoints、userscript、integrations；函数清单包含匿名回调，不包含类型签名或声明文件中的无实现函数。自动清单不是人工验证。',
    summary: {files: inventory.length, functions: inventory.reduce((count, entry) => count + entry.functions.length, 0), groups}, files: inventory};
fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'candidates.json'), JSON.stringify({detached: detached.map(entry => ({file: entry.file, exports: entry.exports})),
    duplicates: [...bodies.values()].filter(group => group.length > 1)}, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
