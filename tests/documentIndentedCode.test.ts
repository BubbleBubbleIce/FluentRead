import {describe, expect, it, vi} from 'vitest';
import {parseDocument, renderDocument} from '@/src/features/document-translation/core/document';
import {createDocumentPreviewHtml} from '@/src/features/document-translation/core/preview';
import {createDocumentSegmentTranslator} from '@/src/features/document-translation/services/translation';
import * as documentPublic from '@/src/features/document-translation/public';

// 受控 Markdown 子集：只要求块级四列缩进，段落续行及列表容器沿用既有契约。
describe('documentbinaryAudit indented code consumer chain', () => {
    it.each(['\n', '\r\n', '\r'])('protects code through translation, preview and export with %j endings', async ending => {
        const source = ['> ```js', '> NOT_TRANSLATABLE_quote', '> ```', '', '- ```ts', '  NOT_TRANSLATABLE_list', '  ```', '', 'Before code', '', '    NOT_TRANSLATABLE_plain', '    const value = 2;', '', 'Visible prose'].join(ending);
        const document = parseDocument('four-blocks.md', source);
        const request = vi.fn(async (text: string) => `译文:${text}`);
        const translate = createDocumentSegmentTranslator({waitUntilReady: async () => {}, getDefaultService: () => 'fixture', supportsBatch: () => false, translateText: request, translateTextBatch: vi.fn()});
        const translations = await translate(document.segments, {fileName: document.fileName});
        expect(request.mock.calls.flat().join('')).not.toContain('NOT_TRANSLATABLE');
        expect(document.segments.map(s => s.source)).toEqual(['Before code', 'Visible prose']);
        expect(document.markdownCodeBlocks).toHaveLength(3);
        for (const mode of ['source', 'translated', 'bilingual'] as const) {
            const preview = createDocumentPreviewHtml(document, translations, mode);
            expect(preview.match(/<pre data-reader-unit>/gu)).toHaveLength(3);
            expect(preview).toContain('NOT_TRANSLATABLE_plain\nconst value = 2;');
        }
        expect(renderDocument(document, [], 'translated')).toBe(source);
        expect(renderDocument(document, translations, 'translated')).toBe(source.replace('Before code', '译文:Before code').replace('Visible prose', '译文:Visible prose'));
        expect(renderDocument(document, translations, 'bilingual')).toContain('    NOT_TRANSLATABLE_plain' + ending + '    const value = 2;');
    });

    it('does not interrupt ordinary paragraphs or list continuation text', () => {
        const source = 'Paragraph\n    continuation\n    > quote-like continuation\n\n- List body\n    continued list\n\n  second list paragraph\n\n      list code\n      more code\n\nAfter';
        const document = parseDocument('paragraphs.md', source);
        expect(document.segments.map(s => s.source)).toEqual(['Paragraph', 'continuation', '> quote-like continuation', '- List body', 'continued list', 'second list paragraph', 'After']);
        expect(document.markdownCodeBlocks).toMatchObject([{contentLines: ['list code', 'more code']}]);
        expect(renderDocument(document, [], 'translated')).toBe(source);
    });

    it('keeps interior blank lines, extra indentation, tabs, marker-like code and separate blocks', () => {
        const source = '\talpha\n\n      beta\n    - literal marker\n    > literal quote\n\nEnd\n\n    second';
        const document = parseDocument('tabs.md', source);
        expect(document.segments.map(s => s.source)).toEqual(['End']);
        expect(document.markdownCodeBlocks).toMatchObject([
            {startLine: 0, endLine: 5, contentLines: ['alpha', '', '  beta', '- literal marker', '> literal quote']},
            {startLine: 8, endLine: 9, contentLines: ['second']},
        ]);
        expect(renderDocument(document, [], 'translated')).toBe(source);
    });

    it('uses the same parser for old models and leaves TXT indentation translatable', () => {
        const source = '    NOT_TRANSLATABLE\n\nVisible';
        const document = parseDocument('old.md', source);
        delete document.markdownCodeBlocks;
        expect(createDocumentPreviewHtml(document, [], 'source')).toContain('<code>NOT_TRANSLATABLE</code>');
        expect(parseDocument('plain.txt', source).segments.map(s => s.source)).toEqual(['NOT_TRANSLATABLE', 'Visible']);
    });

    it.each(['\n', '\r\n', '\r'])('protects quoted indented code through the actual public translation, preview and export chain with %j endings', async ending => {
        const source = ['> Before', '>', '>     NOT_TRANSLATABLE_quote_indent', '>     const value = 1;', '>', '> After'].join(ending);
        const document = documentPublic.parseDocument('quote-indented.md', source);
        const request = vi.fn(async (value: string) => `译文:${value}`);
        const translate = documentPublic.createDocumentSegmentTranslator({waitUntilReady: async () => {}, getDefaultService: () => 'fixture', supportsBatch: () => false, translateText: request, translateTextBatch: vi.fn()});
        const translations = await translate(document.segments, {fileName: document.fileName});
        if (ending === '\n') console.info('documentbinaryAudit-quote:' + JSON.stringify({source, segments: document.segments.map(segment => segment.source), codeBlocks: document.markdownCodeBlocks, providerRequests: request.mock.calls.map(([value]) => value), sourcePreview: documentPublic.createDocumentPreviewHtml(document, translations, 'source'), sourceExport: documentPublic.renderDocument(document, [], 'translated'), translatedExport: documentPublic.renderDocument(document, translations, 'translated')}));
        expect(request.mock.calls.flat().join('')).not.toContain('NOT_TRANSLATABLE');
        expect(document.segments.map(segment => segment.source)).toEqual(['> Before', '> After']);
        expect(document.markdownCodeBlocks).toEqual([{startLine: 2, endLine: 4, info: '', closed: true, contentLines: ['NOT_TRANSLATABLE_quote_indent', 'const value = 1;']}]);
        for (const mode of ['source', 'translated', 'bilingual'] as const) {
            const preview = documentPublic.createDocumentPreviewHtml(document, translations, mode);
            expect(preview.match(/<pre data-reader-unit>/gu)).toHaveLength(1);
            expect(preview).toContain('<code>NOT_TRANSLATABLE_quote_indent\nconst value = 1;</code>');
        }
        expect(documentPublic.renderDocument(document, [], 'translated')).toBe(source);
        expect(documentPublic.renderDocument(document, translations, 'translated')).toBe(source.replace('> Before', '译文:> Before').replace('> After', '译文:> After'));
        expect(documentPublic.renderDocument(document, translations, 'bilingual')).toContain('>     NOT_TRANSLATABLE_quote_indent' + ending + '>     const value = 1;');
    });

    it.each([
        ['nested quote', '> > Before\n> >\n> >     NOT_TRANSLATABLE\n> >     - literal marker\n> >     > literal quote\n> > After'],
        ['quote in list', '- > Before\n  >\n  >     NOT_TRANSLATABLE\n  >     - literal marker\n  >     > literal quote\n  > After'],
        ['list in quote', '> - Before\n>\n>       NOT_TRANSLATABLE\n>       - literal marker\n>       > literal quote\n>   After'],
        ['container margin', '   > Before\n   >\n   >     NOT_TRANSLATABLE\n   >     - literal marker\n   >     > literal quote\n   > After'],
    ])('preserves code syntax and container ownership inside %s', async (_name, source) => {
        const document = documentPublic.parseDocument('containers-indented.md', source);
        expect(document.markdownCodeBlocks).toMatchObject([{contentLines: ['NOT_TRANSLATABLE', '- literal marker', '> literal quote']}]);
        const request = vi.fn(async (value: string) => value);
        const translate = documentPublic.createDocumentSegmentTranslator({waitUntilReady: async () => {}, getDefaultService: () => 'fixture', supportsBatch: () => false, translateText: request, translateTextBatch: vi.fn()});
        await translate(document.segments, {fileName: document.fileName});
        expect(request.mock.calls.flat().join('')).not.toContain('NOT_TRANSLATABLE');
        expect(documentPublic.createDocumentPreviewHtml(document, [], 'source')).toContain('<code>NOT_TRANSLATABLE\n- literal marker\n&gt; literal quote</code>');
        expect(documentPublic.renderDocument(document, [], 'translated')).toBe(source);
    });

    it('ends indented code when its quote ends and keeps blank lines only within the owned container', () => {
        const source = '>     NOT_TRANSLATABLE_quote\n>\n>     continuation\n>\nOutside\n\n    NOT_TRANSLATABLE_root\n\n> >     NOT_TRANSLATABLE_nested\n>     NOT_TRANSLATABLE_outer\n> After';
        const document = documentPublic.parseDocument('exit-indented.md', source);
        expect(document.segments.map(segment => segment.source)).toEqual(['Outside', '> After']);
        expect(document.markdownCodeBlocks).toMatchObject([
            {startLine: 0, endLine: 3, contentLines: ['NOT_TRANSLATABLE_quote', '', 'continuation']},
            {startLine: 6, endLine: 7, contentLines: ['NOT_TRANSLATABLE_root']},
            {startLine: 8, endLine: 9, contentLines: ['NOT_TRANSLATABLE_nested']},
            {startLine: 9, endLine: 10, contentLines: ['NOT_TRANSLATABLE_outer']},
        ]);
        expect(documentPublic.createDocumentPreviewHtml(document, [], 'source').match(/<pre data-reader-unit>/gu)).toHaveLength(4);
        expect(documentPublic.renderDocument(document, [], 'translated')).toBe(source);
    });

    it('keeps quoted paragraph and list continuations translatable while protecting the later indented block', () => {
        const source = '> Paragraph\n>     continued quote\n>     > comparison\n>\n> - List body\n>     continued list\n>\n>   second list paragraph\n>\n>       NOT_TRANSLATABLE\n> After';
        const document = documentPublic.parseDocument('quote-continuations.md', source);
        expect(document.segments.map(segment => segment.source)).toEqual(['> Paragraph', '>     continued quote', '>     > comparison', '> - List body', '>     continued list', '>   second list paragraph', '> After']);
        expect(document.markdownCodeBlocks).toMatchObject([{contentLines: ['NOT_TRANSLATABLE']}]);
        expect(documentPublic.renderDocument(document, [], 'translated')).toBe(source);
    });
});
