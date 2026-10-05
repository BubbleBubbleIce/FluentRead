/**
 * @file tests/inputTranslationConfig.test.ts
 * 文件职责：验证输入框翻译配置的默认值、边界规范化、服务保留和提示词变量补齐规则。
 * 主要内容：覆盖 interval 的整数范围、无效服务回退、已配置自定义服务保留、用户提示词原文保留与执行变量补齐。
 * 模块边界：本文件只测试 core 配置纯函数，不访问浏览器、不调用翻译服务，也不验证设置界面渲染。
 */
import {describe, expect, it} from 'vitest';
import {services} from '@/src/core/config/catalog';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL,
    DEFAULT_INPUT_BOX_TRANSLATION_PROMPT,
    DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
    completeInputBoxTranslationPrompt,
    INPUT_BOX_TRANSLATION_INTERVAL_MAX,
    INPUT_BOX_TRANSLATION_INTERVAL_MIN,
    normalizeInputBoxTranslationInterval,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationOutputMode,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
    supportsInputBoxTranslationPrompt,
} from '@/src/core/config/inputTranslation';

describe('输入框翻译配置', () => {
    it.each([NaN, Infinity, -Infinity, '700', null])('非有限或非数字间隔 %s 使用默认值，不产生零延迟连击', value => {
        expect(normalizeInputBoxTranslationInterval(value)).toBe(DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL);
    });

    it('双语追加显式保存，旧配置和非法值继续替换原文', () => {
        expect(normalizeConfig({inputBoxTranslationOutputMode: 'prepend'}).inputBoxTranslationOutputMode).toBe('prepend');
        expect(new Config().inputBoxTranslationOutputMode).toBe('replace');
        expect(normalizeConfig({}).inputBoxTranslationOutputMode).toBe('replace');
        expect(normalizeConfig({inputBoxTranslationOutputMode: 'append'}).inputBoxTranslationOutputMode).toBe('append');
        for (const value of [undefined, null, true, 'unknown', 'replace']) {
            expect(normalizeInputBoxTranslationOutputMode(value)).toBe('replace');
        }
    });
    it('保留默认服务、空模型与独立默认提示词，并规范化 interval', () => {
        const config = normalizeConfig({});
        expect(config.inputBoxTranslationInterval).toBe(DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL);
        expect(config.inputBoxTranslationService).toBe('');
        expect(config.inputBoxTranslationModel).toBe('');
        expect(config.inputBoxTranslationPrompt).toBe('');
        expect(config.inputBoxTranslationSystemPrompt).toBe('');
        expect(DEFAULT_INPUT_BOX_TRANSLATION_PROMPT).toContain('{{origin}}');
        expect(DEFAULT_INPUT_BOX_TRANSLATION_PROMPT).toContain('{{to}}');
        expect(DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT).toContain('translation');

        expect(normalizeConfig({inputBoxTranslationInterval: 199}).inputBoxTranslationInterval)
            .toBe(INPUT_BOX_TRANSLATION_INTERVAL_MIN);
        expect(normalizeConfig({inputBoxTranslationInterval: 2001.8}).inputBoxTranslationInterval)
            .toBe(INPUT_BOX_TRANSLATION_INTERVAL_MAX);
        expect(normalizeConfig({inputBoxTranslationInterval: 801.9}).inputBoxTranslationInterval).toBe(801);
    });

    it('无效服务回退跟随默认，合法配置服务和用户文本保留', () => {
        const customOpenAIProviders = [{
            id: 'custom:input',
            name: '输入服务',
            endpoint: 'https://example.test/v1',
            models: ['input-model'],
        }];
        const config = normalizeConfig({
            inputBoxTranslationService: 'custom:input',
            customOpenAIProviders,
            inputBoxTranslationModel: '  input-model  ',
            inputBoxTranslationPrompt: '  语气自然  \n',
            inputBoxTranslationSystemPrompt: '  只输出译文  \n',
        });
        expect(config.inputBoxTranslationService).toBe('custom:input');
        expect(config.inputBoxTranslationModel).toBe('input-model');
        expect(config.inputBoxTranslationPrompt).toBe('  语气自然  \n');
        expect(config.inputBoxTranslationSystemPrompt).toBe('  只输出译文  \n');
        expect(normalizeConfig({inputBoxTranslationService: 'unknown'}).inputBoxTranslationService)
            .toBe('');
    });

    it('执行 prompt 只补齐缺失变量，并保留用户原始指令', () => {
        const prompt = '语气自然，不要解释';
        const completed = completeInputBoxTranslationPrompt(prompt);
        expect(completed).toContain(prompt);
        expect(completed).toContain('{{to}}');
        expect(completed).toContain('{{origin}}');
        expect(completeInputBoxTranslationPrompt('已有 {{to}}\n原文 {{origin}}')).toBe('已有 {{to}}\n原文 {{origin}}');
        expect(completeInputBoxTranslationPrompt('')).toBe(DEFAULT_INPUT_BOX_TRANSLATION_PROMPT);
        expect(new Config().inputBoxTranslationPrompt).toBe('');
    });

    it('覆盖服务、模型、提示词和 interval 规范化的异常与能力分支', () => {
        expect(normalizeInputBoxTranslationInterval('bad')).toBe(DEFAULT_INPUT_BOX_TRANSLATION_INTERVAL);
        expect(normalizeInputBoxTranslationInterval(200.9)).toBe(200);
        expect(normalizeInputBoxTranslationModel(12)).toBe('');
        expect(normalizeInputBoxTranslationPrompt(12)).toBe('');
        expect(normalizeInputBoxTranslationService(null)).toBe('');
        expect(normalizeInputBoxTranslationService('custom:missing')).toBe('');
        expect(normalizeInputBoxTranslationService(services.microsoft)).toBe(services.microsoft);
        expect(normalizeInputBoxTranslationService(services.deepseek)).toBe(services.deepseek);
        expect(supportsInputBoxTranslationPrompt(services.deepseek, 'deepseek-chat')).toBe(true);
        expect(supportsInputBoxTranslationPrompt(services.tongyi, 'qwen-mt-plus')).toBe(false);
        expect(supportsInputBoxTranslationPrompt(services.microsoft)).toBe(false);
    });
});
