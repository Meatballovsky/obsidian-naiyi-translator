/** Obsidian renders soft/hard breaks as <br> inside one paragraph. Temporarily
 * project its visual lines as independent translation anchors, keeping the exact
 * original nodes off-DOM for restoration (including listeners and inline marks). */
export const LINE_CLASS = "obstr-source-line";
interface Projection { original: DocumentFragment; lines: HTMLElement[] }
const scopes = new Map<HTMLElement, Map<HTMLElement, Projection>>();

export function prepareLineSegments(root: HTMLElement): void {
  let records = scopes.get(root);
  if (!records) scopes.set(root, records = new Map());
  for (const paragraph of root.querySelectorAll<HTMLElement>("p")) {
    if (paragraph.closest(".obstr-wrapper,pre,code,.internal-embed")) continue;
    const previous = records.get(paragraph);
    if (previous) {
      if (previous.lines.every((line) => line.parentElement === paragraph)) continue;
      records.delete(paragraph);
    }
    const breaks = Array.from(paragraph.querySelectorAll("br")).filter((br) => !br.closest("code,.math,.internal-embed"));
    if (!breaks.length) continue;
    const lines: HTMLElement[] = [];
    const range = paragraph.ownerDocument.createRange();
    range.setStart(paragraph, 0);
    for (const boundary of [...breaks, null]) {
      if (boundary) range.setEndBefore(boundary);
      else range.setEnd(paragraph, paragraph.childNodes.length);
      const line = paragraph.createSpan();
      line.className = LINE_CLASS;
      line.detach();
      line.append(range.cloneContents());
      lines.push(line);
      if (boundary) range.setStartAfter(boundary);
    }
    range.selectNodeContents(paragraph);
    const original = range.extractContents();
    paragraph.append(...lines);
    records.set(paragraph, { original, lines });
  }
}

export function restoreLineSegments(root: HTMLElement): void {
  for (const [scope, records] of scopes) {
    if (scope !== root && !root.contains(scope)) continue;
    scopes.delete(scope);
    for (const [paragraph, { original, lines }] of records) {
      // If Obsidian already replaced this paragraph's content, keep that new
      // render. Never restore an old snapshot over an external edit.
      if (paragraph.childNodes.length === lines.length && lines.every((line, i) => paragraph.childNodes[i] === line)) {
        paragraph.replaceChildren(original);
      }
    }
  }
}

export function restoreAllLineSegments(): void {
  for (const scope of scopes.keys()) restoreLineSegments(scope);
}
