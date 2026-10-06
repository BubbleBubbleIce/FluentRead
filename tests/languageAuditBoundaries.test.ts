/**
 * @file tests/languageAuditBoundaries.test.ts
 * 文件职责：第 47 批语言核心审计的独立边界与消费者功能测试，直接加载真实语言模块和响应校验消费者。
 * 主要内容：非法标签不能触发漏译或接受原文回显，扩展与私有段保持合法兼容；大量短汉字段避免参数展开溢出，
 * 长名称和 Unicode 索引保持原文、统计阈值和词性展示边界；组合长点号链在独立子进程的硬超时内完成。
 * 不使用浏览器、账号或网络服务；子进程通过实际 TypeScript 模块加载器运行生产函数，不复制算法。
 */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseLanguageTag, normalizeLanguageCode, normalizeDetectedLanguageCode, isLanguageCodeMatch} from '@/src/core/language/codes';
import {detectlang, shouldSkipTranslationForTarget, shouldSkipChineseSelection} from '@/src/core/language/detect';
import {clearLanguageIdentificationCache, identifyTextLanguage} from '@/src/core/language/identify';
import {createLanguageDetectionCopy} from '@/src/core/language/technicalTokens';
import {segmentScriptWords} from '@/src/core/language/scripts';
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';
import {isLikelyUntranslatedResponse, hasTranslatableText} from '@/src/core/translation/resultValidation';

afterEach(clearLanguageIdentificationCache);

const english = 'This paragraph explains how the translation extension keeps the original text and shows the translated sentence below it.';
const invalidTags = ['en-u', 'en-x', 'en-u-', 'en-x-', 'en-u-abcdefghi', 'en-x-abcdefghi',
    'en-u-ca-gregory-u-nu-latn', 'en-a-foo-A-bar', 'en-US-Latn', 'zh-TW-Hans',
    'de-DE-1901-1901', 'sl-rozaj-ROZAJ', 'en-x-private--tail', 'en-u-ca-!'];

describe('非法语言标签不得进入同目标和排除语种决策', () => {
    it.each(invalidTags)('%s 不产生可比较语言码', tag => {
        expect(parseLanguageTag(tag)).toBeUndefined();
        expect(normalizeLanguageCode(tag)).toBe('');
        expect(normalizeDetectedLanguageCode(tag)).toBe('');
        expect(isLanguageCodeMatch('en', tag)).toBe(false);
        expect(isLanguageCodeMatch(tag, 'en')).toBe(false);
    });

    it.each(invalidTags.filter(tag => tag.startsWith('en')))('%s 不静默跳过英文正文', tag => {
        expect(shouldSkipTranslationForTarget(english, tag)).toBe(false);
        expect(shouldSkipTranslationForTarget(english, 'de', [tag])).toBe(false);
        // 实际响应校验消费者：非法目标仍应拒绝外语正文的原文回显。
        expect(isLikelyUntranslatedResponse(english, english, tag)).toBe(true);
    });

    it.each([
        ['en-u-ca-gregory', 'en'], ['en-a-foo-b-bar-x-a-b', 'en'], ['en-0-foo', 'en'],
        ['en-x-a', 'en'], ['en-x-u-u', 'en'], ['en-x-abcdefgh', 'en'],
        ['sl-rozaj-biske-1994-u-ca-gregory', 'sl'], ['zh-CHS-u-ca-chinese', 'zh-Hans'],
        ['zh-Hant-TW-x-private', 'zh-Hant'], ['zh-cmn-Hans-CN-u-nu-hanidec', 'zh-Hans'],
    ])('合法标签 %s 保持兼容', (tag, language) => {
        expect(normalizeLanguageCode(tag)).toBe(language);
        expect(normalizeDetectedLanguageCode(tag)).toBe(language);
    });
});

describe('大文本、名称与索引的实际模块边界', () => {
    it('13 万个短汉字段在韩文正文中无需展开函数参数', () => {
        const source = '漢 '.repeat(130_000) + '한국어'.repeat(50_000);
        expect(identifyTextLanguage(source)).toMatchObject({status: 'identified', languages: ['ko']});
        expect(shouldSkipTranslationForTarget(source, 'ko')).toBe(true);
        expect(shouldSkipTranslationForTarget(source, 'zh-Hant')).toBe(false);
    });

    it('八字汉字长串和简体字仍使韩文结论保留翻译机会', () => {
        expect(identifyTextLanguage('一二三四五六七八 한국어한국어한국어').status).toBe('mixed');
        expect(identifyTextLanguage('这 한국어한국어한국어').status).toBe('mixed');
    });

    it('长伪名称不被截短遮蔽，正文、原文和消费者可译性保持一致', () => {
        const name = 'A'.repeat(4096);
        expect(createLanguageDetectionCopy(name)).toEqual({text: name, identifiers: 0, versionedNames: 0});
        expect(hasTranslatableText(name)).toBe(true);
        const source = `${english} ${name}`;
        expect(createLanguageDetectionCopy(source).text).toBe(source);
        expect(source.endsWith(name)).toBe(true);
    });

    it('无标记长词只执行必要的替换扫描，输出仍完整保留', () => {
        const source = 'a'.repeat(4000);
        const native = String.prototype.replace;
        let replacementPasses = 0;
        const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function(this: string, ...args) {
            replacementPasses += 1;
            return Reflect.apply(native, this, args);
        });
        let copy;
        try { copy = createLanguageDetectionCopy(source); } finally { spy.mockRestore(); }
        expect(copy).toEqual({text: source, identifiers: 0, versionedNames: 0});
        expect(replacementPasses).toBeLessThanOrEqual(2);
    });

    it.each(['aaaa@', 'plain_text', '123', 'simple-word', 'a-'.repeat(1000)])('不完整语法与普通正文保持旧输出：%s', source => {
        const expected = source === 'plain_text' ? ' ' : source;
        expect(createLanguageDetectionCopy(source).text).toBe(expected);
    });

    it('点号长串保持旧成员标记输出，根路径和真实文件仍遮蔽', () => {
        expect(createLanguageDetectionCopy('a.'.repeat(1000))).toEqual({text: ' .', identifiers: 1, versionedNames: 0});
        expect(createLanguageDetectionCopy('see ./local and config.txt').text).toBe('see   and  ');
    });

    it.each([['A'.repeat(46) + '-6', 1], ['A'.repeat(47) + '-6', 0]])('名称已有总长边界：长度 %s', (source, count) => {
        expect(createLanguageDetectionCopy(source as string).versionedNames).toBe(count);
    });

    it('补充平面字、撇号和继承型组合标记均用 UTF-16 源索引', () => {
        const source = "😀𠀾中 Cafe\u0301 don’t ไทย";
        const words = segmentScriptWords(source);
        for (const word of words) expect(source.slice(word.start, word.end)).toBe(word.text);
        expect(words.map(word => word.script)).toEqual(['Han', 'Latin', 'Latin', 'Thai']);
        expect(words[0]).toMatchObject({start: 2, end: 5, letters: 2});
    });

    it('不同目标复用识别结论仍各自比较，调用方不能修改缓存结果', () => {
        const result = identifyTextLanguage(english);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.languages)).toBe(true);
        expect(identifyTextLanguage(english)).toBe(result);
        expect(shouldSkipTranslationForTarget(english, 'en')).toBe(true);
        expect(shouldSkipTranslationForTarget(english, 'zh-Hans')).toBe(false);
        expect(detectlang(english)).toBe('en');
        expect(shouldSkipChineseSelection('中文😀', 'zh-Hant')).toBe(true);
        expect(shouldSkipChineseSelection('中文 Cafe\u0301', 'zh-Hant')).toBe(false);
    });
});

describe('词性静态数据的展示接口', () => {
    it.each([
        ['noun phrase', 'noun'], ['v.', 'verb'], ['adj.', 'adjective'], ['r', 'adverb'],
        ['art', 'article'], ['det', 'determiner'], ['pron', 'pronoun'], ['prep', 'preposition'],
        ['conj', 'conjunction'], ['aux', 'auxiliary'], ['intj', 'interjection'], ['num', 'numeral'],
        ['infinitival phrase', 'phrase'], ['短語', 'phrase'],
    ])('%s 显示词性与短语标签', (value, id) => {
        expect(describePartOfSpeech(value)).toMatchObject({id});
        expect(describePartOfSpeech(value).description).not.toBe('');
    });

    it('未知成分标签和非字符串安全兜底，限制供应方标签展示长度', () => {
        expect(describePartOfSpeech(' subject ')).toMatchObject({id: 'other', label: 'subject'});
        expect(describePartOfSpeech(null)).toMatchObject({id: 'other', label: '其他'});
        expect(describePartOfSpeech('x'.repeat(90)).label).toHaveLength(80);
    });
});

describe('组合标记与超长名称前缀的回溯边界', () => {
    const markers = ['marker.com', 'valid.js', 'https://marker.com', 'user@example.com', '/usr/local/bin', 'owner/repo#123', 'enabled=true'];
    it.each(markers)('长无效点号链后 %s 保持整体输出和普通正文', suffix => {
        const source = 'a.'.repeat(2000) + `b ordinary ${suffix}`;
        expect(createLanguageDetectionCopy(source)).toEqual({text: '  ordinary  ', identifiers: 2, versionedNames: 0});
        expect(source).toContain('ordinary');
        expect(hasTranslatableText(source)).toBe(true);
    });

    it.each(markers)('独立进程处理长链后 %s，不阻塞测试主进程', suffix => {
        const sourcePath = resolve(process.env.LANGUAGECORE_AUDIT_SOURCE_ROOT ?? process.cwd(), 'src/core/language/technicalTokens.ts');
        // 只有加载器代码；业务函数来自真实源文件，受控 source root 供同例旧源重放使用。
        const loader = `
            import fs from 'node:fs';
            import {createRequire} from 'node:module';
            const require = createRequire(process.cwd() + '/package.json');
            const ts = require('typescript');
            const source = fs.readFileSync(process.argv[1], 'utf8');
            const output = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}, fileName: process.argv[1]}).outputText;
            const {createLanguageDetectionCopy} = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
            console.log(JSON.stringify(createLanguageDetectionCopy('a.'.repeat(20000) + 'b ordinary ' + process.argv[2])));
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', loader, sourcePath, suffix], {
            encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024,
        });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({text: '  ordinary  ', identifiers: 2, versionedNames: 0});
    }, 10_000);

    it.each([
        ['A'.repeat(120), 0, 1], ['a'.repeat(119) + 'A', 0, 1],
        ['A' + 'a'.repeat(119), 1, 0], ['É' + 'A'.repeat(120), 1, 0],
        ['A'.repeat(120) + ' ', 1, 0], ['', 1, 0],
    ])('长前缀 %s 保持名称与标记的旧计权', (prefix, versionedNames, identifiers) => {
        expect(createLanguageDetectionCopy(`${prefix} GPT6`)).toEqual({text: `${prefix}  `, identifiers, versionedNames});
    });

    it.each([
        ['a.www.example.com', 'a. ', 1], ['a.www.local', 'a. ', 1],
        ['a.WWW.local', 'a. ', 1], ['a-www.local', 'a- ', 1],
        ['www.', 'www.', 0], ['aaawww.example.com', ' ', 1],
        ['www. ordinary marker.com', 'www. ordinary  ', 1],
        ['a.www. ordinary https://marker.com', 'a.www. ordinary  ', 1],
    ])('候选内部的 www. 保持原 URL 边界：%s', (source, text, identifiers) => {
        expect(createLanguageDetectionCopy(source as string)).toEqual({text, identifiers, versionedNames: 0});
    });
});
