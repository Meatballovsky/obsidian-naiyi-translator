import { defaultRequestRetryPolicy, type RequestRetryPolicy } from "../utils/retry-policy";

/**
 * Rejection used for tasks the plugin cancelled itself (stopped session, cleared
 * note). Callers must treat it as "no result", not as a provider failure, so a
 * cancelled paragraph shows nothing instead of an error line.
 */
export function cancelledError(): Error & { cancelled: true } {
  const error = new Error("cancelled") as Error & { cancelled: true };
  error.cancelled = true;
  return error;
}

export function isCancelled(error: unknown): boolean {
  return (error as { cancelled?: boolean } | undefined)?.cancelled === true;
}

export interface QueueTask<T = unknown> {
  hash: string;
  scope: string;
  /** Earliest dispatch time; the heap orders on this so retries sink to the back. */
  scheduleAt: number;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  attempts: number;
  /** 429 retries spent here; a separate budget from attempts (see retry policy). */
  rateLimitRetries: number;
  drained?: boolean;
}

export interface QueueOptions {
  /** Max simultaneous in-flight requests. */
  capacity: number;
  /** Token refill per second. */
  rate: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  retryPolicy?: RequestRetryPolicy;
  /** Called once per permanently failed task, and once for a drained backlog (task null). */
  onTaskFailed?: (error: unknown, task: QueueTask<unknown> | null) => void;
}

/**
 * Token-bucket limiter over a schedule-time priority heap, ported from read-frog's
 * request queue. A rate limit pauses dispatch for the whole queue and retries the
 * offender after the pause, so a transient 429 never turns every queued paragraph
 * into an error at once.
 */
export class TranslateQueue {
  private bucketTokens: number;
  private lastRefillMs: number;
  private waiting = new TaskHeap();
  private waitingByHash = new Map<string, QueueTask<unknown>>();
  private executingByHash = new Map<string, QueueTask<unknown>>();
  private pausedUntil = 0;
  private consecutiveRateLimits = 0;
  private timer: number | null = null;
  private options: QueueOptions;
  private retryPolicy: RequestRetryPolicy;

  constructor(options: QueueOptions) {
    this.options = options;
    this.retryPolicy = options.retryPolicy ?? defaultRequestRetryPolicy;
    this.bucketTokens = options.capacity;
    this.lastRefillMs = Date.now();
  }

  setOptions(options: Partial<QueueOptions>): void {
    const { retryPolicy, ...queueOptions } = options;
    // Settle token accrual under the OLD rate before switching.
    this.refillTokens();
    this.options = { ...this.options, ...queueOptions };
    if (retryPolicy) this.retryPolicy = retryPolicy;
    if (options.capacity !== undefined) {
      // Clamp, never refill-to-full: raising the ceiling must not grant a free
      // burst, and repeated identical calls (config sync) must be no-ops.
      this.bucketTokens = Math.min(this.bucketTokens, options.capacity);
    }
    // The pending timer's delay was computed under the old rate — recompute.
    this.schedule();
  }

  enqueue<T>(
    task: Pick<QueueTask<T>, "hash" | "scope" | "execute" | "resolve" | "reject">
  ): void {
    const queued = task as QueueTask<unknown>;
    queued.scheduleAt = queued.scheduleAt ?? Date.now();
    queued.attempts = 0;
    queued.rateLimitRetries = 0;
    this.waitingByHash.set(queued.hash, queued);
    this.waiting.push(queued);
    this.schedule();
  }

  /** Drain every waiting task of a scope and report the in-flight ones. */
  cancelScope(scope: string): QueueTask<unknown>[] {
    const inFlight: QueueTask<unknown>[] = [];
    for (const task of Array.from(this.waitingByHash.values())) {
      if (task.scope !== scope) continue;
      task.drained = true;
      this.waitingByHash.delete(task.hash);
      this.rejectSilently(task, cancelledError());
    }
    const droppedWaiting = this.waiting.filter((task) => task.scope !== scope);
    this.waiting.replace(droppedWaiting);
    for (const task of Array.from(this.executingByHash.values())) {
      if (task.scope === scope) inFlight.push(task);
    }
    this.schedule();
    return inFlight;
  }

  clear(): void {
    for (const task of Array.from(this.waitingByHash.values())) {
      task.drained = true;
      this.rejectSilently(task, cancelledError());
    }
    this.waitingByHash.clear();
    this.waiting.replace([]);
    this.executingByHash.clear();
    this.clearTimer();
  }

  get sizes(): { waiting: number; executing: number } {
    return {
      waiting: this.waitingByHash.size,
      executing: this.executingByHash.size,
    };
  }

  /**
   * When `needed` tokens would be available. The batch queue uses this as a
   * dispatch gate: a saturated limiter means holding a group is free.
   */
  nextDispatchEtaMs(needed = 1): number {
    const now = Date.now();
    const pauseDelay = Math.max(0, this.pausedUntil - now);
    this.refillTokens();
    const tokenDelay =
      this.bucketTokens >= needed
        ? 0
        : Math.ceil(((needed - this.bucketTokens) / this.options.rate) * 1000);
    return now + Math.max(pauseDelay, tokenDelay);
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) return;
    this.bucketTokens = Math.min(
      this.options.capacity,
      this.bucketTokens + (elapsedMs / 1000) * this.options.rate
    );
    this.lastRefillMs = now;
  }

  private schedule(): void {
    this.refillTokens();
    this.clearTimer();

    const pauseRemaining = this.pausedUntil - Date.now();
    if (pauseRemaining > 0) {
      if (this.waiting.size > 0) this.armTimer(pauseRemaining);
      return;
    }

    const now = Date.now();
    while (this.bucketTokens >= 1 && this.waiting.size > 0) {
      const task = this.waiting.peek();
      if (!task) break;
      if (task.drained) {
        this.waiting.pop();
        this.waitingByHash.delete(task.hash);
        continue;
      }
      if (task.scheduleAt > now) break;
      this.waiting.pop();
      this.waitingByHash.delete(task.hash);
      this.executingByHash.set(task.hash, task);
      this.bucketTokens -= 1;
      void this.run(task);
    }

    const next = this.waiting.peek();
    if (next) {
      const untilScheduled = Math.max(0, next.scheduleAt - Date.now());
      const untilToken =
        this.bucketTokens >= 1
          ? 0
          : Math.ceil(((1 - this.bucketTokens) / this.options.rate) * 1000);
      this.armTimer(Math.max(untilScheduled, untilToken));
    }
  }

  private async run(task: QueueTask<unknown>): Promise<void> {
    try {
      const value = await task.execute();
      this.executingByHash.delete(task.hash);
      // Any completed request proves the provider recovered from rate limiting.
      this.consecutiveRateLimits = 0;
      if (!task.drained) task.resolve(value);
    } catch (error) {
      this.executingByHash.delete(task.hash);
      if (task.drained) return;
      this.handleFailure(task, error);
    }
    this.schedule();
  }

  private handleFailure(task: QueueTask<unknown>, error: unknown): void {
    const now = Date.now();
    const decision = this.retryPolicy.decide(error, {
      now,
      retryCount: task.attempts,
      maxRetries: this.options.maxRetries,
      baseRetryDelayMs: this.options.baseRetryDelayMs,
      rateLimitRetryCount: task.rateLimitRetries,
      consecutiveRateLimits: this.consecutiveRateLimits,
    });

    if (decision.action === "retry") {
      task.attempts += 1;
      this.requeue(task, now + decision.delayMs);
      return;
    }

    if (decision.action === "pause-and-retry") {
      // One pause per window, not per failing sibling: with capacity > 1 several
      // in-flight attempts can all 429 within milliseconds of each other.
      if (now >= this.pausedUntil) this.consecutiveRateLimits += 1;
      this.pausedUntil = Math.max(this.pausedUntil, now + decision.pauseMs);
      // Resume with at most one token, so recovery probes the provider with a
      // single request instead of bursting `capacity` at it.
      this.bucketTokens = Math.min(this.bucketTokens, 1);
      this.lastRefillMs = now;
      task.rateLimitRetries += 1;
      this.requeue(task, this.pausedUntil);
      return;
    }

    if (decision.failQueue) {
      // The offender left executingByHash before this handler ran, so it is the
      // one task failBacklog cannot see; settle it here or its caller hangs.
      this.failBacklog(error);
      this.drain(task, error);
    } else {
      this.options.onTaskFailed?.(error, task);
      task.reject(error);
    }
  }

  private requeue(task: QueueTask<unknown>, scheduleAt: number): void {
    task.scheduleAt = scheduleAt;
    this.waitingByHash.set(task.hash, task);
    this.waiting.push(task);
  }

  /**
   * A permanent error (bad key, dead endpoint) fails everything at once: the
   * remaining backlog would fail identically, one Notice per paragraph helps
   * nobody. The cooldown survives, so a fresh session still waits it out.
   */
  private failBacklog(error: unknown): void {
    this.consecutiveRateLimits = 0;
    this.clearTimer();

    const drained = Array.from(this.waitingByHash.values());
    this.waitingByHash.clear();
    this.waiting.replace([]);
    for (const task of drained) this.drain(task, error);
    for (const task of Array.from(this.executingByHash.values())) {
      this.executingByHash.delete(task.hash);
      this.drain(task, error);
    }
    // One notice for the whole drained backlog, with no task attached so the
    // caller words it as "the provider stopped us" rather than a per-paragraph error.
    this.options.onTaskFailed?.(error, null);
  }

  private drain(task: QueueTask<unknown>, error: unknown): void {
    if (task.drained) return;
    task.drained = true;
    task.reject(error);
  }

  private rejectSilently(task: QueueTask<unknown>, error: unknown): void {
    try {
      task.reject(error);
    } catch {
      /* callers gate on scope cancellation */
    }
  }

  private armTimer(ms: number): void {
    this.clearTimer();
    this.timer = window.setTimeout(() => this.schedule(), Math.max(0, ms));
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Binary min-heap on scheduleAt. */
class TaskHeap {
  private items: QueueTask<unknown>[] = [];

  get size(): number {
    return this.items.length;
  }

  push(task: QueueTask<unknown>): void {
    const items = this.items;
    items.push(task);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].scheduleAt <= items[index].scheduleAt) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  peek(): QueueTask<unknown> | undefined {
    return this.items[0];
  }

  pop(): QueueTask<unknown> | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as QueueTask<unknown>;
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && items[left].scheduleAt < items[smallest].scheduleAt) smallest = left;
        if (right < items.length && items[right].scheduleAt < items[smallest].scheduleAt) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top;
  }

  filter(predicate: (task: QueueTask<unknown>) => boolean): QueueTask<unknown>[] {
    return this.items.filter(predicate);
  }

  replace(items: QueueTask<unknown>[]): void {
    this.items = [];
    for (const item of items) this.push(item);
  }
}
