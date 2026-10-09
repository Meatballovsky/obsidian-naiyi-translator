import { requestUrl } from "obsidian";

import { attachRequestErrorMeta, parseRetryAfterMs } from "../utils/retry-policy";

export interface HttpError extends Error {
  status?: number;
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

class TimeoutError extends Error {
  status = 0;
  constructor() {
    super("Request timed out");
    this.name = "TimeoutError";
    attachRequestErrorMeta(this, { kind: "timeout" });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new TimeoutError()), timeoutMs);
  });
  // The underlying request keeps running but its result is discarded; callers
  // gate on a session version so a late response can never paint.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

function statusError(
  status: number,
  body: string,
  headers?: Record<string, string>
): HttpError {
  const err = new Error(
    `HTTP ${status}: ${body.slice(0, 300)}`
  ) as HttpError;
  err.status = status;
  attachRequestErrorMeta(err, {
    statusCode: status,
    retryAfterMs: parseRetryAfterMs(headers),
  });
  return err;
}

/**
 * All provider traffic goes through Obsidian's requestUrl, which dispatches from
 * the main process, so renderer CORS and Chrome-style private-network preflight
 * never apply. Local endpoints on 127.0.0.1 need no special binding.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  options: PostJsonOptions = {}
): Promise<T> {
  const response = await withTimeout(
    requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      throw: false,
    }),
    options.timeoutMs
  );
  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, response.text ?? "", response.headers);
  }
  return parseJson<T>(response.text);
}

export async function getJson<T = unknown>(
  url: string,
  options: PostJsonOptions = {}
): Promise<T> {
  const response = await withTimeout(
    requestUrl({ url, method: "GET", throw: false }),
    options.timeoutMs
  );
  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, response.text ?? "", response.headers);
  }
  return parseJson<T>(response.text);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const err = new Error(
      `Malformed JSON response: ${text.slice(0, 200)}`
    ) as HttpError;
    err.status = 0;
    throw err;
  }
}
