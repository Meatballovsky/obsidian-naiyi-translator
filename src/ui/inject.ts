import { Component } from "obsidian";
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

export type Renderer = (container: HTMLElement, markdown: string, component: Component) => void | Promise<void>;

const renderVersions = new WeakMap<HTMLElement, number>();
const renderScopes = new Map<HTMLElement, Component>();
const removalObservers = new Map<Document, MutationObserver>();

/** Plugin unload must release even a render whose preview was just detached. */
export function disposeRenderScopes(): void {
  for (const body of renderScopes.keys()) releaseRender(body);
}

function releaseRender(body: HTMLElement): void {
  renderVersions.set(body, (renderVersions.get(body) ?? 0) + 1);
  renderScopes.get(body)?.unload();
  renderScopes.delete(body);
  const doc = body.ownerDocument;
  if (![...renderScopes.keys()].some((el) => el.ownerDocument === doc)) {
    removalObservers.get(doc)?.disconnect();
    removalObservers.delete(doc);
  }
}

function createRenderScope(body: HTMLElement): Component {
  const component = new Component();
  component.load();
  renderScopes.set(body, component);
  const doc = body.ownerDocument;
  if (!removalObservers.has(doc)) {
    const Observer = doc.defaultView!.MutationObserver;
    const observer = new Observer(() => {
      // Also release renders when Obsidian replaces a preview outside our clear path.
      for (const el of renderScopes.keys()) {
        if (el.ownerDocument === doc && !el.isConnected) releaseRender(el);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    removalObservers.set(doc, observer);
  }
  return component;
}

function removeWrapper(wrapper: Element): void {
  const body = wrapper.querySelector<HTMLElement>(`.${TEXT_CLASS}`);
  if (body) releaseRender(body);
  wrapper.remove();
}

/** Sibling wrappers cannot inherit styles applied directly to the source block. */
function matchTypography(source: HTMLElement, wrapper: HTMLElement): void {
  const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
  if (!computed) return;
  for (const property of [
    "font-family", "font-size", "font-weight", "font-style", "line-height",
    "letter-spacing", "color", "text-align", "text-indent", "text-transform",
  ]) {
    wrapper.style.setProperty(property, computed.getPropertyValue(property));
  }
  if (wrapper.dataset.state === "error") {
    wrapper.style.removeProperty("color");
    wrapper.style.removeProperty("font-size");
  }
}

/** Refresh snapshots when the theme or its stylesheet changes, without translating again. */
export function refreshInjectedTypography(root: HTMLElement): void {
  for (const wrapper of root.querySelectorAll<HTMLElement>(`.${WRAPPER_CLASS}`)) {
    const parent = wrapper.parentElement;
    const source = parent && (parent.tagName === "TD" || parent.tagName === "TH")
      ? parent : wrapper.previousElementSibling;
    if (source instanceof HTMLElement && source.hasAttribute(UNIT_ATTRIBUTE)) {
      matchTypography(source, wrapper);
    }
  }
}

/** Wrap inline runs, leaving Markdown blocks and formula DOM intact. */
function shadeText(container: HTMLElement): void {
  const blocks = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"]);
  let run: ChildNode[] = [];
  const flush = () => {
    // MarkdownRenderer inserts newline text nodes between blocks. A padded span
    // around those invisible separators creates a visible empty line and stripe.
    const hasContent = run.some((node) =>
      node.nodeType === 3 ? !!node.textContent?.trim() : node.nodeType === 1
        && (node as HTMLElement).tagName !== "BR"
    );
    if (hasContent) {
      const shade = container.createSpan();
      shade.className = "obstr-shaded-text";
      container.insertBefore(shade, run[0]);
      shade.append(...run);
    }
    run = [];
  };
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === 1 && blocks.has((node as HTMLElement).tagName)) {
      flush();
      if ((node as HTMLElement).tagName !== "PRE") shadeText(node as HTMLElement);
    } else {
      run.push(node);
    }
  }
  flush();
}

function makeWrapper(el: HTMLElement, style: string = "card"): HTMLElement {
  const wrapper = el.createDiv();
  wrapper.detach();
  wrapper.className = `${WRAPPER_CLASS} obstr-style-${style} notranslate`;
  const body = wrapper.createDiv();
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
    wrapper = makeWrapper(el, style);
    attach(el, wrapper);
  } else {
    wrapper.classList.remove("obstr-style-card", "obstr-style-quote", "obstr-style-minimal");
    wrapper.classList.add(`obstr-style-${style}`);
  }
  el.setAttribute(UNIT_ATTRIBUTE, options.state);
  wrapper.dataset.state = options.state;

  const body = wrapper.querySelector<HTMLElement>(`.${TEXT_CLASS}`);
  if (!body) return;
  releaseRender(body);
  matchTypography(el, wrapper);
  const version = (renderVersions.get(body) ?? 0) + 1;
  renderVersions.set(body, version);

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
    removeWrapper(wrapper);
    el.removeAttribute(UNIT_ATTRIBUTE);
    return;
  }

  body.textContent = "";
  // Render off-DOM so a late Markdown render cannot overwrite a newer state.
  const content = body.createDiv();
  content.detach();
  const finish = () => {
    if (renderVersions.get(body) !== version) return;
    if (style === "card") shadeText(content);
    body.replaceChildren(...Array.from(content.childNodes));
  };
  if (options.renderMarkdown) {
    const component = createRenderScope(body);
    try {
      const result = render(content, text, component);
      if (result) void result.then(finish).catch(() => {
        if (renderScopes.get(body) === component) releaseRender(body);
      });
      else finish();
    } catch (error) {
      releaseRender(body);
      throw error;
    }
  } else {
    content.textContent = text;
    finish();
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
  if (sibling?.classList.contains(WRAPPER_CLASS)) removeWrapper(sibling);
  const child = el.querySelector<HTMLElement>(`:scope > .${WRAPPER_CLASS}`);
  if (child) removeWrapper(child);
  el.removeAttribute(UNIT_ATTRIBUTE);
}

export function clearInjected(root: HTMLElement): void {
  root.querySelectorAll(`.${WRAPPER_CLASS}`).forEach(removeWrapper);
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
