import { transportLimiter } from "./transport";
import { requestUrl } from "obsidian";

import { attachRequestErrorMeta, parseRetryAfterMs } from "../utils/retry-policy";

export interface HttpError extends Error {
  status?: number;
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
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
  const response = await transportLimiter.run(() => requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      throw: false,
    }), options.timeoutMs, options.signal);
  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, response.text ?? "", response.headers);
  }
  return parseJson<T>(response.text);
}

export async function getJson<T = unknown>(
  url: string,
  options: PostJsonOptions = {}
): Promise<T> {
  const response = await transportLimiter.run(() => requestUrl({ url, method: "GET", throw: false }),
    options.timeoutMs, options.signal
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
