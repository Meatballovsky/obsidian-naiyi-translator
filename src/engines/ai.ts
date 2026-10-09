import { getJson, postJson } from "./http";
import type { AiEndpointSettings } from "../settings";
import { BATCH_SEPARATOR } from "../settings";

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
  }[];
}

interface ModelsResponse {
  data?: { id?: string }[];
}

export class BatchCountMismatchError extends Error {
  constructor(public readonly expected: number, public readonly got: number) {
    super(`AI batch reply had ${got} segments for ${expected} inputs`);
    this.name = "BatchCountMismatchError";
  }
}

const BATCH_RULES = `## Multi-paragraph Translation Rules
1. The input contains ${BATCH_SEPARATOR} on standalone lines separating paragraphs to translate. Put a standalone ${BATCH_SEPARATOR} line between each translation in your output.
2. **CRITICAL**: Treat ${BATCH_SEPARATOR} as a separator only when it appears on its own line. Never introduce ${BATCH_SEPARATOR} inside translated text.
3. Output exactly the same number of segments as the input has, in the same order. Do not merge or drop a segment, even if some segments are already in the target language.`;

function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

// Built by concatenation so this source never contains a literal tag closer.
const THINK_END = "<" + "/think>";

/**
 * Reasoning models leak chain-of-thought either into a dedicated field or inline
 * ahead of the answer; both shapes are handled here.
 */
export function extractContent(message: {
  content?: string;
  reasoning_content?: string;
}): string {
  const raw = message.content ?? "";
  const closed = raw.lastIndexOf(THINK_END);
  const content = closed === -1 ? raw : raw.slice(closed + THINK_END.length);
  return content.trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * `reasoning_effort` is honored by Ollama, OMLX, and other OpenAI-compatible servers.
 * Translation gains nothing from chain of thought, and leaving it on multiplies latency
 * on a local model.
 */
function buildRequestBody(
  ai: AiEndpointSettings,
  system: string,
  user: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ai.model,
    temperature: ai.temperature,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (ai.disableThinking) body.reasoning_effort = "none";
  return body;
}

async function requestChat(
  ai: AiEndpointSettings,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs?: number
): Promise<string> {
  const data = await postJson<ChatCompletionResponse>(
    `${normalizeBaseUrl(ai.baseUrl)}/chat/completions`,
    buildRequestBody(ai, systemPrompt, userPrompt),
    {
      timeoutMs,
      headers: ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : undefined,
    }
  );

  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("AI endpoint returned no message");
  const content = extractContent(message);
  if (!content) throw new Error("AI endpoint returned empty content");
  return content;
}

export function buildSinglePrompts(
  ai: AiEndpointSettings,
  targetLang: string,
  sourceLang: string
): { system: string; user: (input: string) => string } {
  const values = { targetLang, sourceLang };
  return {
    system: applyTemplate(ai.systemPrompt, values),
    user: (input: string) => applyTemplate(ai.userPrompt, { ...values, input }),
  };
}

export async function aiTranslate(
  ai: AiEndpointSettings,
  text: string,
  targetLang: string,
  sourceLang: string,
  timeoutMs?: number
): Promise<string> {
  if (!text.trim()) return "";
  const prompts = buildSinglePrompts(ai, targetLang, sourceLang);
  return requestChat(ai, prompts.system, prompts.user(text), timeoutMs);
}

export function joinBatch(texts: string[]): string {
  return texts.join(`\n\n${BATCH_SEPARATOR}\n\n`);
}

export function parseBatchResult(raw: string, expected: number): string[] {
  const parts = raw
    .split(/\r?\n[ \t]*%%[ \t]*\r?\n/)
    .map((part) => part.trim());
  if (parts.length !== expected) {
    throw new BatchCountMismatchError(expected, parts.length);
  }
  return parts;
}

export async function aiTranslateBatch(
  ai: AiEndpointSettings,
  texts: string[],
  targetLang: string,
  sourceLang: string,
  timeoutMs?: number
): Promise<string[]> {
  if (texts.length === 1) {
    return [await aiTranslate(ai, texts[0], targetLang, sourceLang, timeoutMs)];
  }
  const prompts = buildSinglePrompts(ai, targetLang, sourceLang);
  const raw = await requestChat(
    ai,
    `${prompts.system}\n\n${BATCH_RULES}`,
    prompts.user(joinBatch(texts)),
    timeoutMs
  );
  return parseBatchResult(raw, texts.length);
}

/** Lets the settings tab pick a real model id instead of guessing one. */
export async function listModels(ai: AiEndpointSettings): Promise<string[]> {
  const data = await getJson<ModelsResponse>(`${normalizeBaseUrl(ai.baseUrl)}/models`, {
    timeoutMs: 8000,
    headers: ai.apiKey ? { Authorization: `Bearer ${ai.apiKey}` } : undefined,
  });
  return (data?.data ?? []).map((entry) => entry.id ?? "").filter(Boolean);
}
