/**
 * FluentRead 的 Obsidian 桌面插件入口：显式触发翻译，并在库内创建相邻双语笔记。
 */
import {MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl} from 'obsidian';
import {translationLanguageOptions} from '../../src/core/language/catalog';
import {DOCUMENT_MAX_BYTES, parseDocument, renderDocument} from '../../src/features/document-translation/core/document';
import {prepareMarkdownSegments} from './markdown';
import {renderBilingualPdfNote} from './output';
import {disposePdfWorker, extractPdfSegments} from './pdf';
import {createObsidianTranslator} from './translation';
import {createBilingualNote} from './vault';

interface FluentReadObsidianSettings {
    sourceLanguage: string;
    targetLanguage: string;
}

const LANGUAGE_OPTIONS: Record<string, string> = Object.fromEntries(
    translationLanguageOptions.map(({value, label}) => [value, label]),
);

const DEFAULT_SETTINGS: FluentReadObsidianSettings = {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};

function canTranslate(file: TFile | null): file is TFile {
    return !!file && ['md', 'markdown', 'pdf'].includes(file.extension.toLowerCase());
}

class FluentReadSettingsTab extends PluginSettingTab {
    private readonly isCurrent: () => boolean;

    constructor(private readonly plugin: FluentReadObsidianPlugin) {
        super(plugin.app, plugin);
        this.isCurrent = plugin.captureSettingsSession();
    }

    display(): void {
        if (!this.isCurrent()) return;
        const {containerEl} = this;
        containerEl.empty();
        new Setting(containerEl).setName('FluentRead document translation').setHeading();
        containerEl.createEl('p', {
            text: 'Choose the languages for translated notes. Source text is sent to Microsoft Translator when you run a command; the original vault file is never changed.',
        });
        new Setting(containerEl).setName('Source language').addDropdown((dropdown) => {
            dropdown.addOption('auto', 'Auto detect');
            Object.entries(LANGUAGE_OPTIONS).forEach(([code, label]) => dropdown.addOption(code, label));
            dropdown.setValue(this.plugin.settings.sourceLanguage);
            dropdown.onChange((value) => {
                if (!this.isCurrent()) return;
                this.plugin.settings.sourceLanguage = value;
                void this.plugin.saveSettings().catch(() => undefined);
            });
        });
        new Setting(containerEl).setName('Target language').addDropdown((dropdown) => {
            Object.entries(LANGUAGE_OPTIONS).forEach(([code, label]) => dropdown.addOption(code, label));
            dropdown.setValue(this.plugin.settings.targetLanguage);
            dropdown.onChange((value) => {
                if (!this.isCurrent()) return;
                this.plugin.settings.targetLanguage = value;
                void this.plugin.saveSettings().catch(() => undefined);
            });
        });
    }
}

export default class FluentReadObsidianPlugin extends Plugin {
    settings: FluentReadObsidianSettings = {...DEFAULT_SETTINGS};
    private readonly translator = createObsidianTranslator(requestUrl);
    // TFile 身份在 rename/move 后保持稳定，路径则会被 Obsidian 原地修改。
    private readonly jobs = new Map<TFile, {controller: AbortController; notice: Notice}>();
    private unloaded = true;
    private lifetime = 0;
    private settingsWrites: Promise<void> = Promise.resolve();

    async onload(): Promise<void> {
        const lifetime = ++this.lifetime;
        this.unloaded = true;
        const stored = await this.loadData() as Partial<FluentReadObsidianSettings> | null;
        if (lifetime !== this.lifetime) return;
        const source = stored?.sourceLanguage;
        const target = stored?.targetLanguage;
        this.settings = {
            sourceLanguage: typeof source === 'string' && (source === 'auto' || Object.hasOwn(LANGUAGE_OPTIONS, source))
                ? source : DEFAULT_SETTINGS.sourceLanguage,
            targetLanguage: typeof target === 'string' && Object.hasOwn(LANGUAGE_OPTIONS, target)
                ? target : DEFAULT_SETTINGS.targetLanguage,
        };
        this.unloaded = false;
        this.addSettingTab(new FluentReadSettingsTab(this));
        this.addCommand({
            id: 'translate-active-document',
            name: 'Translate current Markdown note or PDF',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (this.unloaded || !canTranslate(file)) return false;
                if (!checking) void this.translateFile(file);
                return true;
            },
        });
        this.addCommand({
            id: 'cancel-document-translation',
            name: 'Cancel document translation',
            checkCallback: (checking) => {
                if (this.jobs.size === 0) return false;
                if (!checking) this.jobs.forEach(({controller}) => controller.abort());
                return true;
            },
        });
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (this.unloaded || !(file instanceof TFile) || !canTranslate(file)) return;
            menu.addItem((item) => item
                .setTitle('Translate with FluentRead')
                .setIcon('languages')
                .onClick(() => { void this.translateFile(file); }));
        }));
    }

    onunload(): void {
        this.unloaded = true;
        this.lifetime += 1;
        this.jobs.forEach(({controller, notice}) => {
            controller.abort();
            notice.hide();
        });
        this.jobs.clear();
        disposePdfWorker();
    }

    /** 设置 UI 与排队写入均绑定创建时的会话，不能因同实例重新加载而复活。 */
    captureSettingsSession(): () => boolean {
        const lifetime = this.lifetime;
        return () => !this.unloaded && lifetime === this.lifetime;
    }

    async saveSettings(): Promise<void> {
        if (this.unloaded) return;
        const isCurrent = this.captureSettingsSession();
        const snapshot = {...this.settings};
        const saving = this.settingsWrites.catch(() => undefined).then(() => {
            if (isCurrent()) return this.saveData(snapshot);
        });
        this.settingsWrites = saving;
        try {
            await saving;
        } catch (error) {
            if (isCurrent()) new Notice(`FluentRead: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    private async translateFile(file: TFile): Promise<void> {
        if (this.unloaded || !canTranslate(file)) return;
        if (this.jobs.has(file)) {
            new Notice('FluentRead is already translating this file.');
            return;
        }
        if (file.stat.size > DOCUMENT_MAX_BYTES) {
            new Notice('This file exceeds FluentRead’s 10 MB document limit.');
            return;
        }
        const sourceSnapshot = {mtime: file.stat.mtime, size: file.stat.size};
        const settings = {...this.settings};
        const fileName = file.name;
        const controller = new AbortController();
        const notice = new Notice(`FluentRead: reading ${file.name}…`, 0);
        const job = {controller, notice};
        this.jobs.set(file, job);
        const isCurrent = () => !this.unloaded && !controller.signal.aborted && this.jobs.get(file) === job;
        try {
            const isPdf = file.extension.toLowerCase() === 'pdf';
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            const beganInView = activeView?.file === file;
            const source = isPdf ? '' : beganInView
                ? activeView.getViewData() : await this.app.vault.read(file);
            if (!isCurrent()) return;
            if (!isPdf && (source.length > DOCUMENT_MAX_BYTES || new TextEncoder().encode(source).byteLength > DOCUMENT_MAX_BYTES)) {
                throw new Error('This note exceeds FluentRead’s 10 MB document limit.');
            }
            const document = isPdf ? null : parseDocument(fileName, source);
            let segments;
            if (isPdf) {
                const bytes = await this.app.vault.readBinary(file);
                if (!isCurrent()) return;
                if (bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error('This PDF exceeds FluentRead’s 10 MB document limit.');
                segments = await extractPdfSegments(bytes, controller.signal);
            } else segments = document!.segments;
            if (!isCurrent()) return;
            if (segments.length === 0) throw new Error('No translatable text was found in this file.');
            const translations = await this.translator(isPdf ? segments : prepareMarkdownSegments(segments), {
                fileName,
                sourceLanguage: settings.sourceLanguage,
                targetLanguage: settings.targetLanguage,
                signal: controller.signal,
                onProgress: ({completed, total}) => {
                    if (isCurrent()) notice.setMessage(`FluentRead: ${file.name} · ${completed}/${total}`);
                },
            });
            if (!isCurrent()) return;
            if (!isPdf) {
                const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const sourceView = activeView?.file === file ? activeView : currentView?.file === file ? currentView : null;
                const currentSource = sourceView ? sourceView.getViewData()
                    : beganInView ? await this.app.vault.read(file) : source;
                if (!isCurrent()) return;
                if (currentSource !== source) throw new Error('The source note changed during translation. Please try again.');
            }
            const content = isPdf
                ? renderBilingualPdfNote(file.path, segments, translations)
                : renderDocument(document!, translations, 'bilingual');
            const output = await createBilingualNote(this.app.vault, file, sourceSnapshot, content, controller.signal);
            if (isCurrent()) {
                await this.app.workspace.getLeaf('split').openFile(output);
                if (isCurrent()) new Notice(`FluentRead: created ${output.name}`);
            }
        } catch (error) {
            if (isCurrent()) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                new Notice(`FluentRead: ${message}`);
            }
        } finally {
            notice.hide();
            if (this.jobs.get(file) === job) this.jobs.delete(file);
        }
    }
}
