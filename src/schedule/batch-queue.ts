import { cancelledError, type TranslateQueue } from "./queue";

export interface BatchQueueOptions {
  maxItems: number;
  maxChars: number;
  /** Hold an unfinished group this long so sibling units can join it. */
  delayMs: number;
  /** Ceiling on holding a group while the rate limiter is saturated. */
  saturatedHoldMs: number;
}

interface Pending {
  text: string;
  seq: number;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

interface Group {
  /** Composite of scope + provider group key; unique per session per provider. */
  id: string;
  scope: string;
  items: Pending[];
  chars: number;
  timer: number | null;
}

let seq = 0;

/**
 * Accumulates units headed for the same provider into one queue task, so a single
 * round trip carries several paragraphs. A group flushes when it is full, when its
 * hold timer expires, or when a new unit would overflow it.
 */
export class BatchQueue {
  private groups = new Map<string, Group>();
  private options: BatchQueueOptions;

  constructor(private queue: TranslateQueue, options: BatchQueueOptions) {
    this.options = options;
  }

  setOptions(partial: Partial<BatchQueueOptions>): void {
    this.options = { ...this.options, ...partial };
  }

  /**
   * @param groupKey provider identity + language pair; decides which units may share a request.
   * @param scope    session id; lets stop() drain queued work for one view only.
   * @param run      issues the actual provider request for the whole group.
   */
  submit(
    groupKey: string,
    scope: string,
    text: string,
    run: (texts: string[]) => Promise<string[]>
  ): Promise<string> {
    const id = `${scope}\u0000${groupKey}`;
    return new Promise<string>((resolve, reject) => {
      let group = this.groups.get(id);
      if (group && this.wouldOverflow(group, text)) {
        this.flush(group, run);
        group = undefined;
      }
      if (!group) {
        group = { id, scope, items: [], chars: 0, timer: null };
        this.groups.set(id, group);
      }

      group.items.push({ text, seq: seq++, resolve, reject });
      group.chars += text.length;

      if (
        group.items.length >= this.options.maxItems ||
        group.chars >= this.options.maxChars
      ) {
        this.flush(group, run);
        return;
      }

      // When the limiter is already saturated, holding costs nothing and lets the
      // batch grow; when it is free, flush after a short hold so a lone paragraph
      // is not delayed waiting for siblings that may never arrive.
      const freeAt = this.queue.nextDispatchEtaMs(group.items.length);
      const holdMs =
        freeAt > Date.now()
          ? Math.min(freeAt - Date.now(), this.options.saturatedHoldMs)
          : this.options.delayMs;

      if (group.timer !== null) window.clearTimeout(group.timer);
      const captured = group;
      group.timer = window.setTimeout(
        () => this.flush(captured, run),
        Math.max(0, holdMs)
      );
    });
  }

  /**
   * Discard a session's held groups. A group whose hold timer has not fired would
   * otherwise enqueue itself after stop(), i.e. keep sending requests for a view
   * the user already left.
   */
  dropScope(scope: string): void {
    for (const group of Array.from(this.groups.values())) {
      if (group.scope !== scope) continue;
      if (group.timer !== null) window.clearTimeout(group.timer);
      group.timer = null;
      if (this.groups.get(group.id) === group) this.groups.delete(group.id);
      const items = group.items;
      group.items = [];
      group.chars = 0;
      const error = cancelledError();
      for (const item of items) item.reject(error);
    }
  }

  private wouldOverflow(group: Group, text: string): boolean {
    return (
      group.items.length >= this.options.maxItems ||
      group.chars + text.length > this.options.maxChars
    );
  }

  private flush(
    group: Group,
    run: (texts: string[]) => Promise<string[]>
  ): void {
    if (group.timer !== null) window.clearTimeout(group.timer);
    group.timer = null;
    if (this.groups.get(group.id) === group) this.groups.delete(group.id);
    if (group.items.length === 0) return;

    const items = group.items.slice().sort((a, b) => a.seq - b.seq);
    const texts = items.map((item) => item.text);

    this.queue.enqueue<string[]>({
      hash: `batch:${group.id}:${items[0].seq}`,
      scope: group.scope,
      execute: () => run(texts),
      resolve: (results) => {
        items.forEach((item, index) => item.resolve(results[index] ?? ""));
      },
      reject: (error) => {
        items.forEach((item) => item.reject(error));
      },
    });
  }
}
