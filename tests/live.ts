import assert from "node:assert/strict";
import { googleTranslate } from "../src/engines/google";
import { microsoftTranslate, microsoftTranslateBatch } from "../src/engines/microsoft";
import { aiTranslateBatch, aiTranslate } from "../src/engines/ai";
import { DEFAULT_SETTINGS, type AiEndpointSettings } from "../src/settings";

const results: string[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const SAMPLES = [
  "The interpreter parses the source before evaluation.",
  "a < b and c > d should not be read as markup",
  "Caching removes repeated network calls for the same paragraph.",
];

async function main(): Promise<void> {
  await test("microsoft translates a batch with 1:1 mapping", async () => {
    const out = await microsoftTranslateBatch(SAMPLES, "auto", "zh-CN", 15000);
    assert.equal(out.length, SAMPLES.length);
    out.forEach((text, index) => {
      assert.ok(text.trim().length > 0, `item ${index} came back empty`);
    });
  });

  await test("microsoft does not let a bare < become a tag", async () => {
    const out = await microsoftTranslate(SAMPLES[1], "auto", "zh-CN", 15000);
    assert.ok(out.includes("<") && out.includes(">"), `angle brackets lost: ${out}`);
  });

  for (const [label, ai] of localEndpoints()) {
    await test(`ai ${label}: single translation`, async () => {
      const out = await aiTranslate(ai, SAMPLES[0], "简体中文", "auto", 60000);
      assert.ok(/[一-鿿]/.test(out), `expected Chinese, got ${out.slice(0, 80)}`);
      assert.ok(!out.includes("%%"), "single reply must not invent a separator");
    });

    await test(`ai ${label}: batch maps back 1:1`, async () => {
      const out = await aiTranslateBatch(ai, SAMPLES, "简体中文", "auto", 90000);
      assert.equal(out.length, SAMPLES.length, "batch segment count must match");
      out.forEach((text, index) => {
        assert.ok(/[一-鿿]/.test(text), `segment ${index} is not Chinese: ${text.slice(0, 60)}`);
        assert.ok(!text.includes("%%"), `segment ${index} leaks a separator`);
      });
    });
  }

  // Google's web endpoint throttles bursts from a single IP, and the queue now
  // pauses on 429, so a rate-limited probe is slow instead of informative.
  if (process.env.GOOGLE_PROBE === "1") {
    await test("google translates a single unit", async () => {
      const out = await googleTranslate(SAMPLES[0], "auto", "zh-CN", 15000);
      assert.ok(out.length > 0, "empty translation");
      assert.ok(/[一-鿿]/.test(out), `expected Chinese, got ${out}`);
    });

    await test("google leaves already-target-language text alone", async () => {
      const out = await googleTranslate("已经翻译过的中文段落。", "auto", "zh-CN", 15000);
      assert.ok(out.includes("中文"), `expected passthrough, got ${out}`);
    });
  } else {
    results.push("skip google probes (set GOOGLE_PROBE=1 to run them last)");
  }

  console.log(results.join("\n"));
  process.exitCode = results.some((line) => line.startsWith("FAIL")) ? 1 : 0;
}

function localEndpoints(): [string, AiEndpointSettings][] {
  const base = DEFAULT_SETTINGS.ai;
  const out: [string, AiEndpointSettings][] = [];
  if (process.env.OPENAI_BASE_URL) {
    out.push(["openai", { ...base, baseUrl: process.env.OPENAI_BASE_URL, model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" }]);
  }
  if (process.env.OLLAMA_BASE_URL) {
    out.push(["ollama", { ...base, baseUrl: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b" }]);
  }
  if (process.env.OMLX_BASE_URL) {
    out.push(["omlx", { ...base, baseUrl: process.env.OMLX_BASE_URL, model: process.env.OMLX_MODEL ?? "qwen2.5:7b" }]);
  }
  if (process.env.AI_BASE_URL) {
    out.push(["custom", { ...base, baseUrl: process.env.AI_BASE_URL, model: process.env.AI_MODEL ?? "qwen2.5:7b" }]);
  }
  return out;
}

void main();
