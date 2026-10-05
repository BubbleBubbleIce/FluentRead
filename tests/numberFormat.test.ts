import {afterEach, describe, expect, it, vi} from 'vitest';
import {createNumberFormatter} from '@/src/core/i18n/numberFormat';

afterEach(() => vi.restoreAllMocks());

describe('固定规则数字格式器缓存', () => {
    it('复用同语言实例，保留规则快照且不同规则独立缓存', () => {
        const rules = {maximumFractionDigits: 0};
        const integer = createNumberFormatter(rules);
        const percentage = createNumberFormatter({style: 'percent', maximumFractionDigits: 1});
        rules.maximumFractionDigits = 2;
        const formatter = vi.spyOn(Intl, 'NumberFormat');
        expect(integer('en-US').format(1234.56)).toBe('1,235');
        expect(integer('en-US')).toBe(integer('en-US'));
        expect(percentage('en-US').format(.1234)).toBe('12.3%');
        expect(formatter).toHaveBeenCalledTimes(2);
    });

    it('每套规则最多缓存八种语言，随后淘汰最早语言并可重建', () => {
        const integer = createNumberFormatter({maximumFractionDigits: 0});
        const first = integer('en-US');
        for (let index = 0; index < 7; index += 1) integer(`en-US-x-a${index}`);
        expect(integer('en-US')).toBe(first);
        integer('en-US-x-next');
        expect(integer('en-US')).not.toBe(first);
        expect(integer('en-US').format(1234)).toBe(first.format(1234));
    });

    it('非法语言沿用原生异常，失败不会污染已缓存语言', () => {
        const integer = createNumberFormatter({maximumFractionDigits: 0});
        const first = integer('zh-CN');
        expect(() => integer('invalid_locale')).toThrow(RangeError);
        expect(integer('zh-CN')).toBe(first);
    });
});
