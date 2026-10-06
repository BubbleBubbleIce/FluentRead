/**
 * @file tests/quickProfileDraft.test.ts
 * 文件职责：验证快捷方案草稿的最新回传、逻辑生命周期与字段版本。
 * 主要内容：覆盖连续发布、乱序确认、外部编辑/重建、上下文变化及术语选择身份。
 * 模块边界：在 Vue effectScope 中测试纯组件状态，不读浏览器存储或执行翻译。
 */
import {effectScope, reactive, shallowRef, type EffectScope} from 'vue'
import {afterEach, describe, expect, it} from 'vitest'
import {createQuickTranslationProfile, type QuickTranslationProfile} from '@/src/core/config/quickTranslation'
import {useQuickProfileDraft} from '@/src/features/settings/model/useQuickProfileDraft'

let scope: EffectScope
afterEach(() => scope?.stop())
function p(overrides: Partial<QuickTranslationProfile> = {}) {return {...createQuickTranslationProfile('hover'), ...overrides}}
function setup(initial: QuickTranslationProfile[] = [p()]) {
  const incoming = shallowRef(reactive(initial)), context = shallowRef<readonly unknown[]>([{}])
  scope = effectScope();const draft = scope.run(() => useQuickProfileDraft(() => incoming.value, () => context.value))!
  return {incoming, context, draft}
}
describe('快捷方案最新草稿与字段版本', () => {
  it('发布合并最新列表，乱序旧回传不覆盖最新，当前回传恢复响应式代理', () => {
    const {incoming,draft}=setup(), first=[p({service:'openai'})], second=[p({service:'openai',targetLanguage:'ja'})]
    draft.publish(first);draft.publish(second);incoming.value=reactive(first);expect(draft.profiles.value).toBe(second);incoming.value=reactive(second);expect(draft.profiles.value).toBe(incoming.value);incoming.value=reactive(first);expect(draft.profiles.value).not.toBe(incoming.value);expect(draft.profiles.value[0].targetLanguage).toBe('ja')
  })
  it('外部克隆相同 ID 重新分配所有生命周期；自己发布保留逻辑身份及未改字段', () => {
    const {incoming,draft}=setup(), token=draft.token('quick-1'), hotkey=draft.token('quick-1','hotkey'), target=draft.token('quick-1','targetLanguage')
    draft.publish([p({targetLanguage:'ja'})]);expect(draft.token('quick-1')).toBe(token);expect(draft.token('quick-1','hotkey')).toBe(hotkey);expect(draft.token('quick-1','targetLanguage')).not.toBe(target);const own=draft.token('quick-1');incoming.value=reactive([p({targetLanguage:'ja'})]);expect(draft.token('quick-1')).not.toBe(own)
  })
  it('删除并重建同 ID 不保留旧生命周期，未知 ID 没有标识', () => {
    const {draft}=setup(), token=draft.token('quick-1');draft.publish([]);expect(draft.token('quick-1')).toBeUndefined();expect(draft.token('quick-1','model')).toBeUndefined();draft.publish([p()]);expect(draft.token('quick-1')).not.toBe(token)
  })
  it.each(['id','enabled','action','hotkey','service','model','targetLanguage','displayMode','fullPageMode'] as const)('%s 修改再复原仍保持新字段版本', field => {
    const {draft}=setup(), values={id:'other',enabled:true,action:'section',hotkey:'F9',service:'openai',model:'private',targetLanguage:'ja',displayMode:'bilingual',fullPageMode:'all'}
    const before=draft.token('quick-1',field);draft.publish([p({[field]:values[field]})]);draft.publish([p()]);expect(draft.token('quick-1',field)).not.toBe(before)
  })
  it('术语快照复制数组，内容相同保留版本，顺序/数量、停用和继承分别更新', () => {
    const {incoming,draft}=setup([p({glossaryIds:['a']})]), initial=draft.token('quick-1','glossaryIds')
    const next=[p({glossaryIds:['a']})];draft.publish(next);expect(draft.token('quick-1','glossaryIds')).toBe(initial);incoming.value=reactive(next);const token=draft.token('quick-1','glossaryIds');incoming.value[0].glossaryIds!.push('b');expect(draft.token('quick-1','glossaryIds')).not.toBe(token)
    const extended=draft.token('quick-1','glossaryIds');draft.publish([p({glossaryIds:['b','a']})]);expect(draft.token('quick-1','glossaryIds')).not.toBe(extended);draft.publish([p({glossaryIds:[]})]);const empty=draft.token('quick-1','glossaryIds');draft.publish([p({glossaryIds:null})]);expect(draft.token('quick-1','glossaryIds')).not.toBe(empty);draft.publish([p()]);expect(draft.profiles.value[0].glossaryIds).toBeUndefined()
  })
  it('改过内容的旧发布数组是外部编辑，不冒充自己的确认', () => {
    const {incoming,draft}=setup(), first=[p()], second=[p({service:'openai'})];draft.publish(first);draft.publish(second);first[0].service='microsoft';incoming.value=reactive(first);expect(draft.profiles.value).toBe(incoming.value);expect(draft.profiles.value[0].service).toBe('microsoft')
  })
  it('列表长度不同或术语不同也不是旧确认，稳定对象保留逻辑身份但更新字段版本', () => {
    const {incoming,draft}=setup(), next=[p({glossaryIds:['a']})];draft.publish(next);const token=draft.token('quick-1');next.push(p({id:'other'}));incoming.value=reactive(next);expect(draft.profiles.value).toBe(incoming.value);expect(draft.token('quick-1')).toBe(token);const newList=[p({glossaryIds:['a']})];draft.publish(newList);newList[0].glossaryIds=['b'];incoming.value=reactive(newList);expect(draft.profiles.value[0].glossaryIds).toEqual(['b'])
  })
  it('上下文值或长度变化清理发布身份，旧确认回到新上下文只作为外部输入', () => {
    const {incoming,context,draft}=setup(), next=[p({service:'openai'})];draft.publish(next);const token=draft.token('quick-1');context.value=[{}];expect(draft.profiles.value).toBe(incoming.value);expect(draft.token('quick-1')).not.toBe(token);context.value=[];expect(draft.profiles.value).toBe(incoming.value);incoming.value=reactive(next);expect(draft.profiles.value).toBe(incoming.value)
  })
})
