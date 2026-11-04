import { bilibiliTranslate, splitBilibiliText, BILIBILI_URL, BILIBILI_MODEL } from "../src/engines/bilibili";
import { protectText, validateTranslation, TranslationValidationError } from "../src/engines/protection";
import { TransportLimiter, transportLimiter } from "../src/engines/transport";
import { maxItemsPerBatch, translateTexts } from "../src/engines";
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
  await test("Bilibili chunks preserve Unicode, whitespace and whole protection tokens", () => {
    const input = ("Technical prose 😀 ZXQNAIYI123QXZ. ".repeat(130)) + "\nLast sentence.";
    const chunks = splitBilibiliText(input);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), input);
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 2000));
    assert.equal(chunks.reduce((n, chunk) => n + (chunk.match(/ZXQNAIYI123QXZ/g) ?? []).length, 0), 130);
    assert.equal(maxItemsPerBatch({ ...DEFAULT_SETTINGS, engine: "bilibili" }), 1);
  });

  await test("Bilibili preset uses fixed anonymous endpoint, model and no-thinking payload", async () => {
    const originalFetch = globalThis.fetch;
    transportLimiter.configure(4, 10000);
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), BILIBILI_URL);
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, BILIBILI_MODEL);
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, "user");
      assert.ok(body.messages[0].content.includes("简体中文"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "这是中文译文。" } }] }));
    };
    try {
      assert.deepEqual(await translateTexts(["This paragraph is synthetic."], {
        ...DEFAULT_SETTINGS, engine: "bilibili", ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-private-key" },
      }), ["这是中文译文。"]);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(bilibiliTranslate("Text.", "auto", "zh-CN", 100, controller.signal), isCancelled);
      await assert.rejects(bilibiliTranslate("Text.", "auto", "invalid", 100));
      assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
  });

  await test("Bilibili rejects truncation, absent messages and unclosed thought blocks", async () => {
    const originalFetch = globalThis.fetch;
    transportLimiter.configure(4, 10000);
    try {
      for (const choice of [
        { finish_reason: "length", message: { content: "截断的译文" } },
        { finish_reason: "stop" },
        { finish_reason: "stop", message: { content: "<think>unfinished" } },
        { finish_reason: "stop", message: { content: "" } },
      ]) {
        globalThis.fetch = async () => new Response(JSON.stringify({ choices: [choice] }));
        await assert.rejects(bilibiliTranslate("Source text.", "en", "zh-TW", 100));
      }
    } finally { globalThis.fetch = originalFetch; }
  });

  await test("logical queue caps slow in-flight tasks even with fast token refill", async () => {
    const queue = mkQueue({ capacity: 2, rate: 10000 });
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
      queue.enqueue(mkTask(`slow-${i}`, async () => {
        peak = Math.max(peak, ++active); await sleep(15); active--;
      }, { resolve, reject }));
    })));
    assert.equal(peak, 2); queue.clear();
  });

  await test("transport launch rate applies independently of concurrency", async () => {
    const limiter = new TransportLimiter(); limiter.configure(1, 20);
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 3 }, () => limiter.run(async () => { starts.push(Date.now()); })));
    assert.ok(starts[1] - starts[0] >= 40);
    assert.ok(starts[2] - starts[1] >= 40);
  });

  await test("cancelled AI batch retries never dispatch another HTTP attempt", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    transportLimiter.configure(4, 10000);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      controller.abort();
      return new Response(JSON.stringify({ choices: [{ message: { content: "incorrect single segment" } }] }), { status: 200 });
    };
    try {
      await assert.rejects(translateTexts(["First paragraph.", "Second paragraph."], {
        ...DEFAULT_SETTINGS, engine: "ai", ai: { ...DEFAULT_SETTINGS.ai, baseUrl: "https://example.org/v1" },
      }, controller.signal), isCancelled);
      assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
  });

  await test("real transport concurrency remains capped after token refill", async () => {
    const limiter = new TransportLimiter();
    limiter.configure(2, 10000);
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 10 }, () => limiter.run(async () => {
      peak = Math.max(peak, ++active);
      await sleep(12); active--;
    })));
    assert.equal(peak, 2);
  });

  await test("timeout and cancellation retain physical slots until transport settles", async () => {
    const limiter = new TransportLimiter(); limiter.configure(1, 10000);
    let finish!: (value: string) => void;
    const timed = limiter.run(() => new Promise<string>((resolve) => { finish = resolve; }), 5);
    await assert.rejects(timed, /timed out/);
    let nextStarted = false;
    const controller = new AbortController();
    const cancelled = limiter.run(async () => { throw new Error("must not dispatch"); }, 100, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, isCancelled);
    const next = limiter.run(async () => { nextStarted = true; return "next"; });
    await sleep(10);
    assert.equal(nextStarted, false, "timed-out physical request still occupies slot");
    finish("late");
    assert.equal(await next, "next");
    const activeController = new AbortController();
    let finishCancelled!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const activeRequest = limiter.run(() => new Promise<void>((resolve) => { finishCancelled = resolve; markStarted(); }), 100, activeController.signal);
    await started; activeController.abort();
    await assert.rejects(activeRequest, isCancelled);
    let afterStarted = false;
    const after = limiter.run(async () => { afterStarted = true; });
    await sleep(5); assert.equal(afterStarted, false, "cancelled physical request still occupies slot");
    finishCancelled(); await after;
  });

  await test("protected code math links and line breaks round-trip with strict token checks", () => {
    const source = 'Read `a < b` with $x^2$ at [the link](../note.md#part) or https://example.org/a.\n[[Target|Alias]]\n-----';
    const item = protectText(source);
    assert.equal(item.restore(item.text.replace("Read", "阅读")), source.replace("Read", "阅读"));
    const token = item.text.match(/ZXQNAIYI\d+QXZ/)![0];
    assert.throws(() => item.restore(item.text.replace(token, "")), TranslationValidationError);
    assert.throws(() => item.restore(item.text + token), TranslationValidationError);
    assert.throws(() => item.restore(item.text + "ZXQNAIYI999QXZ"), TranslationValidationError);
    assert.equal(protectText("ZXQNAIYI0QXZ and `code`").restore(protectText("ZXQNAIYI0QXZ and `code`").text), "ZXQNAIYI0QXZ and `code`");
  });

  await test("link punctuation is protected while labels translate and destinations stay exact", () => {
    const source = 'Read [chipmakers](https://example.org/a_(b)?x=1&y=2) and [equipment](../note.md#part).';
    const item = protectText(source);
    assert.ok(!/[\[\]()]/.test(item.text));
    assert.ok(!item.text.includes('https://'));
    assert.deepEqual(item.labels, ['chipmakers', 'equipment']);
    assert.equal(item.restore(item.text, ['芯片制造商', '设备']),
      source.replace('chipmakers', '芯片制造商').replace('equipment', '设备'));
    const code = protectText('Keep `[label](https://example.org)` intact.');
    assert.ok(!code.prose.includes('label'));
    assert.equal(code.restore(code.text), 'Keep `[label](https://example.org)` intact.');
  });

  await test("Chinese result validation rejects long echoed/wrong-language prose but keeps short labels", () => {
    const source = "This is a sufficiently long English passage about how readers understand technical material in context.";
    assert.throws(() => validateTranslation(source, source, "zh-CN"), TranslationValidationError);
    assert.throws(() => validateTranslation(source, "Este es un texto largo en otro idioma que no es chino en absoluto.", "zh-TW"), TranslationValidationError);
    validateTranslation(source, "这是关于读者理解专业资料的一段中文。", "zh-CN");
    validateTranslation("OpenAI API", "OpenAI API", "zh-CN");
    validateTranslation(source, source, "en");
    validateTranslation("中文与 English mixed text", "English", "zh-CN");
    assert.throws(() => validateTranslation("Text", "", "en"), TranslationValidationError);
  });

  await test("engine protects actual payloads and rejects damaged or echoed replies", async () => {
    const originalFetch = globalThis.fetch;
    const settings = { ...DEFAULT_SETTINGS, requestRate: 10000 };
    transportLimiter.configure(4, 10000);
    let calls = 0;
    let damage = false;
    globalThis.fetch = async (input) => {
      calls++;
      const payload = new URL(String(input)).searchParams.get("q")!;
      assert.ok(!payload.includes("`code`"));
      const translated = damage ? payload.replace(/ZXQNAIYI\d+QXZ/, "lost") : payload.replace("Read", "阅读");
      return new Response(JSON.stringify([[[translated]]]), { status: 200 });
    };
    try {
      assert.deepEqual(await translateTexts(["Read `code`\nnext", "", "$x$"], settings), ["阅读 `code`\nnext", "", "$x$"]);
      assert.equal(calls, 1, "pure protected text and blanks need no request");
      assert.deepEqual(await translateTexts(["Read [Read](https://example.org/one) and [Read](../two).", "[Read](#three)"], settings),
        ["阅读 [阅读](https://example.org/one) and [阅读](../two).", "[阅读](#three)"]);
      damage = true;
      await assert.rejects(translateTexts(["Read `code`"], settings), TranslationValidationError);
      damage = false;
      await assert.rejects(translateTexts(["This long English paragraph remains exactly unchanged despite asking for a complete Chinese translation."], settings), TranslationValidationError);
    } finally { globalThis.fetch = originalFetch; }
  });

  await test("validation failures use the bounded retry budget and cannot resolve as cacheable results", async () => {
    const queue = mkQueue({ rate: 10000, maxRetries: 2, baseRetryDelayMs: 1 });
    let attempts = 0, resolved = false;
    const result = new Promise((resolve) => queue.enqueue(mkTask("invalid", async () => {
      attempts++; throw new TranslationValidationError("invalid translation");
    }, { resolve: () => { resolved = true; resolve(null); }, reject: resolve })));
    assert.ok(await result instanceof TranslationValidationError);
    assert.equal(attempts, 3); assert.equal(resolved, false);
    queue.clear();
  });

  await test("cancelled in-flight failures cannot retry or drain a new session", async () => {
    const queue = mkQueue({ capacity: 2 });
    let failOld!: (error: unknown) => void;
    let finishNew!: (value: string) => void;
    let decisions = 0;
    queue.setOptions({ retryPolicy: { decide: () => { decisions++; return { action: "fail", failQueue: true }; } } });
    const old = new Promise((resolve) => queue.enqueue(mkTask("old", () => new Promise((_, reject) => { failOld = reject; }), {
      resolve, reject: (error) => resolve(error),
    }, "old-session")));
    queue.cancelScope("old-session");
    const fresh = new Promise((resolve, reject) => queue.enqueue(mkTask("fresh", () => new Promise<string>((done) => { finishNew = done; }), {
      resolve, reject,
    }, "new-session")));
    // Attach handlers before failing either request so a regression reports cleanly.
    const settledFresh = fresh.then((value) => value, (error) => error);
    failOld(httpError(401));
    await sleep(0);
    finishNew("new translation");
    assert.ok(isCancelled(await old));
    assert.equal(await settledFresh, "new translation");
    assert.equal(decisions, 0, "retired requests must not affect the provider retry policy");
    queue.clear();
  });

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
