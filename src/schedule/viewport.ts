export interface ViewportWatcherOptions {
  /** Extra band around the window so translation lands before the text is read. */
  rootMarginPx: number;
  onEnter: (el: HTMLElement) => void;
}

/**
 * One-shot viewport gating: a unit is handed off the first time it enters the
 * preload band and then unobserved, so scrolling back is served from cache
 * instead of re-enqueuing work. That is why there is no cancel-on-scroll path.
 */
export class ViewportWatcher {
  private observer: IntersectionObserver | null = null;
  private rootMarginPx: number;
  private onEnter: (el: HTMLElement) => void;

  constructor(options: ViewportWatcherOptions) {
    this.rootMarginPx = options.rootMarginPx;
    this.onEnter = options.onEnter;
    this.rebuild();
  }

  private rebuild(): void {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          this.observer?.unobserve(el);
          this.onEnter(el);
        }
      },
      { root: null, rootMargin: `${this.rootMarginPx}px`, threshold: 0 }
    );
  }

  observe(elements: Iterable<HTMLElement>): void {
    if (!this.observer) return;
    for (const el of elements) this.observer.observe(el);
  }

  setRootMargin(rootMarginPx: number): void {
    if (this.rootMarginPx === rootMarginPx) return;
    this.rootMarginPx = rootMarginPx;
    this.rebuild();
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
