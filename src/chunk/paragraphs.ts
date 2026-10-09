export const UNIT_ATTRIBUTE = "data-obstr-unit";
/**
 * The marker pair between the chunker and the injector. Declared here because the
 * collector is the side that has to honour them: a translation rendered as Markdown
 * contains real `p`/`li`/`h*` nodes, and if any of them looked like source the
 * plugin would translate its own output.
 */
export const WRAPPER_CLASS = "obstr-wrapper";
export const TEXT_CLASS = "obstr-text";

/**
 * Block elements that hold prose. Obsidian's preview already segments Markdown
 * into these, so no sentence splitting is needed — a unit is one rendered block.
 */
const UNIT_SELECTOR = [
  "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "li",
  "dt", "dd",
  "td", "th",
  "figcaption",
  "caption",
  "blockquote",
].join(",");

/**
 * Content that must not be sent to a translator: code, math, diagrams, embeds,
 * Obsidian's own chrome, and everything inside a wrapper we injected ourselves.
 * A unit inside any of these is skipped entirely.
 */
const SKIP_SELECTOR = [
  `.${WRAPPER_CLASS}`,
  "pre",
  "code",
  "kbd",
  "samp",
  ".math",
  ".mermaid",
  ".frontmatter-container",
  ".internal-embed",
  ".embed-gutter",
  ".metadata-container",
  ".callout-title",
  ".list-collapse-indicator",
  ".collapse-indicator",
  "svg",
  "a.external-link",
].join(",");

export interface ParagraphUnit {
  el: HTMLElement;
  text: string;
  index: number;
}

function hasUnitDescendant(el: HTMLElement): boolean {
  // Only real source blocks count: a wrapper we injected inside a table cell must
  // not turn the cell itself into "a block that contains another unit".
  return Array.from(el.querySelectorAll<HTMLElement>(UNIT_SELECTOR)).some(
    (inner) => !inner.closest(`.${WRAPPER_CLASS}`)
  );
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.display === "flex" && el.classList.contains("collapse")) return false;
  return true;
}

/**
 * Collect translation units in reading order. A block that itself contains another
 * unit block (blockquote > p, li > p) is skipped so the innermost node is translated
 * exactly once, and anything inside an injected wrapper is excluded so a translation
 * can never become source.
 */
export function collectUnits(root: HTMLElement): ParagraphUnit[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(UNIT_SELECTOR));
  const units: ParagraphUnit[] = [];

  for (const el of nodes) {
    if (el.classList.contains(WRAPPER_CLASS)) continue;
    if (el.closest(SKIP_SELECTOR)) continue;
    if (hasUnitDescendant(el)) continue;
    if (!isVisible(el)) continue;

    const text = extractText(el);
    if (!text) continue;
    units.push({ el, text, index: units.length });
  }

  return units;
}

export function extractText(el: HTMLElement): string {
  // <br> is real line structure in a rendered note, so map it to a newline
  // instead of letting textContent glue two lines together.
  const cloned = el.cloneNode(true) as HTMLElement;
  // A table cell hosts its wrapper inside itself, so the translation would otherwise
  // be read back as part of the source text.
  cloned.querySelectorAll(`.${WRAPPER_CLASS}`).forEach((node) => node.remove());
  cloned.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));

  // MathJax renders formulas as glyphs whose textContent is useless, but the
  // assistive-mml annotation Obsidian enables keeps the original LaTeX. Sending
  // that instead lets the formula survive the round trip.
  cloned.querySelectorAll<HTMLElement>(".math").forEach((math) => {
    const source =
      math.querySelector("annotation")?.textContent?.trim() ??
      math.textContent?.trim() ??
      "";
    const block = math.classList.contains("math-block") || math.classList.contains("math-display");
    math.textContent = source ? (block ? `$$${source}$$` : `$${source}$`) : "";
  });

  const text = (cloned.textContent ?? "").replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
  return stripProtected(text).length > 0 ? text : "";
}

/**
 * True when nothing but math, code and punctuation remains, so no request would
 * produce anything worth showing.
 */
function stripProtected(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

export function meetsMinimum(text: string, minChars: number, minWords: number): boolean {
  if (text.length < minChars) return false;
  if (minWords > 0 && countWords(text) < minWords) return false;
  // Pure wiki links, tags or handles are not worth a request.
  if (/^[#@\w_-]+$/.test(text)) return false;
  return true;
}

/** CJK counts per character, everything else per whitespace-delimited word. */
function countWords(text: string): number {
  const cjkPattern = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;
  const cjk = (text.match(cjkPattern) ?? []).length;
  const latin = text
    .replace(cjkPattern, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
  return cjk + latin;
}
