/**
 * Unit coverage for the inference deadline primitives.
 *
 * The client-level behaviour (failover on a silent provider, cooldown on a
 * stalled stream) is covered end-to-end in inferenceDeadlines.test.ts against a
 * real stalling socket server. These tests pin the primitives themselves.
 */

import { describe, expect, it, vi } from "vitest";
import {
  InferenceTimeoutError,
  createDeadlineHandle,
  isInferenceTimeoutError,
  withProgress,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TTFB_TIMEOUT_MS,
} from "../../client/deadlines";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createDeadlineHandle", () => {
  it("defaults to a 180 s headers budget and a 180 s idle budget", () => {
    // 180 s comes from measured traffic: reasoning models legitimately take up
    // to ~260 s to first byte, so a shorter default would abort real answers.
    expect(DEFAULT_TTFB_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(180_000);
    const handle = createDeadlineHandle({});
    expect(handle.hasBudget("ttfb")).toBe(true);
    expect(handle.hasBudget("idle")).toBe(true);
    expect(handle.hasBudget("body")).toBe(false);
    handle.dispose();
  });

  it("treats a non-positive budget as disabled", () => {
    const handle = createDeadlineHandle({ deadlines: { ttfbMs: 0, idleMs: -1 } });
    expect(handle.hasBudget("ttfb")).toBe(false);
    expect(handle.hasBudget("idle")).toBe(false);
    handle.dispose();
  });

  it("aborts with a TimeoutError when the headers budget expires", async () => {
    const handle = createDeadlineHandle({ deadlines: { ttfbMs: 10 }, baseUrl: "https://n.example/" });
    await sleep(40);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.timedOut()).toBe(true);
    expect(handle.timedOutPhase()).toBe("ttfb");
    const reason = handle.reason();
    expect(isInferenceTimeoutError(reason)).toBe(true);
    expect((reason as Error).name).toBe("TimeoutError");
    expect((reason as Error).message).toContain("https://n.example/");
    handle.dispose();
  });

  it("keeps a caller abort distinct from a local deadline", async () => {
    const caller = new AbortController();
    const handle = createDeadlineHandle({ signal: caller.signal, deadlines: { ttfbMs: 5_000 } });
    caller.abort(new DOMException("cancelled", "AbortError"));
    await sleep(0);
    expect(handle.signal.aborted).toBe(true);
    // A caller abort must never be reported as a provider fault.
    expect(handle.timedOut()).toBe(false);
    expect(handle.timedOutPhase()).toBeUndefined();
    expect((handle.reason() as Error).name).toBe("AbortError");
    handle.dispose();
  });

  it("suspend() stops the clock without aborting, so a pause is not a stall", async () => {
    const handle = createDeadlineHandle({ deadlines: { idleMs: 10 } });
    handle.armIdle();
    handle.suspend();
    await sleep(40);
    expect(handle.signal.aborted).toBe(false);
    handle.dispose();
  });

  it("re-arms the idle budget after a chunk, so progress extends the deadline", async () => {
    const handle = createDeadlineHandle({ deadlines: { idleMs: 30 } });
    // Three windows that each stay under the budget: total elapsed far exceeds
    // it, but no single silence does — exactly what a healthy slow stream is.
    for (let i = 0; i < 4; i += 1) {
      handle.armIdle();
      await sleep(12);
    }
    expect(handle.signal.aborted).toBe(false);
    handle.dispose();
  });

  it("dispose() prevents a pending deadline from firing", async () => {
    const handle = createDeadlineHandle({ deadlines: { ttfbMs: 10 } });
    handle.dispose();
    await sleep(40);
    expect(handle.signal.aborted).toBe(false);
  });

  it("exposes the phase and budget of the expired deadline", async () => {
    const handle = createDeadlineHandle({ deadlines: { idleMs: 10 } });
    handle.armIdle();
    await sleep(40);
    expect(handle.timedOutPhase()).toBe("idle");
    expect((handle.reason() as InferenceTimeoutError).timeoutMs).toBe(10);
    handle.dispose();
  });
});

describe("withProgress", () => {
  it("forwards bytes unchanged and reports read windows", async () => {
    const events: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one"));
        controller.enqueue(new TextEncoder().encode("two"));
        controller.close();
      },
    });
    const wrapped = withProgress(source, {
      onWaitStart: () => events.push("start"),
      onWaitEnd: () => events.push("end"),
    });

    const text = await new Response(wrapped).text();
    expect(text).toBe("onetwo");
    // start/end are paired around each read.
    expect(events[0]).toBe("start");
    expect(events.length % 2).toBe(0);
  });

  it("reports a stall only for a TimeoutError failure", async () => {
    const stalls: string[] = [];
    const timeoutSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Object.assign(new Error("stalled"), { name: "TimeoutError" }));
      },
    });
    await expect(new Response(withProgress(timeoutSource, { onStalled: () => stalls.push("y") })).text())
      .rejects.toThrow();
    expect(stalls).toEqual(["y"]);

    stalls.length = 0;
    const socketSource = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Object.assign(new Error("reset"), { name: "TypeError" }));
      },
    });
    await expect(new Response(withProgress(socketSource, { onStalled: () => stalls.push("y") })).text())
      .rejects.toThrow();
    expect(stalls).toEqual([]);
  });
});

describe("InferenceTimeoutError", () => {
  it("names the phase so a failure is diagnosable from the message alone", () => {
    expect(new InferenceTimeoutError("ttfb", 60_000).message).toContain("no response headers");
    expect(new InferenceTimeoutError("idle", 120_000).message).toContain("stream stalled");
    expect(new InferenceTimeoutError("body", 1).message).toContain("not completed");
    // Callers switch on name, matching runtime timeouts.
    expect(new InferenceTimeoutError("ttfb", 1).name).toBe("TimeoutError");
  });
});
