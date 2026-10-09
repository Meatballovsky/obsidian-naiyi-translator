import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
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
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  getComputedStyle: window.getComputedStyle.bind(window),
});

const root = window.document.querySelector<HTMLElement>(".markdown-preview-view")!;
// Captured before any injection so cleanup can be checked against the original DOM.
const ORIGINAL_NODE_COUNT = root.querySelectorAll("*").length;
const texts = () => collectUnits(root).map((unit) => unit.text);

async function main(): Promise<void> {
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

  console.log(results.join("\n"));
  const failures = results.filter((line) => line.startsWith("FAIL"));
  process.exitCode = failures.length > 0 ? 1 : 0;
}

void main();
