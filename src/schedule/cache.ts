export interface CachedEntry {
  translation: string;
  updatedAt: number;
}

export interface CacheOptions {
  maxEntries: number;
  ttlDays: number;
}

/**
 * Hot LRU in memory plus a persisted snapshot, so re-opening a note the user
 * already translated does not re-hit the provider. Persistence is the plugin's
 * data.json, debounced by the caller; entries are pruned by TTL then LRU order.
 */
export class TranslationCache {
  private map = new Map<string, CachedEntry>();
  private options: CacheOptions;

  constructor(options: CacheOptions) {
    this.options = options;
  }

  setOptions(options: Partial<CacheOptions>): void {
    this.options = { ...this.options, ...options };
    this.prune();
  }

  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.isStale(entry)) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to move it to the MRU end.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.translation;
  }

  set(key: string, translation: string): void {
    if (!translation.trim()) return;
    this.map.delete(key);
    this.map.set(key, { translation, updatedAt: Date.now() });
    this.prune();
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** Restores a snapshot; existing entries win so fresher data is not clobbered. */
  hydrate(records: Record<string, CachedEntry>): void {
    for (const [key, entry] of Object.entries(records)) {
      if (!entry || typeof entry.translation !== "string") continue;
      if (this.isStale(entry)) continue;
      if (!this.map.has(key)) this.map.set(key, entry);
    }
    this.prune();
  }

  toJSON(): Record<string, CachedEntry> {
    const out: Record<string, CachedEntry> = {};
    for (const [key, entry] of this.map) out[key] = entry;
    return out;
  }

  private isStale(entry: CachedEntry): boolean {
    if (this.options.ttlDays <= 0) return false;
    const ttlMs = this.options.ttlDays * 24 * 60 * 60 * 1000;
    return Date.now() - entry.updatedAt > ttlMs;
  }

  private prune(): void {
    for (const [key, entry] of Array.from(this.map)) {
      if (this.isStale(entry)) this.map.delete(key);
    }
    while (this.map.size > this.options.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
}
