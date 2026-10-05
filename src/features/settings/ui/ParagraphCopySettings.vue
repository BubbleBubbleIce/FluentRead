<!--
 * @file src/features/settings/ui/ParagraphCopySettings.vue
 * 文件职责：在翻译交互设置中提供"复制鼠标所指段落"的开关、触发快捷键与复制内容口径，让用户不必先选中文字也能取走一整段。
 * 主要内容：绑定 paragraphCopyEnabled、paragraphCopyHotkey、customParagraphCopyHotkey 与 paragraphCopyContent，提供预设与自定义录制入口，并对悬浮、全文、划词、圈选、局部翻译、输入框翻译和快捷翻译方案的占用给出冲突提示。
 * 模块边界：本组件只修改传入的 config 对象并提示冲突，不持久化配置、不监听网页按键、不访问剪贴板；快捷键归一化归 core/config/paragraphCopy，复制行为归 features/paragraph-copy。
 -->
<template>
  <SettingsGroup :title="t('paragraphCopy.settings.title')" :description="t('paragraphCopy.settings.description')">
    <SettingsItem :label="t('paragraphCopy.settings.enabled')" :description="t('paragraphCopy.settings.enabledDescription', {shortcut: hotkeyDisplayName})">
      <el-switch v-model="props.config.paragraphCopyEnabled" class="settings-toggle" :aria-label="t('paragraphCopy.settings.enabled')" />
    </SettingsItem>
    <SettingsItem :label="t('paragraphCopy.settings.hotkey')" :description="t('paragraphCopy.settings.hotkeyDescription')" :disabled="!props.config.paragraphCopyEnabled">
      <div class="hotkey-config">
        <el-select :model-value="props.config.paragraphCopyHotkey" data-testid="paragraph-copy-hotkey" :aria-label="t('paragraphCopy.settings.hotkey')" :disabled="!props.config.paragraphCopyEnabled" @change="handleHotkeyChange">
          <el-option v-for="item in PARAGRAPH_COPY_HOTKEY_OPTIONS" :key="item.value" :value="item.value" :label="item.label" data-i18n-ignore />
          <el-option value="custom" :label="t('paragraphCopy.settings.hotkeyCustom')" />
        </el-select>
        <div v-if="props.config.paragraphCopyHotkey === 'custom'" class="paragraph-copy-hotkey-custom">
          <span v-if="props.config.customParagraphCopyHotkey" class="paragraph-copy-hotkey-text" data-i18n-ignore>{{ hotkeyDisplayName }}</span>
          <span v-else class="paragraph-copy-hotkey-text paragraph-copy-hotkey-placeholder">{{ t('paragraphCopy.settings.hotkeyCustomEmpty') }}</span>
          <el-button size="small" type="text" :aria-label="t('paragraphCopy.settings.hotkeyEdit')" :title="t('paragraphCopy.settings.hotkeyEdit')" @click="openCustomHotkeyDialog">
            <el-icon><Edit /></el-icon>
          </el-button>
        </div>
      </div>
    </SettingsItem>
    <SettingsItem :label="t('paragraphCopy.settings.content')" :description="t(`paragraphCopy.settings.content.${props.config.paragraphCopyContent}Description`)" :disabled="!props.config.paragraphCopyEnabled">
      <el-select v-model="props.config.paragraphCopyContent" data-testid="paragraph-copy-content" :aria-label="t('paragraphCopy.settings.content')" :disabled="!props.config.paragraphCopyEnabled">
        <el-option v-for="mode in PARAGRAPH_COPY_CONTENT_MODES" :key="mode" :value="mode" :label="t(`paragraphCopy.settings.content.${mode}`)" />
      </el-select>
    </SettingsItem>
  </SettingsGroup>
  <CustomHotkeyInput
    v-model="showCustomHotkeyDialog"
    :current-value="props.config.customParagraphCopyHotkey"
    :validate="findHotkeyConflict"
    @confirm="handleCustomHotkeyConfirm"
    @cancel="handleCustomHotkeyCancel"
  />
</template>

<script setup lang="ts">
import {computed, defineAsyncComponent, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import {Edit} from '@element-plus/icons-vue';
import {ElMessage} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    PARAGRAPH_COPY_CONTENT_MODES,
    PARAGRAPH_COPY_HOTKEY_OPTIONS,
    paragraphCopyHotkeyDisplayName,
} from '@/src/core/config/paragraphCopy';
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation';
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation';
import {canonicalizeHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {
    findEnabledQuickTranslationHotkeyConflict,
    quickTranslationActionKey,
    inputBoxTranslationTriggerHotkey,
} from '@/src/core/config/quickTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'));

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t, translateLegacy} = useUiI18n();
const showCustomHotkeyDialog = ref(false);
let viewActive = true;
let draft: {config: Config; hotkey: string; customHotkey: string} | null = null;
const hotkeyDisplayName = computed(() => paragraphCopyHotkeyDisplayName(
    props.config.paragraphCopyHotkey,
    props.config.customParagraphCopyHotkey,
));

function isCurrentDraft(): boolean {
    return viewActive && props.active && draft !== null && draft.config === props.config && props.config.paragraphCopyEnabled
        && draft.hotkey === props.config.paragraphCopyHotkey && draft.customHotkey === props.config.customParagraphCopyHotkey;
}

function closeCustomHotkeyDialog(): void {
    showCustomHotkeyDialog.value = false;
    draft = null;
}

function openCustomHotkeyDialog(): void {
    if (!viewActive || !props.active || !props.config.paragraphCopyEnabled || isCurrentDraft()) return;
    draft = {config: props.config, hotkey: props.config.paragraphCopyHotkey, customHotkey: props.config.customParagraphCopyHotkey};
    showCustomHotkeyDialog.value = true;
}

watch(() => [props.active, props.config, props.config.paragraphCopyEnabled, props.config.paragraphCopyHotkey, props.config.customParagraphCopyHotkey], () => {
    if (draft && !isCurrentDraft()) closeCustomHotkeyDialog();
});
onActivated(() => {viewActive = true;});
onDeactivated(() => {viewActive = false;closeCustomHotkeyDialog();});
onBeforeUnmount(() => {viewActive = false;closeCustomHotkeyDialog();});

/** 列出已被其他功能占用的快捷键，避免一次按键同时触发复制和翻译。 */
function reservedHotkeyOwners(): {hotkey: string; feature: string}[] {
    return [
        {hotkey: resolveConfiguredHotkey(props.config.hotkey, props.config.customHotkey), feature: t('popup.hoverTranslation')},
        {hotkey: resolveConfiguredHotkey(props.config.floatingBallHotkey, props.config.customFloatingBallHotkey), feature: t('quickTranslation.commonFullPageShortcut')},
        {
            // 划词已停用时它的旧快捷键不再接管按键，不应阻止段落复制使用同一个组合键。
            hotkey: props.config.selectionTranslatorMode === 'disabled'
                ? ''
                : resolveConfiguredHotkey(props.config.selectionTranslatorTrigger, props.config.customSelectionTranslatorHotkey),
            feature: t('popup.selectionTranslation'),
        },
        {
            hotkey: props.config.selectionAreaEnabled
                ? resolveAreaTranslationHotkey(props.config.selectionAreaHotkey, props.config.customSelectionAreaHotkey)
                : '',
            feature: t('popup.areaTranslation'),
        },
        {
            hotkey: props.config.sectionTranslationHotkeyEnabled
                ? resolveSectionTranslationHotkey(props.config.sectionTranslationHotkey, props.config.customSectionTranslationHotkey)
                : '',
            feature: t('sectionTranslation.settings.title'),
        },
        {hotkey: inputBoxTranslationTriggerHotkey(props.config.inputBoxTranslationTrigger), feature: translateLegacy('输入框翻译')},
    ];
}

/** 供自定义录制对话框实时校验；返回空字符串表示可以使用。 */
function findHotkeyConflict(hotkey: string): string {
    // 清除录制将回到默认组合键，也要检查默认入口是否已被其他功能占用。
    const resolved = canonicalizeHotkey(hotkey) || DEFAULT_PARAGRAPH_COPY_HOTKEY;
    const identity = resolved.toLocaleLowerCase();
    const owner = reservedHotkeyOwners().find(item => canonicalizeHotkey(item.hotkey).toLocaleLowerCase() === identity);
    if (owner) return t('paragraphCopy.settings.hotkeyConflict', {feature: owner.feature});
    const profile = findEnabledQuickTranslationHotkeyConflict(props.config.quickTranslationProfiles, resolved);
    if (!profile) return '';
    return t('quickTranslation.conflictProfile', {
        group: t(`quickTranslation.heading.${quickTranslationActionKey(profile.action)}`),
    });
}

function handleHotkeyChange(value: string): void {
    if (!viewActive || !props.active || !props.config.paragraphCopyEnabled) return;
    if (value !== 'custom') {
        const conflict = findHotkeyConflict(value);
        if (conflict) {
            ElMessage.warning(conflict);
            return;
        }
        closeCustomHotkeyDialog();
        props.config.paragraphCopyHotkey = value;
        return;
    }
    // 未录制时保留已保存的入口，直到确认才提交；取消或外部改动无需回写旧配置。
    if (!props.config.customParagraphCopyHotkey) {
        openCustomHotkeyDialog();
        return;
    }
    closeCustomHotkeyDialog();
    props.config.paragraphCopyHotkey = 'custom';
}

function handleCustomHotkeyConfirm(hotkey: string): void {
    if (!isCurrentDraft()) {
        closeCustomHotkeyDialog();
        return;
    }
    const canonical = canonicalizeHotkey(hotkey);
    if (findHotkeyConflict(canonical)) return;
    // 清除自定义组合键等于放弃自定义入口；段落复制没有别的触发方式，因此回到默认预设而不是停用。
    props.config.customParagraphCopyHotkey = canonical;
    props.config.paragraphCopyHotkey = canonical ? 'custom' : DEFAULT_PARAGRAPH_COPY_HOTKEY;
    closeCustomHotkeyDialog();
    ElMessage({message: t('paragraphCopy.settings.hotkeySet', {shortcut: hotkeyDisplayName.value}), type: 'success', duration: 2000});
}

function handleCustomHotkeyCancel(): void {
    closeCustomHotkeyDialog();
}
</script>

<style scoped>
.hotkey-config { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.paragraph-copy-hotkey-custom { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px dashed var(--line, #e7e9f0); border-radius: 8px; }
.paragraph-copy-hotkey-text { font-size: 12px; color: var(--ink, #172033); }
.paragraph-copy-hotkey-placeholder { color: var(--muted, #737c8f); }
</style>
