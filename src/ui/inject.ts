import {
  TEXT_CLASS,
  UNIT_ATTRIBUTE,
  WRAPPER_CLASS,
} from "../chunk/paragraphs";

export type UnitState = "pending" | "done" | "error" | "skipped";

export interface InjectOptions {
  state: UnitState;
  translation?: string;
  /** Rendered as Markdown by the caller when the engine returns formatting. */
  renderMarkdown?: boolean;
  /** Translation rendering style (e.g. "card", "quote", "minimal") */
  style?: string;
}

export type Renderer = (container: HTMLElement, markdown: string) => void | Promise<void>;

function makeWrapper(style: string = "card"): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `${WRAPPER_CLASS} obstr-style-${style} notranslate`;
  const body = document.createElement("div");
  body.className = TEXT_CLASS;
  wrapper.appendChild(body);
  return wrapper;
}

/**
 * Translation lives in a sibling wrapper carrying `notranslate`. The collector
 * excludes everything under `.obstr-wrapper`, so a Markdown-rendered translation
 * (whose `p`/`li` nodes are real blocks) can never be re-collected as source, and
 * removing every wrapper restores the note exactly as Obsidian rendered it.
 * Nothing touches the file on disk.
 */
/**
 * A block element hosts its wrapper as its next sibling; a table cell hosts
 * one inside itself as a child.
 */
export function findWrapper(el: HTMLElement): HTMLElement | null {
  if (el.tagName === "TD" || el.tagName === "TH") {
    return el.querySelector<HTMLElement>(`:scope > .${WRAPPER_CLASS}`);
  }
  const sibling = el.nextElementSibling;
  if (sibling?.classList.contains(WRAPPER_CLASS)) {
    return sibling as HTMLElement;
  }
  return el.querySelector<HTMLElement>(`:scope > .${WRAPPER_CLASS}`);
}

export function inject(
  el: HTMLElement,
  options: InjectOptions,
  render: Renderer
): void {
  const style = options.style || "card";
  let wrapper = findWrapper(el);
  if (!wrapper) {
    wrapper = makeWrapper(style);
    attach(el, wrapper);
  } else {
    wrapper.classList.remove("obstr-style-card", "obstr-style-quote", "obstr-style-minimal");
    wrapper.classList.add(`obstr-style-${style}`);
  }
  el.setAttribute(UNIT_ATTRIBUTE, options.state);
  wrapper.dataset.state = options.state;

  const body = wrapper.querySelector<HTMLElement>(`.${TEXT_CLASS}`);
  if (!body) return;

  if (options.state === "pending") {
    body.textContent = "";
    body.classList.add("obstr-shimmer");
    return;
  }
  body.classList.remove("obstr-shimmer");

  const text = options.translation ?? "";
  if (options.state === "error") {
    body.textContent = text || "translation failed";
    return;
  }
  if (options.state === "skipped" || !text.trim()) {
    // A unit that turns out to need no translation leaves no placeholder behind.
    wrapper.remove();
    el.removeAttribute(UNIT_ATTRIBUTE);
    return;
  }

  body.textContent = "";
  if (options.renderMarkdown) {
    void render(body, text);
  } else {
    body.textContent = text;
  }
}

/** Table cells cannot take a sibling row, so the wrapper goes inside the cell. */
function attach(el: HTMLElement, wrapper: HTMLElement): void {
  if (el.tagName === "TD" || el.tagName === "TH") {
    el.appendChild(wrapper);
    return;
  }
  el.insertAdjacentElement("afterend", wrapper);
}

export function markPending(el: HTMLElement, render: Renderer, style?: string): void {
  inject(el, { state: "pending", style }, render);
}

/**
 * Blocks that were queued but never produced a readable translation: still waiting,
 * or painted with a provider error. Both must be forgotten when a session ends so the
 * next one retries them instead of trusting a stale record.
 */
const UNFINISHED_STATES = new Set(["pending", "error"]);

export function unfinishedUnits(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[${UNIT_ATTRIBUTE}]`)
  ).filter((el) => UNFINISHED_STATES.has(el.getAttribute(UNIT_ATTRIBUTE) ?? ""));
}

/** Remove a unit's wrapper (placeholder or error row) and its state marker. */
export function dropUnit(el: HTMLElement): void {
  // A block's wrapper is its next sibling; a table cell hosts one inside itself.
  const sibling = el.nextElementSibling;
  if (sibling?.classList.contains(WRAPPER_CLASS)) sibling.remove();
  el.querySelector<HTMLElement>(`:scope > .${WRAPPER_CLASS}`)?.remove();
  el.removeAttribute(UNIT_ATTRIBUTE);
}

export function clearInjected(root: HTMLElement): void {
  root.querySelectorAll(`.${WRAPPER_CLASS}`).forEach((node) => node.remove());
  root.querySelectorAll(`[${UNIT_ATTRIBUTE}]`).forEach((node) => node.removeAttribute(UNIT_ATTRIBUTE));
}

/**
 * True when a mutation can only have come from this injector, so a re-render
 * watcher can ignore it. Without this, every painted paragraph mutates the preview
 * subtree and schedules another scan of the whole note.
 */
export function isOwnInjection(record: MutationRecord): boolean {
  const target = record.target as HTMLElement;
  if (target.nodeType === 1 && target.closest?.(`.${WRAPPER_CLASS}`)) return true;

  const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  if (nodes.length === 0) return false;
  // A note re-render adds our wrappers alongside real blocks; that is not our own work.
  return nodes.every((node) => node.nodeType === 1 && (node as HTMLElement).classList?.contains(WRAPPER_CLASS));
}
