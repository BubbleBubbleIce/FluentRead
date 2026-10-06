import {describe, expect, it} from 'vitest';
import {createDocumentDownloadName, inspectMarkdownLine, parseDocument, renderDocument} from '../src/features/document-translation/core/document';
import {prepareMarkdownSegments} from '../integrations/obsidian/markdown';

const texts = (source: string) => prepareMarkdownSegments(parseDocument('containers.md', source).segments).map(({source}) => source);

describe('Markdown container code and inline positions', () => {
    it.each([
        ['quote', '> ```js\n> const code = 1;\n> ```\nVisible'],
        ['callout', '> [!note] Example\n> ```js\n> const code = 1;\n> ```\nVisible'],
        ['nested quote', '> > ~~~js\n> > const code = 1;\n> > ~~~\nVisible'],
        ['list opening', '- ```js\n  const code = 1;\n  ```\nVisible'],
        ['list continuation', '- Item\n  ```js\n  const code = 1;\n  ```\nVisible'],
        ['quote in list', '- > ```js\n  > const code = 1;\n  > ```\nVisible'],
        ['list in quote', '> - ```js\n>   const code = 1;\n>   ```\nVisible'],
    ])('does not expose fenced code inside %s and preserves the source', (_name, source) => {
        const parsed = parseDocument('containers.md', source);
        expect(texts(source)).not.toContain('const code = 1;');
        expect(texts(source).some(text => text.includes('```') || text.includes('~~~'))).toBe(false);
        expect(texts(source)).toContain('Visible');
        expect(renderDocument(parsed, [], 'translated')).toBe(source);
    });

    it.each([
        '> ```js\n> protected\nOutside',
        '- ```js\n  protected\nOutside',
        '> $$\n> x^2\nOutside',
    ])('ends a protected block when its enclosing container ends: %j', (source) => {
        expect(texts(source)).toEqual(['Outside']);
    });

    it('ignores misleading fence-like lines inside a block until the matching close', () => {
        const source = '> ````js\n> ```\n> ~~~~\n> ```` invalid\n> secret\n> ````\nAfter';
        expect(texts(source)).toEqual(['After']);
    });

    it.each([
        ['Use [[source]] - keep the dash.', ['Use', '- keep the dash.']],
        ['Use `code` > keep the comparison.', ['Use', '> keep the comparison.']],
        ['[[source]] ## keep these hashes.', ['## keep these hashes.']],
        ['- First [[source]] - keep the second dash.', ['First', '- keep the second dash.']],
    ])('normalizes only native line-start structure: %j', (source, expected) => {
        const parsed = parseDocument('inline.md', source);
        expect(prepareMarkdownSegments(parsed.segments).map(({source}) => source)).toEqual(expected);
        expect(renderDocument(parsed, [], 'translated')).toBe(source);
    });

    it('marks first and inline fragments without changing the shared source contract', () => {
        const parsed = parseDocument('inline.md', '  # Heading\nRead [[source]] - keep it.');
        expect(parsed.segments.map(({source}) => source)).toEqual(['# Heading', 'Read', '- keep it.']);
        expect(parsed.segments.map(segment => (segment as typeof segment & {markdownLineStart?: boolean}).markdownLineStart))
            .toEqual([true, true, false]);
    });

    it.each(['* * *', '- - -', '> * * *', '> > ---'])('keeps a thematic break out of the translation queue: %j', source => {
        expect(texts(source)).toEqual([]);
        expect(renderDocument(parseDocument('rule.md', source), [], 'translated')).toBe(source);
    });

    it('keeps list and quote marker-looking code lines from closing a fence', () => {
        expect(texts('> ```\n> - ```\n> > ```\n> secret\n> ```\nOutside')).toEqual(['Outside']);
    });

    it.each([
        ['quoted', '> ```js\n> - code\n> > comparison\n>   indent\n> ```\nVisible',
            {startLine: 0, endLine: 5, closed: true, info: 'js', contentLines: ['- code', '> comparison', '  indent']}],
        ['list continuation', '- Item\n  ``` ts\n  - code\n    indent\n  ```\nVisible',
            {startLine: 1, endLine: 5, closed: true, info: ' ts', contentLines: ['- code', '  indent']}],
        ['quote in list', '- > ```\n  > - code\n  >   indent\n  > ```\nVisible',
            {startLine: 0, endLine: 4, closed: true, info: '', contentLines: ['- code', '  indent']}],
        ['list in quote', '> - ```\n>   > code\n>     indent\n>   ```\nVisible',
            {startLine: 0, endLine: 4, closed: true, info: '', contentLines: ['> code', '  indent']}],
        ['short false close', '> ````js\n> ```\n> code\n> `````\nVisible',
            {startLine: 0, endLine: 4, closed: true, info: 'js', contentLines: ['```', 'code']}],
        ['quote exit', '> ```\n> code\nVisible',
            {startLine: 0, endLine: 2, closed: false, info: '', contentLines: ['code']}],
        ['list exit', '- ```\n  code\n- Visible',
            {startLine: 0, endLine: 2, closed: false, info: '', contentLines: ['code']}],
        ['end of file', '```\ncode\n\nlast',
            {startLine: 0, endLine: 4, closed: false, info: '', contentLines: ['code', '', 'last']}],
        ['partial tab indentation', '  ```\n\tcode\n  ```',
            {startLine: 0, endLine: 3, closed: true, info: '', contentLines: ['  code']}],
        ['quote without optional spaces', '>```\n>code\n>```',
            {startLine: 0, endLine: 3, closed: true, info: '', contentLines: ['code']}],
        ['less-indented quoted body', '>   ```\n> code\n>   ```',
            {startLine: 0, endLine: 3, closed: true, info: '', contentLines: ['code']}],
        ['tab list indentation', '-\t```\n\tcode\n\t```',
            {startLine: 0, endLine: 3, closed: true, info: '', contentLines: ['code']}],
    ])('provides parser-owned preview ranges for %s without changing source', (_name, source, block) => {
        const parsed = parseDocument('ranges.md', source as string);
        expect(parsed.markdownCodeBlocks).toEqual([block]);
        expect(renderDocument(parsed, [], 'translated')).toBe(source);
    });

    it('records separate code blocks and leaves metadata absent for plain text', () => {
        const source = 'Before\n```\none\n```\nMiddle\n> ~~~\n> two';
        expect(parseDocument('ranges.md', source).markdownCodeBlocks).toMatchObject([
            {startLine: 1, endLine: 4, closed: true, contentLines: ['one']},
            {startLine: 5, endLine: 7, closed: false, contentLines: ['two']},
        ]);
        expect(parseDocument('plain.txt', source).markdownCodeBlocks).toBeUndefined();
    });

    it('preserves frontmatter preceded by a UTF-8 BOM', () => {
        const source = '\uFEFF---\ntitle: private\n---\nVisible';
        const parsed = parseDocument('bom.md', source);
        expect(texts(source)).toEqual(['Visible']);
        expect(renderDocument(parsed, ['可见'], 'translated')).toBe(source.replace('Visible', '可见'));
    });

    it('handles long blank lines and very deep container prefixes without recursive traversal', () => {
        const blank = ' '.repeat(100_000);
        const nested = '> '.repeat(10_000) + 'Visible';
        const parsed = parseDocument('large.md', blank + '\n' + nested);
        expect(parsed.segments).toHaveLength(1);
        expect(inspectMarkdownLine(nested)).toMatchObject({quoteDepth: 10_000, content: 'Visible'});
        expect(renderDocument(parsed, [], 'translated')).toBe(blank + '\n' + nested);
    });

    it.each(['['.repeat(44_000), '['.repeat(44_000) + ']', '['.repeat(44_000) + '](unclosed'])
        ('keeps unmatched bracket runs as source text with bounded scanning', source => {
            const parsed = parseDocument('unclosed.md', source);
            expect(renderDocument(parsed, [], 'translated')).toBe(source);
            expect(parsed.segments.map(({source}) => source)).toEqual([source]);
        });

    it.each([
        '[source](https://example.test/a_(b))',
        '![image](https://example.test/a_(b))',
        '[source](path\\(escaped\\))',
        '[source]()',
        '`[code](url)`',
        '[[https://example.test/path]]',
    ])('keeps complete inline syntax literal, including balanced URL parentheses: %j', syntax => {
        const source = `Read ${syntax} - after.`;
        const parsed = parseDocument('links.md', source);
        expect(texts(source)).toEqual(['Read', '- after.']);
        expect(renderDocument(parsed, ['阅读', '- 后文。'], 'translated')).toBe(`阅读 ${syntax} - 后文。`);
    });

    it('retains unfinished syntax following a complete link', () => {
        const source = '[source](url) [unfinished';
        const parsed = parseDocument('links.md', source);
        expect(texts(source)).toEqual(['[unfinished']);
        expect(renderDocument(parsed, [], 'translated')).toBe(source);
    });

    it('does not read translations when a bounded excerpt ends in the original source line', () => {
        const parsed = parseDocument('large.md', 'A'.repeat(50_000) + ' [[link]] remainder');
        const translations = new Proxy([] as string[], {get: () => {throw new Error('Unused full translation');}});
        expect(renderDocument(parsed, translations, 'bilingual', 12)).toBe('A'.repeat(12));
    });

    it('normalizes CRLF across adjacent translated fragments while retaining original text', () => {
        const parsed = parseDocument('manual.md', 'Original');
        parsed.parts = [
            {kind: 'segment', source: 'First', segmentIndex: 0, prefix: '', suffix: '', bilingualGroup: 0},
            {kind: 'literal', value: '', bilingualGroup: 0},
            {kind: 'literal', value: '\n', bilingualGroup: 0},
            {kind: 'segment', source: 'Second', segmentIndex: 1, prefix: '', suffix: '', bilingualGroup: 0},
        ];
        expect(renderDocument(parsed, ['一\r', '二'], 'bilingual')).toBe('First\nSecond\n> 一\n> 二');
    });

    it('stops a translated excerpt before reading the remaining fragments', () => {
        const source = 'Read [[source]] tail';
        const parsed = parseDocument('excerpt.md', source);
        const translations = ['A'.repeat(100)];
        Object.defineProperty(translations, 1, {get: () => {throw new Error('Unused tail');}});
        expect(renderDocument(parsed, translations, 'bilingual', source.length + 8)).toBe(source + '\n> ' + 'A'.repeat(5));
    });
});

describe('Document format boundary regressions', () => {
    it('keeps timestamps in VTT NOTE blocks out of the translation queue', () => {
        const source = 'WEBVTT\n\nNOTE private metadata\n00:00:01.000 --> 00:00:02.000\nDo not translate metadata\n\n00:00:03.000 --> 00:00:04.000\nVisible cue';
        const parsed = parseDocument('notes.vtt', source);
        expect(parsed.segments.map(({source}) => source)).toEqual(['Visible cue']);
        expect(renderDocument(parsed, ['可见字幕'], 'translated')).toBe(source.replace('Visible cue', '可见字幕'));
    });

    it('handles line breaks in a real file name when adding the download suffix', () => {
        expect(createDocumentDownloadName('odd\nname.md', 'bilingual')).toBe('odd\nname.bilingual.md');
    });

    it('rejects excessive JSON nesting without recursive stack overflow', () => {
        const source = '['.repeat(5_000) + '"leaf"' + ']'.repeat(5_000);
        expect(() => parseDocument('deep.json', source)).toThrow('JSON 文件嵌套过深');
    });

    it('preserves JSON traversal order, whitespace and prototype-like ordinary keys', () => {
        const source = '{"__proto__":{"label":" First "},"constructor":"Second","array":["Third",null,42,true]}';
        const parsed = parseDocument('data.json', source);
        const original = JSON.stringify(parsed.jsonValue);
        expect(parsed.segments.map(({source}) => source)).toEqual(['First', 'Second', 'Third']);
        expect(JSON.parse(renderDocument(parsed, ['一', '二', '三'], 'translated'))).toEqual(JSON.parse(
            '{"__proto__":{"label":" 一 "},"constructor":"二","array":["三",null,42,true]}',
        ));
        expect(JSON.stringify(parsed.jsonValue)).toBe(original);
    });

    it('renders a deeply nested valid JSON tree without recursive copying', () => {
        const parsed = parseDocument('deep.json', '['.repeat(512) + '"leaf"' + ']'.repeat(512));
        expect(parsed.segments).toHaveLength(1);
        expect(renderDocument(parsed, ['译文'], 'translated')).toContain('译文');
        expect(parsed.segments[0].source).toBe('leaf');
    });

    it('does not loop while copying a circular manually supplied JSON model', () => {
        const parsed = parseDocument('manual.json', '{}');
        const value: {self?: unknown} = {};
        value.self = value;
        parsed.jsonValue = value;
        expect(() => renderDocument(parsed, [], 'translated')).toThrow(/circular|cyclic/iu);
    });

    it('bounds the depth of externally supplied JSON models during rendering', () => {
        const parsed = parseDocument('manual.json', '{}');
        const root: unknown[] = [];
        let cursor = root;
        for (let index = 0; index < 1_010; index += 1) {
            const child: unknown[] = []; cursor.push(child); cursor = child;
        }
        parsed.jsonValue = root;
        expect(() => renderDocument(parsed, [], 'translated')).toThrow('JSON 文件嵌套过深');
    });

    it.each([0, -1, NaN])('returns an empty excerpt without serializing JSON for limit %j', (limit) => {
        const parsed = parseDocument('data.json', '"Source"');
        Object.defineProperty(parsed, 'jsonValue', {get: () => {throw new Error('Unused full JSON');}});
        expect(renderDocument(parsed, [], 'bilingual', limit)).toBe('');
    });
});
