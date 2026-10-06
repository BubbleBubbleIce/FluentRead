/**
 * @file src/features/settings/model/useQuickProfileDraft.ts
 * 文件职责：合并快捷方案连续编辑，并区分父级回传与外部替换。
 * 主要内容：保留最新发布列表、校验回传内容，给逻辑方案分配生命周期标识；新增、删除、外部替换与配置切换不会复活旧方案。
 * 模块边界：只管理组件草稿与归属，不校验业务选项、保存配置或运行快捷键。
 */
import {ref, shallowRef, toRaw, watch} from 'vue'
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation'

const fields = ['id', 'enabled', 'action', 'hotkey', 'service', 'model', 'targetLanguage', 'displayMode', 'fullPageMode'] as const
type ProfileField = typeof fields[number] | 'glossaryIds'
const trackedFields: readonly ProfileField[] = [...fields, 'glossaryIds']
function sameValue(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right
}
function snapshot(profiles: readonly QuickTranslationProfile[]): QuickTranslationProfile[] {
  return profiles.map(profile => ({...profile, glossaryIds: profile.glossaryIds?.slice() ?? profile.glossaryIds}))
}
function matches(left: readonly QuickTranslationProfile[], right: readonly QuickTranslationProfile[]): boolean {
  return left.length === right.length && left.every((profile, index) => {
    const other = right[index]!
    if (!fields.every(field => profile[field] === other[field])) return false
    return sameValue(profile.glossaryIds, other.glossaryIds)
  })
}

export function useQuickProfileDraft(getProfiles: () => QuickTranslationProfile[], getContext: () => readonly unknown[]) {
  const profiles = shallowRef(getProfiles()), lineageRevision = ref(0)
  let context = getContext(), published = new WeakMap<QuickTranslationProfile[], QuickTranslationProfile[]>()
  let owners = new Map<string, {source: QuickTranslationProfile; token: symbol; state: QuickTranslationProfile; fields: Record<ProfileField, symbol>}>()
  function assignOwners(next: QuickTranslationProfile[], preserve: boolean) {
    const previous = owners
    owners = new Map(next.map(profile => {
      const source = toRaw(profile), old = previous.get(profile.id)
      const owned = old && (preserve || old.source === source), state = snapshot([profile])[0]!
      const tokens = Object.fromEntries(trackedFields.map(field => [field,
        owned && sameValue(old.state[field], state[field]) ? old.fields[field] : Symbol(field),
      ])) as Record<ProfileField, symbol>
      return [profile.id, {source, state, fields: tokens, token: owned ? old.token : Symbol(profile.id)}]
    }))
    lineageRevision.value += 1
  }
  assignOwners(profiles.value, false)
  watch(() => ({list: getProfiles(), state: snapshot(getProfiles()), context: getContext()}), next => {
    if (context.length !== next.context.length || !context.every((value, index) => value === next.context[index])) {
      context = next.context;published = new WeakMap();owners.clear();assignOwners(next.list, false);profiles.value = next.list;return
    }
    const acknowledged = published.get(toRaw(next.list))
    if (acknowledged && matches(acknowledged, next.state)) {
      if (toRaw(profiles.value) === toRaw(next.list)) profiles.value = next.list
      return
    }
    // 同引用但内容变化也是外部编辑；不能把改过的旧回传当作自己的确认。
    published = new WeakMap();assignOwners(next.list, false);profiles.value = next.list
  }, {flush: 'sync'})
  function publish(next: QuickTranslationProfile[]): void {
    published.set(toRaw(next), snapshot(next));assignOwners(next, true);profiles.value = next
  }
  return {profiles, lineageRevision, publish, token: (id: string, field?: ProfileField) => field === undefined ? owners.get(id)?.token : owners.get(id)?.fields[field]}
}
