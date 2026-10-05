<!--
 * @file src/features/settings/ui/services/ServiceCatalog.vue
 * 文件职责：以服务目录和清晰分层的配置工作区呈现翻译服务，窄屏按需展开目录，保持配置与默认使用分离。
 * 主要内容：侧栏展示全部内置及自定义服务，分组可单独收起，选中服务或回到本页时展开正在配置的服务所在分组；顶部分组导航点击后展开并滚动到对应分组，并随目录滚动同步高亮；搜索过滤目录时展开全部匹配分组，此时点击分组导航会清空搜索并回到完整目录；自定义按钮直接打开创建表单；右侧集中展示服务名称及接口性质徽章、模型、官网帮助和连接配置；目录搜索文本按需缓存，活跃上下文限定操作并取消过期焦点与滚动。
 * 模块边界：目录提供“配置服务”和“自定义服务”入口，标题栏承载当前服务的检查连接操作，不编辑凭据、不测试连接也不保存配置；分组收起状态只保存在本次页面会话，不写入配置，卸载时断开目录尺寸观察；详细表单归 ServiceConfiguration.vue，服务定义来自 core/config，外层 SettingsSections 处理持久化。
 -->
<template>
  <section
    class="service-catalog"
    aria-label="翻译服务配置"
    :data-default-service="defaultService"
    :data-editing-service="service"
  >
    <nav v-if="directoryGroups.length > 1" class="service-group-navigation" :aria-label="t('options.categories')">
      <button
        v-for="group in directoryGroups"
        :key="group.id"
        type="button"
        :data-service-group-link="group.id"
        :aria-current="activeGroup === group.id ? 'location' : undefined"
        @click="revealGroup(group.id)"
      >{{ group.label }}</button>
    </nav>
    <div class="catalog-layout">
      <aside class="service-rail" :class="{ 'is-expanded': directoryOpen }" :aria-label="t('settings.services.library.shortlist')">
        <button ref="directoryToggle" type="button" class="mobile-directory-toggle" :disabled="!active" :aria-expanded="directoryOpen" :aria-controls="directoryId" :onClick="actions.toggleDirectory">
          <ServiceIcon :service="isCustomOpenAIProviderId(service) ? 'custom' : service" :label="selectedService?.label" size="small" />
          <span class="mobile-directory-name">{{ selectedService?.label }}</span><small>{{ t('settings.organization.chooseService') }}</small>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
        <div :id="directoryId" class="service-directory-content">
        <div class="rail-heading">
          <div>
            <strong>{{ t('settings.services.library.shortlist') }}</strong>
            <span class="service-count">{{ allServices.length }}</span>
          </div>
          <el-tooltip :content="t('settings.services.library.addHelp')" placement="bottom" :show-after="250" :trigger="['hover', 'focus']">
          <button ref="addButton" type="button" class="service-add-button" data-testid="custom-service-add" :disabled="!active" :aria-label="t('settings.services.library.add')" :onClick="actions.addService">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            <span>{{ t('settings.services.library.add') }}</span>
          </button>
          </el-tooltip>
        </div>
        <label class="catalog-search">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input :value="serviceQuery" :disabled="!active" :onInput="actions.updateQuery" type="search" :aria-label="t('settings.services.library.search')" :placeholder="t('settings.services.library.search')" />
        </label>
        <div ref="groupsElement" class="service-groups" @scroll.passive="syncActiveGroup" @wheel.passive="releasePinnedGroup" @touchstart.passive="releasePinnedGroup" @pointerdown="releasePinnedGroup" @keydown="releasePinnedGroup" @focusin="releasePinnedGroup">
          <section v-for="group in visibleDirectoryGroups" :key="group.id" :data-service-section="group.id" class="directory-section" :class="{ 'is-collapsed': !isGroupOpen(group.id) }">
            <h4>
              <button type="button" class="directory-section-toggle" :aria-expanded="isGroupOpen(group.id)" :aria-controls="`${directoryId}-${group.id}`" :disabled="searching" @click="toggleGroup(group.id)">
                <span>{{ group.label }}</span><small>{{ group.items.length }}</small>
                <svg v-if="!searching" class="directory-section-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
            </h4>
            <div v-show="isGroupOpen(group.id)" :id="`${directoryId}-${group.id}`" class="directory-items">
              <ServiceCatalogItem v-for="item in group.items" :key="item.value" :item="item" compact
                :selected="service === item.value" :is-default="defaultService === item.value"
                :is-configured="configuredSet.has(item.value)" :is-favorite="favoriteSet.has(item.value)"
                :onSelect="actions.selectService" />
            </div>
          </section>
          <p v-if="!visibleDirectoryGroups.length" class="catalog-empty" role="status">{{ t('settings.services.library.empty') }}</p>
        </div>
        </div>
      </aside>

      <section class="service-detail" aria-label="当前翻译服务详情">
        <div class="detail-hero">
          <ServiceIcon :service="isCustomOpenAIProviderId(service) ? 'custom' : service" :label="selectedService?.label" size="large" />
          <div class="detail-heading">
            <div class="detail-title-row">
              <h4>{{ selectedService?.label || '尚未配置服务' }}</h4>
              <ServiceNatureBadge :service="service" />
              <span v-if="service === defaultService" class="active-badge">{{ t('settings.services.library.default') }}</span>
              <span v-else class="editing-badge">{{ t('settings.services.library.viewing') }}</span>
              <a
                v-if="website"
                class="service-website-link"
                data-testid="service-website-link"
                :href="website.url"
                target="_blank"
                rel="noopener noreferrer"
                :title="website.url"
                :aria-label="t('settings.services.openExternal', { service: selectedService?.label || service, action: t(`settings.services.${website.kind}`) })"
              >
                {{ t(`settings.services.${website.kind}`) }}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
                </svg>
              </a>
            </div>
          </div>
          <div ref="connectionActionTarget" class="hero-connection-action" />
        </div>

        <p v-if="selectedService?.description && !credentialGuide && service !== 'freeTranslation' && !isCustomOpenAIProviderId(service)" class="service-description">{{ selectedService.description }}</p>

        <details
          v-if="credentialGuide"
          :key="service"
          class="credential-guide"
          data-testid="service-credential-guide"
          aria-label="免费额度与开通步骤"
        >
          <summary class="credential-guide-summary">
            <span class="credential-guide-summary-copy">
              <span class="credential-guide-badge">{{ t('settings.organization.guide') }}</span>
              <strong>{{ credentialGuide.freeQuota }}</strong>
            </span>
            <svg class="credential-guide-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </summary>
          <div class="credential-guide-body">
            <small>免费额度与超额处理以厂商控制台和当前套餐为准</small>
            <ol class="credential-guide-steps">
              <li v-for="(step, index) in credentialGuide.steps" :key="index">{{ step }}</li>
            </ol>
            <div class="credential-guide-links">
              <a
                class="credential-guide-link is-primary"
                data-testid="service-credential-console"
                :href="credentialGuide.consoleUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="credentialGuide.consoleUrl"
              >
                {{ credentialGuide.consoleLabel }}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
                </svg>
              </a>
              <a
                class="credential-guide-link"
                data-testid="service-credential-docs"
                :href="credentialGuide.docsUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="credentialGuide.docsUrl"
              >{{ credentialGuide.docsLabel }}</a>
            </div>
          </div>
        </details>

        <div v-if="showModel && service !== 'localTranslation'" class="model-section">
          <div class="model-heading">
            <strong>模型</strong>
          </div>
          <ModelPicker :active="active" :context="props.context" :context-key="service"
            :options="modelOptions"
            :selected-model="selectedModel"
            :maximum-models="maximumModels"
            :maximum-model-length="maximumModelLength"
            :custom-model-count="customModelCount"
            :allow-custom-models="allowCustomModels"
            :onSelect="actions.selectModel"
            :onAdd="actions.addModel"
            :onRemove="actions.removeModel"
          />
        </div>

        <div class="service-configuration-slot" :class="{'local-model-configuration': service === 'localTranslation'}" aria-label="当前服务配置">
          <slot name="configuration" :connection-action-target="connectionActionTarget" />
        </div>

      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import ServiceNatureBadge from './ServiceNatureBadge.vue'
import { useUiI18n } from '@/src/ui/i18n'
import { isCustomOpenAIProviderId } from '@/src/core/config/customOpenAI'
import {
  buildServiceSections,
  type ServiceCredentialGuide,
  type ServiceOption,
  type ServiceWebsite,
} from '@/src/ui/view-model/serviceCatalog'
import ModelPicker from './ModelPicker.vue'
import ServiceCatalogItem from './ServiceCatalogItem.vue'
import {useSettingsActionContext} from '../../model/useSettingsActionContext'

interface ModelPickerOption {
  value: string
  label?: string
  removable?: boolean
}

const props = withDefaults(defineProps<{
  active?: boolean
  context?: unknown
  service: string
  defaultService: string
  website?: ServiceWebsite
  credentialGuide?: ServiceCredentialGuide
  selectedModel?: string
  services: ServiceOption[]
  favoriteServices: string[]
  configuredServices: string[]
  modelOptions: ModelPickerOption[]
  showModel: boolean
  maximumModels: number
  maximumModelLength: number
  customModelCount: number
  allowCustomModels: boolean
}>(), {active: true})

const emit = defineEmits<{
  'update:service': [value: string]
  'update:model': [value: string]
  'add:service': []
  'add:model': [value: string]
  'remove:model': [value: string]
}>()

const { t } = useUiI18n()
const {active, capture} = useSettingsActionContext(() => props.active, () => [props.context, props.service])
const serviceQuery = ref('')
const directoryOpen = ref(false)
const directoryToggle = ref<HTMLButtonElement | null>(null)
const directoryId = useId()
const addButton = ref<HTMLButtonElement | null>(null)
const connectionActionTarget = ref<HTMLElement | null>(null)
const configuredSet = computed(() => new Set(props.configuredServices))
const favoriteSet = computed(() => new Set(props.favoriteServices))
const customServices = computed(() => props.services.filter((item) => isCustomOpenAIProviderId(item.value)))
const builtInServices = computed(() => props.services.filter((item) => !isCustomOpenAIProviderId(item.value)))
const sections = computed(() => buildServiceSections(builtInServices.value))
const directoryGroups = computed(() => [
  ...sections.value.flatMap(section => section.groups.map(group => ({ ...group, label: group.label || section.label }))),
  ...(customServices.value.length ? [{ id: 'custom', label: t('settings.services.library.custom'), items: customServices.value }] : []),
])
const allServices = computed(() => directoryGroups.value.flatMap(group => group.items))
// 延迟建立索引，空搜索不读取或规范化逐项文本；连续输入复用同一目录索引。
const directorySearchText = computed(() => new Map(allServices.value.map(item => [item,
  [item.label, item.value, item.description, ...(item.searchTerms || [])].join(' ').normalize('NFKC').toLocaleLowerCase(),
])))
const visibleDirectoryGroups = computed(() => {
  const keyword = serviceQuery.value.trim().normalize('NFKC').toLocaleLowerCase()
  if (!keyword) return directoryGroups.value
  return directoryGroups.value
    .map(group => ({ ...group, items: group.items.filter(item => directorySearchText.value.get(item)!.includes(keyword)) }))
    .filter(group => group.items.length)
})
const selectedService = computed(() => allServices.value.find(item => item.value === props.service))
const searching = computed(() => Boolean(serviceQuery.value.trim()))
const groupsElement = ref<HTMLElement | null>(null)
const collapsedGroups = ref<ReadonlySet<string>>(new Set())
const activeGroup = ref('')
// 末尾的短分组无法滚到目录顶部；点击导航后保持指向目标，直到用户自己操作目录。
let pinnedGroup = ''

// 搜索时展开全部匹配分组，避免结果藏在已收起的分组里。
function isGroupOpen(id: string): boolean {
  return searching.value || !collapsedGroups.value.has(id)
}
function setGroupOpen(id: string, open: boolean): void {
  if (collapsedGroups.value.has(id) === !open) return
  const next = new Set(collapsedGroups.value)
  if (open) next.delete(id)
  else next.add(id)
  collapsedGroups.value = next
}
function toggleGroup(id: string): void {
  setGroupOpen(id, !isGroupOpen(id))
}
function expandGroupOf(service: string): void {
  const group = directoryGroups.value.find(candidate => candidate.items.some(item => item.value === service))
  if (group) setGroupOpen(group.id, true)
}
function groupElement(id: string): HTMLElement | undefined {
  return [...groupsElement.value?.querySelectorAll<HTMLElement>('[data-service-section]') ?? []]
    .find(element => element.dataset.serviceSection === id)
}
function releasePinnedGroup(): void {
  pinnedGroup = ''
}
function syncActiveGroup(): void {
  const scroller = groupsElement.value
  // 目录隐藏时没有可比较的位置，保留上一次的结果。
  if (!scroller?.getClientRects().length) return
  const sections = [...scroller.querySelectorAll<HTMLElement>('[data-service-section]')]
  const ids = sections.map(section => section.dataset.serviceSection || '')
  if (ids.includes(pinnedGroup)) {
    activeGroup.value = pinnedGroup
    return
  }
  let current = ids[0] || ''
  if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    current = ids[ids.length - 1]
  } else {
    const top = scroller.getBoundingClientRect().top + 8
    sections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= top) current = ids[index]
    })
  }
  activeGroup.value = current
}
async function revealGroup(id: string) {
  // 导航始终列出全部分组；搜索中点击即回到完整目录。
  serviceQuery.value = ''
  setGroupOpen(id, true)
  pinnedGroup = id
  activeGroup.value = id
  await nextTick()
  const scroller = groupsElement.value
  const target = groupElement(id)
  if (!scroller || !target) return
  scroller.scrollTo({
    top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  })
}
// 同步执行，保证 revealGroup 清空搜索后设置的目标不会被随后的回调清掉。
watch(serviceQuery, releasePinnedGroup, {flush: 'sync'})
// 分组增减、收起或展开都会改变目录高度，但不会触发滚动事件；等 v-show 生效后再比较位置。
watch([visibleDirectoryGroups, collapsedGroups], () => nextTick(syncActiveGroup), {flush: 'post'})
// 切回本页、窄屏展开目录或跨越断点时目录从隐藏变为可见，同样没有滚动事件：此时让正在配置的服务保持可见并重新定位高亮。
let directoryVisible = false
let directoryObserver: ResizeObserver | undefined
onMounted(() => {
  const scroller = groupsElement.value
  if (!scroller) return
  directoryObserver = new ResizeObserver(() => {
    const visible = scroller.getClientRects().length > 0
    if (visible && !directoryVisible) expandGroupOf(props.service)
    directoryVisible = visible
    void nextTick(syncActiveGroup)
  })
  directoryObserver.observe(scroller)
})
onBeforeUnmount(() => directoryObserver?.disconnect())

function selectService(service: string): void {
  if (!active.value || !allServices.value.some(item => item.value === service && !item.disabled)) return
  expandGroupOf(service)
  if (service === props.service) {
    const restoreFocus = directoryOpen.value, current = capture()
    directoryOpen.value = false
    if (restoreFocus) void nextTick(() => {if (current()) directoryToggle.value?.focus({preventScroll: true})})
    return
  }
  emit('update:service', service)
}
const actions = computed(() => {
  const current = capture()
  return {
    selectService: (value: string) => {if (current()) selectService(value)},
    toggleDirectory: () => {if (current()) directoryOpen.value = !directoryOpen.value},
    updateQuery: (event: Event) => {const value = (event.currentTarget as HTMLInputElement | null)?.value;if (current() && typeof value === 'string') serviceQuery.value = value},
    addService: () => {if (current()) emit('add:service')},
    selectModel: (value: string) => {if (current()) emit('update:model', value)},
    addModel: (value: string) => {if (current()) emit('add:model', value)},
    removeModel: (value: string) => {if (current()) emit('remove:model', value)},
  }
})
watch(() => [active.value, props.context], () => {directoryOpen.value = false;serviceQuery.value = ''}, {flush: 'sync'})
// 外部跳转和新建服务沿用同一编辑工作区，并从表单顶部开始。
watch(() => props.service, (service) => {
  expandGroupOf(service)
  const restoreDirectoryFocus = directoryOpen.value
  directoryOpen.value = false
  const current = capture()
  void nextTick(() => {
    if (!current()) return
    if (restoreDirectoryFocus) directoryToggle.value?.focus({ preventScroll: true })
    addButton.value?.closest('.catalog-layout')?.querySelector('.service-detail')?.scrollTo({ top: 0 })
  })
}, {flush: 'sync'})

</script>

<style scoped>
.service-catalog { display: flex; flex-direction: column; height: min(650px, 70dvh); min-height: 0; color: var(--ink, #172033); background: var(--surface, #fff); }
.service-group-navigation { display: flex; flex: none; gap: 24px; min-width: 0; padding: 0 18px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: thin; overscroll-behavior-x: contain; }
.service-group-navigation button { flex: none; padding: 10px 2px 12px; border: 0; border-bottom: 2px solid transparent; color: var(--muted); background: transparent; font: inherit; font-size: 13px; font-weight: 600; line-height: 1.4; white-space: nowrap; cursor: pointer; }
.service-group-navigation button:hover { color: var(--ink); }
.service-group-navigation button[aria-current] { border-bottom-color: var(--brand); color: var(--brand-strong); font-weight: 650; }
.service-group-navigation button:focus-visible { outline-offset: -3px; border-radius: 4px; }
.catalog-layout { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 0; flex: 1; overflow: hidden; }
.service-rail { display: flex; flex-direction: column; min-height: 0; padding: 16px 12px; border-right: 1px solid var(--line, #e4e7ef); background: var(--surface-soft, #fafbfc); }
.rail-heading { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 6px 10px; }
.rail-heading > div { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.rail-heading strong { color: var(--ink, #172033); font-size: 13px; font-weight: 700; }
.service-add-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 34px; padding: 7px 11px; border: 1.5px solid color-mix(in srgb, var(--brand) 65%, var(--line)); border-radius: 10px; color: var(--brand-strong); background: var(--surface); font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s; }
.service-add-button:hover, .service-add-button:focus-visible { border-color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 10%, transparent); }

.service-count { margin-left: 4px; font-variant-numeric: tabular-nums; }
.service-groups { overflow-y: auto; min-height: 0; flex: 1; margin-top: 12px; overscroll-behavior: contain; }
.directory-items { display: grid; gap: 1px; }
.service-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 14px; padding: 24px; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); }
.detail-hero { display: flex; align-items: center; gap: 14px; padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.detail-hero > :deep(.service-icon) { margin-top: 2px; }
.detail-heading { flex: 1; min-width: 0; }
.hero-connection-action { flex: none; margin-left: auto; }
.detail-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.detail-title-row h4 { margin: 0; font-size: 20px; line-height: 1.4; overflow-wrap: anywhere; }
.detail-hero p { margin: 5px 0 0; color: var(--muted, #737c8f); font-size: 12px; line-height: 1.6; }
.active-badge { padding: 4px 8px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 10px; font-weight: 600; white-space: nowrap; }
.editing-badge { color: var(--muted, #737c8f); font-size: 11px; white-space: nowrap; }
.service-description { max-width: 760px; margin: -8px 0 18px; color: var(--muted, #737c8f); font-size: 12px; line-height: 1.65; }
.service-website-link { display: inline-flex; align-items: center; gap: 4px; color: var(--brand-strong); font-size: 12px; font-weight: 550; text-decoration: none; }
.service-website-link:hover { color: var(--brand-strong, #bd2853); text-decoration: underline; }
.model-section { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: center; gap: 16px; padding: 0 0 18px; margin: 0 0 18px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; flex-shrink: 0; }
.model-section > :deep(.model-picker) { width: 100%; max-width: 640px; justify-self: start; }
.model-heading strong { font-size: 13px; font-weight: 550; }
.service-configuration-slot { flex-shrink: 0; padding-bottom: 12px; }
.catalog-search { flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 10px; border: 1px solid var(--line, #dfe3eb); border-radius: 8px; color: var(--muted, #737c8f); background: var(--surface, #fff); }
.catalog-search:focus-within { border-color: var(--brand-strong, #bd2853); }
.catalog-search input { width: 100%; min-width: 0; padding: 9px 0; border: 0; outline: none; color: var(--ink, #172033); background: transparent; font-size: 13px; }
.directory-section + .directory-section { margin-top: 16px; }
.directory-section.is-collapsed + .directory-section { margin-top: 8px; }
.directory-section h4 { margin: 0 0 6px; }
.directory-section.is-collapsed h4 { margin-bottom: 0; }
.directory-section-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: 0; border-bottom: 1px solid var(--line); border-radius: 8px 8px 0 0; background: color-mix(in srgb, var(--line) 22%, transparent); color: var(--ink); font: inherit; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.directory-section-toggle:disabled { cursor: default; }
.directory-section-toggle:focus-visible { outline-offset: -2px; }
.directory-section-toggle:not(:disabled):hover { background: color-mix(in srgb, var(--line) 40%, transparent); }
.directory-section-toggle > span { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.directory-section-toggle small { color: var(--muted); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; }
.directory-section-chevron { flex: none; width: 14px; height: 14px; color: var(--muted); transition: transform 150ms ease; }
.directory-section-toggle[aria-expanded="true"] .directory-section-chevron { transform: rotate(90deg); }
.directory-section.is-collapsed .directory-section-toggle { border-radius: 8px; }
@media (prefers-reduced-motion: reduce) { .directory-section-chevron { transition: none; } }
.catalog-empty { padding: 32px 0; color: var(--muted, #737c8f); text-align: center; font-size: 13px; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }
.credential-guide { margin: 0 0 20px; border: 0; border-radius: 10px; background: var(--surface-soft, #fff8fa); }
.credential-guide-summary { display: flex; align-items: center; gap: 9px; min-height: 40px; padding: 10px 12px; cursor: pointer; list-style: none; }
.credential-guide-summary::-webkit-details-marker { display: none; }
.credential-guide-summary-copy { display: flex; min-width: 0; align-items: center; gap: 8px; }
.credential-guide-summary-copy strong { min-width: 0; overflow-wrap: anywhere; color: #172033; font-size: 13px; }
.credential-guide-summary-action { margin-left: auto; color: var(--brand-strong, #bd2853); font-size: 11px; white-space: nowrap; }
.credential-guide-chevron { margin-left: auto; width: 16px; height: 16px; flex: none; color: var(--muted, #8991a2); transition: transform 150ms ease; }
.credential-guide[open] .credential-guide-chevron { transform: rotate(180deg); }
.credential-guide-body { display: grid; gap: 12px; padding: 14px 16px 16px; border-top: 1px solid var(--line); }
.credential-guide-body > small { color: var(--muted); font-size: 12px; line-height: 1.5; }
.credential-guide-badge { flex-shrink: 0; padding: 3px 8px; border-radius: 999px; color: var(--brand-strong); background: var(--brand-soft); font-size: 11px; font-weight: 600; letter-spacing: .04em; }
.credential-guide-steps { display: grid; gap: 6px; margin: 0; padding-left: 20px; color: var(--ink); font-size: 12px; line-height: 1.6; }
.credential-guide-steps li::marker { color: #c72a56; font-weight: 800; }
.credential-guide-links { display: flex; flex-wrap: wrap; gap: 8px; }
.credential-guide-link { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 12px; border: 1px solid #e2e5ec; border-radius: 9px; color: #46526a; background: #fff; font-size: 12px; font-weight: 650; text-decoration: none; transition: 150ms ease; }
.credential-guide-link:hover { border-color: #f3c4d1; color: var(--brand-strong, #bd2853); background: var(--brand-soft, #fff0f4); }
.credential-guide-link.is-primary { border-color: var(--brand-border, #f3c0ce); color: var(--brand-strong); background: var(--brand-soft); }
.credential-guide-link.is-primary:hover { color: #fff; background: var(--brand-strong, #bd2853); filter: brightness(.92); box-shadow: 0 6px 16px rgba(214, 50, 96, .18); }
.credential-guide-link:focus-visible { outline: 2px solid var(--brand-strong, #bd2853); outline-offset: 2px; }

:global(:root.dark .credential-guide) { border-color: var(--line); background: var(--surface-soft); }
:global(:root.dark .credential-guide-summary-copy strong), :global(:root.dark .credential-guide-steps) { color: var(--ink); }
:global(:root.dark .credential-guide-body) { border-color: var(--line); }
:global(:root.dark .credential-guide-link) { border-color: var(--line); color: var(--ink); background: var(--surface); }
:global(:root.dark .credential-guide-link.is-primary) { color: var(--brand-strong); background: var(--brand-soft); }
@media (max-width: 1100px) {
  .catalog-layout { grid-template-columns: 212px minmax(0, 1fr); }
  .service-detail { margin: 12px; padding: 18px; }
  .model-section { grid-template-columns: 1fr; gap: 8px; }
}
@media (max-width: 700px) {
  .service-catalog { height: auto; min-height: 0; }
  .service-group-navigation { display: none; }
  .catalog-layout { display: block; }
  .service-rail { border-right: 0; border-bottom: 1px solid var(--line, #e4e7ef); padding: 10px 12px; }
  .rail-heading { margin-bottom: 6px; }
  .service-groups { min-height: 80px; }
  .directory-items { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .service-detail { margin: 0; padding: 18px 14px; border: 0; border-radius: 0; overflow: visible; }
  .detail-hero { flex-wrap: wrap; gap: 10px; }
  .detail-title-row h4 { font-size: 18px; }
  .model-section { grid-template-columns: 1fr; gap: 7px; }

}
@media (min-width: 701px) and (max-width: 1250px) { .model-section { grid-template-columns: 1fr; gap: 8px; } }
@media (max-width: 700px) { .credential-guide-summary-copy { align-items: flex-start; flex-direction: column; gap: 6px; } }
.service-directory-content { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mobile-directory-toggle { display: none; }
@media (max-width: 700px) {
  .mobile-directory-toggle { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 6px 2px; border: 0; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
  .mobile-directory-name { min-width: 0; flex: 1; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .mobile-directory-toggle > small { color: var(--brand-strong); font-size: 12px; }
  .mobile-directory-toggle > svg { flex: none; width: 16px; height: 16px; }
  .mobile-directory-toggle[aria-expanded="true"] > svg { transform: rotate(180deg); }
  .service-rail:not(.is-expanded) .service-directory-content { display: none; }
  .service-rail.is-expanded .service-directory-content { height: 280px; max-height: 40dvh; padding-top: 12px; flex: none; }
  .service-groups { max-height: 240px; }
  .hero-connection-action { margin-left: 0; }
  .detail-hero { margin-bottom: 16px; padding-bottom: 16px; }
}
</style>
