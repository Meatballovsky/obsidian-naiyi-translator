// Explicit opt-in: three synthetic HTTP requests, no vault text or credentials.
import assert from "node:assert/strict";
import { translateTexts } from "../src/engines";
import { DEFAULT_SETTINGS } from "../src/settings";
Object.assign(globalThis, { window: { setTimeout, clearTimeout } });

const originalFetch = globalThis.fetch;
const starts: number[] = [];
let active = 0, peak = 0;
globalThis.fetch = async (...args) => {
  starts.push(Date.now()); peak = Math.max(peak, ++active);
  try { return await originalFetch(...args); } finally { active--; }
};
async function main() {
  const start = Date.now();
  const output = await translateTexts([
    "A small cache reduces repeated network requests when readers revisit a paragraph.",
    "Please read `print(x)` and $x^2$ at [this page](https://example.org/guide).\nThe next line explains the example.",
  ], { ...DEFAULT_SETTINGS, engine: "google", requestTimeoutMs: 12000 });
  assert.ok(output.every((text) => /\p{Script=Han}/u.test(text)));
  assert.ok(output[1].includes("`print(x)`") && output[1].includes("$x^2$") && output[1].includes("\n"));
  assert.match(output[1], /\[[^\]\n]+\]\(https:\/\/example\.org\/guide\)/);
  assert.ok(output.every((text) => !text.includes("ZXQNAIYI")));
  assert.equal(peak, 1);
  assert.ok(starts.slice(1).every((time, i) => time - starts[i] >= 950));
  console.log(JSON.stringify({ ok: true, requests: starts.length, peak, startIntervalsMs: starts.slice(1).map((time, i) => time - starts[i]), totalMs: Date.now()-start, output }, null, 2));
}
void main().catch((error) => { console.error(String(error)); process.exitCode = 1; }).finally(() => { globalThis.fetch = originalFetch; });
