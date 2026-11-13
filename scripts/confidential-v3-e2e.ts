// SDK-level end-to-end gate of the protocol-v3 confidential client against a
// node you started (PROTOCOL-V3.md §13: "SDK"). Real requests at the real
// provider, max_tokens 20; nothing is announced by this script.
//
//   CU_PROVER=…/cu-prover CU_2PC=…/cu-2pc bun scripts/confidential-v3-e2e.ts <node url> <sk-key> <model> [cases...]
//
// Cases (default: all):
//   seq       three sequential chat requests on one framing-"2" connection (cold, open, open)
//   burst     three overlapping requests: one reuses the open connection, two open their own
//   image     ONE image of E2E_IMAGE_MODEL (default: the cheapest the node prices) on the
//             open connection, then one with framing "1.1" (about $0.01 each; E2E_NO_IMAGES=1 skips)
//   h11       framing "1.1" forced: two cold requests, a connection each
//   armed     pre-warm: a "1.1" request served by an armed connection, and a "2" request
//             served by an armed connection (reuse "none", so each request needs its own)
//   fallback  the sidecar's HTTP/2 open is made to fail (E2E_H2_FAIL_FILE, the sidecar's
//             CU_TEST_H2_FAIL_FILE): the request is served on "1.1" on the same node, "2" is
//             marked bad; the mark is lifted for the next case
//   scopes    two reuse scopes get separate connections; each scope keeps its own
//   refused   a request the node refuses (402: E2E_POOR_KEY holds the deposit but not the
//             reservation), then, after E2E_TOPUP_CMD ran, a good one on the same connection
//   upgrade   a fake v2 node (`node_protocol_outdated`) and a fake newer node
//             (426 `upgrade_required`), both local
//   money     the key's balance at the node fell by exactly the receipts' costs plus the
//             deposits of the connections that ended unused
//
// Another provider: E2E_TRUSTED_HOSTS=<its host> and E2E_NO_IMAGES=1 for a chat-only node.
//
// The script prints one row per request (framing, what it found, time to first token,
// bytes each way) and a summary by (framing, cold | armed | open).
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  closeConfidentialConnections,
  confidentialConnectionsSnapshot,
  fetchConfidential,
  NodeProtocolOutdatedError,
  UpgradeRequiredError,
  canonicalJson,
  type ConfidentialRequestStats,
} from "../client/confidential/index";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

// Runs under Bun (its HTTP and WebSocket server play the fake nodes).
declare const Bun: any;

const [node, bearer, model, ...cases] = process.argv.slice(2);
if (!node || !bearer || !model) {
  console.error("usage: bun scripts/confidential-v3-e2e.ts <node url> <sk-key> <model> [cases...]");
  process.exit(2);
}
const want = (c: string) => cases.length === 0 || cases.includes(c);
const offer = (await (await fetch(`${node}/v1/confidential/offer?v=3`)).json()) as any;
const DEPOSIT: number = offer.connection_deposit_msat ?? 0;
const FEE: number = offer.session_fee_msat ?? 0;
const FAIL_FILE = process.env.E2E_H2_FAIL_FILE;
const POOR_KEY = process.env.E2E_POOR_KEY;
const TOPUP_CMD = process.env.E2E_TOPUP_CMD;

interface Row extends ConfidentialRequestStats {
  label: string;
  costMsats?: number;
}
const rows: Row[] = [];
const logs: string[] = [];
let label = "";
/** What the node charged this key, from the receipts. */
let spent = 0;
/** Deposits of connections that ended without a settled request (charged by the node). */
let depositsLost = 0;

const options = (extra: Record<string, unknown> = {}, http2: Record<string, unknown> = {}) => ({
  // The provider hosts accepted (E2E_TRUSTED_HOSTS, comma-separated; default Venice).
  trustedHosts: (process.env.E2E_TRUSTED_HOSTS ?? "api.venice.ai").split(",").filter(Boolean),
  nodePubkeys: [offer.notary_pubkey],
  proverPath: process.env.CU_PROVER,
  twoPcPath: process.env.CU_2PC,
  http2: {
    log: (m: string) => (logs.push(m), console.log("  log:", m)),
    onRequest: (s: ConfidentialRequestStats) => rows.push({ ...s, label }),
    ...http2,
  },
  ...extra,
});
let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function balance(key = bearer!): Promise<{ balance: number; reserved: number }> {
  const j = (await (await fetch(`${node}/v1/balance/info`, { headers: { Authorization: `Bearer ${key}` } })).json()) as any;
  return { balance: Number(j.balance), reserved: Number(j.reserved ?? j.reserved_balance ?? 0) };
}

interface Out {
  status: number;
  http: string | null;
  conn: string | null;
  sid: string | null;
  ttft?: number;
  text: string;
  settled: string;
  cost?: number;
}

async function chat(prompt: string, opts = options(), extra: Record<string, unknown> = {}, key = bearer!): Promise<Out> {
  const t0 = Date.now();
  const res = await fetchConfidential({
    baseUrl: node!,
    body: { model, messages: [{ role: "user", content: prompt }], max_tokens: 20, stream: true },
    bearer: key,
    options: opts as never,
    ...extra,
  });
  let ttft: number | undefined;
  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttft === undefined && value?.length) ttft = Date.now() - t0;
      text += dec.decode(value, { stream: true });
    }
  }
  let settled = "ok";
  let cost: number | undefined;
  try {
    const s = await (res as any).confidentialSettled;
    cost = s?.costMsats;
  } catch (e) {
    settled = `FAILED: ${(e as Error).message}`;
  }
  if (cost !== undefined && key === bearer) spent += cost;
  const last = rows[rows.length - 1];
  if (last && cost !== undefined) last.costMsats = cost;
  return {
    status: res.status,
    http: res.headers.get("x-routstr-confidential-http"),
    conn: res.headers.get("x-routstr-confidential-connection"),
    sid: res.headers.get("x-routstr-confidential-sid"),
    ttft,
    text,
    settled,
    cost,
  };
}
const good = (o: Out) => o.status === 200 && o.settled === "ok" && o.text.includes("data: [DONE]");
const show = (o: Out) => `status=${o.status} http=${o.http} conn="${o.conn}" ttft=${o.ttft}ms settled=${o.settled} cost=${o.cost}`;

const start = await balance();
console.log(`node ${node} v=${offer.v} http=${JSON.stringify(offer.http)} deposit=${DEPOSIT} fee=${FEE} idle=${offer.idle_timeout_s}s balance=${start.balance}`);

if (want("seq")) {
  label = "seq";
  console.log("\n# seq: three sequential requests on one framing-2 connection");
  const outs: Out[] = [];
  for (let i = 1; i <= 3; i++) {
    const o = await chat(`Reply with the number ${i} only.`);
    outs.push(o);
    console.log(`  ${i}: ${show(o)}`);
  }
  check(outs.every(good), "three requests settled");
  check(outs.every((o) => o.http === "2"), 'all on framing "2"');
  check(outs[0]!.conn === "new; request=1" && outs[1]!.conn === "reused; request=2" && outs[2]!.conn === "reused; request=3", "one connection, requests 1, 2, 3");
  check(new Set(outs.map((o) => o.sid)).size === 1, "one connection id");
  const mine = rows.filter((r) => r.label === "seq");
  check(mine[0]?.depositReleasedMsat === DEPOSIT && mine[1]?.depositReleasedMsat === undefined, `the first receipt returns the deposit (${DEPOSIT} msat), later ones do not`);
  // The session fee is charged once: request 1 costs at least the fee, later ones less than it.
  if (FEE > 0) check((outs[0]!.cost ?? 0) >= FEE && (outs[1]!.cost ?? FEE) < FEE && (outs[2]!.cost ?? FEE) < FEE, `the session fee (${FEE} msat) is charged once per connection`);
}

if (want("burst")) {
  label = "burst";
  console.log("\n# burst: three overlapping requests");
  const before = confidentialConnectionsSnapshot().length;
  const outs = await Promise.all([1, 2, 3].map((i) => chat(`Reply with the letter ${"abc"[i - 1]} only.`)));
  outs.forEach((o, i) => console.log(`  ${i + 1}: ${show(o)}`));
  check(outs.every(good), "three overlapping requests settled");
  check(new Set(outs.map((o) => o.sid)).size === 3, "on three connections");
  check(confidentialConnectionsSnapshot().length === Math.max(before, 3), `the pool holds ${confidentialConnectionsSnapshot().length} connections`);
}

if (want("image") && process.env.E2E_NO_IMAGES !== "1") {
  label = "image";
  console.log("\n# image: one image on the open framing-2 connection, one with framing 1.1");
  const list = (offer.images?.price_list ?? {}) as Record<string, { id: string; msat_per_image: number }[]>;
  const cheapest = Object.entries(list)
    .flatMap(([m, vs]) => vs.map((v) => ({ m, price: v.msat_per_image })))
    .sort((a, b) => a.price - b.price)[0];
  const imageModel = process.env.E2E_IMAGE_MODEL ?? cheapest?.m;
  if (!imageModel || !list[imageModel]) check(false, "the node prices no image model");
  else {
    const price = Math.min(...list[imageModel]!.map((v) => v.msat_per_image));
    for (const [http, wantHttp] of [["auto", (offer.h2?.kinds ?? []).includes("images") ? "2" : "1.1"], ["1.1", "1.1"]] as const) {
      const t0 = Date.now();
      const heap0 = process.memoryUsage().rss;
      const res = await fetchConfidential({
        baseUrl: node!,
        method: "POST",
        path: "/v1/images/generations",
        body: { model: imageModel, prompt: "a plain red circle on a white background", n: 1 },
        bearer: bearer!,
        options: options({ http }) as never,
      });
      const json = (await res.json()) as any;
      const s = await (res as any).confidentialSettled;
      if (typeof s?.costMsats === "number") spent += s.costMsats;
      const b64: string = json?.data?.[0]?.b64_json ?? "";
      const last = rows[rows.length - 1];
      if (last) last.costMsats = s?.costMsats;
      console.log(
        `  http=${res.headers.get("x-routstr-confidential-http")} conn="${res.headers.get("x-routstr-confidential-connection")}" status=${res.status} ` +
          `image_bytes=${Math.floor((b64.length * 3) / 4)} cost=${s?.costMsats} total=${Date.now() - t0}ms rss_delta=${Math.round((process.memoryUsage().rss - heap0) / 1e6)}MB`,
      );
      check(res.status === 200 && b64.length > 1000, `an image of ${imageModel} came back (framing ${wantHttp})`);
      check(res.headers.get("x-routstr-confidential-http") === wantHttp, `on framing "${wantHttp}"`);
      const firstOnConn = /request=1$/.test(res.headers.get("x-routstr-confidential-connection") ?? "");
      check(s?.costMsats === price + (firstOnConn ? FEE : 0), `flat receipt: ${price} msat per image${firstOnConn ? ` + the session fee ${FEE}` : ", no second session fee"}`);
    }
  }
}

if (want("h11")) {
  label = "h11";
  console.log('\n# h11: framing "1.1" forced');
  const outs: Out[] = [];
  for (let i = 1; i <= 2; i++) {
    const o = await chat(`Reply with the number ${i + 3} only.`, options({ http: "1.1" }));
    outs.push(o);
    console.log(`  ${i}: ${show(o)}`);
  }
  check(outs.every(good), "two requests settled");
  check(outs.every((o) => o.http === "1.1" && o.conn === "new; request=1"), 'each on its own framing-"1.1" connection');
  check(outs[0]!.sid !== outs[1]!.sid, "two connection ids");
  if (FEE > 0) check(outs.every((o) => (o.cost ?? 0) >= FEE), "each connection pays the session fee");
  const mine = rows.filter((r) => r.label === "h11");
  check(mine.every((r) => r.depositReleasedMsat === DEPOSIT), "each receipt returns its connection's deposit");
}

if (want("armed")) {
  console.log("\n# armed: requests served by armed connections (pre-warm)");
  closeConfidentialConnections();
  // A spare that is never used costs the deposit: allow this node's.
  const prewarm = { log: (m: string) => console.log("  log:", m), maxDepositMsat: Math.max(5000, DEPOSIT) };
  const armedSpare = async (http: string) => {
    for (let i = 0; i < 600; i++) {
      if (confidentialConnectionsSnapshot().some((s) => s.http === http && s.state === "armed")) return true;
      await sleep(100);
    }
    return false;
  };
  for (const http of ["1.1", "2"] as const) {
    label = `armed-${http}`;
    const opts = () => options({ http, prewarm }, http === "2" ? { reuse: "none" } : {});
    const first = await chat("Reply with the word one only.", opts());
    console.log(`  ${http} first: ${show(first)}`);
    check(good(first), `framing ${http}: the first request settled (cold)`);
    check(await armedSpare(http), `framing ${http}: an armed connection is waiting`);
    const second = await chat("Reply with the word two only.", opts());
    console.log(`  ${http} second: ${show(second)}`);
    check(good(second) && second.http === http && second.conn === "armed; request=1", `framing ${http}: the second request ran on the armed connection`);
    // The spare armed after the second request is never used: its deposit is charged when it is closed.
    await armedSpare(http);
    const spares = confidentialConnectionsSnapshot().filter((s) => s.state === "armed" || s.state === "arming").length;
    closeConfidentialConnections();
    depositsLost += spares * DEPOSIT;
    console.log(`  ${http}: closed ${spares} unused armed connection(s): ${spares * DEPOSIT} msat of deposits charged`);
    await sleep(1500);
  }
}

if (want("fallback")) {
  label = "fallback";
  console.log('\n# fallback: framing "2" fails to open, the request is served on "1.1"');
  if (!FAIL_FILE) check(false, "E2E_H2_FAIL_FILE is not set (the sidecar's CU_TEST_H2_FAIL_FILE)");
  else {
    closeConfidentialConnections();
    writeFileSync(FAIL_FILE, "");
    try {
      const logs0 = logs.length;
      const o = await chat("Reply with the word fallback only.");
      console.log(`  1: ${show(o)}`);
      check(good(o) && o.http === "1.1", 'served on framing "1.1" on the same node');
      check(logs.slice(logs0).some((l) => /framing "2" marked bad/.test(l)), 'framing "2" is marked bad for the node');
      const again = await chat("Reply with the word again only.");
      console.log(`  2: ${show(again)}`);
      check(good(again) && again.http === "1.1" && again.conn === "new; request=1", 'the next request goes straight to "1.1" (the mark holds)');
    } finally {
      if (existsSync(FAIL_FILE)) rmSync(FAIL_FILE);
    }
    // A new pool forgets the mark; the sidecar offers "2" again once its own retry time passed.
    closeConfidentialConnections();
    for (let i = 0; i < 40; i++) {
      const o2 = (await (await fetch(`${node}/v1/confidential/offer?v=3`)).json()) as any;
      if ((o2.http ?? []).includes("2")) break;
      await sleep(1000);
    }
    await sleep(31_000); // the transport's offer cache (30 s) may still hold an offer without "2"
    const back = await chat("Reply with the word back only.");
    console.log(`  3: ${show(back)}`);
    check(good(back) && back.http === "2", 'framing "2" is used again after the failure was lifted');
  }
}

if (want("scopes")) {
  label = "scopes";
  console.log("\n# scopes: two local clients get separate connections");
  const a1 = await chat("Reply with the letter a only.", options(), { reuseScope: "client-a" });
  const b1 = await chat("Reply with the letter b only.", options(), { reuseScope: "client-b" });
  const a2 = await chat("Reply with the letter c only.", options(), { reuseScope: "client-a" });
  const b2 = await chat("Reply with the letter d only.", options(), { reuseScope: "client-b" });
  for (const [k, o] of Object.entries({ a1, b1, a2, b2 })) console.log(`  ${k}: ${show(o)} sid=${o.sid?.slice(0, 8)}`);
  check([a1, b1, a2, b2].every(good), "four requests settled");
  check(a1.sid !== b1.sid, "the two scopes use different connections");
  check(a1.sid === a2.sid && b1.sid === b2.sid, "each scope reuses its own connection");
  check(a2.conn === "reused; request=2" && b2.conn === "reused; request=2", "request 2 of each scope");
}

if (want("refused")) {
  label = "refused";
  console.log("\n# refused: a refused request (402), then a good one on the same connection");
  if (!POOR_KEY || !TOPUP_CMD) check(false, "E2E_POOR_KEY and E2E_TOPUP_CMD are not set");
  else {
    const before = await balance(POOR_KEY);
    const refused = await chat("Reply with the word no only.", options({ http: "2" }), {}, POOR_KEY);
    console.log(`  1: status=${refused.status} body=${refused.text.slice(0, 160)}`);
    check(refused.status === 402, "the node refused the request with 402 (the balance covers the deposit, not the reservation)");
    const snap = confidentialConnectionsSnapshot().filter((s) => s.state === "idle" && s.requests === 0);
    check(snap.length === 1, "the connection is kept (idle, no request accepted)");
    const mid = await balance(POOR_KEY);
    // The balance the node reports is what is available: the deposit is held, nothing else moved.
    check(
      mid.balance + mid.reserved === before.balance + before.reserved && mid.reserved === DEPOSIT,
      `the refusal cost nothing: only the deposit is held (available ${mid.balance}, reserved ${mid.reserved})`,
    );
    execSync(TOPUP_CMD, { stdio: "ignore" });
    const ok = await chat("Reply with the word yes only.", options({ http: "2" }), {}, POOR_KEY);
    console.log(`  2: ${show(ok)}`);
    check(good(ok) && ok.conn === "reused; request=1", "the good request ran on the same connection with the same number");
    const row = rows[rows.length - 1];
    check(row?.depositReleasedMsat === DEPOSIT, "its receipt returns the deposit");
    const after = await balance(POOR_KEY);
    console.log(`  poor key: before=${before.balance} after_topup_and_request=${after.balance} cost=${ok.cost}`);
  }
}

if (want("upgrade")) {
  console.log("\n# upgrade: a fake v2 node, and a fake node that is newer than this client");
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = bytesToHex(schnorr.getPublicKey(priv));
  const sign = (o: Record<string, unknown>) => {
    const payload = canonicalJson(o);
    return { ...o, sig: bytesToHex(schnorr.sign(sha256(utf8ToBytes(payload)), priv)), sig_payload: payload };
  };
  const asked: string[] = [];
  const { sig: _s, sig_payload: _p, ...real } = JSON.parse(offer.sig_payload ?? JSON.stringify(offer));
  const v2 = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request) {
      asked.push(new URL(req.url).pathname + new URL(req.url).search);
      const { twopc: _t, http: _h, h2: _b, connection_deposit_msat: _d, idle_timeout_s: _i, ...old } = real;
      return Response.json(sign({ ...old, v: 2, min_v: 2, max_v: 2, notary_pubkey: pub }));
    },
  });
  let err: unknown;
  try {
    await fetchConfidential({
      baseUrl: `http://127.0.0.1:${v2.port}`,
      body: { model, messages: [{ role: "user", content: "x" }] },
      bearer: "sk-none",
      options: { ...options(), nodePubkeys: [pub] } as never,
    });
  } catch (e) {
    err = e;
  }
  v2.stop(true);
  console.log(`  v2 node: ${(err as Error)?.message}`);
  check(err instanceof NodeProtocolOutdatedError && (err as any).code === "node_protocol_outdated", "a v2 node is node_protocol_outdated");
  check(asked[0] === "/v1/confidential/offer?v=3", "the offer was asked for with ?v=3");

  const newer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request, server: any) {
      if (new URL(req.url).pathname.endsWith("/ws")) return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
      return Response.json(sign({ ...real, notary_pubkey: pub }));
    },
    websocket: {
      message(ws: any) {
        ws.send(JSON.stringify({ type: "error", status: 426, reason: "upgrade_required", min_v: 4, detail: "this node speaks routstr-confidential v4; update your client" }));
        ws.close();
      },
    },
  });
  err = undefined;
  try {
    await fetchConfidential({
      baseUrl: `http://127.0.0.1:${newer.port}`,
      body: { model, messages: [{ role: "user", content: "x" }] },
      bearer: "sk-none",
      options: { ...options(), nodePubkeys: [pub] } as never,
    });
  } catch (e) {
    err = e;
  }
  newer.stop(true);
  console.log(`  newer node: ${(err as Error)?.message}`);
  check(err instanceof UpgradeRequiredError && (err as any).code === "upgrade_required" && (err as any).minVersion === 4, "a 426 is upgrade_required, with the node's minimum version");
}

closeConfidentialConnections();

if (want("money")) {
  console.log("\n# money");
  await sleep(2500);
  let end = await balance();
  for (let i = 0; i < 20 && end.reserved !== 0; i++) {
    await sleep(500);
    end = await balance();
  }
  const fell = start.balance - end.balance;
  console.log(`  balance ${start.balance} -> ${end.balance} (fell by ${fell}); receipts ${spent}; deposits of unused connections ${depositsLost}; reserved ${end.reserved}`);
  check(end.reserved === 0, "nothing is reserved at the end");
  check(fell === spent + depositsLost, `the balance fell by exactly the receipts' costs plus the unused deposits (${spent} + ${depositsLost})`);
}

console.log("\n# requests (time to first token from the request's arrival; bytes between client and node)");
const pad = (v: unknown, n: number) => String(v ?? "-").padEnd(n);
console.log(`${pad("case", 10)}${pad("http", 5)}${pad("found", 7)}${pad("n", 3)}${pad("status", 7)}${pad("ttft_ms", 9)}${pad("total_ms", 9)}${pad("connect_ms", 11)}${pad("sent", 9)}${pad("recv", 10)}${pad("arm_sent", 10)}${pad("arm_recv", 10)}${pad("cost_msat", 10)}`);
for (const r of rows) {
  console.log(
    `${pad(r.label, 10)}${pad(r.http, 5)}${pad(r.warm, 7)}${pad(r.n, 3)}${pad(r.status, 7)}${pad(r.ttftMs, 9)}${pad(r.totalMs, 9)}${pad(r.connectMs, 11)}${pad(r.bytesSent, 9)}${pad(r.bytesRecv, 10)}${pad(r.armBytesSent, 10)}${pad(r.armBytesRecv, 10)}${pad(r.costMsats, 10)}`,
  );
}
console.log("\n# summary: chat requests by framing and what they found (medians)");
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
console.log(`${pad("http", 5)}${pad("found", 7)}${pad("count", 6)}${pad("ttft_ms", 9)}${pad("sent", 9)}${pad("recv", 10)}${pad("arm_sent", 10)}${pad("arm_recv", 10)}`);
for (const http of ["2", "1.1"]) {
  for (const warm of ["cold", "armed", "open"]) {
    const g = rows.filter((r) => r.http === http && r.warm === warm && r.kind !== "images" && r.status === 200);
    if (!g.length) continue;
    console.log(
      `${pad(http, 5)}${pad(warm, 7)}${pad(g.length, 6)}${pad(median(g.map((r) => r.ttftMs ?? 0)), 9)}${pad(median(g.map((r) => r.bytesSent)), 9)}${pad(median(g.map((r) => r.bytesRecv)), 10)}` +
        `${pad(median(g.map((r) => r.armBytesSent ?? 0)), 10)}${pad(median(g.map((r) => r.armBytesRecv ?? 0)), 10)}`,
    );
  }
}
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
