/**
 * Error classification and retry decisions, ported from read-frog's request
 * retry policy. A rate limit must pause the whole queue instead of burning the
 * per-task retry budget, and a permanent config error must fail the backlog at
 * once rather than paragraph by paragraph.
 */

export type RequestErrorKind =
  | "rate-limit"
  | "timeout"
  | "network"
  | "bad-request"
  | "access-denied"
  | "unknown";

export interface RequestErrorMeta {
  kind: RequestErrorKind;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
}

export interface RequestRetryContext {
  now: number;
  /** Ordinary failures spent on this task. */
  retryCount: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  /** 429 retries spent on this task; a separate budget from retryCount. */
  rateLimitRetryCount: number;
  /** Queue-level pause windows since the last successful request. */
  consecutiveRateLimits: number;
}

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "pause-and-retry"; pauseMs: number }
  | { action: "fail"; failQueue?: boolean };

export interface RequestRetryPolicy {
  decide: (error: unknown, context: RequestRetryContext) => RetryDecision;
}

/** Ceiling for any single retry or pause, so a bogus Retry-After cannot wedge the queue. */
export const MAX_RETRY_DELAY_MS = 5 * 60_000;
/**
 * Base pause after a 429 with no Retry-After; doubles per consecutive window.
 * Sized for the slowest free tier in use (Google's web endpoint throttles bursts
 * hard), so the first pause is short enough to stay interactive.
 */
export const RATE_LIMIT_BASE_PAUSE_MS = 5_000;
/** Pause windows without an intervening success before the backlog is failed. */
export const MAX_CONSECUTIVE_RATE_LIMIT_PAUSES = 5;
/** Per-task 429 cap for the case where queue counters keep resetting. */
export const MAX_RATE_LIMIT_RETRIES_PER_TASK = 8;

const RATE_LIMIT_ERROR_RE = /\b429\b|too many requests|rate[ -]?limit/i;
const TIMEOUT_ERROR_RE = /timed? out|timeout/i;
const NETWORK_ERROR_RE = /network error|failed to fetch|fetch failed|err_connection|err_name_not_resolved/i;
const ACCESS_DENIED_RE = /\b(401|403)\b|unauthorized|forbidden/i;

const ERROR_META = Symbol("obstrRequestErrorMeta");

export function attachRequestErrorMeta<T extends Error>(
  error: T,
  meta: Partial<RequestErrorMeta>
): T {
  const merged: RequestErrorMeta = {
    ...readMeta(error),
    ...removeUndefined(meta),
  };
  Object.defineProperty(error, ERROR_META, {
    value: merged,
    configurable: true,
  });
  return error;
}

export function readMeta(error: unknown): RequestErrorMeta {
  const carried = (error as Record<symbol, unknown> | undefined)?.[ERROR_META] as
    | RequestErrorMeta
    | undefined;
  if (carried) return carried;

  const statusCode = normalizeStatusCode(
    (error as { status?: unknown } | undefined)?.status
  );
  const message = error instanceof Error ? error.message : String(error ?? "");
  return { kind: inferKind(statusCode, message), statusCode, message };
}

export const defaultRequestRetryPolicy: RequestRetryPolicy = {
  decide(error, context) {
    const meta = readMeta(error);

    // Wrong key / wrong model / dead endpoint: every queued sibling would fail
    // identically, so drain the backlog instead of walking through it.
    if (isQueueFatal(meta)) return { action: "fail", failQueue: true };

    if (isRateLimit(meta)) {
      if (
        context.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMIT_PAUSES ||
        context.rateLimitRetryCount >= MAX_RATE_LIMIT_RETRIES_PER_TASK
      ) {
        return { action: "fail", failQueue: true };
      }
      const retryAfterMs = meta.retryAfterMs ?? 0;
      const backoffMs = RATE_LIMIT_BASE_PAUSE_MS * 2 ** context.consecutiveRateLimits;
      return {
        action: "pause-and-retry",
        pauseMs: clampRetryDelay(Math.max(retryAfterMs, withJitter(backoffMs))),
      };
    }

    if (context.retryCount >= context.maxRetries || !isRetryable(meta)) {
      return { action: "fail" };
    }

    return {
      action: "retry",
      delayMs: clampRetryDelay(withJitter(context.baseRetryDelayMs * 2 ** context.retryCount)),
    };
  },
};

function isRateLimit(meta: RequestErrorMeta): boolean {
  return meta.kind === "rate-limit" || meta.statusCode === 429;
}

function isQueueFatal(meta: RequestErrorMeta): boolean {
  return (
    meta.kind === "access-denied" ||
    meta.statusCode === 401 ||
    meta.statusCode === 403 ||
    meta.statusCode === 404
  );
}

function isRetryable(meta: RequestErrorMeta): boolean {
  if (meta.kind === "bad-request" || meta.kind === "access-denied") return false;
  if (meta.kind === "rate-limit" || meta.kind === "timeout" || meta.kind === "network") return true;

  const { statusCode } = meta;
  if (statusCode !== undefined) {
    if (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) {
      return true;
    }
    if (statusCode >= 400 && statusCode < 500) return false;
  }
  return true;
}

/**
 * `retry-after` in seconds or an HTTP date; `retry-after-ms` wins when present.
 * Called with the response headers the provider sent on the failure.
 */
export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  now = Date.now()
): number | undefined {
  if (!headers) return undefined;
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;

  const milliseconds = Number.parseFloat(lower["retry-after-ms"] ?? "");
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;

  const retryAfter = lower["retry-after"];
  if (!retryAfter) return undefined;

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const deadline = Date.parse(retryAfter);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - now);
}

function inferKind(statusCode: number | undefined, message: string): RequestErrorKind {
  if (statusCode === 429 || RATE_LIMIT_ERROR_RE.test(message)) return "rate-limit";
  if (statusCode === 401 || statusCode === 403 || ACCESS_DENIED_RE.test(message)) {
    return "access-denied";
  }
  if (statusCode === 408 || TIMEOUT_ERROR_RE.test(message)) return "timeout";
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return "bad-request";
  if (NETWORK_ERROR_RE.test(message)) return "network";
  return "unknown";
}

/** Spread the wait so a whole backlog does not retry in lockstep on the next 429. */
function withJitter(delayMs: number): number {
  return delayMs + Math.random() * 0.1 * delayMs;
}

function clampRetryDelay(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), MAX_RETRY_DELAY_MS);
}

function normalizeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}
