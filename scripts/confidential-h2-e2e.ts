// SDK-level end-to-end check of `http: 2` sessions against a local node.
//   CU_PROVER=…/cu-prover bun scripts/confidential-h2-e2e.ts <node url> <sk-key> <model> [cases...]
// Cases (default: all): seq overlap error unknown idle v2. Real requests (max_tokens 20) on
// the credential; `idle` waits for the offer's h2.idle_secs (E2E_IDLE_WAIT_MS overrides).
import {
  closeConfidentialHttp2,
  closeConfidentialPrewarm,
  confidentialHttp2Snapshot,
  fetchConfidential,
} from "../client/confidential/index";

const [node, bearer, model, ...cases] = process.argv.slice(2);
const want = (c: string) => cases.length === 0 || cases.includes(c);
const offer = (await (await fetch(`${node}/v1/confidential/offer`)).json()) as any;
const stats: any[] = [];
const logs: string[] = [];
const options = (http2: Record<string, unknown> = {}) => ({
  trustedHosts: ["api.venice.ai"],
  nodePubkeys: [offer.notary_pubkey],
  proverPath: process.env.CU_PROVER,
  http2: {
    log: (m: string) => (logs.push(m), console.log("  log:", m)),
    onRequest: (s: any) => stats.push(s),
    ...http2,
  },
});
let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

async function chat(prompt: string, extra: Record<string, unknown> = {}, opts = options(), m = model) {
  const t0 = Date.now();
  const res = await fetchConfidential({
    baseUrl: node!,
    body: { model: m, messages: [{ role: "user", content: prompt }], max_tokens: 20, stream: true, ...extra },
    bearer: bearer!,
    options: opts as never,
  });
  let ttft: number | undefined;
  let text = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttft === undefined && value?.length) ttft = Date.now() - t0;
    text += dec.decode(value, { stream: true });
  }
  let settled = "ok";
  try {
    await (res as any).confidentialSettled;
  } catch (e) {
    settled = `FAILED: ${(e as Error).message}`;
  }
  const content = [...text.matchAll(/^data: (\{.*\})$/gm)]
    .map((x) => {
      try {
        return JSON.parse(x[1]!).choices?.[0]?.delta?.content ?? "";
      } catch {
        return "";
      }
    })
    .join("");
  return {
    status: res.status,
    sid: res.headers.get("x-routstr-confidential-sid"),
    http: res.headers.get("x-routstr-confidential-http"),
    conn: res.headers.get("x-routstr-confidential-connection"),
    prewarmed: res.headers.get("x-routstr-confidential-prewarmed"),
    ttft,
    total: Date.now() - t0,
    done: /data: \[DONE\]/.test(text),
    settled,
    content: content.slice(0, 60),
    raw: text.slice(0, 200),
  };
}
const show = (r: any) => console.log("  ", JSON.stringify({ ...r, raw: undefined }));

if (want("seq")) {
  console.log("== 5 sequential requests");
  const rs: any[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = await chat(`Reply with the number ${i} and nothing else.`);
    show(r);
    rs.push(r);
  }
  check(rs.every((r) => r.status === 200 && r.http === "2" && r.settled === "ok" && r.done), "5 requests: 200, http 2, settled (receipt verified), [DONE]");
  check(new Set(rs.map((r) => r.sid)).size === 1, "one connection (one sid)");
  check(rs.map((r) => r.conn).join("|") === "new; request=1|reused; request=2|reused; request=3|reused; request=4|reused; request=5", "request numbers 1..5, first new, rest reused");
  check(confidentialHttp2Snapshot().length === 1, "one pooled connection");
  console.log("   stats:", JSON.stringify(stats.splice(0)));
}

if (want("overlap")) {
  console.log("== two overlapping requests");
  const before = confidentialHttp2Snapshot().length;
  const [a, b] = await Promise.all([chat("Say A."), chat("Say B.")]);
  show(a);
  show(b);
  check(a.status === 200 && b.status === 200 && a.settled === "ok" && b.settled === "ok", "both settled");
  check(a.sid !== b.sid, "two connections (two sids)");
  check(confidentialHttp2Snapshot().length === Math.max(2, before), `pool holds ${confidentialHttp2Snapshot().length} connection(s)`);
  console.log("   stats:", JSON.stringify(stats.splice(0)));
}

if (want("error")) {
  console.log("== provider error (400), then a request on a fresh connection");
  const pool0 = confidentialHttp2Snapshot().map((s) => s.sid);
  const bad = await chat("x", { temperature: "hot" });
  show(bad);
  console.log("   body:", bad.raw);
  check(bad.status === 400 && bad.http === "2", "the provider's 400 is surfaced with its status");
  check(bad.settled === "ok", "the error was settled (error head disclosed, receipt verified)");
  await new Promise((r) => setTimeout(r, 500));
  check(!confidentialHttp2Snapshot().some((s) => s.sid === bad.sid?.slice(0, 8)), "its connection left the pool");
  const next = await chat("Reply with OK.");
  show(next);
  check(next.status === 200 && next.settled === "ok", "the next request works");
  check(next.sid !== bad.sid, "on another connection");
  console.log("   pool before:", pool0, "after:", confidentialHttp2Snapshot().map((s) => s.sid));
  console.log("   stats:", JSON.stringify(stats.splice(0)));
}

if (want("unknown")) {
  console.log("== unknown model");
  let err: any;
  try {
    await chat("x", {}, options(), "no-such-model-xyz");
  } catch (e) {
    err = e;
  }
  check(err?.code === "offer_malformed" && /does not serve no-such-model-xyz/.test(err.message), `refused before any connection: ${err?.code}: ${err?.message}`);
  const next = await chat("Reply with OK.");
  show(next);
  check(next.status === 200 && next.settled === "ok", "the next request works");
  stats.splice(0);
}

if (want("idle")) {
  // The node's idle limit ends a pooled connection the client still holds
  // (a negative margin keeps it past the limit): the next request must run.
  const idle = Number(offer.h2?.idle_secs ?? 300);
  console.log(`== a connection the node closed while idle (idle_secs ${idle})`);
  closeConfidentialHttp2();
  const o = options({ idleMarginMs: -60_000 });
  const a = await chat("Reply with 1.", {}, o);
  show(a);
  const waitMs = Number(process.env.E2E_IDLE_WAIT_MS ?? idle * 1000 + 1500);
  await new Promise((r) => setTimeout(r, waitMs));
  console.log("   pool after the wait:", JSON.stringify(confidentialHttp2Snapshot()));
  const b = await chat("Reply with 2.", {}, o);
  show(b);
  check(a.status === 200 && b.status === 200 && b.settled === "ok", "the request after the idle close settled");
  check(a.sid !== b.sid, "on a new connection");
  stats.splice(0);
}

if (want("v2")) {
  console.log("== http2 disabled: the v2 flow");
  const r = await chat("Reply with OK.", {}, options({ enabled: false }));
  show(r);
  check(r.status === 200 && r.http === null && r.settled === "ok", "v2 session settled, no http 2 header");
}

closeConfidentialHttp2();
closeConfidentialPrewarm();
console.log(failures ? `FAILED: ${failures}` : "ALL OK");
setTimeout(() => process.exit(failures ? 1 : 0), 800);
