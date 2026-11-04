export interface TransportPolicy {
  key: string;
  capacity: number;
  minIntervalMs: number;
  rateLimitPauseMs: number;
}

/** Limits real HTTP attempts, including internal retries and batch fallbacks.
 * A timed-out request keeps its slot until requestUrl actually settles. */
export class TransportLimiter {
  private active = 0;
  private tokens = 4;
  private updatedAt = Date.now();
  private capacity = 4;
  private rate = 2;
  private waiting: { start: () => void; cancelled: boolean; policy?: TransportPolicy }[] = [];
  private providers = new Map<string, { active: number; nextStart: number; pausedUntil: number; strikes: number }>();
  private timer: number | null = null;

  configure(capacity: number, rate: number): void {
    this.refill();
    this.capacity = Math.max(1, Math.floor(capacity));
    this.rate = Math.max(0.01, rate);
    this.tokens = Math.min(this.tokens, this.capacity);
    this.pump();
  }

  private provider(key: string) {
    let state = this.providers.get(key);
    if (!state) this.providers.set(key, state = { active: 0, nextStart: 0, pausedUntil: 0, strikes: 0 });
    return state;
  }

  /** Called inside the physical attempt, before its slot is released. */
  rateLimited(policy: TransportPolicy, retryAfterMs = 0): number {
    const state = this.provider(policy.key);
    const now = Date.now();
    if (now >= state.pausedUntil) state.strikes++;
    const delay = Math.max(Math.min(86_400_000, retryAfterMs), Math.min(300_000, policy.rateLimitPauseMs * 2 ** (state.strikes - 1)));
    state.pausedUntil = Math.max(state.pausedUntil, now + delay);
    this.pump();
    return state.pausedUntil - now;
  }

  succeeded(policy: TransportPolicy): void {
    const state = this.provider(policy.key);
    if (Date.now() >= state.pausedUntil) state.strikes = 0;
  }

  run<T>(request: () => Promise<T>, timeoutMs?: number, signal?: AbortSignal, policy?: TransportPolicy): Promise<T> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      const entry = { cancelled: false, policy, start: () => {
        this.active++;
        if (policy) {
          const state = this.provider(policy.key);
          state.active++;
          state.nextStart = Date.now() + policy.minIntervalMs;
        }
        if (timeoutMs && timeoutMs > 0) timer = window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
          return request();
        }).then(resolve, reject).finally(() => {
          if (timer !== undefined) window.clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.active--;
          if (policy) this.provider(policy.key).active--;
          this.pump();
        });
      } };
      const abort = () => {
        entry.cancelled = true;
        signal?.removeEventListener("abort", abort);
        if (timer !== undefined) window.clearTimeout(timer);
        reject(Object.assign(new Error("cancelled"), { cancelled: true }));
        this.pump();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updatedAt) * this.rate / 1000);
    this.updatedAt = now;
  }

  private pump(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.refill();
    this.waiting = this.waiting.filter((entry) => !entry.cancelled);
    const readyAt = (entry: typeof this.waiting[number]) => {
      if (!entry.policy) return 0;
      const state = this.provider(entry.policy.key);
      return state.active >= entry.policy.capacity ? Infinity : Math.max(state.nextStart, state.pausedUntil);
    };
    while (this.active < this.capacity && this.tokens >= 1 && this.waiting.length) {
      const index = this.waiting.findIndex((entry) => readyAt(entry) <= Date.now());
      if (index < 0) break;
      this.tokens--;
      this.waiting.splice(index, 1)[0].start();
    }
    if (this.waiting.length && this.active < this.capacity) {
      const providerDelay = Math.max(0, Math.min(...this.waiting.map(readyAt)) - Date.now());
      if (Number.isFinite(providerDelay)) {
        const tokenDelay = Math.max(0, Math.ceil((1 - this.tokens) * 1000 / this.rate));
        this.timer = window.setTimeout(() => this.pump(), Math.max(1, tokenDelay, providerDelay));
      }
    }
  }
}

export const transportLimiter = new TransportLimiter();
