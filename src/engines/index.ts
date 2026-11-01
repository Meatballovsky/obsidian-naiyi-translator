import { BILIBILI_MODEL, bilibiliTranslate } from "./bilibili";
import { protectText, validateTranslation, TranslationValidationError } from "./protection";
import type { TranslatorSettings } from "../settings";
import { googleTranslate } from "./google";
import { microsoftTranslateBatch } from "./microsoft";
import { aiTranslate, aiTranslateBatch, BatchCountMismatchError } from "./ai";
import { hashKey } from "../utils/hash";
import { listModels as aiListModels } from "./ai";

/** How many times to re-ask before giving up on batch→segments mapping. */
const BATCH_MAP_RETRIES = 2;
const BATCH_RETRY_BASE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * A provider identity is part of every cache key, so switching model, endpoint
 * or prompt must not reuse a stale translation.
 */
export async function providerIdentity(settings: TranslatorSettings): Promise<string> {
  const { engine, ai } = settings;
  if (engine === "bilibili") return `v2:bilibili:${BILIBILI_MODEL}`;
  if (engine !== "ai") return `v2:${engine}`;
  const promptHash = await hashKey(`${ai.systemPrompt}\u0000${ai.userPrompt}`);
  return `v2:ai\u0000${ai.baseUrl}\u0000${ai.model}\u0000${ai.temperature}\u0000${promptHash}`;
}

async function translateBatch(
  texts: string[],
  settings: TranslatorSettings,
  signal?: AbortSignal
): Promise<string[]> {
  const { engine, sourceLang, targetLang, requestTimeoutMs, ai } = settings;

  if (texts.length === 0) return [];

  if (engine === "bilibili") {
    const out: string[] = [];
    for (const text of texts) out.push(await bilibiliTranslate(text, sourceLang, targetLang, requestTimeoutMs, signal));
    return out;
  }

  if (engine === "google") {
    // No reliable N:N mapping on the gtx endpoint; one request per unit.
    const out: string[] = [];
    for (const text of texts) {
      out.push(await googleTranslate(text, sourceLang, targetLang, requestTimeoutMs, signal));
    }
    return out;
  }

  if (engine === "microsoft") {
    return microsoftTranslateBatch(texts, sourceLang, targetLang, requestTimeoutMs, signal);
  }

  try {
    return await aiTranslateBatch(
      ai,
      texts,
      targetLang,
      sourceLang,
      aiTimeout(texts, settings), signal
    );
  } catch (error) {
    if (!(error instanceof BatchCountMismatchError)) throw error;
    for (let attempt = 1; attempt <= BATCH_MAP_RETRIES; attempt++) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
      await sleep(BATCH_RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        return await aiTranslateBatch(
          ai,
          texts,
          targetLang,
          sourceLang,
          aiTimeout(texts, settings), signal
        );
      } catch (retryError) {
        if (!(retryError instanceof BatchCountMismatchError)) throw retryError;
      }
    }
    // Last resort: individual requests, sequential so a misbehaving model
    // cannot fan out into a burst past the rate limiter.
    const out: string[] = [];
    for (const text of texts) {
      out.push(await aiTranslate(ai, text, targetLang, sourceLang, aiTimeout([text], settings), signal));
    }
    return out;
  }
}

/** A long batch on a slow local model cannot fit the single-request timeout. */
function aiTimeout(texts: string[], settings: TranslatorSettings): number {
  // A local model's first request pays model loading, so the AI endpoint carries
  // its own budget instead of the free-API timeout.
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.min(
    settings.ai.timeoutMs * 4,
    settings.ai.timeoutMs + chars * 20
  );
}

export const listModels = aiListModels;

export function canBatch(settings: TranslatorSettings): boolean {
  // Google's endpoint re-segments, so batching there loses the 1:1 mapping.
  return settings.engine === "microsoft" || settings.engine === "ai";
}

export function maxItemsPerBatch(settings: TranslatorSettings): number {
  return canBatch(settings) ? settings.maxItemsPerBatch : 1;
}

export async function translateTexts(
  texts: string[],
  settings: TranslatorSettings,
  signal?: AbortSignal
): Promise<string[]> {
  const protectedTexts = texts.map(protectText);
  const indexes = protectedTexts.flatMap((item, index) => /[\p{L}\p{N}]/u.test(item.prose) ? [index] : []);
  const results = await translateBatch(indexes.map((index) => protectedTexts[index].text), settings, signal);
  if (results.length !== indexes.length) throw new TranslationValidationError("Translation result count mismatch.");
  const output = texts.map((text) => text.trim() ? text : "");
  indexes.forEach((index, position) => {
    const item = protectedTexts[index];
    const result = results[position];
    const restored = item.restore(result);
    // Remove protected material from the check so preserved URLs/code do not
    // make a successful translation appear to be an untranslated passage.
    const translatedProse = result.replace(/ZXQNAIYIX*\d+QXZ/g, " ");
    validateTranslation(item.prose, translatedProse, settings.targetLang);
    output[index] = restored;
  });
  return output;
}
