import type { TranslatorSettings } from "./settings";
import { collectUnits, extractText, meetsMinimum } from "./chunk/paragraphs";
import { ViewportWatcher } from "./schedule/viewport";
import { TranslateQueue, isCancelled } from "./schedule/queue";
import { BatchQueue } from "./schedule/batch-queue";
import { TranslationCache } from "./schedule/cache";
import { translateTexts, providerIdentity, maxItemsPerBatch } from "./engines";
import {
  clearInjected,
  dropUnit,
  inject,
  isOwnInjection,
  markPending,
  unfinishedUnits,
  type Renderer,
} from "./ui/inject";
import { hashKey } from "./utils/hash";

export interface OrchestratorEvents {
  onRunningChange: (running: boolean) => void;
  onProgress: (done: number, total: number) => void;
  /** Fired after a cache write so the plugin can debounce persistence. */
  onCacheWrite: () => void;
}

type UnitStatus = "pending" | "done" | "skipped";

interface UnitRecord {
  text: string;
  status: UnitStatus;
}

/**
 * Owns one translation session per reading view. Units enter through the viewport
 * watcher, are deduplicated against the cache, then flow through the batch queue
 * into the rate limiter. A session carries an id so results that land after the
 * user stopped (or switched note) are discarded rather than painted.
 */
export class Orchestrator {
  private sessionId: string | null = null;
  /**
   * Bumped on start/stop/clear. Results are gated on it, so work that lands after
   * the user stopped, cleared, or moved to another note can never paint — including
   * session initialization that is still awaiting the provider identity.
   */
  private epoch = 0;
  private watcher: ViewportWatcher | null = null;
  private units = new WeakMap<HTMLElement, UnitRecord>();
  private root: HTMLElement | null = null;
  private providerKey = "";
  private running = false;
  private total = 0;
  private done = 0;
  private rebindTimer: number | null = null;
  private rerenderObserver: MutationObserver | null = null;

  constructor(
    private queue: TranslateQueue,
    private batch: BatchQueue,
    private cache: TranslationCache,
    private getSettings: () => TranslatorSettings,
    private render: Renderer,
    private events: OrchestratorEvents
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async start(root: HTMLElement): Promise<void> {
    this.stop();
    const settings = this.getSettings();
    this.root = root;
    this.epoch += 1;
    // A session stopped mid-flight leaves unpainted placeholders; their blocks have
    // to become eligible again rather than being remembered as pending forever.
    this.dropUnfinishedUnits();
    this.sessionId = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const epoch = this.epoch;
    this.units = new WeakMap();
    this.running = true;
    this.events.onRunningChange(true);
    const providerKey = await providerIdentity(settings);
    if (epoch !== this.epoch || !this.running) return;
    this.providerKey = providerKey;
    this.done = 0;

    this.watcher?.disconnect();
    this.watcher = new ViewportWatcher({
      rootMarginPx: settings.preloadMarginPx,
      onEnter: (el) => {
        void this.translateUnit(el);
      },
    });

    this.observeRerenders(root);
    this.collectAndObserve();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch += 1;
    this.watcher?.disconnect();
    this.watcher = null;
    if (this.sessionId) {
      this.batch.dropScope(this.sessionId);
      this.queue.cancelScope(this.sessionId);
      this.sessionId = null;
    }
    this.detachRerenderObserver();
    // Cancelled requests never paint, so their shimmer rows — and any error row from
    // a provider that failed mid-session — would otherwise stay in the note.
    this.dropUnfinishedUnits();
    this.events.onRunningChange(false);
  }

  /** Remove every injected node so the note reads exactly as Obsidian rendered it. */
  clear(): void {
    this.stop();
    // Invalidate any work still awaiting hashing or rendering.
    this.epoch += 1;
    if (this.root) clearInjected(this.root);
    this.units = new WeakMap();
    this.done = 0;
    this.total = 0;
    this.events.onProgress(0, 0);
  }

  applySettings(): void {
    const settings = this.getSettings();
    this.queue.setOptions({
      capacity: settings.requestCapacity,
      rate: settings.requestRate,
      maxRetries: settings.maxRetries,
    });
    this.batch.setOptions({
      maxItems: maxItemsPerBatch(settings),
      maxChars: settings.maxCharsPerBatch,
    });
    this.cache.setOptions({
      maxEntries: settings.cacheMaxEntries,
      ttlDays: settings.cacheTtlDays,
    });
    this.watcher?.setRootMargin(settings.preloadMarginPx);
  }

  private collectAndObserve(): void {
    if (!this.root || !this.watcher) return;
    const units = collectUnits(this.root);
    this.total = units.length;
    this.events.onProgress(this.done, this.total);

    const fresh: HTMLElement[] = [];
    for (const unit of units) {
      if (this.units.has(unit.el)) continue;
      this.units.set(unit.el, { text: unit.text, status: "pending" });
      fresh.push(unit.el);
    }
    // Already-seen elements are not re-observed: one-shot gating hands a unit
    // off exactly once per session.
    this.watcher.observe(fresh);
  }

  private async translateUnit(el: HTMLElement): Promise<void> {
    if (!el.isConnected) return;
    const settings = this.getSettings();
    const epoch = this.epoch;
    const text = extractText(el);
    if (!text) return;

    const record = this.units.get(el);
    if (record && record.status !== "pending") return;

    if (!meetsMinimum(text, settings.minCharactersPerNode, settings.minWordsPerNode)) {
      // Too small to be worth a request; leave the block untouched.
      this.units.set(el, { text, status: "skipped" });
      return;
    }

    const key = await this.cacheKey(text);
    if (epoch !== this.epoch || !this.running) return;
    const cached = settings.enableCache ? this.cache.get(key) : undefined;
    if (cached !== undefined) {
      if (epoch === this.epoch) this.paint(el, text, cached);
      return;
    }

    this.units.set(el, { text, status: "pending" });
    markPending(el, this.render, settings.translationStyle);

    const sessionId = this.sessionId;
    try {
      const translated = await this.batch.submit(
        this.groupKey(),
        sessionId ?? "oneshot",
        text,
        (texts) => translateTexts(texts, settings)
      );
      if (epoch !== this.epoch) return;
      if (translated.trim()) {
        this.cache.set(key, translated);
        this.events.onCacheWrite();
      }
      this.paint(el, text, translated);
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (isCancelled(error)) {
        // Stopped or switched away: no result to show and no error to report.
        this.units.delete(el);
        dropUnit(el);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      inject(el, { state: "error", translation: message, style: settings.translationStyle }, this.render);
      this.units.set(el, { text, status: "pending" });
    } finally {
      // Only the session that is still current may move the counter the orb shows.
      if (epoch === this.epoch) {
        this.done += 1;
        this.events.onProgress(this.done, this.total);
      }
    }
  }

  private paint(el: HTMLElement, source: string, translation: string): void {
    const settings = this.getSettings();
    // The engine echoing the input back means there was nothing to translate.
    const noop = translation.trim() === source.trim();
    inject(
      el,
      {
        state: noop ? "skipped" : "done",
        translation,
        renderMarkdown: settings.renderMarkdown,
        style: settings.translationStyle,
      },
      this.render
    );
    this.units.set(el, { text: source, status: noop ? "skipped" : "done" });
  }

  private groupKey(): string {
    const settings = this.getSettings();
    return `${settings.sourceLang}>${settings.targetLang}\u0000${this.providerKey}`;
  }

  private async cacheKey(text: string): Promise<string> {
    const settings = this.getSettings();
    // providerKey already carries model, endpoint and prompt hash for AI engines,
    // so one material covers every engine's invalidation surface.
    return hashKey(
      `${text}\u0000${settings.sourceLang}\u0000${settings.targetLang}\u0000${this.providerKey}`
    );
  }

  // Obsidian re-renders the preview when the note changes, so new blocks must be
  // picked up without restarting the session.
  private observeRerenders(root: HTMLElement): void {
    this.rerenderObserver?.disconnect();
    this.rerenderObserver = new MutationObserver((records) => {
      // Injecting a translation mutates this same subtree; reacting to our own
      // nodes would make every painted paragraph trigger another scan.
      if (records.every(isOwnInjection)) return;
      if (this.rebindTimer !== null) window.clearTimeout(this.rebindTimer);
      this.rebindTimer = window.setTimeout(() => this.collectAndObserve(), 120);
    });
    this.rerenderObserver.observe(root, { childList: true, subtree: true });
  }

  /** Forget blocks that were queued but never painted, so they can be retried. */
  private dropUnfinishedUnits(): void {
    if (!this.root) return;
    for (const el of unfinishedUnits(this.root)) {
      this.units.delete(el);
      dropUnit(el);
    }
  }

  private detachRerenderObserver(): void {
    this.rerenderObserver?.disconnect();
    this.rerenderObserver = null;
    if (this.rebindTimer !== null) {
      window.clearTimeout(this.rebindTimer);
      this.rebindTimer = null;
    }
  }
}
