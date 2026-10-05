import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

const configuredMaxWorkers = Number(process.env.FLUENTREAD_TEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(configuredMaxWorkers) && configuredMaxWorkers > 0 ? configuredMaxWorkers : 2;

// 独立的 Vitest 配置（与 wxt 构建配置互不影响）
export default defineConfig({
    // 漫画入口用真实 SFC 模板执行组件测试，同时让 V8 归因到原始 Vue 源码。
    plugins: [vue({include: /\/src\/(?:features\/image-translation\/ui\/MangaEntry|ui\/components\/CustomHotkeyInput)\.vue$/})],
    resolve: {
        alias: {
            // 与 wxt 一致：'@' 指向项目根目录
            '@': resolve(__dirname, '.'),
        },
    },
    test: {
        environment: 'node',
        testTransformMode: {web: ['**/tests/mangaEntryComponentLifecycle.test.ts', '**/tests/customHotkeyInputLifecycle.test.ts']},
        include: ['tests/**/*.test.ts'],
        globalSetup: ['./scripts/testing/vitest-resource-lock.mjs'],
        maxWorkers,
        minWorkers: 1,
        fileParallelism: false,
        // 词书扫描器按真实规则内容确认共享样式，不能用默认空 CSS 代替。
        css: {include: [/vocabulary-reencounter\.css/]},
    },
});
