import { requestText } from "./http";
import { readMeta } from "../utils/retry-policy";
import { transportLimiter, type TransportPolicy } from "./transport";

const RPC_ID = "MkEWBc";
const RPC_URL = `https://translate.google.com/_/TranslateWebserverUi/data/batchexecute?rpcids=${RPC_ID}`;
const LEGACY_URL = "https://translate.googleapis.com/translate_a/single";
/** One physical request at a time, no initial burst, even for link labels/retries. */
export const GOOGLE_POLICY: TransportPolicy = {
  key: "google-anonymous", capacity: 1, minIntervalMs: 1000, rateLimitPauseMs: 30_000,
};

function item(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

function joinSegments(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value.map((segment) => typeof item(segment, 0) === "string" ? item(segment, 0) : "").join("");
  return text.trim() ? text : null;
}

/** Web RPC returns an XSSI prefix and line-framed, nested JSON records. */
export function parseGoogleRpc(text: string): string {
  for (const line of text.replace(/^\)\]\}'/, "").split(/\r?\n/)) {
    if (!line.trim().startsWith("[")) continue;
    let records: unknown;
    try { records = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (item(record, 0) !== "wrb.fr" || item(record, 1) !== RPC_ID || typeof item(record, 2) !== "string") continue;
      let payload: unknown;
      try { payload = JSON.parse(item(record, 2) as string); } catch { continue; }
      const segments = item(item(item(item(payload, 1), 0), 0), 5);
      const result = joinSegments(segments);
      if (result) return result;
    }
  }
  throw new Error("Unexpected Google Web RPC response format");
}

export function parseGoogleLegacy(text: string): string {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("Unexpected Google legacy response format"); }
  const result = joinSegments(item(data, 0));
  if (result === null) throw new Error("Empty or malformed Google legacy translation");
  return result;
}

/** No keys/cookies. Fall back for protocol/server failures, never around a 429. */
export async function googleTranslate(
  text: string, fromLang: string, toLang: string, timeoutMs = 20000, signal?: AbortSignal
): Promise<string> {
  if (!text.trim()) return "";
  const language = (code: string) => ({ "zh-Hans": "zh-CN", "zh-Hant": "zh-TW", nb: "no", fil: "tl" }[code] ?? code);
  const from = language(fromLang || "auto"), to = language(toLang);
  const deadline = Date.now() + timeoutMs;
  const request = JSON.stringify([[[RPC_ID, JSON.stringify([[text, from, to, true], [null]]), null, "generic"]]]);
  const options = () => ({ timeoutMs: Math.max(1, Math.min(8000, deadline - Date.now())), signal, policy: GOOGLE_POLICY });
  const checkHtml = (body: string) => {
    if (/<!doctype html|<html[\s>]/i.test(body)) {
      // A challenge page is not a protocol failure: do not fan out to other hosts.
      transportLimiter.rateLimited(GOOGLE_POLICY);
      throw Object.assign(new Error("Google returned an HTML verification page; wait or choose another translation source."), { status: 403 });
    }
    return body;
  };
  try {
    return parseGoogleRpc(checkHtml(await requestText(RPC_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ "f.req": request }).toString(),
    }, options())));
  } catch (error) {
    const status = readMeta(error).statusCode;
    if (signal?.aborted || [400, 401, 403, 413, 422, 429].includes(status ?? 0) || /timed? out|timeout/i.test(String(error))) {
      if (status === 429 && error instanceof Error) error.message = "Google anonymous translation is rate limited (HTTP 429). Requests are cooling down; a shared network/proxy exit can also trigger this. Try another source if it persists.";
      throw error;
    }
    if (Date.now() >= deadline) throw error;
    const params = new URLSearchParams({ client: "gtx", sl: from, tl: to, dt: "t", strip: "1", nonced: "1", q: text });
    return parseGoogleLegacy(checkHtml(await requestText(`${LEGACY_URL}?${params}`, { method: "GET" }, options())));
  }
}
