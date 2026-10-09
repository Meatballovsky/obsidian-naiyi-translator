import { MarkdownRenderer, MarkdownView, Notice, Plugin } from "obsidian";

import { DEFAULT_SETTINGS, type TranslatorSettings, type EngineId } from "./settings";
import { TranslateQueue } from "./schedule/queue";
import { BatchQueue } from "./schedule/batch-queue";
import { TranslationCache, type CachedEntry } from "./schedule/cache";
import { Orchestrator } from "./orchestrator";
import { FloatingOrb } from "./ui/orb";
import { clearInjected, refreshInjectedTypography } from "./ui/inject";
import { listModels, maxItemsPerBatch, translateTexts } from "./engines";
import { TranslatorSettingTab } from "./settingsTab";
import { t } from "./i18n";

interface PersistedData {
  settings: TranslatorSettings;
  cache?: Record<string, CachedEntry>;
}

const CACHE_SAVE_DEBOUNCE_MS = 3000;

export default class TranslatorOrbPlugin extends Plugin {
  settings: TranslatorSettings = DEFAULT_SETTINGS;
  private cache = new TranslationCache({
    maxEntries: DEFAULT_SETTINGS.cacheMaxEntries,
    ttlDays: DEFAULT_SETTINGS.cacheTtlDays,
  });
  private queue!: TranslateQueue;
  private batch!: BatchQueue;
  private orchestrator!: Orchestrator;
  private orb: FloatingOrb | null = null;
  private attachedLeaf: MarkdownView | null = null;
  private attachedPath: string | null = null;
  private cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.queue = new TranslateQueue({
      capacity: this.settings.requestCapacity,
      rate: this.settings.requestRate,
      maxRetries: this.settings.maxRetries,
      baseRetryDelayMs: 1000,
      onTaskFailed: (error, task) => {
        // A drained backlog reports once with a null task; per-paragraph
        // notices for dozens of failures are unreadable.
        const detail = String(error).slice(0, 160);
        new Notice(
          task ? `Translation request failed: ${detail}` : `Translation stopped by the provider: ${detail}`,
          task ? 4000 : 8000
        );
      },
    });

    this.batch = new BatchQueue(this.queue, {
      maxItems: maxItemsPerBatch(this.settings),
      maxChars: this.settings.maxCharsPerBatch,
      delayMs: 100,
      saturatedHoldMs: 2000,
    });

    this.orchestrator = new Orchestrator(
      this.queue,
      this.batch,
      this.cache,
      () => this.settings,
      (el, markdown) => {
        const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
        return MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
      },
      {
        onRunningChange: () => this.orb?.syncRunningState(),
        onProgress: () => undefined,
        onCacheWrite: () => this.scheduleCacheSave(),
      }
    );

    this.cache.hydrate(this.loadedCache);

    this.addCommand({
      id: "toggle-page-translation",
      name: t("cmdToggle"),
      callback: () => this.toggleTranslation(),
    });

    this.addCommand({
      id: "clear-translation",
      name: t("cmdClear"),
      callback: () => this.clearTranslation(),
    });

    this.addCommand({
      id: "switch-engine",
      name: t("cmdCycle"),
      callback: () => void this.cycleEngine(),
    });

    this.addSettingTab(new TranslatorSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.syncAttachment());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncAttachment())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.syncAttachment())
    );
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncAttachment()));
    const refreshTypography = () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (!(leaf.view instanceof MarkdownView)) continue;
        const root = this.previewRoot(leaf.view);
        if (root) refreshInjectedTypography(root);
      }
    };
    this.registerEvent(this.app.workspace.on("css-change", refreshTypography));
    // Light/dark switching can update the body class without re-rendering notes.
    const themeObserver = new MutationObserver(refreshTypography);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    this.register(() => themeObserver.disconnect());

    // Toggling between Live Preview and reading view does not emit a workspace
    // event; Obsidian's setMode writes data-mode on the view container instead.
    const modeObserver = new MutationObserver(() => this.syncAttachment());
    modeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-mode"],
      subtree: true,
    });
    this.register(() => modeObserver.disconnect());

  }

  onunload(): void {
    this.orb?.destroy();
    this.orb = null;
    this.orchestrator?.clear();
    // Obsidian keeps the rendered panes alive, so injected nodes must not outlive
    // the plugin.
    this.clearEverywhere();
    if (this.cacheSaveTimer !== null) clearTimeout(this.cacheSaveTimer);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as PersistedData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.settings.ai = Object.assign({}, DEFAULT_SETTINGS.ai, data?.settings?.ai ?? {});
    this.loadedCache = data?.cache ?? {};
  }

  private loadedCache: Record<string, CachedEntry> = {};
  /** Filled on demand so the user picks a real model id instead of guessing. */
  availableModels: string[] = [];

  async saveSettings(): Promise<void> {
    this.orchestrator?.applySettings();
    this.orb?.applySettings(this.settings);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload: PersistedData = {
      settings: this.settings,
      cache: this.settings.enableCache ? this.cache.toJSON() : {},
    };
    await this.saveData(payload);
  }

  /** Cache writes are hot-path work; keep them off the translation critical path. */
  private scheduleCacheSave(): void {
    if (!this.settings.enableCache) return;
    if (this.cacheSaveTimer !== null) clearTimeout(this.cacheSaveTimer);
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      void this.persist();
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  private readingRoot(view: MarkdownView): HTMLElement | null {
    // Obsidian keeps the preview element in the DOM while in Live Preview, so the
    // mode has to be asked for rather than inferred from the DOM.
    if (view.getMode() !== "preview") return null;
    return this.previewRoot(view);
  }

  /** The reading-view element whether or not that pane is currently showing it. */
  private previewRoot(view: MarkdownView): HTMLElement | null {
    const reading = view.contentEl.querySelector<HTMLElement>(".markdown-reading-view");
    if (!reading) return null;
    // Scoped so an embedded note's own preview is never picked up.
    return reading.querySelector<HTMLElement>(":scope > .markdown-preview-view");
  }

  private activeReadingView(): MarkdownView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    return this.readingRoot(view) ? view : null;
  }

  /**
   * The orb is bound to the leaf's content element so it scrolls and repaints with
   * the pane it belongs to, and disappears the moment the user leaves reading view.
   */
  private syncAttachment(): void {
    const view = this.activeReadingView();

    const path = view?.file?.path ?? null;
    if (this.attachedLeaf && (this.attachedLeaf !== view || this.attachedPath !== path)) {
      this.orb?.destroy();
      this.orb = null;
      this.attachedLeaf = null;
      this.orchestrator.clear();
    }
    if (!view) return;

    this.attachedLeaf = view;
    this.attachedPath = path;
    if (!this.orb) {
      this.orb = new FloatingOrb(view.contentEl, this.settings, {
        onToggle: () => this.toggleTranslation(),
        onPositionChange: () => { void this.saveSettings(); },
        isRunning: () => this.orchestrator.isRunning(),
      });
    }
    this.orb.applySettings(this.settings);
  }

  private toggleTranslation(): void {
    const view = this.activeReadingView();
    if (!view) {
      new Notice("Open a note in reading view to translate it.", 3000);
      return;
    }
    const root = this.readingRoot(view);
    if (!root) return;

    if (this.orchestrator.isRunning()) {
      this.clearTranslation();
      return;
    }
    void this.orchestrator.start(root);
    this.orb?.syncRunningState();
  }

  private clearTranslation(): void {
    this.orchestrator.clear();
    this.clearEverywhere();
    this.orb?.syncRunningState();
  }

  /**
   * A translated pane is not necessarily the focused one, so clearing walks every
   * markdown leaf rather than only the active view.
   */
  private clearEverywhere(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const root = this.previewRoot(leaf.view as MarkdownView);
      if (root) clearInjected(root);
    }
  }

  private async cycleEngine(): Promise<void> {
    const order: EngineId[] = ["google", "microsoft", "ai"];
    const next = order[(order.indexOf(this.settings.engine) + 1) % order.length];
    this.settings.engine = next;
    await this.saveSettings();
    this.orb?.applySettings(this.settings);
    new Notice(`${t("engineSwitched")}${next}`, 2500);
  }

  /** Used by the settings tab to prove an endpoint works before saving. */
  async probeEngine(): Promise<string> {
    const probe = "Hello, world.";
    try {
      const [result] = await translateTexts([probe], this.settings);
      return result?.trim() ? `${probe} → ${result.trim()}` : "empty response";
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async fetchModels(): Promise<string> {
    try {
      this.availableModels = await listModels(this.settings.ai);
      return this.availableModels.length
        ? `Found ${this.availableModels.length} models`
        : "Endpoint answered with no models";
    } catch (error) {
      this.availableModels = [];
      return `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  clearCache(): void {
    this.cache.clear();
    void this.persist();
  }
}
