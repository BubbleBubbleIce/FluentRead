/**
 * Obsidian 库写入边界：原文件只读，按当前版本与取消状态创建唯一的相邻双语笔记。
 */
import type {TFile, Vault} from 'obsidian';
import {bilingualNoteName} from './output';

type WriteVault = Pick<Vault, 'getAbstractFileByPath' | 'create'>;

export interface SourceSnapshot {
    mtime: number;
    size: number;
}

export function availableOutputPath(vault: WriteVault, file: TFile): string {
    const base = bilingualNoteName(file.name).replace(/\.md$/u, '');
    const folder = file.parent?.path.replace(/^\/+|\/+$/gu, '') ?? '';
    for (let index = 0; index < 1_000; index += 1) {
        const name = `${base}${index ? ` ${index + 1}` : ''}.md`;
        const path = [folder, name].filter(Boolean).join('/');
        if (!vault.getAbstractFileByPath(path)) return path;
    }
    throw new Error('No available filename for the bilingual note');
}

export async function createBilingualNote(
    vault: WriteVault,
    file: TFile,
    sourceSnapshot: SourceSnapshot,
    content: string,
    signal: AbortSignal,
): Promise<TFile> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (signal.aborted) throw new DOMException('Document translation cancelled', 'AbortError');
        if (vault.getAbstractFileByPath(file.path) !== file ||
            file.stat.mtime !== sourceSnapshot.mtime || file.stat.size !== sourceSnapshot.size) {
            throw new Error('The source file changed during translation. Please try again.');
        }
        const path = availableOutputPath(vault, file);
        try {
            return await vault.create(path, content);
        } catch (error) {
            // 选名与异步创建之间可能被另一项翻译抢占；只重试确实已占用的路径。
            if (!vault.getAbstractFileByPath(path)) throw error;
        }
    }
    throw new Error('No available filename for the bilingual note');
}
