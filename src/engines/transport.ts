/** Limits real HTTP attempts, including internal retries and batch fallbacks.
 * A timed-out request keeps its slot until requestUrl actually settles. */
export class TransportLimiter {
  private active = 0;
  private tokens = 4;
  private updatedAt = Date.now();
  private capacity = 4;
  private rate = 2;
  private waiting: { start: () => void; cancelled: boolean }[] = [];
  private timer: number | null = null;

  configure(capacity: number, rate: number): void {
    this.refill();
    this.capacity = Math.max(1, Math.floor(capacity));
    this.rate = Math.max(0.01, rate);
    this.tokens = Math.min(this.tokens, this.capacity);
    this.pump();
  }

  run<T>(request: () => Promise<T>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      const entry = { cancelled: false, start: () => {
        this.active++;
        if (timeoutMs && timeoutMs > 0) timer = window.setTimeout(() => reject(new Error("Request timed out")), timeoutMs);
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
          return request();
        }).then(resolve, reject).finally(() => {
          if (timer !== undefined) window.clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.active--;
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
    while (this.active < this.capacity && this.tokens >= 1 && this.waiting.length) {
      this.tokens--;
      this.waiting.shift()!.start();
    }
    if (this.waiting.length && this.active < this.capacity) {
      this.timer = window.setTimeout(() => this.pump(), Math.max(1, Math.ceil((1 - this.tokens) * 1000 / this.rate)));
    }
  }
}

export const transportLimiter = new TransportLimiter();
