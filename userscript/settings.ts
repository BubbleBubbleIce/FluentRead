import SettingsPanel from './SettingsPanel.vue';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import type {ShadowRootContentScriptUi} from 'wxt/utils/content-script-ui/shadow-root';

let settingsUi: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let settingsMountPromise: Promise<void> | null = null;
let settingsGeneration = 0;

export async function openUserscriptSettings(ctx: unknown, _section?: string): Promise<void> {
    if (settingsUi) return;
    if (settingsMountPromise) return settingsMountPromise;
    const generation = settingsGeneration;
    const close = () => {
        if (generation === settingsGeneration) closeUserscriptSettings();
    };
    const mountPromise = createVueShadowUi(ctx as never, {
        name: 'fluent-read-userscript-settings-ui',
        hostId: 'fluent-read-userscript-settings-container',
        component: SettingsPanel,
        props: {onClose: close},
        zIndex: 2_147_483_647,
        mode: 'closed',
    }).then((ui) => {
        if (generation !== settingsGeneration) ui.remove();
        else settingsUi = ui;
    });
    settingsMountPromise = mountPromise;
    try {await mountPromise;}
    finally {if (settingsMountPromise === mountPromise) settingsMountPromise = null;}
}

export function closeUserscriptSettings(): void {
    settingsGeneration += 1;
    settingsMountPromise = null;
    const ui = settingsUi;
    settingsUi = null;
    ui?.remove();
}
