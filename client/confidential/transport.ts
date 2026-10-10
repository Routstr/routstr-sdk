/**
 * Confidential-upstream as a request transport.
 *
 * `RoutstrClient` calls this instead of `fetch()` for a request that opted
 * into confidential mode. Credential acquisition, top-ups, failover, usage
 * tracking and balance accounting stay the client's normal code: this only
 * turns (node, request body, bearer) into an ordinary `Response`.
 *
 * The node reserves the request's maximum cost on the bearer (a full-context
 * prompt plus the pinned completion cap, at the signed offer's rates) and
 * settles the π_C3-verified usage on it. The response body streams as records
 * decrypt (each record is authenticated by TLS). Settlement checks (proofs,
 * receipt signature and binding, usage, cost) finish after the body: a
 * non-streaming call fails if they fail, and a stream ends with an error
 * instead of a clean end. `confidentialSettled` carries the same outcome.
 *
 * Only `POST …/chat/completions` is supported: the pinned suffix, the head
 * template and the usage proof are all chat-completions specific.
 */

import { ConfidentialError, SessionRejectedError } from "./errors";
import {
  fetchConfidentialOffer,
  offerAbandonFeeMsat,
  verifyConfidentialOffer,
  type VerifiedOffer,
} from "./offer";
import { CuProverBackend } from "./prover";
import { ConfidentialSession, type ConfidentialSessionResult } from "./session";
import { canonicalSuffix, HOP_BY_HOP_HEADERS } from "./suffix";
import {
  endsWith,
  padPinnedBody,
  PREWARM_DEFAULTS,
  PrewarmPool,
  type ArmHandle,
  type PoolKeyInfo,
  type PrewarmOptions,
  type RequestTicket,
} from "./prewarm";

export interface ConfidentialRequestOptions {
  /** Upstream TLS hostnames the client trusts (exact or wildcard). */
  trustedHosts: readonly string[];
  /** Node signing keys (hex or npub) whose offers are accepted. */
  nodePubkeys?: readonly string[];
  /** Dev only: accept an offer signed by a key that is not pinned. */
  allowUnpinned?: boolean;
  /** `cu-prover` binary (else CU_PROVER_BIN / CU_PROVER / PATH). */
  proverPath?: string;
  /**
   * `cu-2pc` binary for protocol v2 offers (else CU_2PC_BIN / CU_2PC, then
   * next to cu-prover, then PATH).
   */
  twoPcPath?: string;
  /** Evidence directory for per-session artifacts. */
  runsDir?: string;
  /**
   * Traffic-driven pre-warming of protocol v2 sessions (see `prewarm.ts`).
   * Off unless set; `{}` enables it with the defaults. Not used for one-off
   * Cashu bearers (`returnChange`) or v1 offers.
   */
  prewarm?: PrewarmOptions;
}

/** The process-wide pre-warm pool (created on first use). */
let pool: PrewarmPool<ConfidentialSession, ConfidentialRequestOptions> | undefined;

function prewarmPool(options: PrewarmOptions): PrewarmPool<ConfidentialSession, ConfidentialRequestOptions> {
  if (!pool) {
    pool = new PrewarmPool<ConfidentialSession, ConfidentialRequestOptions>(options, {
      arm: armPooledSession,
      availableMsats: availableBalance,
    });
  } else pool.configure(options);
  return pool;
}

/** Close every pre-warmed session (the node releases their reservations). */
export function closeConfidentialPrewarm(): void {
  pool?.close();
  pool = undefined;
}

/** Pool state, for status pages and tests. */
export function confidentialPrewarmSnapshot(): ReturnType<PrewarmPool<ConfidentialSession>["snapshot"]> {
  return pool?.snapshot() ?? [];
}

function armPooledSession(
  info: PoolKeyInfo,
  options: ConfidentialRequestOptions,
  bodyLength: number,
): ArmHandle<ConfidentialSession> {
  let session: ConfidentialSession | undefined;
  let cancelled = false;
  const ready = (async () => {
    const offer = await verifiedOffer(info.baseUrl, options);
    if (offer.v !== 2) throw new ConfidentialError("offer_malformed", "pre-warm needs a protocol v2 offer");
    if (!(info.model in offer.price_list)) {
      throw new ConfidentialError("offer_malformed", `node no longer serves ${info.model} confidentially`);
    }
    // An armed session that is never used costs the node's abandon fee.
    const fee = offerAbandonFeeMsat(offer);
    const maxFee = options.prewarm?.maxSessionFeeMsat ?? PREWARM_DEFAULTS.maxSessionFeeMsat;
    if (fee > maxFee) {
      throw new ConfidentialError(
        "session_rejected",
        `node abandon fee ${fee} msats exceeds prewarm.maxSessionFeeMsat ${maxFee}; not pre-warming`,
      );
    }
    if (cancelled) throw new ConfidentialError("session_rejected", "pre-warm cancelled");
    session = new ConfidentialSession({
      baseUrl: info.baseUrl,
      offer,
      auth: info.bearer,
      model: info.model,
      maxTokens: info.maxTokens,
      bodyLength,
      prover: new CuProverBackend({ binaryPath: options.proverPath }),
      twoPcPath: options.twoPcPath,
      runsDir: options.runsDir,
      // The sidecar allows 180 s of preprocessing; a pooled arm is not
      // waited on by a request, so give it the full window.
      timeouts: { twoPcKeyShare: 175_000 },
    });
    await session.open();
    await session.arm();
    return session;
  })();
  ready.catch(() => session?.close());
  return {
    ready,
    cancel: () => {
      cancelled = true;
      session?.close();
    },
  };
}

/** The credential's spendable balance on the node (msats), via the normal balance endpoint. */
async function availableBalance(info: PoolKeyInfo): Promise<number | undefined> {
  try {
    const res = await fetch(`${info.baseUrl.replace(/\/$/, "")}/v1/balance/info`, {
      headers: { Authorization: `Bearer ${info.bearer}` },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { balance?: unknown };
    return typeof j.balance === "number" ? j.balance : undefined;
  } catch {
    return undefined;
  }
}

/** Request keys the pinned suffix sets; they never come from the caller. */
const PINNED_KEYS = new Set([
  "model",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "n",
  "stream",
  "stream_options",
  "venice_parameters",
]);

/** Signed offers by node; every use re-verifies it under the caller's policy. */
const offerCache = new Map<string, { offer: VerifiedOffer; at: number }>();

async function verifiedOffer(
  baseUrl: string,
  options: ConfidentialRequestOptions,
  fresh = false,
): Promise<VerifiedOffer> {
  const key = baseUrl.replace(/\/$/, "");
  const policy = {
    pinnedPubkeys: options.nodePubkeys,
    allowUnpinned: options.allowUnpinned,
    trustedHosts: options.trustedHosts,
  };
  const hit = offerCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30_000) {
    // Signature, pin, version and trusted host are checked again for *this*
    // call: a cached offer accepted under a looser policy must not leak.
    return verifyConfidentialOffer(hit.offer, policy);
  }
  const offer = await fetchConfidentialOffer(key, policy);
  offerCache.set(key, { offer, at: Date.now() });
  return offer;
}

/** The one endpoint the confidential transport implements. */
export function isConfidentialEndpoint(method: string | undefined, path: string | undefined): boolean {
  return (
    (method ?? "POST").toUpperCase() === "POST" &&
    /(^|\/)chat\/completions\/?$/.test((path ?? "/v1/chat/completions").split("?")[0]!)
  );
}

/** The request body as the provider sees it: private part + pinned suffix. */
export function buildPinnedBody(
  request: Record<string, unknown>,
  model: string,
  maxTokens: number,
): Uint8Array {
  const priv: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request)) {
    if (!PINNED_KEYS.has(k)) priv[k] = v;
  }
  const json = JSON.stringify(priv);
  // Drop the closing brace: the suffix closes the object and wins last. With
  // no private keys the suffix's leading comma must go too.
  const suffix = canonicalSuffix(model, maxTokens);
  const prefix = json.slice(0, -1);
  return new TextEncoder().encode(prefix === "{" ? `{${suffix.slice(1)}` : prefix + suffix);
}

function requestedMaxTokens(request: Record<string, unknown>, cap: number): number {
  for (const k of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const v = request[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      return Math.max(1, Math.min(Math.trunc(v), cap));
    }
  }
  return cap;
}

/**
 * Fold the streamed SSE into one `chat.completion` for a caller that did not
 * ask for a stream (the pinned suffix always streams: the billed usage event
 * only exists there).
 */
export function aggregateChatCompletionSse(sseText: string): Record<string, unknown> {
  let id: unknown;
  let created: unknown;
  let model: unknown;
  let usage: unknown;
  const choices = new Map<
    number,
    {
      role: string;
      content: string;
      reasoning: string;
      finish_reason: unknown;
      tool_calls: Map<number, { id?: unknown; type?: unknown; function: { name: string; arguments: string } }>;
    }
  >();
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    id ??= ev.id;
    created ??= ev.created;
    model ??= ev.model;
    if (ev.usage) usage = ev.usage;
    for (const c of Array.isArray(ev.choices) ? ev.choices : []) {
      const idx = typeof c.index === "number" ? c.index : 0;
      let acc = choices.get(idx);
      if (!acc) {
        acc = { role: "assistant", content: "", reasoning: "", finish_reason: null, tool_calls: new Map() };
        choices.set(idx, acc);
      }
      const d = c.delta ?? {};
      if (typeof d.role === "string") acc.role = d.role;
      if (typeof d.content === "string") acc.content += d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string") acc.reasoning += r;
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const ti = typeof tc.index === "number" ? tc.index : 0;
        let t = acc.tool_calls.get(ti);
        if (!t) {
          t = { function: { name: "", arguments: "" } };
          acc.tool_calls.set(ti, t);
        }
        if (tc.id !== undefined) t.id = tc.id;
        if (tc.type !== undefined) t.type = tc.type;
        if (typeof tc.function?.name === "string") t.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") t.function.arguments += tc.function.arguments;
      }
      if (c.finish_reason != null) acc.finish_reason = c.finish_reason;
    }
  }
  const out: Record<string, unknown> = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [...choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, acc]) => {
        const message: Record<string, unknown> = { role: acc.role, content: acc.content };
        if (acc.reasoning) message.reasoning_content = acc.reasoning;
        if (acc.tool_calls.size > 0) {
          message.tool_calls = [...acc.tool_calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, t]) => ({ id: t.id, type: t.type ?? "function", function: t.function }));
        }
        return { index, message, finish_reason: acc.finish_reason };
      }),
  };
  if (usage !== undefined) out.usage = usage;
  return out;
}

export interface ConfidentialFetchParams {
  baseUrl: string;
  /** The JSON request body the client would have POSTed. */
  body: unknown;
  /** The bearer the client already obtained for this node. */
  bearer: string;
  options: ConfidentialRequestOptions;
  /** The caller's method and path; anything but POST chat/completions is refused. */
  method?: string;
  path?: string;
  /**
   * Return the key's remaining balance as an `x-cashu` header after
   * settlement (xcashu mode: the bearer was a one-off Cashu token).
   */
  returnChange?: boolean;
  signal?: AbortSignal;
}

/** Run one confidential session and present it as a `Response`. */
export async function fetchConfidential(params: ConfidentialFetchParams): Promise<Response> {
  if (!isConfidentialEndpoint(params.method, params.path)) {
    throw new ConfidentialError(
      "unsupported_endpoint",
      `confidential mode supports only POST /v1/chat/completions, not ${params.method ?? ""} ${params.path ?? ""}`,
    );
  }
  try {
    return await fetchConfidentialOnce(params, false);
  } catch (error) {
    // The node settles at the rates of the offer we verified; once it no
    // longer holds that offer it refuses the setup. Refetch and retry once.
    if (error instanceof OfferExpired) return fetchConfidentialOnce(params, true);
    throw error;
  }
}

class OfferExpired extends Error {}

function isOfferExpired(error: SessionRejectedError): boolean {
  const detail = error.nodeDetail as { error?: { type?: string } } | undefined;
  return error.status === 409 && detail?.error?.type === "offer_expired";
}

async function fetchConfidentialOnce(
  params: ConfidentialFetchParams,
  freshOffer: boolean,
): Promise<Response> {
  const { baseUrl, options } = params;
  const request = (params.body ?? {}) as Record<string, unknown>;
  const model = typeof request.model === "string" ? request.model : "";
  const offer = await verifiedOffer(baseUrl, options, freshOffer);
  if (!(model in offer.price_list)) {
    throw new ConfidentialError("offer_malformed", `node ${baseUrl} does not serve ${model} confidentially`);
  }
  const maxTokens = requestedMaxTokens(request, Number(offer.max_tokens_cap ?? 4096));
  const body = buildPinnedBody(request, model, maxTokens);
  const wantStream = request.stream === true;

  const coldSession = () =>
    new ConfidentialSession({
      baseUrl,
      offer,
      auth: params.bearer,
      model,
      maxTokens,
      bodyLength: body.length,
      prover: new CuProverBackend({ binaryPath: options.proverPath }),
      twoPcPath: options.twoPcPath,
      runsDir: options.runsDir,
    });

  // Pre-warm: v2 only, a stable credential only (a one-off Cashu bearer is
  // spent per request), and a body that ends with the pinned suffix.
  const suffix = canonicalSuffix(model, maxTokens);
  const usePool =
    options.prewarm !== undefined &&
    options.prewarm.enabled !== false &&
    !params.returnChange &&
    offer.v === 2 &&
    endsWith(body, new TextEncoder().encode(suffix));
  const ticket: RequestTicket<ConfidentialSession> | undefined = usePool
    ? prewarmPool(options.prewarm!).begin(
        { baseUrl: baseUrl.replace(/\/$/, ""), model, maxTokens, bearer: params.bearer },
        options,
        body.length,
      )
    : undefined;
  const lease = ticket?.take();
  let session: ConfidentialSession = lease ? (undefined as never) : coldSession();
  let prewarmed = false;

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  type Head = { status: number; statusText: string; headers: Record<string, string> };
  let resolveHead!: (h: Head) => void;
  const headP = new Promise<Head>((r) => (resolveHead = r));
  const chunks: Uint8Array[] = [];
  const attach = (s: ConfidentialSession) =>
    s.setResponseHandlers(
      (h) => {
        ticket?.head();
        resolveHead(h);
      },
      (chunk) => {
        if (wantStream && chunk.length) void writer.write(chunk).catch(() => {});
        else if (chunk.length) chunks.push(chunk);
      },
    );
  if (!lease) attach(session);
  const onAbort = () => {
    session?.close();
    const reason = params.signal?.reason ?? new DOMException("aborted", "AbortError");
    void writer.abort(reason).catch(() => {});
  };
  if (params.signal?.aborted) onAbort();
  params.signal?.addEventListener("abort", onAbort, { once: true });

  const runCold = (): Promise<ConfidentialSessionResult> => {
    ticket?.cold();
    return session.run(body);
  };
  const runWarm = async (): Promise<ConfidentialSessionResult> => {
    let warm: ConfidentialSession;
    try {
      warm = await lease!.session;
    } catch (error) {
      // The arm we waited for failed: nothing was sent, go cold.
      ticket!.log(`claimed arm failed (${errorText(error)}); falling back to a cold session`);
      session = coldSession();
      attach(session);
      return runCold();
    }
    if (params.signal?.aborted) {
      warm.close();
      throw params.signal.reason ?? new DOMException("aborted", "AbortError");
    }
    session = warm;
    attach(session);
    prewarmed = true;
    ticket!.warm();
    try {
      return await warm.claim(padPinnedBody(body, warm.bodyLength, suffix));
    } catch (error) {
      // Before the credential record is released nothing reached the
      // provider: retry once on a fresh cold session. Never after.
      if (warm.bodyReleased || params.signal?.aborted) throw error;
      ticket!.log(
        `pre-warmed sid=${warm.sid.slice(0, 8)} failed before release (${errorText(error)}); falling back to a cold session`,
      );
      warm.close();
      prewarmed = false;
      session = coldSession();
      attach(session);
      return runCold();
    }
  };

  // The whole session, including settlement and its checks.
  const runP = (lease ? runWarm() : runCold()).finally(() => {
    session?.close();
    params.signal?.removeEventListener("abort", onAbort);
  });
  runP.then(
    (r) =>
      ticket?.end(
        typeof r.receipt.reserved_msats === "number" ? r.receipt.reserved_msats : undefined,
        // What an unused armed session for this key would cost.
        Math.max(
          typeof r.receipt.abandon_fee_msat === "number" ? r.receipt.abandon_fee_msat : 0,
          typeof r.receipt.session_fee_msat === "number" ? r.receipt.session_fee_msat : 0,
        ),
      ),
    () => ticket?.end(),
  );
  let head: Head;
  try {
    head = await Promise.race([
      // A stream starts at the response head; anything else waits for the
      // settled session, so a failed check fails the call.
      wantStream ? headP : runP.then(() => headP),
      runP.then((r: ConfidentialSessionResult) => ({
        status: r.http.status,
        statusText: r.http.statusText,
        headers: r.http.headers,
      })),
    ]);
  } catch (error) {
    session?.close();
    void writer.abort(error).catch(() => {});
    if (error instanceof SessionRejectedError && isOfferExpired(error)) {
      offerCache.delete(baseUrl.replace(/\/$/, ""));
      throw new OfferExpired(error.message);
    }
    // A node-side refusal (e.g. 402 insufficient balance) becomes the same
    // HTTP error a normal request would get, so the client's existing
    // top-up / failover handling applies.
    if (error instanceof SessionRejectedError && error.status) {
      return new Response(JSON.stringify({ detail: error.nodeDetail ?? error.message }), {
        status: error.status,
        headers: { "content-type": "application/json" },
      });
    }
    throw error;
  }

  let response: Response | undefined;
  let change: string | undefined;
  const settled = runP.then(async (result) => {
    if (params.returnChange) {
      change = await withdrawBalance(baseUrl, params.bearer);
      if (change) response?.headers.set("x-cashu", change);
    }
    return result;
  });
  // A stream ends only once settlement verified; a failed check errors it.
  settled.then(
    () => void writer.close().catch(() => {}),
    (error) => void writer.abort(error).catch(() => {}),
  );

  const headers = new Headers();
  for (const [k, v] of Object.entries(head.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("x-routstr-verify", "confidential");
  headers.set("x-routstr-confidential-sid", session.sid);
  if (usePool) headers.set("x-routstr-confidential-prewarmed", prewarmed ? "1" : "0");
  const ok = head.status < 400 && /event-stream/i.test(head.headers["content-type"] ?? "");
  if (wantStream) {
    response = new Response(stream.readable, { status: head.status, headers });
  } else {
    await settled; // throws on a failed proof, receipt or usage check
    const body = concat(chunks);
    if (ok) {
      headers.set("content-type", "application/json");
      const text = new TextDecoder().decode(body);
      response = new Response(JSON.stringify(aggregateChatCompletionSse(text)), {
        status: head.status,
        headers,
      });
    } else {
      response = new Response(new Blob([body as BlobPart]), { status: head.status, headers });
    }
    if (change) response.headers.set("x-cashu", change);
  }
  const settledHandled = settled.then(() => undefined);
  settledHandled.catch(() => {}); // observed by the stream and by finalize()
  (response as unknown as { confidentialSettled: Promise<unknown> }).confidentialSettled =
    settledHandled;
  return response!;
}

/** The existing node refund endpoint: return the bearer's remaining balance. */
async function withdrawBalance(baseUrl: string, bearer: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/wallet/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { token?: string };
    return j.token;
  } catch {
    return undefined;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
