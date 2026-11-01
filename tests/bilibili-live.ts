// Explicit opt-in probe: synthetic text only, no credentials or note content.
import assert from "node:assert/strict";
import { translateTexts } from "../src/engines";
import { DEFAULT_SETTINGS } from "../src/settings";
Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
async function main() {
  const settings = { ...DEFAULT_SETTINGS, engine: "bilibili" as const };
  for (const text of [
    "A small cache reduces memory latency when the same data is read repeatedly.",
    "Run `print(x)` to evaluate $x^2$. Read [the guide](https://example.org/guide).\nThis sentence belongs to the second line.",
  ]) {
    const start = Date.now();
    const [translated] = await translateTexts([text], settings);
    assert.ok(/[\u4e00-\u9fff]/.test(translated));
    if (text.includes("print(x)")) {
      for (const item of ["`print(x)`", "$x^2$", "https://example.org/guide", "\n"]) assert.ok(translated.includes(item), item);
      assert.ok(!translated.includes("ZXQNAIYI"));
    }
    console.log(JSON.stringify({ input_chars: text.length, seconds: (Date.now() - start) / 1000, translated }));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
