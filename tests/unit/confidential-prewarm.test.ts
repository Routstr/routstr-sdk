/**
 * Pre-warm pool heuristics (fake clock, fake sessions) and body padding.
 */

import { describe, expect, it } from "vitest";

import {
  chooseBucket,
  padPinnedBody,
  PrewarmPool,
  type ArmHandle,
  type ArmedSessionLike,
  type PoolKeyInfo,
  type PrewarmOptions,
  PREWARM_DEFAULTS,
} from "../../client/confidential/prewarm";
import { buildPinnedBody } from "../../client/confidential/transport";
import { canonicalSuffix } from "../../client/confidential/suffix";

class FakeSession implements ArmedSessionLike {
  healthy = true;
  closed = false;
  abandonFeeMsat = 0;
  constructor(
    readonly bodyLength: number,
    public sid: string,
  ) {}
  close(): void {
    this.closed = true;
    this.healthy = false;
  }
}

interface PendingArm {
  len: number;
  session: FakeSession;
  resolve: () => void;
  reject: (e: Error) => void;
  cancelled: boolean;
}

function harness(opts: PrewarmOptions = {}, balance: number | undefined = 1e12, feeMsat = 0) {
  let now = 1_000_000;
  const arms: PendingArm[] = [];
  const logs: string[] = [];
  let timerActive = false;
  let n = 0;
  const pool = new PrewarmPool<FakeSession, null>(
    { log: (m) => logs.push(m), ...opts },
    {
      now: () => now,
      schedule: () => {
        timerActive = true;
        return () => (timerActive = false);
      },
      availableMsats: async () => balance,
      arm: (_info, _ctx, len): ArmHandle<FakeSession> => {
        const session = new FakeSession(len, `sid${++n}`);
        session.abandonFeeMsat = feeMsat;
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const ready = new Promise<FakeSession>((res, rej) => {
          resolve = () => res(session);
          reject = rej;
        });
        ready.catch(() => {});
        const a: PendingArm = { len, session, resolve, reject, cancelled: false };
        arms.push(a);
        return {
          ready,
          cancel: () => {
            a.cancelled = true;
            session.close();
          },
        };
      },
    },
  );
  const info: PoolKeyInfo = { baseUrl: "http://node", model: "m", maxTokens: 100, bearer: "sk-test" };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    pool,
    arms,
    logs,
    info,
    flush,
    advance: (ms: number) => (now += ms),
    timerActive: () => timerActive,
    /** One complete cold request that settles with a 1000 msat reservation. */
    async request(len = 1000, info2 = info) {
      const t = pool.begin(info2, null, len);
      const lease = t.take();
      if (lease) {
        await lease.session;
        t.warm();
      } else t.cold();
      t.head();
      t.end(1000, feeMsat);
      await flush();
      return lease;
    },
    armed: () => pool.snapshot().reduce((a, k) => a + k.ready + k.arming, 0),
  };
}

async function completeArms(h: ReturnType<typeof harness>) {
  await h.flush();
  for (const a of h.arms) if (!a.cancelled) a.resolve();
  await h.flush();
}

describe("pre-warm heuristics", () => {
  it("never arms without traffic (no timer, nothing armed)", async () => {
    const h = harness();
    h.pool.reconcile();
    await h.flush();
    expect(h.arms).toHaveLength(0);
    expect(h.timerActive()).toBe(false);
  });

  it("arms one session after a single settled request", async () => {
    const h = harness();
    expect(await h.request()).toBeUndefined(); // cold
    await h.flush();
    expect(h.arms).toHaveLength(1);
    await completeArms(h);
    expect(h.pool.snapshot()[0]!.ready).toBe(1);
    expect(h.timerActive()).toBe(true);
    // The next request is served warm and the pool replenishes.
    const lease = await h.request();
    expect(lease?.ready).toBe(true);
    await h.flush();
    expect(h.arms.length).toBe(2);
  });

  it("does not arm before a reservation is known (no settled request yet)", async () => {
    const h = harness();
    const t = h.pool.begin(h.info, null, 500);
    t.cold();
    t.head();
    await h.flush();
    expect(h.arms).toHaveLength(0);
    t.end(); // failed request: still unknown
    await h.flush();
    expect(h.arms).toHaveLength(0);
  });

  it("scales to 2 on a burst (≥3 requests in 5 min) and on overlap", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      await h.request();
      await completeArms(h);
      h.advance(20_000);
    }
    expect(h.pool.snapshot()[0]!.target).toBe(2);
    h.pool.reconcile();
    await completeArms(h);
    expect(h.armed()).toBe(2);

    const o = harness();
    await o.request();
    await completeArms(o);
    expect(o.pool.snapshot()[0]!.target).toBe(1);
    const a = o.pool.begin(o.info, null, 900);
    const b = o.pool.begin(o.info, null, 900);
    expect(o.pool.snapshot()[0]!.target).toBe(2);
    a.take();
    b.take();
    a.end(1000);
    b.end(1000);
    await completeArms(o);
    await completeArms(o);
    expect(o.armed()).toBe(2);
  });

  it("caps per key and globally, and arms one at a time", async () => {
    const h = harness({ maxTotal: 2, maxPerKey: 3 });
    await h.request();
    // Four overlapping requests: target 3 per key, but the global cap is 2.
    const ts = [0, 1, 2, 3].map(() => h.pool.begin(h.info, null, 900));
    for (const t of ts) {
      t.take();
      t.cold();
    }
    for (const t of ts) t.end(1000);
    await h.flush();
    expect(h.arms.filter((a) => !a.cancelled)).toHaveLength(1); // one in flight
    await completeArms(h);
    await completeArms(h);
    await completeArms(h);
    expect(h.armed()).toBe(2);
    expect(h.pool.snapshot()[0]!.target).toBe(3);
  });

  it("does not arm while a cold request is still preprocessing", async () => {
    const h = harness();
    await h.request();
    await completeArms(h);
    const other: PoolKeyInfo = { ...h.info, model: "other" };
    await h.request(1000, other); // learn the reservation for the other key
    const t = h.pool.begin(other, null, 500);
    t.take();
    t.cold();
    // Its own reconcile must not start an arm for "other" while t preprocesses.
    const before = h.arms.length;
    h.pool.reconcile();
    await h.flush();
    expect(h.arms.length).toBe(before);
    t.head();
    await h.flush();
    t.end(1000);
  });

  it("tears down armed sessions when the key goes idle, and stops the timer", async () => {
    const h = harness({ activityWindowMs: 60_000 });
    await h.request();
    await completeArms(h);
    expect(h.armed()).toBe(1);
    h.advance(61_000);
    h.pool.reconcile();
    expect(h.armed()).toBe(0);
    expect(h.arms[0]!.cancelled).toBe(true);
    expect(h.logs.some((l) => l.includes("key idle"))).toBe(true);
    expect(h.timerActive()).toBe(false);
    expect(h.pool.snapshot()).toHaveLength(0);
  });

  it("retires sessions by age and re-arms only while active", async () => {
    const h = harness({ maxAgeMs: 100_000, activityWindowMs: 600_000 });
    await h.request();
    await completeArms(h);
    h.advance(101_000);
    h.pool.reconcile();
    await h.flush();
    expect(h.arms[0]!.cancelled).toBe(true);
    expect(h.logs.some((l) => l.includes("retire") && l.includes("age"))).toBe(true);
    expect(h.arms).toHaveLength(2); // still active: replaced
    await completeArms(h);
    // A retired-by-age session is never claimed.
    h.advance(101_000);
    const t = h.pool.begin(h.info, null, 500);
    const lease = t.take();
    expect(lease === undefined || !lease.ready).toBe(true);
    t.end(1000);
  });

  it("drops dead armed sessions and backs off after a failed arm", async () => {
    const h = harness({ backoffBaseMs: 30_000 });
    await h.request();
    await h.flush();
    h.arms[0]!.reject(new Error("402 insufficient balance"));
    await h.flush();
    expect(h.logs.some((l) => l.includes("backing off 30s"))).toBe(true);
    h.pool.reconcile();
    await h.flush();
    expect(h.arms).toHaveLength(1);
    h.advance(31_000);
    h.pool.reconcile();
    await h.flush();
    expect(h.arms).toHaveLength(2);
    h.arms[1]!.resolve();
    await h.flush();
    h.arms[1]!.session.healthy = false;
    const t = h.pool.begin(h.info, null, 500);
    expect(t.take()).toBeUndefined();
    t.end(1000);
  });

  it("does not arm when the balance cannot cover the reservations", async () => {
    const h = harness({}, 1500); // < 2 × 1000
    await h.request();
    await h.flush();
    expect(h.arms).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("available balance 1500"))).toBe(true);
  });

  it("serves only bodies that fit and raises L after a miss", async () => {
    const h = harness();
    await h.request(1000);
    await completeArms(h);
    expect(h.arms[0]!.len).toBe(4096);
    const t = h.pool.begin(h.info, null, 10_000);
    expect(t.take()).toBeUndefined(); // too big: cold
    t.cold();
    t.head();
    t.end(1000);
    await h.flush();
    // The undersized session is replaced by one for 16 KiB.
    expect(h.arms[0]!.cancelled).toBe(true);
    expect(h.arms[1]!.len).toBe(16384);
  });

  it("a request takes an arm that is still in progress instead of going cold", async () => {
    const h = harness();
    await h.request();
    await h.flush();
    const t = h.pool.begin(h.info, null, 500);
    const lease = t.take();
    expect(lease?.ready).toBe(false);
    h.arms[0]!.resolve();
    expect((await lease!.session).sid).toBe("sid1");
    t.end(1000);
  });

  it("keys pools by max_tokens and credential", async () => {
    const h = harness();
    await h.request();
    await completeArms(h);
    const t = h.pool.begin({ ...h.info, maxTokens: 101 }, null, 500);
    expect(t.take()).toBeUndefined();
    t.end();
    const u = h.pool.begin({ ...h.info, bearer: "sk-other" }, null, 500);
    expect(u.take()).toBeUndefined();
    u.end();
  });
});

describe("body-length buckets", () => {
  it("rounds max × 1.25 up to a power of two within [4 KiB, 8 MiB]", () => {
    expect(chooseBucket(0)).toBe(4096);
    expect(chooseBucket(3000)).toBe(4096);
    expect(chooseBucket(3300)).toBe(8192);
    expect(chooseBucket(100_000)).toBe(131072);
    expect(chooseBucket(50 << 20)).toBe(8 << 20);
  });
});

describe("padPinnedBody", () => {
  const suffix = canonicalSuffix("deepseek-v4-flash", 64);
  const body = buildPinnedBody(
    { messages: [{ role: "user", content: "hi ✓" }], temperature: 0.2 },
    "deepseek-v4-flash",
    64,
  );

  it("pads to the exact length with the suffix last and valid, identical JSON", () => {
    const out = padPinnedBody(body, 4096, suffix);
    expect(out.length).toBe(4096);
    const text = new TextDecoder().decode(out);
    expect(text.endsWith(suffix)).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(new TextDecoder().decode(body)));
    const spaces = text.slice(body.length - new TextEncoder().encode(suffix).length - 2, -suffix.length);
    expect(spaces.trim()).toMatch(/^[\]}]*$/);
  });

  it("is the identity at the exact length and refuses a body that does not fit", () => {
    expect(padPinnedBody(body, body.length, suffix)).toBe(body);
    expect(() => padPinnedBody(body, body.length - 1, suffix)).toThrow();
    expect(() => padPinnedBody(new TextEncoder().encode("{}"), 4096, suffix)).toThrow();
  });
});

describe("pre-warm with a node abandon fee", () => {
  it("defaults off: a node without a fee is pre-warmed as before", async () => {
    const h = harness({}, 1e12, 0);
    for (let i = 0; i < 3; i++) {
      await h.request();
      await completeArms(h);
      h.advance(20_000);
    }
    h.pool.reconcile();
    await completeArms(h);
    expect(h.armed()).toBe(2);
    expect(h.pool.unusedFeeMsats).toBe(0);
  });

  it("arms at most one session when the node charges an acceptable fee", async () => {
    const h = harness({ maxArmedWithFee: 1 }, 1e12, 2000);
    for (let i = 0; i < 3; i++) {
      await h.request();
      await completeArms(h);
      h.advance(20_000);
    }
    expect(h.pool.snapshot()[0]!.target).toBe(1);
    h.pool.reconcile();
    await completeArms(h);
    expect(h.armed()).toBe(1);
    expect(h.logs.some((l) => l.includes("abandon fee of 2000 msats"))).toBe(true);
  });

  it("caps fee-charging sessions across keys (maxArmedWithFee)", async () => {
    const h = harness({ maxTotal: 4, maxArmedWithFee: 1 }, 1e12, 2000);
    await h.request();
    await completeArms(h);
    const other: PoolKeyInfo = { ...h.info, model: "other" };
    await h.request(1000, other);
    await completeArms(h);
    expect(h.armed()).toBe(1);
  });

  it("never arms when the fee exceeds maxSessionFeeMsat", async () => {
    const h = harness({ maxSessionFeeMsat: 1000 }, 1e12, 2000);
    await h.request();
    await completeArms(h);
    expect(h.arms).toHaveLength(0);
    expect(h.pool.snapshot()[0]?.target ?? 0).toBe(0);
    expect(h.logs.some((l) => l.includes("not pre-warming"))).toBe(true);

    const z = harness({ maxSessionFeeMsat: 0 }, 1e12, 1);
    await z.request();
    await completeArms(z);
    expect(z.arms).toHaveLength(0);
  });

  it("counts and logs the fee of an armed session retired unused", async () => {
    const h = harness({ activityWindowMs: 60_000 }, 1e12, 2000);
    await h.request();
    await completeArms(h);
    expect(h.armed()).toBe(1);
    h.advance(61_000);
    h.pool.reconcile();
    expect(h.armed()).toBe(0);
    expect(h.pool.unusedFeeMsats).toBe(2000);
    expect(h.logs.some((l) => l.includes("abandon fee 2000 msats paid"))).toBe(true);
  });

  it("does not count the fee of a claimed session", async () => {
    const h = harness({ activityWindowMs: 60_000 }, 1e12, 2000);
    await h.request();
    await completeArms(h);
    const lease = await h.request();
    expect(lease?.ready).toBe(true);
    expect(h.pool.unusedFeeMsats).toBe(0);
  });

  it("defaults allow parallel agents: 6 armed per key and in total, also for fee nodes", () => {
    expect(PREWARM_DEFAULTS.maxPerKey).toBe(6);
    expect(PREWARM_DEFAULTS.maxTotal).toBe(6);
    expect(PREWARM_DEFAULTS.maxArmedWithFee).toBe(6);
  });
});
