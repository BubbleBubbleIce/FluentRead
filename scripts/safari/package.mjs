#!/usr/bin/env node

// 使用 Apple 官方工具包装现有 Safari 构建；不改全局 Xcode 选择，不打开 Xcode 或 Safari。
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const developerDirectory = process.env.DEVELOPER_DIR || '/Applications/Xcode.app/Contents/Developer';
const tool = ['safari-web-extension-packager', 'safari-web-extension-converter']
    .map(name => path.join(developerDirectory, 'usr/bin', name))
    .find(candidate => existsSync(candidate));
if (!tool) throw new Error('请安装完整 Xcode；如不在 /Applications/Xcode.app，请设置 DEVELOPER_DIR。');

const output = path.join(root, '.output/safari-app');
const result = spawnSync(tool, [
    path.join(root, '.output/safari-mv2'),
    '--project-location', output,
    '--app-name', 'FluentRead',
    '--bundle-identifier', 'com.bubblebubbleice.FluentRead',
    '--swift', '--macos-only', '--copy-resources', '--no-open', '--no-prompt',
], {stdio: 'inherit', env: {...process.env, DEVELOPER_DIR: developerDirectory}});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Safari macOS Xcode 项目：${output}/FluentRead/FluentRead.xcodeproj`);
console.log('本机编译和安装步骤见 docs/guide/safari.md。');
