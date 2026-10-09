import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { FloatingOrb } from "../src/ui/orb";
import { Orchestrator } from "../src/orchestrator";
import { DEFAULT_SETTINGS } from "../src/settings";
import { TranslationCache } from "../src/schedule/cache";
import { TranslateQueue } from "../src/schedule/queue";
import { BatchQueue } from "../src/schedule/batch-queue";
import { hashKey } from "../src/utils/hash";
import { FROG_ORB_SVG } from "../src/ui/icons";
import {
  collectUnits,
  extractText,
  UNIT_ATTRIBUTE,
  WRAPPER_CLASS,
} from "../src/chunk/paragraphs";
import {
  clearInjected,
  dropUnit,
  inject,
  isOwnInjection,
  markPending,
  refreshInjectedTypography,
  unfinishedUnits,
} from "../src/ui/inject";

// Obsidian's reading view markup, reproduced from the class names the app itself
// emits (verified against the shipped bundle rather than guessed).
const FIXTURE = `
<div class="markdown-reading-view">
  <div class="markdown-preview-view markdown-rendered">
    <div class="markdown-preview-sizer">
      <h1>Translating Papers</h1>
      <p>A paragraph with <a class="internal-link" href="#x">a link</a> and <code>inline_code()</code>.</p>
      <div class="callout">
        <div class="callout-title">Note</div>
        <div class="callout-content"><p>Callout body text.</p></div>
      </div>
      <pre class="block-language-python"><code>print("do not translate me")</code></pre>
      <blockquote><p>Quoted prose.</p></blockquote>
      <ul>
        <li>Bullet one</li>
        <li><p>Bullet as paragraph</p></li>
      </ul>
      <table>
        <thead><tr><th>Column name</th></tr></thead>
        <tbody><tr><td>Cell prose</td></tr></tbody>
      </table>
      <p><span class="math math-inline"><mjx-container><mjx-assistive-mml><math><annotation encoding="application/x-tex">x^2 + y^2</annotation></math></mjx-assistive-mml>𝑥²+𝑦²</mjx-container></span> is the circle</p>
      <p><span class="math math-block"><mjx-container><mjx-assistive-mml><math><annotation encoding="application/x-tex">\\nabla \\cdot E = \\rho</annotation></math></mjx-assistive-mml>∇·𝐸=𝜌</mjx-container></span></p>
      <div class="mermaid">graph TD; A--&gt;B</div>
      <p>Line one<br>Line two</p>
    </div>
  </div>
</div>`;

const results: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const dom = new JSDOM(`<body>${FIXTURE}</body>`);
const { window } = dom;
// The chunker and injector touch the DOM directly, so the test document is global.
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
});

// Minimal implementations of Obsidian's DOM helpers, scoped to this test window.
Object.assign(window.HTMLElement.prototype, {
  createEl(this: HTMLElement, tag: string) {
    const child = this.ownerDocument.createElement(tag);
    this.append(child);
    return child;
  },
  createDiv(this: HTMLElement) { return this.createEl("div"); },
  createSpan(this: HTMLElement) { return this.createEl("span"); },
  setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); },
  setCssProps(this: HTMLElement, props: Record<string, string>) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  },
  detach(this: HTMLElement) { this.remove(); },
});

const root = window.document.querySelector<HTMLElement>(".markdown-preview-view")!;
// Captured before any injection so cleanup can be checked against the original DOM.
const ORIGINAL_NODE_COUNT = root.querySelectorAll("*").length;
const texts = () => collectUnits(root).map((unit) => unit.text);

async function main(): Promise<void> {
  await test("Markdown components release on replacement, clearing and external preview removal", async () => {
    const pane = document.createElement("div");
    document.body.append(pane);
    const source = pane.createEl("p");
    source.textContent = "Original paragraph";
    let released = 0;
    const renderer = (el: HTMLElement, text: string, component: import("obsidian").Component) => {
      component.register(() => released++);
      el.textContent = text;
    };
    const options = { state: "done" as const, translation: "Translation", renderMarkdown: true };
    inject(source, options, renderer);
    assert.equal(released, 0);
    inject(source, options, renderer);
    assert.equal(released, 1, "re-render releases previous Markdown resources");
    markPending(source, renderer);
    assert.equal(released, 2, "placeholder releases rendered resources");
    inject(source, options, renderer);
    clearInjected(pane);
    assert.equal(released, 3, "clear releases immediately");
    inject(source, options, renderer);
    pane.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.equal(released, 4, "external preview removal releases resources");
  });

  await test("clearing an unfinished Markdown render releases resources and prevents late output", async () => {
    const pane = document.createElement("div");
    document.body.append(pane);
    const source = pane.createEl("p");
    source.textContent = "Original";
    let resolveRender!: () => void;
    let released = false;
    inject(source, { state: "done", translation: "Late", renderMarkdown: true }, (el, text, component) => {
      component.register(() => { released = true; });
      el.textContent = text;
      return new Promise<void>((resolve) => { resolveRender = resolve; });
    });
    clearInjected(pane);
    assert.ok(released);
    resolveRender();
    await Promise.resolve();
    assert.equal(pane.textContent, "Original");
    assert.equal(pane.querySelector(`.${WRAPPER_CLASS}`), null);
    pane.remove();
  });

  await test("collects prose blocks in reading order", () => {
    assert.deepEqual(texts(), [
      "Translating Papers",
      "A paragraph with a link and inline_code().",
      "Callout body text.",
      "Quoted prose.",
      "Bullet one",
      "Bullet as paragraph",
      "Column name",
      "Cell prose",
      "$x^2 + y^2$ is the circle",
      "Line one\nLine two",
    ]);
  });

  await test("skips code blocks, mermaid and math-only content", () => {
    const all = texts().join(" | ");
    assert.ok(!all.includes("do not translate me"), "code block must not be sent");
    assert.ok(!all.includes("graph TD"), "mermaid must not be sent");
    assert.ok(!all.includes("𝑥²+𝑦²"), "rendered math glyphs must not leak into the request");
    assert.ok(!all.includes("∇·"), "rendered block math glyphs must not leak");
  });

  await test("innermost block wins so nothing is translated twice", () => {
    const units = collectUnits(root);
    const quoteTexts = units.filter((unit) => unit.text === "Quoted prose.");
    assert.equal(quoteTexts.length, 1, "blockquote > p must yield exactly one unit");
    const bullets = units.filter((unit) => unit.text === "Bullet as paragraph");
    assert.equal(bullets.length, 1, "li > p must yield exactly one unit");
  });

  await test("inline code stays inside its paragraph text", () => {
    const unit = collectUnits(root).find((candidate) =>
      candidate.text.includes("inline_code")
    );
    assert.ok(unit, "paragraph containing inline code should still translate");
    assert.equal(extractText(unit!.el), "A paragraph with a link and inline_code().");
  });

  await test("injected translation is never re-collected as source", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Quoted prose.")!;
    inject(unit.el, { state: "done", translation: "被引用的文字。" }, (el, md) => {
      el.textContent = md;
    });
    const after = texts();
    assert.ok(after.includes("Quoted prose."), "source must remain");
    assert.ok(!after.includes("被引用的文字。"), "translation must not be treated as source");
    const wrapper = unit.el.nextElementSibling!;
    assert.ok(wrapper.classList.contains(WRAPPER_CLASS));
    assert.ok(wrapper.classList.contains("notranslate"), "wrapper must be marked notranslate");
    assert.equal(
      unit.el.getAttribute(UNIT_ATTRIBUTE),
      "done",
      "unit must carry its state for the session bookkeeping"
    );
  });

  await test("a translation rendered as Markdown does not cascade into new units", () => {
    const unit = collectUnits(root).find((candidate) =>
      candidate.text.startsWith("A paragraph with a link")
    )!;
    const before = texts();
    const renderMarkdown = (el: HTMLElement, markdown: string) => {
      // MarkdownRenderer.render puts real block nodes inside the wrapper body,
      // which is what made the plugin translate its own output.
      const paragraph = window.document.createElement("p");
      paragraph.textContent = markdown;
      el.appendChild(paragraph);
    };
    inject(
      unit.el,
      { state: "done", translation: "带链接的段落。", renderMarkdown: true },
      renderMarkdown
    );

    const wrapper = unit.el.nextElementSibling!;
    assert.ok(wrapper.querySelector("p"), "fixture must look like rendered Markdown");
    assert.deepEqual(texts(), before, "re-scanning after painting must find the same units");
    assert.ok(!texts().includes("带链接的段落。"), "translated markup must not become source");
    assert.ok(
      !wrapper.nextElementSibling?.classList.contains(WRAPPER_CLASS),
      "painting one paragraph must not cascade a second wrapper behind it"
    );
    assert.equal(
      wrapper.querySelectorAll(`.${WRAPPER_CLASS}`).length,
      0,
      "the translation must not contain a placeholder for itself"
    );
  });

  await test("markPending followed by done inject reuses the same wrapper without leaking placeholder", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Translating Papers")!;
    markPending(unit.el, (el, md) => { el.textContent = md; });
    const pendingWrapper = unit.el.nextElementSibling;
    assert.ok(pendingWrapper?.classList.contains(WRAPPER_CLASS));
    assert.equal(pendingWrapper.getAttribute("data-state"), "pending");

    inject(unit.el, { state: "done", translation: "论文翻译" }, (el, md) => {
      el.textContent = md;
    });

    const doneWrapper = unit.el.nextElementSibling;
    assert.equal(doneWrapper, pendingWrapper, "must reuse the existing wrapper");
    assert.equal(doneWrapper?.getAttribute("data-state"), "done");
    assert.ok(
      !doneWrapper?.nextElementSibling?.classList.contains(WRAPPER_CLASS),
      "must not leave a second wrapper / orphan placeholder row"
    );
  });

  await test("a cancelled unit leaves no blank placeholder row", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Callout body text.")!;
    markPending(unit.el, (el, markdown) => {
      el.textContent = markdown;
    });
    assert.equal(unit.el.getAttribute(UNIT_ATTRIBUTE), "pending");
    assert.ok(
      unit.el.nextElementSibling?.classList.contains(WRAPPER_CLASS),
      "the shimmer row exists while the request is in flight"
    );
    assert.ok(unfinishedUnits(root).includes(unit.el));

    dropUnit(unit.el);
    assert.ok(
      !unit.el.nextElementSibling?.classList.contains(WRAPPER_CLASS),
      "a cancelled request must not leave an empty row under the paragraph"
    );
    assert.equal(
      unit.el.getAttribute(UNIT_ATTRIBUTE),
      null,
      "a dropped unit must be collected again on the next session"
    );
  });

  await test("a failed unit's error row is unfinished and gets retried next session", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Bullet one")!;
    inject(unit.el, { state: "error", translation: "HTTP 429: too many requests" }, (el, md) => {
      el.textContent = md;
    });
    assert.equal(unit.el.getAttribute(UNIT_ATTRIBUTE), "error");
    assert.ok(unfinishedUnits(root).includes(unit.el), "an error row must be swept on restart");

    dropUnit(unit.el);
    assert.ok(
      !unit.el.nextElementSibling?.classList.contains(WRAPPER_CLASS),
      "the error row must go away"
    );
  });

  await test("a translation identical to the source leaves no node behind", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Bullet one")!;
    inject(unit.el, { state: "skipped", translation: "Bullet one" }, (el, md) => {
      el.textContent = md;
    });
    assert.equal(unit.el.nextElementSibling!.classList.contains(WRAPPER_CLASS), false);
  });

  await test("table cells host the wrapper inside the cell", () => {
    const cell = collectUnits(root).find((candidate) => candidate.text === "Cell prose")!;
    inject(cell.el, { state: "done", translation: "单元格文字" }, (el, md) => {
      el.textContent = md;
    });
    assert.equal(cell.el.tagName, "TD");
    assert.ok(cell.el.querySelector(`.${WRAPPER_CLASS}`), "cell cannot take a sibling row");
  });

  await test("a rendered cell does not cancel its own unit", () => {
    const cell = collectUnits(root).find((candidate) => candidate.text === "Column name")!;
    inject(cell.el, { state: "done", translation: "列名", renderMarkdown: true }, (el, markdown) => {
      const paragraph = window.document.createElement("p");
      paragraph.textContent = markdown;
      el.appendChild(paragraph);
    });
    // The wrapper now holds a <p>; the cell must not start looking like a block that
    // contains another unit, or the progress count would shrink mid-session.
    assert.ok(
      collectUnits(root).some((candidate) => candidate.text === "Column name"),
      "a painted header cell must still count as one unit"
    );
  });

  await test("a math-only paragraph is skipped entirely", () => {
    assert.ok(
      !texts().some((text) => text.includes("nabla")),
      "a paragraph holding only a display formula has no prose to translate"
    );
  });

  await test("painting a translation does not look like a note re-render", async () => {
    const pane = window.document.createElement("div");
    pane.className = "markdown-preview-view";
    pane.innerHTML = "<p>Brand new paragraph from Obsidian.</p>";
    window.document.body.appendChild(pane);

    const records: MutationRecord[] = [];
    const observer = new window.MutationObserver((list) => records.push(...list));
    observer.observe(pane, { childList: true, subtree: true });
    const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    const unit = collectUnits(pane as HTMLElement)[0];
    inject(unit.el, { state: "done", translation: "全新段落。" }, (el, markdown) => {
      el.textContent = markdown;
    });
    await flush();
    assert.ok(records.length > 0, "injection does mutate the preview subtree");
    assert.ok(
      records.every(isOwnInjection),
      "our own wrapper must not schedule another scan of the note"
    );

    observer.takeRecords();
    records.length = 0;
    const realBlock = window.document.createElement("p");
    realBlock.textContent = "Added by a real re-render.";
    pane.appendChild(realBlock);
    await flush();
    assert.ok(
      records.some((record) => !isOwnInjection(record)),
      "a genuine re-render must still be picked up"
    );

    observer.disconnect();
    pane.remove();
  });

  await test("inject applies requested style class on the wrapper", () => {
    const unit = collectUnits(root).find((candidate) => candidate.text === "Bullet one")!;
    inject(unit.el, { state: "done", translation: "项目一", style: "card" }, (el, md) => {
      el.textContent = md;
    });
    const wrapper = unit.el.nextElementSibling as HTMLElement;
    assert.ok(wrapper.classList.contains("obstr-style-card"));

    inject(unit.el, { state: "done", translation: "项目一", style: "quote" }, (el, md) => {
      el.textContent = md;
    });
    assert.ok(!wrapper.classList.contains("obstr-style-card"));
    assert.ok(wrapper.classList.contains("obstr-style-quote"));
  });

  await test("clearing restores the DOM to the original node count", () => {
    assert.ok(
      root.querySelectorAll(`.${WRAPPER_CLASS}`).length > 0,
      "fixture should carry injected nodes before cleanup"
    );
    clearInjected(root);
    assert.equal(root.querySelectorAll(`.${WRAPPER_CLASS}`).length, 0);
    assert.equal(
      root.querySelectorAll("*").length,
      ORIGINAL_NODE_COUNT,
      "cleanup must leave no residue"
    );
    assert.equal(root.querySelectorAll(`[${UNIT_ATTRIBUTE}]`).length, 0);
  });

  await test("orb parses as SVG in HTML, with grayscale paths and no lettering", () => {
    const button = document.createElement("button");
    button.innerHTML = FROG_ORB_SVG;
    const svg = button.querySelector("svg")!;
    assert.ok(svg);
    assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
    assert.ok(svg.querySelectorAll("path").length > 10);
    assert.equal(svg.querySelectorAll("text, image").length, 0);
    for (const path of svg.querySelectorAll("path")) {
      assert.match(path.getAttribute("fill")!, /^#([0-9a-f]{2})\1\1$/i);
    }
  });

  await test("shading follows inline Markdown while typography matches source", async () => {
    const pane = document.createElement("div");
    pane.innerHTML = '<h2 style="font-size: 24px; font-weight: 600; color: rgb(30, 30, 30); line-height: 36px">Heading</h2>';
    document.body.appendChild(pane);
    const source = pane.firstElementChild as HTMLElement;
    const before = source.outerHTML;
    inject(source, { state: "done", translation: "标题", renderMarkdown: true }, async (content) => {
      content.innerHTML = '<p>译文 <strong>重点</strong> <a href="#ref">链接</a></p>';
    });
    await Promise.resolve();
    const wrapper = source.nextElementSibling as HTMLElement;
    assert.equal(wrapper.style.fontSize, "24px");
    assert.equal(wrapper.style.fontWeight, "600");
    assert.equal(wrapper.style.lineHeight, "36px");
    assert.ok(wrapper.querySelector("p > .obstr-shaded-text > strong"));
    assert.ok(wrapper.querySelector(".obstr-shaded-text > a"));
    assert.equal(source.outerHTML.replace(' data-obstr-unit="done"', ''), before);
    clearInjected(pane);
    assert.equal(source.outerHTML, before);
    pane.remove();
  });

  await test("late Markdown render cannot overwrite a newer translation", async () => {
    const source = document.createElement("p");
    document.body.appendChild(source);
    let resolve!: () => void;
    inject(source, { state: "done", translation: "old", renderMarkdown: true }, async (content) => {
      await new Promise<void>((done) => { resolve = done; });
      content.textContent = "old";
    });
    inject(source, { state: "done", translation: "new" }, () => {});
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(source.nextElementSibling?.textContent, "new");
    source.nextElementSibling?.remove();
    source.remove();
  });

  await test("multi-paragraph quotes do not shade Markdown whitespace as empty lines", () => {
    const pane = document.createElement("div");
    pane.innerHTML = '<blockquote><p>First quoted paragraph.<br>Second line.</p><p>Another quoted paragraph.</p></blockquote>';
    document.body.appendChild(pane);
    const source = pane.querySelector("p")!;
    const originalUnits = collectUnits(pane).map((unit) => unit.text);
    inject(source, { state: "done", translation: "引用译文", renderMarkdown: true }, (content) => {
      // MarkdownRenderer emits separator newlines between its block elements.
      content.innerHTML = '\n<p>第一段译文。<br>第二行。</p>\n<p>第二段 <strong>重点</strong>。</p>\n<p>— 作者与日期</p>\n';
    });
    const body = source.nextElementSibling!.querySelector(".obstr-text")!;
    const shades = Array.from(body.querySelectorAll(".obstr-shaded-text"));
    assert.equal(shades.length, 3, "only the three real paragraphs need shading");
    assert.equal(body.querySelectorAll(":scope > .obstr-shaded-text").length, 0,
      "separator newlines must not become padded inline boxes between paragraphs");
    assert.ok(shades.every((shade) => !!shade.textContent?.trim()));
    assert.equal(body.querySelectorAll("br").length, 1, "keep intentional line breaks");
    assert.ok(body.querySelector(".obstr-shaded-text > strong"));
    assert.deepEqual(collectUnits(pane).map((unit) => unit.text), originalUnits);
    clearInjected(pane);
    pane.remove();
  });

  await test("theme refresh updates existing headings, quotes and cells without rendering again", () => {
    const pane = document.createElement("div");
    pane.innerHTML = '<h2>Heading</h2><blockquote><p>Quoted text.</p></blockquote><table><tbody><tr><td>Cell text.</td></tr></tbody></table><p>Error source.</p>';
    document.body.appendChild(pane);
    const sources = Array.from(pane.querySelectorAll<HTMLElement>("h2, blockquote p, td"));
    let renders = 0;
    for (const source of sources) {
      source.style.color = "rgb(30, 30, 30)";
      inject(source, { state: "done", translation: "译文", renderMarkdown: true }, (content) => {
        renders++;
        content.innerHTML = "<p><strong>译文</strong></p>";
      });
    }
    const bodies = sources.map((source) =>
      (source.tagName === "TD" ? source : source.nextElementSibling!).querySelector(".obstr-text")!
    );
    const originalMarkup = bodies.map((body) => body.innerHTML);
    const errorSource = pane.lastElementChild as HTMLElement;
    inject(errorSource, { state: "error", translation: "HTTP 429" }, () => {});
    for (const color of ["rgb(220, 220, 220)", "rgb(30, 30, 30)"]) {
      for (const source of sources) source.style.color = color;
      refreshInjectedTypography(pane);
      for (const body of bodies) assert.equal((body.parentElement as HTMLElement).style.color, color);
      assert.deepEqual(bodies.map((body) => body.innerHTML), originalMarkup);
      assert.equal((errorSource.nextElementSibling as HTMLElement).style.color, "");
    }
    assert.equal(renders, 3, "theme changes must not invoke the Markdown renderer");
    clearInjected(pane);
    pane.remove();
  });

  await test("orb is one native toggle button with reliable repeated and keyboard clicks", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    let enabled = false;
    let clicks = 0;
    const orb = new FloatingOrb(pane, { ...DEFAULT_SETTINGS }, {
      onToggle: () => { enabled = !enabled; clicks++; }, isRunning: () => enabled,
    });
    const button = pane.querySelector("button")!;
    assert.equal(pane.querySelectorAll("button").length, 1);
    assert.equal(pane.querySelector(".obstr-orb-menu"), null);
    for (let i = 1; i <= 6; i++) {
      button.click(); // native/assistive click: no pointer events required
      assert.equal(clicks, i);
      assert.equal(button.getAttribute("aria-pressed"), String(i % 2 === 1));
    }
    assert.equal((pane.firstElementChild as HTMLElement).style.right, "12px");
    orb.destroy(); pane.remove();
  });

  await test("dragging does not toggle, touch jitter does, and cancellation does not poison next tap", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    pane.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400 } as DOMRect);
    const settings = { ...DEFAULT_SETTINGS };
    let clicks = 0, saves = 0;
    const orb = new FloatingOrb(pane, settings, {
      onToggle: () => { clicks++; }, isRunning: () => false, onPositionChange: () => { saves++; },
    });
    const ball = pane.querySelector("button")!;
    const root = pane.firstElementChild as HTMLElement;
    root.getBoundingClientRect = () => {
      const left = 100 + (parseFloat(root.style.left) || 0);
      const top = 50 + (parseFloat(root.style.top) || 0);
      return { left, top, right: left + 44, bottom: top + 44, width: 44, height: 44 } as DOMRect;
    };
    const pointer = (name: string, x: number, y: number) => {
      const event = new window.Event(name, { bubbles: true });
      Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, pointerType: "touch", clientX: x, clientY: y });
      ball.dispatchEvent(event);
    };
    const click = () => ball.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
    pointer("pointerdown", 110, 60); pointer("pointermove", 150, 100); pointer("pointerup", 150, 100); click();
    assert.equal(clicks, 0);
    assert.equal(saves, 1);
    assert.equal(settings.orbCustomX, 12, "position must be relative to pane");
    pointer("pointerdown", 110, 60); pointer("pointermove", 113, 63); pointer("pointerup", 113, 63); click();
    assert.equal(clicks, 1);
    pointer("pointerdown", 110, 60); pointer("pointercancel", 110, 60);
    pointer("pointerdown", 110, 60); pointer("pointerup", 110, 60); click();
    assert.equal(clicks, 2);
    orb.destroy(); pane.remove();
  });

  await test("translation layer survives repeated off/on and delayed startup cannot revive it", async () => {
    const watchers: FakeViewport[] = [];
    class FakeViewport {
      targets = new Set<Element>();
      disconnected = false;
      constructor(private callback: (entries: {target: Element; isIntersecting: boolean}[]) => void) { watchers.push(this); }
      observe(el: Element) { this.targets.add(el); }
      unobserve(el: Element) { this.targets.delete(el); }
      disconnect() { this.disconnected = true; this.targets.clear(); }
      enter(el: Element) { this.callback([{ target: el, isIntersecting: true }]); }
    }
    Object.assign(globalThis, { IntersectionObserver: FakeViewport, MutationObserver: window.MutationObserver });
    const pane = document.createElement("div");
    pane.innerHTML = "<p>First paragraph for reading.</p><p>Another paragraph below the viewport.</p>";
    document.body.appendChild(pane);
    const settings = { ...DEFAULT_SETTINGS, renderMarkdown: false };
    const cache = new TranslationCache({ maxEntries: 20, ttlDays: 7 });
    for (const source of pane.querySelectorAll("p")) {
      cache.set(await hashKey(`${source.textContent}\u0000auto\u0000zh-CN\u0000google`), "译文");
    }
    const queue = new TranslateQueue({ capacity: 4, rate: 2, maxRetries: 0, baseRetryDelayMs: 1 });
    const batch = new BatchQueue(queue, { maxItems: 4, maxChars: 1000, delayMs: 1 });
    const session = new Orchestrator(queue, batch, cache, () => settings, (content, text) => { content.textContent = text; }, {
      onRunningChange: () => {}, onProgress: () => {}, onCacheWrite: () => {},
    });
    const starting = session.start(pane);
    assert.equal(session.isRunning(), true, "first click takes effect before provider hashing resolves");
    session.clear();
    await starting;
    assert.equal(session.isRunning(), false);
    assert.equal(watchers.length, 0, "cancelled initialization must not start observing");
    for (let round = 0; round < 3; round++) {
      await session.start(pane);
      const watcher = watchers[watchers.length - 1];
      assert.equal(watcher.targets.size, 2, "new session must observe previously translated blocks again");
      const first = pane.querySelector("p")!;
      watcher.enter(first);
      for (let i = 0; i < 100 && !pane.querySelector('.obstr-wrapper[data-state="done"]'); i++) {
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.equal(pane.querySelectorAll(".obstr-wrapper").length, 1, "offscreen paragraphs remain deferred");
      const second = Array.from(watcher.targets)[0];
      watcher.enter(second);
      for (let i = 0; i < 100 && pane.querySelectorAll('.obstr-wrapper[data-state="done"]').length !== 2; i++) {
        await new Promise((done) => setTimeout(done, 5));
      }
      assert.equal(pane.querySelectorAll('.obstr-wrapper[data-state="done"]').length, 2);
      session.clear();
      assert.equal(pane.querySelectorAll(".obstr-wrapper").length, 0);
      assert.equal(watcher.disconnected, true);
    }
    const firstStart = session.start(pane);
    session.clear();
    const nextStart = session.start(pane);
    await Promise.all([firstStart, nextStart]);
    assert.equal(session.isRunning(), true);
    assert.equal(watchers.filter((watcher) => !watcher.disconnected).length, 1);
    session.clear(); pane.remove();
  });

  console.log(results.join("\n"));
  const failures = results.filter((line) => line.startsWith("FAIL"));
  process.exitCode = failures.length > 0 ? 1 : 0;
}

void main();
