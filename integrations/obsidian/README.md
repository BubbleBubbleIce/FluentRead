# FluentRead for Obsidian

Translate a Markdown note or a text-based PDF from Obsidian's command palette or file context menu. FluentRead creates a bilingual Markdown note next to the original and opens it in a split pane. The source file is never overwritten.

## Build and install

From the FluentRead repository root, run `pnpm install --frozen-lockfile` and `pnpm build:obsidian`. Copy `integrations/obsidian/dist/main.js` and `integrations/obsidian/dist/manifest.json` into `<your vault>/.obsidian/plugins/fluentread-translation/`. Enable **FluentRead Translation** under Obsidian's Community plugins settings. Use a test vault first.

Choose source and target languages in the plugin settings. The default is automatic detection to Simplified Chinese. Open a `.md`, `.markdown`, or `.pdf` file and run **Translate current Markdown note or PDF**, or right-click the file and choose **Translate with FluentRead**. Use **Cancel document translation** to stop a running job. Another run creates a numbered sibling note; it does not replace an earlier translation.

Each job uses the languages selected when it starts. If the source note changes during translation, FluentRead asks you to try again. Fenced code inside quotes and lists stays unchanged.

## Scope and privacy

- Markdown syntax, YAML frontmatter, code fences, Obsidian wiki links and embeds remain in the generated note. The note content is translated by FluentRead's existing document segmenter.
- PDF text extraction runs locally. The output is a bilingual Markdown note grouped by page, with a link to the original PDF. It does not alter or recreate PDF page layout. Scanned PDFs without a text layer and files over 10 MB are unsupported.
- When you start a translation, text segments are sent to the Microsoft Translator endpoint used by FluentRead's browser extension. The plugin stores only language choices in Obsidian settings and does not use telemetry. Generated notes remain in your vault.
- This integration currently targets Obsidian Desktop. It is not yet listed in the Obsidian Community plugin directory.

The plugin is GPL-3.0 like FluentRead. Its bundled PDF.js component is Apache-2.0; the generated `main.js` includes the PDF.js license text.

## 中文说明

在 Obsidian 中打开 Markdown 笔记或带文字层的 PDF，执行命令面板中的 **Translate current Markdown note or PDF**，或在文件右键菜单选择 **Translate with FluentRead**。插件会在原文件旁创建双语 Markdown 笔记并分栏打开，不覆盖原文件；再次翻译会生成带编号的新笔记。语言可在插件设置中调整，默认自动识别源语言、翻译为简体中文。

每次任务使用开始时的语言设置，可通过 **Cancel document translation** 取消。翻译期间修改原笔记会提示重试；引用和列表中的围栏代码保持原文。

在 FluentRead 仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build:obsidian`，将 `integrations/obsidian/dist/` 中的 `main.js`、`manifest.json` 复制到笔记库的 `.obsidian/plugins/fluentread-translation/`，再启用社区插件。建议先在测试库安装。

PDF 在本地提取文字，双语结果按页写入 Markdown，原 PDF 版式不会改写；扫描版 PDF 和超过 10 MB 的文件暂不支持。点击翻译时，待译文字会发送到 FluentRead 浏览器扩展使用的微软翻译端点；插件只保存语言设置，不收集遥测。目前仅支持 Obsidian 桌面版，尚未上架社区插件目录。
