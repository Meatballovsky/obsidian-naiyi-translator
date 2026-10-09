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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A provider identity is part of every cache key, so switching model, endpoint
 * or prompt must not reuse a stale translation.
 */
export async function providerIdentity(settings: TranslatorSettings): Promise<string> {
  const { engine, ai } = settings;
  if (engine !== "ai") return engine;
  const promptHash = await hashKey(`${ai.systemPrompt}\u0000${ai.userPrompt}`);
  return `ai\u0000${ai.baseUrl}\u0000${ai.model}\u0000${ai.temperature}\u0000${promptHash}`;
}

async function translateBatch(
  texts: string[],
  settings: TranslatorSettings
): Promise<string[]> {
  const { engine, sourceLang, targetLang, requestTimeoutMs, ai } = settings;

  if (texts.length === 0) return [];

  if (engine === "google") {
    // No reliable N:N mapping on the gtx endpoint; one request per unit.
    const out: string[] = [];
    for (const text of texts) {
      out.push(await googleTranslate(text, sourceLang, targetLang, requestTimeoutMs));
    }
    return out;
  }

  if (engine === "microsoft") {
    return microsoftTranslateBatch(texts, sourceLang, targetLang, requestTimeoutMs);
  }

  try {
    return await aiTranslateBatch(
      ai,
      texts,
      targetLang,
      sourceLang,
      aiTimeout(texts, settings)
    );
  } catch (error) {
    if (!(error instanceof BatchCountMismatchError)) throw error;
    for (let attempt = 1; attempt <= BATCH_MAP_RETRIES; attempt++) {
      await sleep(BATCH_RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        return await aiTranslateBatch(
          ai,
          texts,
          targetLang,
          sourceLang,
          aiTimeout(texts, settings)
        );
      } catch (retryError) {
        if (!(retryError instanceof BatchCountMismatchError)) throw retryError;
      }
    }
    // Last resort: individual requests, sequential so a misbehaving model
    // cannot fan out into a burst past the rate limiter.
    const out: string[] = [];
    for (const text of texts) {
      out.push(await aiTranslate(ai, text, targetLang, sourceLang, aiTimeout([text], settings)));
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
  return settings.engine !== "google";
}

export function maxItemsPerBatch(settings: TranslatorSettings): number {
  return canBatch(settings) ? settings.maxItemsPerBatch : 1;
}

export async function translateTexts(
  texts: string[],
  settings: TranslatorSettings
): Promise<string[]> {
  const clean = texts.filter((text) => text.trim().length > 0);
  if (clean.length !== texts.length) {
    // Preserve index alignment for the caller.
    const results = await translateBatch(clean, settings);
    let cursor = 0;
    return texts.map((text) =>
      text.trim().length > 0 ? results[cursor++] ?? "" : ""
    );
  }
  return translateBatch(texts, settings);
}
