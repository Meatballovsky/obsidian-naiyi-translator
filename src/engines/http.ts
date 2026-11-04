import { transportLimiter, type TransportPolicy } from "./transport";
import { requestUrl } from "obsidian";

import { attachRequestErrorMeta, parseRetryAfterMs } from "../utils/retry-policy";

export interface HttpError extends Error {
  status?: number;
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: TransportPolicy;
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
  return parseJson<T>(await requestText(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
    }, options));
}

/** Keeps status handling inside the attempt so a 429 gates waiting HTTP work. */
export function requestText(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, options: PostJsonOptions = {}): Promise<string> {
  return transportLimiter.run(async () => {
    const response = await requestUrl({ url, ...init, throw: false });
    if (response.status < 200 || response.status >= 300) {
      const error = statusError(response.status, response.text ?? "", response.headers);
      if (response.status === 429 && options.policy) {
        const pause = transportLimiter.rateLimited(options.policy, parseRetryAfterMs(response.headers));
        attachRequestErrorMeta(error, { retryAfterMs: pause });
      }
      throw error;
    }
    if (options.policy) transportLimiter.succeeded(options.policy);
    return response.text;
  }, options.timeoutMs, options.signal, options.policy);
}

export async function getJson<T = unknown>(
  url: string,
  options: PostJsonOptions = {}
): Promise<T> {
  return parseJson<T>(await requestText(url, { method: "GET", headers: options.headers }, options));
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
