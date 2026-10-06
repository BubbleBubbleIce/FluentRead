import {describe, expect, it, vi} from 'vitest';
import {availableOutputPath, createBilingualNote} from '../integrations/obsidian/vault';

type File = Parameters<typeof createBilingualNote>[1];
type Vault = Parameters<typeof createBilingualNote>[0];

function fixture() {
    const entries = new Map([
        ['notes/source.md', 'Original content'],
        ['notes/source.bilingual.md', 'Earlier translation'],
    ]);
    const file = {
        name: 'source.md',
        path: 'notes/source.md',
        parent: {path: 'notes'},
        stat: {mtime: 42, size: 16},
    } as File;
    const create = vi.fn(async (path: string, content: string) => {
        if (entries.has(path)) throw new Error('File already exists');
        entries.set(path, content);
        return {name: path.split('/').at(-1), path} as File;
    });
    const vault = {
        getAbstractFileByPath: (path: string) => entries.has(path)
            ? path === file.path ? file : {path}
            : null,
        create,
    } as unknown as Vault;
    return {entries, file, vault, create};
}

describe('Obsidian vault write boundary', () => {
    it('creates a numbered sibling and leaves source and earlier output untouched', async () => {
        const {entries, file, vault, create} = fixture();
        expect(availableOutputPath(vault, file)).toBe('notes/source.bilingual 2.md');
        await createBilingualNote(vault, file, {mtime: 42, size: 16}, 'New bilingual content', new AbortController().signal);
        expect(create).toHaveBeenCalledWith('notes/source.bilingual 2.md', 'New bilingual content');
        expect(entries.get('notes/source.md')).toBe('Original content');
        expect(entries.get('notes/source.bilingual.md')).toBe('Earlier translation');
    });

    it('does not write after cancellation or a source edit', async () => {
        const {file, vault, create} = fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Late output', controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        file.stat.mtime = 43;
        await expect(createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Stale output', new AbortController().signal))
            .rejects.toThrow('source file changed');
        expect(create).not.toHaveBeenCalled();
    });

    it.each(['deleted', 'replaced'])('rejects output when the source was %s during translation', async (change) => {
        const {entries, file, vault, create} = fixture();
        if (change === 'deleted') entries.delete(file.path);
        else {
            const lookup = vault.getAbstractFileByPath;
            vault.getAbstractFileByPath = (path) => path === file.path ? {...file} : lookup(path);
        }
        await expect(createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Stale output', new AbortController().signal))
            .rejects.toThrow('source file changed');
        expect(create).not.toHaveBeenCalled();
    });

    it('creates separate notes when Markdown files with the same basename finish together', async () => {
        const {entries, file, vault, create} = fixture();
        entries.delete('notes/source.bilingual.md');
        const second = {...file, name: 'source.markdown', path: 'notes/source.markdown'} as File;
        entries.set(second.path, 'Second original');
        const lookup = vault.getAbstractFileByPath;
        vault.getAbstractFileByPath = (path) => path === second.path ? second : lookup(path);
        create.mockImplementation(async (path, content) => {
            // 模拟真实异步落盘：两个任务可以先后选中同一个空闲路径。
            await Promise.resolve();
            if (entries.has(path)) throw new Error('File already exists');
            entries.set(path, content);
            return {path} as File;
        });
        const signal = new AbortController().signal;
        const outputs = await Promise.all([
            createBilingualNote(vault, file, {mtime: 42, size: 16}, 'First translation', signal),
            createBilingualNote(vault, second, {mtime: 42, size: 16}, 'Second translation', signal),
        ]);
        expect(outputs.map(({path}) => path)).toEqual(['notes/source.bilingual.md', 'notes/source.bilingual 2.md']);
        expect(entries.get('notes/source.md')).toBe('Original content');
        expect(entries.get(second.path)).toBe('Second original');
        expect(entries.get(outputs[0].path)).toBe('First translation');
        expect(entries.get(outputs[1].path)).toBe('Second translation');
    });

    it('propagates storage errors without retrying an unoccupied output', async () => {
        const {file, vault, create} = fixture();
        const error = new Error('Disk full');
        create.mockRejectedValue(error);
        await expect(createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Output', new AbortController().signal))
            .rejects.toBe(error);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it.each(['cancelled', 'edited'])('rechecks source and cancellation before a collision retry: %s', async (change) => {
        const {entries, file, vault, create} = fixture();
        const controller = new AbortController();
        create.mockImplementation(async (path) => {
            entries.set(path, 'Concurrent output');
            if (change === 'cancelled') controller.abort();
            else file.stat.size += 1;
            throw new Error('File already exists');
        });
        const outcome = createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Output', controller.signal);
        if (change === 'cancelled') await expect(outcome).rejects.toMatchObject({name: 'AbortError'});
        else await expect(outcome).rejects.toThrow('source file changed');
        expect(create).toHaveBeenCalledTimes(1);
        expect(entries.has('notes/source.bilingual 3.md')).toBe(false);
    });

    it.each([null, {path: '/'}, {path: '/nested/folder/'}])('keeps output inside the normalized source folder %j', (parent) => {
        const {file, vault} = fixture();
        file.parent = parent as File['parent'];
        expect(availableOutputPath(vault, file)).toBe(`${parent?.path === '/nested/folder/' ? 'nested/folder/' : ''}source.bilingual.md`);
    });

    it('fails without writing when all numbered paths are occupied', async () => {
        const {entries, file, vault, create} = fixture();
        for (let number = 2; number <= 1_000; number += 1) entries.set(`notes/source.bilingual ${number}.md`, 'Earlier output');
        await expect(createBilingualNote(vault, file, {mtime: 42, size: 16}, 'Output', new AbortController().signal))
            .rejects.toThrow('No available filename');
        expect(create).not.toHaveBeenCalled();
    });
});
