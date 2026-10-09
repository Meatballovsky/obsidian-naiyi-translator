import assert from "node:assert/strict";
// Scheduling uses the host window; Node provides equivalent timer primitives.
Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
import { TranslateQueue, isCancelled, type QueueOptions, type QueueTask } from "../src/schedule/queue";
import { BatchQueue } from "../src/schedule/batch-queue";
import { TranslationCache } from "../src/schedule/cache";
import { parseBatchResult, joinBatch, BatchCountMismatchError } from "../src/engines/ai";
import { escapeEntities, unescapeEntities } from "../src/utils/entities";
import { DEFAULT_SETTINGS } from "../src/settings";
import { meetsMinimum } from "../src/chunk/paragraphs";
import {
  MAX_CONSECUTIVE_RATE_LIMIT_PAUSES,
  MAX_RATE_LIMIT_RETRIES_PER_TASK,
  MAX_RETRY_DELAY_MS,
  RATE_LIMIT_BASE_PAUSE_MS,
  attachRequestErrorMeta,
  defaultRequestRetryPolicy,
  parseRetryAfterMs,
  readMeta,
  type RequestRetryContext,
  type RequestRetryPolicy,
} from "../src/utils/retry-policy";

const results: string[] = [];
const TEST_TIMEOUT_MS = 2000;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  // A never-settling queue promise must fail loudly, not silence the whole suite.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve().then(fn), timeout])
    .then(() => results.push(`ok   ${name}`))
    .catch((error) => results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Classified exactly like an engine failure: a status field plus an "HTTP 429" message. */
function httpError(status: number, body = "boom"): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}: ${body}`), { status });
}

function mkQueue(extra: Partial<QueueOptions> = {}): TranslateQueue {
  return new TranslateQueue({
    capacity: 5,
    rate: 100,
    maxRetries: 0,
    baseRetryDelayMs: 5,
    ...extra,
  });
}

type TaskInit<T> = Pick<QueueTask<T>, "hash" | "scope" | "execute" | "resolve" | "reject">;

function mkTask<T>(
  hash: string,
  execute: () => Promise<T>,
  settle: { resolve: (value: T) => void; reject: (error: unknown) => void },
  scope = "s"
): TaskInit<T> {
  return { hash, scope, execute, resolve: settle.resolve, reject: settle.reject };
}

function retryContext(over: Partial<RequestRetryContext> = {}): RequestRetryContext {
  return {
    now: Date.now(),
    retryCount: 0,
    maxRetries: 2,
    baseRetryDelayMs: 1000,
    rateLimitRetryCount: 0,
    consecutiveRateLimits: 0,
    ...over,
  };
}

async function main(): Promise<void> {
  await test("token bucket caps simultaneous in-flight requests", async () => {
    const queue = mkQueue({ capacity: 3, rate: 10 });
    let inFlight = 0;
    let peak = 0;
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      runs.push(
        new Promise((resolve) => {
          queue.enqueue<void>(
            mkTask<void>(`t${i}`, async () => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await sleep(20);
              inFlight -= 1;
            }, { resolve: () => resolve(null), reject: () => resolve(null) })
          );
        })
      );
    }
    await Promise.all(runs);
    assert.ok(peak <= 3, `peak in-flight ${peak} exceeded capacity 3`);
  });

  await test("cancelScope drains waiting tasks", async () => {
    const queue = mkQueue({ capacity: 1, rate: 1 });
    const settled: string[] = [];
    const reasons: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      queue.enqueue<void>(
        mkTask<void>(
          `c${i}`,
          async () => {
            await sleep(30);
          },
          {
            resolve: () => settled.push(`r${i}`),
            reject: (error) => {
              settled.push(`j${i}`);
              reasons.push(error);
            },
          },
          "doomed"
        )
      );
    }
    await sleep(5);
    queue.cancelScope("doomed");
    await sleep(60);
    assert.ok(
      settled.some((entry) => entry.startsWith("j")),
      "cancelled tasks should reject rather than hang"
    );
    assert.ok(
      reasons.length > 0 && reasons.every(isCancelled),
      "a cancellation must be recognisable so no error row gets painted"
    );
  });

  await test("a 429 pauses dispatch, retries, and does not spend the retry budget", async () => {
    const contexts: RequestRetryContext[] = [];
    const stub: RequestRetryPolicy = {
      decide(error, context) {
        void error;
        contexts.push(context);
        return context.rateLimitRetryCount === 0
          ? { action: "pause-and-retry", pauseMs: 40 }
          : { action: "retry", delayMs: 1 };
      },
    };
    // maxRetries 0: any ordinary failure would already be terminal here.
    const queue = mkQueue({ capacity: 1, maxRetries: 0, retryPolicy: stub });

    const startedAt: number[] = [];
    const t0 = Date.now();

    let attempts = 0;
    const limited = new Promise<number>((resolve, reject) => {
      queue.enqueue<void>(
        mkTask("a", async () => {
          startedAt.push(Date.now());
          if (attempts++ === 0) throw httpError(429);
        }, { resolve: () => resolve(attempts), reject })
      );
    });

    // Enqueued while the provider is cooling down, so it must wait the pause out.
    await sleep(2);
    const siblingDelay = await new Promise<number>((resolve, reject) => {
      queue.enqueue<void>(
        mkTask("b", async () => {
          startedAt.push(Date.now());
        }, { resolve: () => resolve(Date.now() - t0), reject })
      );
    });

    assert.equal(await limited, 2, "the rate-limited request should be retried once");
    assert.equal(contexts.length, 1, "a 429 should be decided exactly once per pause window");
    assert.equal(contexts[0].retryCount, 0, "a 429 must not consume an ordinary retry");
    assert.ok(
      siblingDelay >= 35,
      `a sibling dispatched ${siblingDelay}ms after the 429, before the pause expired`
    );
  });

  await test("siblings failing in one pause window count as a single strike", async () => {
    const counters: number[] = [];
    let decides = 0;
    const stub: RequestRetryPolicy = {
      decide(error, context) {
        void error;
        decides += 1;
        if (decides <= 3) counters.push(context.consecutiveRateLimits);
        return decides <= 3
          ? { action: "pause-and-retry", pauseMs: 10 }
          : { action: "fail" };
      },
    };
    // The token budget refills fast here: the third round must be reached
    // quickly so the test observes re-dispatch instead of idling.
    const queue = mkQueue({ capacity: 3, rate: 100, retryPolicy: stub });
    const settle = (hash: string) =>
      new Promise<void>((resolve) => {
        queue.enqueue<void>(
          mkTask(hash, async () => {
            throw httpError(429);
          }, { resolve, reject: () => resolve() })
        );
      });
    await Promise.all([settle("x"), settle("y"), settle("z")]);
    assert.equal(counters.length, 3, "each sibling failure should be decided");
    assert.equal(
      Math.max(...counters),
      1,
      `three simultaneous 429s should be one pause window, saw counters ${counters}`
    );
  });

  await test("a successful request clears the consecutive rate-limit counter", async () => {
    const counters: number[] = [];
    const stub: RequestRetryPolicy = {
      decide(error, context) {
        void error;
        counters.push(context.consecutiveRateLimits);
        return context.rateLimitRetryCount === 0
          ? { action: "pause-and-retry", pauseMs: 4 }
          : { action: "retry", delayMs: 1 };
      },
    };
    const queue = mkQueue({ capacity: 1, retryPolicy: stub });

    const runOnce = (failures: number) =>
      new Promise<void>((resolve, reject) => {
        let fired = 0;
        queue.enqueue<void>(
          mkTask(`k${counters.length}`, async () => {
            if (fired++ < failures) throw httpError(429);
          }, { resolve, reject })
        );
      });

    // Two 429s inside one window: the second decision sees the strike counted.
    await runOnce(2);
    // That task then succeeded, so the next window must start from the base.
    await runOnce(1);
    assert.deepEqual(counters, [0, 1, 0], `expected the counter to reset after success, saw ${counters}`);
  });

  await test("a queue-fatal error rejects the whole backlog and reports once", async () => {
    let notices = 0;
    let drainedReports = 0;
    const queue = mkQueue({
      capacity: 1,
      maxRetries: 5,
      retryPolicy: defaultRequestRetryPolicy, // 401 is queue-fatal
      onTaskFailed: (error, task) => {
        void error;
        notices += 1;
        if (task === null) drainedReports += 1;
      },
    });

    const rejections: string[] = [];
    const settle = (hash: string) =>
      new Promise<void>((resolve) => {
        queue.enqueue<void>(
          mkTask(hash, async () => {
            throw httpError(401, "bad key");
          }, {
            resolve: () => resolve(),
            reject: () => {
              rejections.push(hash);
              resolve();
            },
          })
        );
      });

    await Promise.all([settle("a"), settle("b"), settle("c"), settle("d")]);
    assert.equal(notices, 1, `expected one notice for a drained backlog, got ${notices}`);
    assert.equal(drainedReports, 1, "a drained backlog reports with a null task");
    assert.equal(rejections.length, 4, "every queued paragraph must settle, not hang");
  });

  await test("an ordinary failure fails its own task instead of draining the backlog", async () => {
    const queue = mkQueue({ capacity: 1, rate: 1000, maxRetries: 0 });
    const outcome: string[] = [];
    const settle = (hash: string) =>
      new Promise<void>((resolve) => {
        queue.enqueue<void>(
          mkTask(hash, async () => {
            throw httpError(501, "not implemented");
          }, {
            resolve: () => {
              outcome.push(`${hash}:ok`);
              resolve();
            },
            reject: () => {
              outcome.push(`${hash}:fail`);
              resolve();
            },
          })
        );
      });
    await Promise.all([settle("a"), settle("b")]);
    assert.deepEqual(outcome.slice().sort(), ["a:fail", "b:fail"]);
  });

  await test("raising capacity does not grant a free burst", async () => {
    const queue = mkQueue({ capacity: 1, rate: 10 });
    let inFlight = 0;
    let peak = 0;
    const runs = Array.from({ length: 4 }, (_, i) => {
      return new Promise<void>((resolve) => {
        queue.enqueue<void>(
          mkTask(`b${i}`, async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await sleep(10);
            inFlight -= 1;
          }, {
            resolve: () => resolve(),
            reject: () => resolve(),
          })
        );
      });
    });
    await sleep(5);
    queue.setOptions({ capacity: 4 });
    await Promise.all(runs);
    assert.ok(peak <= 2, `raising capacity let ${peak} requests run at once`);
  });

  await test("retry policy pauses exponentially and honours Retry-After", () => {
    const decide = (error: unknown, over: Partial<RequestRetryContext> = {}) =>
      defaultRequestRetryPolicy.decide(error, retryContext(over));

    const first = decide(httpError(429));
    assert.equal(first.action, "pause-and-retry");
    if (first.action === "pause-and-retry") {
      assert.ok(
        first.pauseMs >= RATE_LIMIT_BASE_PAUSE_MS &&
          first.pauseMs <= RATE_LIMIT_BASE_PAUSE_MS * 1.1 + 1,
        `first pause ${first.pauseMs} is not the base window`
      );
    }

    const third = decide(httpError(429), { consecutiveRateLimits: 2 });
    assert.equal(third.action, "pause-and-retry");
    if (third.action === "pause-and-retry") {
      assert.ok(
        third.pauseMs >= RATE_LIMIT_BASE_PAUSE_MS * 4 &&
          third.pauseMs <= RATE_LIMIT_BASE_PAUSE_MS * 4 * 1.1 + 1,
        `pause should double per window, got ${third.pauseMs}`
      );
    }

    const withHeader = decide(attachRequestErrorMeta(httpError(429), { retryAfterMs: 120_000 }));
    assert.equal(withHeader.action, "pause-and-retry");
    if (withHeader.action === "pause-and-retry") {
      assert.ok(
        withHeader.pauseMs >= 120_000,
        `Retry-After of 120s must outrank the ${RATE_LIMIT_BASE_PAUSE_MS}ms base backoff`
      );
    }

    const absurd = decide(attachRequestErrorMeta(httpError(429), { retryAfterMs: 10 * 60_000 }));
    assert.equal(absurd.action, "pause-and-retry");
    if (absurd.action === "pause-and-retry") {
      assert.equal(absurd.pauseMs, MAX_RETRY_DELAY_MS, "a huge Retry-After must be clamped");
    }

    for (const over of [
      { consecutiveRateLimits: MAX_CONSECUTIVE_RATE_LIMIT_PAUSES },
      { rateLimitRetryCount: MAX_RATE_LIMIT_RETRIES_PER_TASK },
    ]) {
      const givenUp = decide(httpError(429), over);
      assert.equal(givenUp.action, "fail");
      assert.equal(givenUp.failQueue, true, "a provider that never recovers should stop the session");
    }

    const fatal = decide(httpError(403, "no access"));
    assert.equal(fatal.action, "fail");
    assert.equal(fatal.failQueue, true, "a wrong key or model should not walk the backlog");

    assert.deepEqual(decide(httpError(400, "bad payload")), { action: "fail" });

    const server = decide(httpError(500), { retryCount: 1 });
    assert.equal(server.action, "retry");
    if (server.action === "retry") {
      assert.ok(
        server.delayMs >= 2000 && server.delayMs <= 2200,
        `expected ~2s exponential delay, got ${server.delayMs}`
      );
    }

    assert.deepEqual(decide(httpError(500), { retryCount: 2, maxRetries: 2 }), { action: "fail" });
  });

  await test("Retry-After parses seconds, milliseconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs({ "Retry-After": "30" }), 30_000);
    assert.equal(parseRetryAfterMs({ "retry-after-ms": "750" }), 750);
    assert.equal(
      parseRetryAfterMs({ "retry-after-ms": "750", "Retry-After": "30" }),
      750,
      "the millisecond header is more precise"
    );
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    assert.equal(
      parseRetryAfterMs({ "Retry-After": new Date(now + 45_000).toUTCString() }, now),
      45_000
    );
    assert.equal(parseRetryAfterMs({ "Retry-After": "nonsense" }), undefined);
    assert.equal(parseRetryAfterMs(undefined), undefined);
  });

  await test("errors keep their message while carrying classified metadata", () => {
    const meta = readMeta(attachRequestErrorMeta(httpError(429), { retryAfterMs: 1000 }));
    assert.equal(meta.kind, "rate-limit");
    assert.equal(meta.retryAfterMs, 1000);
    assert.equal(meta.statusCode, 429);
    assert.equal(meta.message, "HTTP 429: boom");

    assert.equal(readMeta(httpError(401)).kind, "access-denied");
    assert.equal(readMeta(new Error("fetch failed")).kind, "network");
    assert.equal(readMeta(new Error("Request timed out")).kind, "timeout");
    assert.equal(readMeta(httpError(503)).kind, "unknown");
  });

  await test("batch queue groups by provider and preserves order", async () => {
    const queue = mkQueue({ capacity: 10 });
    const batch = new BatchQueue(queue, {
      maxItems: 3,
      maxChars: 1000,
      delayMs: 50,
      saturatedHoldMs: 200,
    });
    const seen: string[][] = [];
    const run = async (texts: string[]) => {
      seen.push(texts);
      return texts.map((text) => `X-${text}`);
    };
    const settled = await Promise.all([
      batch.submit("g", "s1", "one", run),
      batch.submit("g", "s1", "two", run),
      batch.submit("g", "s1", "three", run),
    ]);
    assert.deepEqual(settled, ["X-one", "X-two", "X-three"]);
    assert.equal(seen.length, 1, "three units under the cap must share one request");
    assert.deepEqual(seen[0], ["one", "two", "three"]);
  });

  await test("batch queue splits on the item cap and isolates scopes", async () => {
    const queue = mkQueue({ capacity: 10 });
    const batch = new BatchQueue(queue, { maxItems: 2, maxChars: 1000, delayMs: 50, saturatedHoldMs: 200 });
    const seen: string[][] = [];
    const run = async (texts: string[]) => {
      seen.push(texts);
      return texts.map((text) => `X-${text}`);
    };
    const settled = await Promise.all([
      batch.submit("g", "s1", "a", run),
      batch.submit("g", "s1", "b", run),
      batch.submit("g", "s1", "c", run),
      batch.submit("g", "s2", "d", run),
    ]);
    assert.deepEqual(settled, ["X-a", "X-b", "X-c", "X-d"]);
    const s1 = seen.filter((group) => group.every((text) => ["a", "b", "c"].includes(text)));
    assert.equal(s1.length, 2, "three items with a cap of two need two requests");
    assert.ok(seen.some((group) => group.length === 1 && group[0] === "d"), "other scope must not join");
  });

  await test("batch queue respects the character cap", async () => {
    const queue = mkQueue({ capacity: 10 });
    const batch = new BatchQueue(queue, { maxItems: 50, maxChars: 30, delayMs: 20, saturatedHoldMs: 200 });
    const seen: string[][] = [];
    const run = async (texts: string[]) => {
      seen.push(texts);
      return texts.map((text) => text);
    };
    await Promise.all([
      batch.submit("g", "s", "1234567890", run),
      batch.submit("g", "s", "1234567890", run),
      batch.submit("g", "s", "1234567890", run),
    ]);
    assert.ok(seen.every((group) => group.join("").length <= 30), "a group exceeded the character cap");
  });

  await test("dropScope strands a held batch instead of sending it late", async () => {
    const queue = mkQueue({ capacity: 10 });
    const batch = new BatchQueue(queue, {
      maxItems: 5,
      maxChars: 1000,
      delayMs: 30,
      saturatedHoldMs: 200,
    });
    let requests = 0;
    const run = async (texts: string[]) => {
      requests += 1;
      return texts.map(() => "X");
    };
    const dropped = Promise.allSettled([
      batch.submit("g", "s1", "one", run),
      batch.submit("g", "s1", "two", run),
    ]);
    const kept = batch.submit("g", "s2", "three", run);

    await sleep(5); // still inside the hold window, so nothing is in flight yet
    batch.dropScope("s1");

    const outcomes = await dropped;
    outcomes.forEach((outcome) => {
      assert.equal(outcome.status, "rejected", "a dropped unit must settle, not hang");
      assert.ok(isCancelled((outcome as PromiseRejectedResult).reason));
    });
    assert.equal(await kept, "X", "another session's batch is unaffected");
    await sleep(60);
    assert.equal(requests, 1, "only the surviving scope may reach the provider");
  });

  await test("batch result parsing maps back 1:1", () => {
    const joined = joinBatch(["Alpha", "Beta", "Gamma"]);
    const parsed = parseBatchResult(`甲\n\n%%\n\n乙\n\n%%\n\n丙`, 3);
    assert.deepEqual(parsed, ["甲", "乙", "丙"]);
    assert.ok(joined.includes("\n\n%%\n\n"));
  });

  await test("batch parsing throws on count mismatch so the caller can fall back", () => {
    assert.throws(
      () => parseBatchResult("甲\n\n%%\n\n乙", 3),
      BatchCountMismatchError,
      "a short reply must not silently drop a paragraph"
    );
  });

  await test("entity escaping round-trips", () => {
    const source = "a < b and & c > d \"quoted\"";
    const escaped = escapeEntities(source);
    assert.ok(!escaped.includes("<"), "raw < must not reach the tag aligner");
    assert.equal(unescapeEntities(escaped), source);
    assert.equal(unescapeEntities("&amp;lt;"), "&lt;", "double-decoding must not occur");
    assert.equal(unescapeEntities("&#39;x&#39;"), "'x'");
  });

  await test("cache is LRU and TTL bounded", async () => {
    const cache = new TranslationCache({ maxEntries: 2, ttlDays: 1 });
    cache.set("a", "A");
    cache.set("b", "B");
    cache.get("a"); // touch a so b becomes LRU
    cache.set("c", "C");
    assert.equal(cache.get("a"), "A");
    assert.equal(cache.get("b"), undefined, "least recently used entry should be evicted");
    assert.equal(cache.get("c"), "C");
  });

  await test("cache drops stale entries", async () => {
    const cache = new TranslationCache({ maxEntries: 10, ttlDays: 1 });
    cache.set("k", "V");
    cache.hydrate({ old: { translation: "OLD", updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 } });
    assert.equal(cache.get("old"), undefined, "expired entry must not be restored");
    assert.equal(cache.get("k"), "V");
  });

  await test("cache ignores blank translations", () => {
    const cache = new TranslationCache({ maxEntries: 10, ttlDays: 1 });
    cache.set("k", "   ");
    assert.equal(cache.get("k"), undefined);
  });

  await test("short or handle-only paragraphs are filtered before requesting", () => {
    assert.equal(meetsMinimum("some prose here", 0, 0), true);
    assert.equal(meetsMinimum("xi", 10, 0), false, "below the character floor");
    assert.equal(meetsMinimum("@handle", 0, 0), false, "a bare handle is not prose");
    assert.equal(meetsMinimum("一 二 三", 0, 4), false, "below the word floor");
  });

  await test("defaults keep free endpoints inside polite limits", () => {
    assert.ok(DEFAULT_SETTINGS.requestRate <= 10, "default request rate is too aggressive");
    assert.ok(DEFAULT_SETTINGS.maxItemsPerBatch <= 4);
  });

  console.log(results.join("\n"));
  const failures = results.filter((line) => line.startsWith("FAIL"));
  process.exitCode = failures.length > 0 ? 1 : 0;
  if (failures.length > 0) console.log(`\n${failures.length} failing`);
}

void main();
