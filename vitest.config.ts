import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

const configuredMaxWorkers = Number(process.env.FLUENTREAD_TEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(configuredMaxWorkers) && configuredMaxWorkers > 0 ? configuredMaxWorkers : 2;

// 独立的 Vitest 配置（与 wxt 构建配置互不影响）
export default defineConfig({
    // 组件生命周期测试执行实际客户端 SFC 模板，让 V8 归因到原始 Vue 源码。
    plugins: [vue({include: /\/src\/(?:features\/share-card\/ui\/ShareCardStudio|features\/selection-translation\/ui\/SelectionTranslator|features\/settings\/ui\/services\/RequestLimit(?:Settings|Fields)|features\/reading-assistant\/ui\/[^/]+|ui\/components\/(?:MarkdownContent|MarkdownTable|[^/]*Reading[^/]*)|features\/image-translation\/ui\/MangaEntry|app\/document-translation\/(?:DocumentApp|DocumentSegmentEditor)|ui\/components\/(?:CustomHotkeyInput|UiSelect|GlossaryLibrarySelect|ServiceIcon|TranslationLoadingPreview|UiIcon|InterfaceBackdrop|FeatureEnableCard)|features\/settings\/ui\/components\/(?:FieldHelp|InterfaceSkinPreview|PopupLayoutPreview|PopupLayoutPreviewItem|SettingsGroup|SettingsItem|TranslationColorField|TranslationStylePreview|WritingStylePreview|SegmentedControl))\.vue$/})],
    resolve: {
        alias: {
            // 与 wxt 一致：'@' 指向项目根目录
            '@': resolve(__dirname, '.'),
        },
    },
    test: {
        environment: 'node',
        testTransformMode: {web: ['**/tests/implementationAudit48J.test.ts', '**/tests/implementationAudit48I.test.ts', '**/tests/implementationAudit48C.test.ts', '**/tests/implementationAudit48E.test.ts', '**/tests/mangaEntryComponentLifecycle.test.ts', '**/tests/customHotkeyInputLifecycle.test.ts', '**/tests/sharedUiComponentsLifecycle.test.ts', '**/tests/documentAppLifecycle.test.ts', '**/tests/documentUserActions.test.ts']},
        include: ['tests/**/*.test.ts'],
        globalSetup: ['./scripts/testing/vitest-resource-lock.mjs'],
        maxWorkers,
        minWorkers: 1,
        fileParallelism: false,
        // 词书扫描器按真实规则内容确认共享样式，不能用默认空 CSS 代替。
        css: {include: [/vocabulary-reencounter\.css/]},
    },
});
