import { getJson } from "./http";

interface GoogleSegment {
  0: string | null;
  1: string | null;
}

/**
 * The free `client=gtx` endpoint. It re-segments sentences with its own
 * splitter, so batching multiple units into one request cannot be mapped back
 * 1:1 — callers must issue one request per unit and rely on the rate limiter.
 */
export async function googleTranslate(
  text: string,
  fromLang: string,
  toLang: string,
  timeoutMs?: number
): Promise<string> {
  if (!text.trim()) return "";
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=${encodeURIComponent(fromLang || "auto")}` +
    `&tl=${encodeURIComponent(toLang)}&dt=t` +
    `&q=${encodeURIComponent(text)}`;

  const data = await getJson<unknown[]>(url, { timeoutMs });
  const blocks = data?.[0];
  if (!Array.isArray(blocks)) return "";

  let out = "";
  for (const segment of blocks as GoogleSegment[]) {
    if (typeof segment?.[0] === "string") out += segment[0];
  }
  return out;
}
