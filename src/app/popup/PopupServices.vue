<!--
 @file src/app/popup/PopupServices.vue
 文件职责：在 Popup 翻译服务抽屉中展示功能分配概览，以独立选择面板替代层叠下拉菜单，让窄弹窗里的服务选择更直观。
 主要内容：突出网页默认服务，以紧凑列表展示各功能的独立服务或继承状态，以统一状态标签呈现服务并让多语言名称完整换行，保留本地图标、模型和配置提醒；选择面板合并功能标题、返回与关闭操作，将主要空间用于常用/更多服务、模型搜索及键盘导航，保留不可用的旧选择，缓存行级凭据与模型，只让当前活跃配置和所属面板的事件修改草稿；焦点返回复验面板与用户焦点。
 模块边界：复用功能服务映射、模型解析及供应商能力，只修改父级配置草稿；保存由 PopupApp 负责，不请求翻译或处理连接密钥。
-->
<template>
  <div ref="panel" class="popup-service-panel" data-i18n-ignore :onKeydown="panelActions.keydown">
    <div v-if="!editing" class="popup-service-toolbar">
      <button type="button" class="service-panel-close" :aria-label="t('common.close')" :onClick="panelActions.close">×</button>
    </div>
    <div v-if="!editing" class="popup-service-overview">
      <button v-for="row in rows" :key="row.field.id" type="button" class="service-assignment"
        :class="{'default-assignment': !row.field.feature}" :data-feature-service="row.field.id"
        :aria-label="`${t(`featureServices.${row.field.id}`)} · ${row.selectedLabel}`"
        :title="row.warning || (!row.field.feature ? t('featureServices.defaultHelp') : row.selectedLabel)"
        :onClick="row.open">
        <span class="assignment-heading"><strong>{{ t(`featureServices.${row.field.id}`) }}</strong></span>
        <span class="assignment-details">
          <span v-if="row.warning" class="assignment-warning" role="img" :aria-label="row.warning" :title="row.warning">!</span>
          <span class="assignment-value" :class="{'assignment-inherited': row.field.feature?.inherit && !row.selected}">
            <ServiceIcon v-if="!row.field.feature?.inherit || row.selected" :service="row.service" :label="label(row.service)" size="small" />
            <span>{{ row.field.feature?.inherit && !row.selected ? t('featureServices.followDefault') : label(row.service) }}</span>
          </span>
          <small v-if="!row.warning && row.field.feature && row.selected && servicesType.isUseModel(row.service)" :title="row.model">{{ row.model }}</small>
        </span>
        <span class="assignment-chevron" aria-hidden="true">›</span>
      </button>
    </div>
    <section v-else class="popup-service-picker" :data-service-picker="editing.id">
      <header class="service-picker-heading">
        <button type="button" class="service-picker-back" :aria-label="t('featureServices.back')" :onClick="panelActions.back">←</button>
        <strong>{{ t(`featureServices.${editing.id}`) }}</strong>
        <small v-if="editing.feature?.aiOnly">{{ t('featureServices.aiOnly') }}</small>
        <button type="button" class="service-panel-close" :aria-label="t('common.close')" :onClick="panelActions.close">×</button>
      </header>
      <label class="service-picker-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
        <input ref="searchInput" :value="query" :onInput="panelActions.search" type="search" :aria-label="t('popup.serviceSearchPlaceholder')" :placeholder="t('popup.serviceSearchPlaceholder')" :onKeydown="panelActions.searchKeydown" />
        <button v-if="query" type="button" :aria-label="t('popup.clearSearch')" :onClick="panelActions.clear">×</button>
      </label>
      <div ref="results" class="service-picker-list" role="listbox" :aria-label="t(`featureServices.${editing.id}`)" :onKeydown="panelActions.navigate">
        <button v-if="editing.feature?.inherit && !query.trim()" type="button" role="option" class="service-choice follow-choice"
          data-service-choice="" :aria-selected="!selected(editing.feature)" :onClick="panelActions.inherit">
          <ServiceIcon :service="config.service" :label="label(config.service)" size="small" />
          <span class="service-choice-copy"><strong>{{ t('featureServices.followDefault') }}</strong><small>{{ label(config.service) }}</small></span>
          <span v-if="!selected(editing.feature)" class="service-choice-check" aria-hidden="true">✓</span>
        </button>
        <template v-for="group in choiceGroups" :key="group.id">
          <button v-if="group.id === 'more' && !query.trim() && moreChoices.length" type="button" class="service-picker-more" :aria-expanded="moreOpen" :onClick="panelActions.more">
            <span>{{ t('popup.moreServices') }} <small>{{ moreChoices.length }}</small></span><span aria-hidden="true">{{ moreOpen ? '⌃' : '⌄' }}</span>
          </button>
          <div v-if="group.items.length" role="group" :aria-label="group.label" class="service-choice-group">
            <span class="service-choice-group-label">{{ group.label }}</span>
            <div class="service-choice-grid" :class="{common: group.id === 'common'}">
            <button v-for="option in group.items" :key="option.value" type="button" role="option" class="service-choice"
              :data-service-choice="option.value" :aria-selected="selected(editing.feature) === option.value"
              :disabled="option.disabled" :onClick="option.choose">
              <ServiceIcon :service="option.value" :label="option.label" size="small" />
              <span class="service-choice-copy"><strong>{{ option.label }}</strong><small v-if="option.disabled">{{ translateLegacy(getTranslationServiceUnavailableMessage(option.value) || '') }}</small><small v-else-if="option.matchingModels.length">{{ option.matchingModels.join(' · ') }}</small></span>
              <span v-if="selected(editing.feature) === option.value" class="service-choice-check" aria-hidden="true">✓</span>
            </button>
            </div>
          </div>
        </template>
        <p v-if="!filteredChoices.length" class="service-picker-empty" role="status">{{ t('popup.noServiceFound') }}</p>
      </div>
      <p v-if="editingWarning" class="service-picker-warning" role="status">{{ editingWarning }}</p>
    </section>
  </div>
</template>
<script setup lang="ts">
import {computed, nextTick, ref, shallowRef, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {featureServiceDefinitions, getFeatureService, setFeatureService, getFeatureModel, type FeatureServiceDefinition} from '@/src/core/config/featureServices';
import {models, customModelString, servicesType} from '@/src/core/config/catalog';
import {isHarnessService} from '@/src/core/config/harness';
import {getCustomOpenAIProvider, isCustomOpenAIProviderId} from '@/src/core/config/customOpenAI';
import {getMissingCredentialMessage} from '@/src/core/config/validation';
import {getTranslationServiceUnavailableMessage, isTranslationServiceAvailable} from '@/src/services/translation/capabilities';
import {searchServiceOptions, type ServiceOption} from '@/src/ui/view-model/serviceCatalog';
import {useSettingsActionContext} from '@/src/features/settings/model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue';
type Field = {id: string; feature?: FeatureServiceDefinition};
type PickerSession = {field: Field; config: Config; selected: string; service: string; current: () => boolean};
const emit = defineEmits<{close: []}>();
const props = withDefaults(defineProps<{config: Config; serviceOptions: readonly ServiceOption[]; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const {active, capture, revision} = useSettingsActionContext(() => props.active, () => [props.config]);
const query = ref(''), moreOpen = ref(false), viewRevision = ref(0);
const session = shallowRef<PickerSession | null>(null);
const editing = computed(() => session.value?.field || null);
const searchInput = shallowRef<HTMLInputElement | null>(null);
const results = shallowRef<HTMLElement | null>(null), panel = shallowRef<HTMLElement | null>(null);
const fields: Field[] = [{id: 'default'}, ...featureServiceDefinitions.map(feature => ({id: feature.id, feature}))];
const popularServices = new Set(['freeTranslation', 'microsoft', 'google', 'deepL', 'openai', 'deepseek', 'tongyi', 'gemini']);
const labels = computed(() => {
  const result = new Map<string, string>();
  for (const option of props.serviceOptions) if (!result.has(option.value)) result.set(option.value, option.label);
  return result;
});
const label = (service: string) => labels.value.get(service) || service;
const selected = (feature?: FeatureServiceDefinition) => feature ? getFeatureService(props.config, feature) : props.config.service;
const effective = (feature?: FeatureServiceDefinition) => selected(feature) || props.config.service;
function selectionMatches(config: Config, field: Field, value: string, service: string) {
  const current = field.feature ? getFeatureService(config, field.feature) : config.service;
  return current === value && (current || config.service) === service;
}
function warning(feature?: FeatureServiceDefinition) {
  const config = props.config, service = effective(feature);
  if (feature?.aiOnly && !isHarnessService(service, config.customOpenAIProviders)) return `${t(`featureServices.${feature.id}`)} · ${t('featureServices.aiOnly')}`;
  const model = feature ? getFeatureModel(config, feature) : config.model[service];
  const message = getTranslationServiceUnavailableMessage(service) || getMissingCredentialMessage(service, config, model);
  return message ? translateLegacy(message) : '';
}
const rows = computed(() => {
  const token = viewRevision.value, current = capture(), config = props.config;
  return fields.map(field => {
    const value = selected(field.feature), service = value || config.service;
    return {field, selected: value, service, model: field.feature ? getFeatureModel(config, field.feature) : config.model[service],
      selectedLabel: field.feature?.inherit && !value ? t('featureServices.follow', {service: label(config.service)}) : label(service),
      warning: warning(field.feature), open: () => {
        if (current() && token === viewRevision.value && !session.value && selectionMatches(config, field, value, service)) openPicker(field);
      }};
  });
});
const editingWarning = computed(() => editing.value ? warning(editing.value.feature) : '');
const searchableModels = computed(() => {
  const merged = new Map<string, readonly string[]>(models);
  Object.entries(props.config.customModels).forEach(([service, saved]) => merged.set(service, [...new Set([...(merged.get(service) || []).filter(model => model !== customModelString), ...saved])]));
  props.config.customOpenAIProviders.forEach(provider => merged.set(provider.id, provider.models));
  return merged;
});
const filteredChoices = computed(() => {
  const feature = editing.value?.feature;
  const available = props.serviceOptions.filter(option => !option.disabled && isTranslationServiceAvailable(option.value)
    && (!isCustomOpenAIProviderId(option.value) || Boolean(getCustomOpenAIProvider(props.config.customOpenAIProviders, option.value)))
    && (!feature?.aiOnly || isHarnessService(option.value, props.config.customOpenAIProviders)));
  const matches = searchServiceOptions(available, query.value, searchableModels.value, props.config.model, props.config.customModel);
  const current = selected(feature);
  return current && !query.value.trim() && !available.some(option => option.value === current)
    ? [{value: current, label: label(current), disabled: true, matchingModels: []}, ...matches] : matches;
});
const moreChoices = computed(() => filteredChoices.value.filter(option => !popularServices.has(option.value)));
const choiceGroups = computed(() => {
  const owned = ownView(), keyword = query.value, expanded = moreOpen.value;
  const bind = (items: typeof filteredChoices.value) => items.map(option => ({...option, choose: () => {
    if (owned() && query.value === keyword && moreOpen.value === expanded) choose(session.value!, option.value);
  }}));
  return query.value.trim() ? [{id: 'search', label: t('popup.providers.title'), items: bind(filteredChoices.value)}] : [
    {id: 'common', label: t('popup.commonServices'), items: bind(filteredChoices.value.filter(option => popularServices.has(option.value)))},
    {id: 'more', label: t('popup.moreServices'), items: moreOpen.value ? bind(moreChoices.value) : []},
  ];
});
function resetPicker() {session.value = null;query.value = '';moreOpen.value = false;viewRevision.value += 1;}
watch(() => [revision.value, session.value && selected(session.value.field.feature), session.value && effective(session.value.field.feature)], () => {
  if (!active.value || (session.value && !ownsSession(session.value))) resetPicker();
}, {flush: 'sync'});
function ownsSession(value: PickerSession) {
  return session.value === value && value.current() && selectionMatches(value.config, value.field, value.selected, value.service);
}
function ownView() {
  const value = session.value, token = viewRevision.value, current = capture();
  return () => current() && token === viewRevision.value && (value ? ownsSession(value) : !session.value);
}
function focusAfterRender(current: () => boolean, before: Element | null, target: () => HTMLElement | null) {
  const root = panel.value, startedHere = before === document.body || Boolean(before && root?.contains(before));
  void nextTick(() => {
    if (!current() || !root?.isConnected || !startedHere) return;
    if (document.activeElement !== before && document.activeElement !== document.body) return;
    target()?.focus({preventScroll: true});
  });
}
function openPicker(field: Field) {
  if (!active.value || !fields.includes(field)) return;
  const before = document.activeElement, config = props.config;
  resetPicker();session.value = {field, config, selected: selected(field.feature), service: effective(field.feature), current: capture()};
  moreOpen.value = Boolean(session.value.selected && !popularServices.has(session.value.selected));
  const current = ownView();
  focusAfterRender(current, before, () => searchInput.value);
  void nextTick(() => {
    if (!current()) return;
    const list = results.value, option = list?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (list?.isConnected && option) list.scrollTop = Math.max(0, option.offsetTop - (list.clientHeight - option.offsetHeight) / 2);
  });
}
function backToOverview(value: PickerSession) {
  if (!ownsSession(value)) return;
  const before = document.activeElement, id = value.field.id;
  resetPicker();focusAfterRender(ownView(), before, () => panel.value?.querySelector<HTMLButtonElement>(`[data-feature-service="${id}"]`) || null);
}
function choose(value: PickerSession, service: string) {
  if (!ownsSession(value)) return;
  const feature = value.field.feature, config = value.config;
  if (service && !filteredChoices.value.some(option => option.value === service && !option.disabled)) return;
  if (!service && !feature?.inherit) return;
  // 写入会同步失效会话，所以先安排所属面板的返回，再修改捕获的配置。
  backToOverview(value);
  if (feature) setFeatureService(config, feature, service);else config.service = service;
}
function navigateOptions(event: KeyboardEvent) {
  const buttons = [...(results.value?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
const panelActions = computed(() => {
  const owned = ownView(), value = session.value, keyword = query.value, expanded = moreOpen.value;
  const ownsControls = () => owned() && query.value === keyword && moreOpen.value === expanded;
  return {
    close: () => {if (owned()) {resetPicker();emit('close');}},
    back: () => {if (owned() && value) backToOverview(value);},
    inherit: () => {if (ownsControls() && value) choose(value, '');},
    search: (event: Event) => {if (ownsControls() && event.target === searchInput.value) query.value = searchInput.value?.value || '';},
    clear: () => {if (ownsControls()) {query.value = '';searchInput.value?.focus({preventScroll: true});}},
    more: () => {if (ownsControls()) moreOpen.value = !expanded;},
    searchKeydown: (event: KeyboardEvent) => {
      if (ownsControls() && event.key === 'ArrowDown') {event.preventDefault();results.value?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus();}
    },
    navigate: (event: KeyboardEvent) => {if (ownsControls()) navigateOptions(event);},
    keydown: (event: KeyboardEvent) => {if (owned() && value && event.key === 'Escape') {event.stopPropagation();backToOverview(value);}},
  };
});
</script>
<style scoped>
.popup-service-toolbar { position: sticky; top: 0; z-index: 1; display: flex; justify-content: flex-end; margin-bottom: 8px; background: var(--surface); }
.service-panel-close { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; color: var(--muted); background: var(--surface-soft); font-size: 22px; cursor: pointer; }
.service-panel-close:hover { color: var(--ink); background: var(--brand-soft); }
.popup-service-overview { display: grid; grid-template-columns: minmax(0, 1fr); }
.service-assignment { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr) 8px; align-items: center; gap: 8px; min-width: 0; min-height: 38px; padding: 6px 8px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.service-assignment:last-child { border-bottom: 0; }
.service-assignment:hover { border-radius: 8px; background: var(--surface-soft); }
.default-assignment { min-height: 50px; margin-bottom: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.default-assignment:hover { border-color: var(--brand); background: var(--brand-soft); }
.assignment-heading { min-width: 0; font-size: 11px; line-height: 1.4; }
.assignment-heading strong { font-weight: 600; }
.default-assignment .assignment-heading strong { font-weight: 650; }
.assignment-details { display: grid; grid-template-columns: auto minmax(0, auto); align-items: center; justify-content: end; justify-items: end; gap: 2px 5px; min-width: 0; }
.assignment-value { grid-column: 2; min-height: 26px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); display: flex; align-items: center; justify-content: flex-end; gap: 6px; max-width: 100%; min-width: 0; font-size: 10px; line-height: 1.4; }
.assignment-value > span { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.assignment-inherited { border-color: transparent; color: var(--muted); background: var(--surface-soft); }
.assignment-details > small { grid-column: 2; max-width: 100%; overflow: hidden; color: var(--muted); font-size: 9px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.assignment-warning { grid-column: 1; grid-row: 1; display: grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: var(--brand-soft); color: var(--brand-strong); font-size: 10px; font-weight: 600; }
.assignment-chevron { color: var(--muted); font-size: 16px; line-height: 1; }
.service-picker-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.service-picker-heading > strong { min-width: 0; flex: 1; font-size: 12px; }
.service-picker-heading > small { max-width: 100px; color: var(--muted); font-size: 9px; }
.service-picker-back { flex: none; width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--ink); cursor: pointer; }
.service-picker-search { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-soft); }
.service-picker-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
.service-picker-search > svg { width: 14px; height: 14px; flex: none; color: var(--muted); }
.service-picker-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 10px; }
.service-picker-search input::-webkit-search-cancel-button { display: none; }
.service-picker-search button { flex: none; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.service-picker-list { position: relative; max-height: clamp(140px, calc(88dvh - 176px), 340px); margin-top: 10px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.service-choice-grid.common { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.service-choice-grid.common .service-choice { min-width: 0; padding: 6px 4px; gap: 6px; }
.service-choice-grid.common .service-choice-copy strong { font-size: 10px; overflow-wrap: anywhere; }
.service-choice-group-label { display: block; padding: 8px 4px 5px; color: var(--muted); font-size: 10px; }
.service-choice { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 38px; padding: 6px 8px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--ink); text-align: left; cursor: pointer; }
.service-choice:hover:not(:disabled) { background: var(--surface-soft); }
.service-choice[aria-selected="true"] { border-color: color-mix(in srgb, var(--brand) 24%, transparent); background: var(--brand-soft); color: var(--brand-strong); }
.service-choice:disabled { opacity: .6; cursor: not-allowed; }
.service-choice-copy { display: grid; gap: 2px; min-width: 0; flex: 1; }
.service-choice-copy strong { font-size: 11px; font-weight: 550; }
.service-choice-copy small { color: var(--muted); font-size: 9px; line-height: 1.5; overflow-wrap: anywhere; }
.service-choice-check { font-size: 14px; color: var(--brand-strong); }
.follow-choice { margin-bottom: 3px; border-color: var(--line); }
.service-picker-more { display: flex; justify-content: space-between; align-items: center; width: 100%; min-height: 34px; margin-top: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface-soft); font-size: 11px; cursor: pointer; }
.service-picker-more small { margin-left: 4px; color: var(--muted); font-size: 9px; }
.service-picker-empty { padding: 15px 4px; color: var(--muted); font-size: 11px; text-align: center; }
.service-picker-warning { margin: 10px 0 0; color: var(--muted); font-size: 10px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
