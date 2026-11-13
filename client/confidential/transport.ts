/**
 * Confidential-upstream as a request transport (protocol v3).
 *
 * `RoutstrClient` calls this instead of `fetch()` for a request that opted
 * into confidential mode. Credential acquisition, top-ups, failover, usage
 * tracking and balance accounting stay the client's normal code: this only
 * turns (node, request body, bearer) into an ordinary `Response`.
 *
 * A request runs on a confidential connection (`connection.ts`) from the
 * process-wide pool (`pool.ts`): with framing `"2"` an HTTP/2 connection that
 * is kept and reused (one two-party handshake per connection), with framing
 * `"1.1"` a connection of its own. The framing is chosen per §2.3 from the
 * node's signed offer (`http`: `auto`, `"2"` or `"1.1"`); when a framing-`"2"`
 * connection fails to open, the request is served on `"1.1"` on the same node
 * and `"2"` is not tried there for 10 minutes.
 *
 * The node holds a connection deposit from the `setup` and reserves each
 * request's maximum cost on the bearer at the `request` (a full-context
 * prompt plus the pinned completion cap, at the signed offer's rates), then
 * settles the π_C3S-verified usage on it. The response body streams as
 * records decrypt (each record is authenticated by TLS). Settlement checks
 * (proofs, receipt signature and binding, usage, cost, deposit) finish after
 * the body: a non-streaming call fails if they fail, and a stream ends with
 * an error instead of a clean end. A stream's final `data: [DONE]` line is
 * held back until those checks passed, so a consumer that stops reading at
 * `[DONE]` still sees the error (the rest of the stream is not delayed).
 * `confidentialSettled` carries the same outcome, and the change of a
 * one-off bearer (`returnChange`).
 *
 * `POST /v1/chat/completions` is a chat request (usage disclosed and proven).
 * `POST /v1/images/generations` and `/v1/image/generate` are image requests
 * when the node's signed offer has the `images` capability: the price is
 * fixed by the pinned model, variant and count, so nothing is disclosed on
 * success (`accept`).
 */

import {
  ConfidentialError,
  ConnectionDepositError,
  MAY_HAVE_REACHED_PROVIDER,
  NodeProtocolOutdatedError,
  OfferUnavailableError,
  ProverMissingError,
  RequestRefusedError,
  ReservationAboveCeilingError,
  SessionRejectedError,
  StreamNotProcessedError,
  TwoPcVersionMismatchError,
  UpgradeRequiredError,
} from "./errors";
import {
  fetchConfidentialOffer,
  imageCountKey,
  offerConnectionDepositMsat,
  offerFramingsFor,
  offerSupportsImages,
  pinnedModelId,
  renderImageSuffix,
  verifyConfidentialOffer,
  type ConfidentialFraming,
  type ConfidentialImageVariant,
  type ConfidentialImagesOffer,
  type VerifiedOffer,
} from "./offer";
import { CuProverBackend, resolveProverPath } from "./prover";
import { requireHelperBinaries } from "./twopc";
import { checkImageResponse } from "./wire";
import {
  CHAT_PROTOCOL_KEYS,
  type ChatSuffixSpec,
  canonicalSuffix,
  exposedProviderHeader,
  samePinValue,
  type PadBucket,
} from "./suffix";
import { confidentialKind } from "./endpoints";
import { encryptedNodeTransport } from "./hosts";
import { chooseImageVariant, IMAGE_SELECTOR_KEYS } from "./imagePlan";
import {
  ConfidentialConnection,
  connectionTerms,
  DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT,
  type ConnectionBytes,
  type ConnectionRequestHandle,
  type ConnectionRequestOptions,
  type ConnectionRequestResult,
} from "./connection";
import { ConnectionPool, PoolBusyError, poolKey, type Http2Options, type PoolLease, type PrewarmOptions } from "./pool";

export interface ConfidentialRequestOptions {
  /**
   * Optional body-size bucket (off by default): pad each request body with
   * JSON whitespace before the pinned suffix to the next multiple of this
   * many bytes, or to the next power of two (`"pow2"`). It hides the exact
   * body size from observers of the client–node and node–provider
   * connections (and from the provider), at the cost of upload bytes; the
   * node still learns the prompt's token count at settlement.
   */
  padBucket?: PadBucket;
  /** Upstream TLS hostnames the client trusts (exact or wildcard). */
  trustedHosts: readonly string[];
  /** Node signing keys (hex or npub) whose offers are accepted. */
  nodePubkeys?: readonly string[];
  /**
   * Used only when `nodePubkeys` is not set: the keys that announced this node
   * URL (e.g. its Nostr provider announcement). Applied only to `https:` and
   * onion URLs, where the transport authenticates the server that serves the
   * offer; a plain-http URL with no configured pin is refused.
   */
  nodePubkeysFor?: (baseUrl: string) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /** Dev only: accept an offer signed by a key that is not pinned. */
  allowUnpinned?: boolean;
  /**
   * Dev only: run connections with a plain-http node that is neither loopback
   * nor an onion service. The node credential (setup `auth`) then travels
   * over an unencrypted websocket.
   */
  allowInsecureTransport?: boolean;
  /** `cu-prover` binary (else CU_PROVER_BIN / CU_PROVER / PATH). */
  proverPath?: string;
  /**
   * `cu-2pc` binary (else CU_2PC_BIN / CU_2PC, then
   * next to cu-prover, then PATH).
   */
  twoPcPath?: string;
  /** Unused since protocol v3 (no per-request evidence files are written); accepted for old configurations. */
  runsDir?: string;
  /**
   * Hand confidential requests and responses to the client's raw
   * request/response log sink. Off by default: that sink writes the prompt
   * and the decrypted response in plaintext.
   */
  logPlaintext?: boolean;
  /**
   * The framing towards the provider (§2.3): `auto` (default) takes the first
   * entry of the offer's `http` that serves the request and is not marked bad
   * for the node, and falls back from `"2"` to `"1.1"` when a connection
   * fails to open; `"2"` or `"1.1"` uses only that framing (a node that does
   * not offer it is not used).
   */
  http?: "auto" | ConfidentialFraming;
  /**
   * The largest connection deposit (msat) to accept from a node's offer
   * (`connection_deposit_msat`; default 100 000). The node reserves it at
   * the setup and releases it with the connection's first settled request; a
   * connection that ends without one loses it. A node asking for more is not
   * used.
   */
  maxConnectionDepositMsat?: number;
  /** The pool of framing-`"2"` connections (see `pool.ts`): reuse, limits, idle times. */
  http2?: Http2Options & {
    /** Earlier place of `maxConnectionDepositMsat`; still read. */
    maxConnectionDepositMsat?: number;
  };
  /**
   * Per request: requests with different scopes never share a connection to
   * the provider (§9.1), so a caller serving several users keeps them
   * unlinkable there. Absent: one scope for every request of the credential.
   */
  reuseScope?: string;
  /**
   * Called when a node's offer names an older protocol than this client
   * speaks (`node_protocol_outdated`, §11): the node is not used. For the
   * caller's log (routstrd: once per node per day).
   */
  onNodeProtocolOutdated?: (baseUrl: string, nodeVersion: number) => void;
  /**
   * Pre-warming (§9.2, `pool.ts`): armed connections bound to the credential
   * only, for both framings. Off unless set; `{}` enables it with the
   * defaults. Not used for one-off Cashu bearers (`returnChange`).
   */
  prewarm?: PrewarmOptions;
}

/** The process-wide connection pool (created on first use). */
let pool: ConnectionPool | undefined;

function connectionPool(options: ConfidentialRequestOptions): ConnectionPool {
  if (!pool) pool = new ConnectionPool(options.http2 ?? {}, options.prewarm);
  else pool.configure(options.http2 ?? {}, options.prewarm);
  return pool;
}

/** Close every pooled and armed connection (an armed one that never settled a request loses its deposit). */
export function closeConfidentialConnections(): void {
  pool?.close();
  pool = undefined;
}

/** The pooled connections, for status pages and tests. */
export function confidentialConnectionsSnapshot(): ReturnType<ConnectionPool["snapshot"]> {
  return pool?.snapshot() ?? [];
}

/** The largest connection deposit the caller accepts (msat). */
export function maxConnectionDepositMsat(options: ConfidentialRequestOptions): number {
  const v = options.maxConnectionDepositMsat ?? options.http2?.maxConnectionDepositMsat;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_CONNECTION_DEPOSIT_MSAT;
}

/** A bearer that is spent by one request: never pooled, never pre-warmed. */
function oneOffBearer(params: { returnChange?: boolean; bearer: string }): boolean {
  return params.returnChange === true || params.bearer.startsWith("cashu");
}

/**
 * The framing a request of `kind` uses with `offer` (§2.3): the configured
 * one, else the first the offer lists that serves the kind and is not marked
 * bad for the node. A one-off bearer prefers `"1.1"` (a connection per token,
 * §9.1). Throws when the node serves the request with no framing the caller
 * allows.
 */
export function chooseFraming(
  offer: VerifiedOffer,
  kind: "chat" | "images",
  choice: { http?: "auto" | ConfidentialFraming; oneOff?: boolean; bad?: boolean; baseUrl?: string } = {},
): ConfidentialFraming {
  const served = offerFramingsFor(offer, kind);
  const node = choice.baseUrl ?? "the node";
  if (served.length === 0) {
    throw new ConfidentialError(
      kind === "images" ? "offer_no_images" : "offer_malformed",
      `${node} serves no confidential ${kind} requests`,
    );
  }
  const want = choice.http ?? "auto";
  if (want !== "auto") {
    if (want !== "2" && want !== "1.1") throw new ConfidentialError("not_configured", `confidential.http is not "auto", "2" or "1.1"`);
    if (!served.includes(want)) {
      throw new ConfidentialError(
        "not_configured",
        `${node} does not serve ${kind} requests with framing "${want}" (it offers ${JSON.stringify(served)}); confidential.http allows nothing else`,
      );
    }
    return want;
  }
  if (choice.oneOff && served.includes("1.1")) return "1.1";
  return served.find((f) => !(f === "2" && choice.bad)) ?? served[0]!;
}

/**
 * Whether a failure of a framing-`"2"` connection, before the body of its
 * first request was released, is one the fallback of §2.3 covers (the
 * handshake, ALPN, the connection head, the provider closing): not a refusal
 * the node gave with a status (the credential, the balance, an expired
 * offer), which another framing would not change, and not a local fault.
 */
export function http2OpenFailure(error: unknown): boolean {
  if (error instanceof RequestRefusedError || error instanceof ConnectionDepositError) return false;
  // The node's reservation, not the framing: "1.1" would be refused the same way.
  if (error instanceof ReservationAboveCeilingError) return false;
  if (error instanceof UpgradeRequiredError || error instanceof TwoPcVersionMismatchError) return false;
  if (error instanceof ProverMissingError) return false;
  // The provider refused one stream or went away: the framing worked.
  if (error instanceof StreamNotProcessedError) return false;
  // Waiting for a free connection of the pool says nothing about the framing.
  if (error instanceof PoolBusyError) return false;
  if (error instanceof SessionRejectedError) {
    if (error.nodeCode?.startsWith("h2_") || error.nodeCode === "upstream_unreachable" || error.fault === "upstream") return true;
    return error.status === undefined || error.status >= 500 || error.status === 408;
  }
  if (error instanceof ConfidentialError) return error.code !== "not_configured" && error.code !== "pinned_parameter";
  // An abort (DOMException) is the caller's.
  return !(error instanceof DOMException);
}

/**
 * Whether a request that failed on a pooled connection, before anything of
 * it was released, may run again on a fresh one: yes unless the node refused
 * the request itself with a status (no funds, an expired offer, a bad
 * request), which a new connection would not change.
 */
function retryOnFreshConnection(error: unknown): boolean {
  if (error instanceof RequestRefusedError || error instanceof ReservationAboveCeilingError) return false;
  return !(error instanceof SessionRejectedError && error.status !== undefined && error.status !== 408);
}

/** Nodes whose offer could not be fetched (unreachable, an HTTP error, a timeout), until when. */
const offerUnreachable = new Map<string, { until: number; failures: number; error: Error }>();
const OFFER_COOLDOWN_BASE_MS = 30_000;
const OFFER_COOLDOWN_MAX_MS = 10 * 60_000;

/** Signed offers by node; every use re-verifies it under the caller's policy. */
const offerCache = new Map<string, { offer: VerifiedOffer; at: number }>();

/** The announced keys for `baseUrl`, when its scheme authenticates the server. */
async function discoveredPins(
  baseUrl: string,
  options: ConfidentialRequestOptions,
): Promise<readonly string[] | undefined> {
  if (!options.nodePubkeysFor) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const authenticated = url.protocol === "https:" || url.hostname.endsWith(".onion");
  if (!authenticated) return undefined;
  const keys = await options.nodePubkeysFor(baseUrl);
  return keys && keys.length > 0 ? keys : undefined;
}

async function verifiedOffer(
  baseUrl: string,
  options: ConfidentialRequestOptions,
  fresh = false,
): Promise<VerifiedOffer> {
  const key = baseUrl.replace(/\/$/, "");
  const policy = {
    pinnedPubkeys: options.nodePubkeys ?? (await discoveredPins(baseUrl, options)),
    allowUnpinned: options.allowUnpinned,
    trustedHosts: options.trustedHosts,
  };
  const hit = offerCache.get(key);
  let offer: VerifiedOffer;
  if (!fresh && hit && Date.now() - hit.at < 30_000) {
    // Signature, pin, version and trusted host are checked again for *this*
    // call: a cached offer accepted under a looser policy must not leak.
    offer = verifyConfidentialOffer(hit.offer, policy);
  } else {
    // A node whose offer could not be fetched lately is not asked again
    // until its cooldown ends: each request would otherwise wait for it
    // (a connect timeout) before failing over (§2.2).
    const cool = offerUnreachable.get(key);
    if (cool && Date.now() < cool.until) {
      throw new OfferUnavailableError(
        `${key} did not serve its offer lately; not asked again for ${Math.ceil((cool.until - Date.now()) / 1000)} s`,
        cool.error.message,
      );
    }
    try {
      offer = await fetchConfidentialOffer(key, policy);
      offerUnreachable.delete(key);
    } catch (error) {
      if (error instanceof OfferUnavailableError) {
        const failures = (cool?.failures ?? 0) + 1;
        const ms = Math.min(OFFER_COOLDOWN_BASE_MS * 2 ** (failures - 1), OFFER_COOLDOWN_MAX_MS);
        offerUnreachable.set(key, { until: Date.now() + ms, failures, error });
      }
      if (error instanceof NodeProtocolOutdatedError) {
        try {
          options.onNodeProtocolOutdated?.(key, error.nodeVersion);
        } catch {
          /* the caller's log */
        }
      }
      throw error;
    }
    offerCache.set(key, { offer, at: Date.now() });
  }
  // Pinned keys authenticate the offer, not the connection: the session
  // carries the node credential, which plain http would expose on the wire.
  if (!options.allowInsecureTransport && !encryptedNodeTransport(baseUrl)) {
    throw new ConfidentialError(
      "not_configured",
      `refusing a confidential session with ${key}: plain http would send the node credential unencrypted ` +
        "(use an https or onion URL; allowInsecureTransport is for development)",
    );
  }
  return offer;
}


/** The node's verified offer, which must price `model` for this kind of request. */
async function qualifiedOffer(
  baseUrl: string,
  model: string,
  options: ConfidentialRequestOptions,
  fresh = false,
  kind: "chat" | "images" = "chat",
): Promise<VerifiedOffer> {
  const offer = await verifiedOffer(baseUrl, options, fresh);
  if (kind === "images") {
    if (!offerSupportsImages(offer)) {
      throw new ConfidentialError("offer_no_images", `node ${baseUrl} serves no confidential image generation`);
    }
    if (!Object.hasOwn(offer.images!.price_list, model)) {
      throw new ConfidentialError("offer_malformed", `node ${baseUrl} does not generate ${model} images confidentially`);
    }
    return offer;
  }
  if (!Object.hasOwn(offer.price_list, model)) {
    throw new ConfidentialError("offer_malformed", `node ${baseUrl} does not serve ${model} confidentially`);
  }
  return offer;
}

/**
 * Check, with no credential, that this client and `baseUrl` would run a
 * confidential session for `model`: the helper binaries can be run, the
 * node's signed offer verifies under the caller's policy, the node is
 * reachable over an encrypted transport and its price list names the model.
 * With `request` (the body the session would send, `model` being the id the
 * node lists), also that the request can be pinned under that offer: no
 * parameter the offer pins to another value, and for an image request a
 * variant and count the offer serves. Throws the error the session itself
 * would raise; returns the verified offer. The client calls this before it
 * spends a token on a node, and sizes the deposit from the offer: a one-off
 * Cashu deposit minted for a session that then fails locally would stay in
 * the store, unspent, until a refund sweep.
 */
export async function qualifyConfidentialNode(
  baseUrl: string,
  model: string,
  options: ConfidentialRequestOptions,
  kind: "chat" | "images" = "chat",
  request?: unknown,
): Promise<VerifiedOffer> {
  // Local, so first: no node can run a session without them.
  requireHelperBinaries({ proverPath: resolveProverPath(options.proverPath), twoPcPath: options.twoPcPath });
  const offer = await qualifiedOffer(baseUrl, model, options, false, kind);
  // A framing the caller allows must serve the request, and the deposit must
  // be one the caller accepts: otherwise the node is not used at all.
  chooseFraming(offer, kind, { http: options.http, baseUrl });
  checkDeposit(baseUrl, offer, options);
  if (request !== null && typeof request === "object" && !Array.isArray(request)) {
    const body = { ...(request as Record<string, unknown>), model };
    if (kind === "images") planImageRequest(body, offer.images!);
    else buildPinnedBody(body, pinnedModelId(offer, model), maxTokensFor(body, Number(offer.max_tokens_cap ?? 4096)).maxTokens, offer.chat);
  }
  return offer;
}

/** Refuse a node whose connection deposit exceeds the caller's maximum (before anything is sent). */
function checkDeposit(baseUrl: string, offer: VerifiedOffer, options: ConfidentialRequestOptions): void {
  const deposit = offerConnectionDepositMsat(offer);
  const max = maxConnectionDepositMsat(options);
  if (deposit > max) {
    throw new ConnectionDepositError(
      `${baseUrl} asks for a connection deposit of ${deposit} msat, above the maximum of ${max} msat (maxConnectionDepositMsat)`,
      deposit,
    );
  }
}

/** The chat endpoint the confidential transport implements. */
export function isConfidentialEndpoint(method: string | undefined, path: string | undefined): boolean {
  return (method ?? "POST").toUpperCase() === "POST" && confidentialKind(path ?? "/v1/chat/completions") === "chat";
}

/** The image endpoints the confidential transport implements. */
export function isConfidentialImageEndpoint(method: string | undefined, path: string | undefined): boolean {
  return (method ?? "POST").toUpperCase() === "POST" && confidentialKind(path ?? "") === "images";
}

/**
 * An image request split into what the node may see (model, variant, count:
 * they set the price and are pinned in the suffix) and the private part
 * (prompt and every option that does not change the price). The choice is
 * `chooseImageVariant`'s, which refuses rather than substitutes.
 */
export function planImageRequest(
  request: Record<string, unknown>,
  images: ConfidentialImagesOffer,
): { model: string; variant: ConfidentialImageVariant; count: number; body: Uint8Array; suffix: string } {
  const { model, variant, count, countKey } = chooseImageVariant(request, images);
  const priv: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request)) {
    if (IMAGE_SELECTOR_KEYS.has(k) || k === countKey) continue;
    priv[k] = v;
  }
  const suffix = renderImageSuffix(model, count, countKey, images.fixed_pins, variant.pins);
  const prefix = JSON.stringify(priv).slice(0, -1);
  // The suffix is its own final record and begins with a comma: a body with
  // no private keys could not end with it (the prompt is required anyway).
  if (prefix === "{") throw new ConfidentialError("unsupported_endpoint", "an image request needs a prompt");
  return { model, variant, count, body: new TextEncoder().encode(prefix + suffix), suffix };
}

/**
 * The request body as the provider sees it: private part + pinned suffix.
 * The protocol's own keys (model, caps, n, stream) never come from the
 * caller. Another key the offer pins is dropped when the caller asked for the
 * pinned value, and refused when it asked for another: the suffix would
 * silently override it. `n` follows that rule too (one completion): the
 * model and the caps are the session's own terms and `stream` is converted
 * for the caller, but a second choice would simply be missing.
 */
export function buildPinnedBody(
  request: Record<string, unknown>,
  model: string,
  maxTokens: number,
  chat: ChatSuffixSpec,
): Uint8Array {
  const pinned = new Map(chat.fixed_pins);
  const priv: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request)) {
    if (k === "n" && v !== undefined && v !== null) {
      // One completion per session (the offer's pin, else the provider's
      // default): another count would be answered with one choice and no error.
      const one = pinned.has("n") ? pinned.get("n") : 1;
      if (!samePinValue(v, one)) {
        throw new ConfidentialError(
          "pinned_parameter",
          `a confidential session returns n = ${JSON.stringify(one)} completion; this request sets n to ${JSON.stringify(v)}`,
        );
      }
    }
    if (CHAT_PROTOCOL_KEYS.has(k)) continue;
    if (pinned.has(k)) {
      if (samePinValue(v, pinned.get(k))) continue;
      throw new ConfidentialError(
        "pinned_parameter",
        `the node's offer pins ${k} to ${JSON.stringify(pinned.get(k))}; this request sets it to ${JSON.stringify(v)}`,
      );
    }
    priv[k] = v;
  }
  const json = JSON.stringify(priv);
  // Drop the closing brace: the suffix closes the object and wins last.
  const suffix = canonicalSuffix(chat, model, maxTokens);
  const prefix = json.slice(0, -1);
  // The pinned suffix begins with a comma and must end the body exactly: a
  // request with no private keys (no messages) cannot be pinned.
  if (prefix === "{") throw new ConfidentialError("unsupported_endpoint", "a chat request needs messages");
  return new TextEncoder().encode(prefix + suffix);
}

/**
 * The token cap the session pins: the smallest the caller set (`max_tokens`,
 * `max_completion_tokens`, `max_output_tokens`), at most the node's cap.
 * `clampedFrom` is the caller's value when the node's cap lowered it, so the
 * response can say the answer may be cut short.
 */
export function maxTokensFor(
  request: Record<string, unknown>,
  cap: number,
): { maxTokens: number; clampedFrom?: number } {
  let asked: number | undefined;
  for (const k of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const v = request[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      asked = Math.min(asked ?? Infinity, Math.trunc(v));
    }
  }
  if (asked === undefined) return { maxTokens: cap };
  const maxTokens = Math.max(1, Math.min(asked, cap));
  return maxTokens < asked ? { maxTokens, clampedFrom: asked } : { maxTokens };
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
  /**
   * Requests with different scopes never share a connection (§9.1): a
   * caller serving several users keeps them unlinkable to the provider.
   */
  reuseScope?: string;
  /**
   * Chat: the most the node may reserve for the request (msat), or a function
   * of the verified offer the request is priced by and the request's pinned
   * terms that returns it (undefined: no ceiling). A node announcing more in
   * `request_ok` (`reserved_msats`) gets no record of the request: the call
   * fails with `ReservationAboveCeilingError` before anything reaches the
   * provider. The ceiling also bounds a receipt that charges the reservation
   * for a provider error when the node announced none. It must never be below
   * what an honest node reserves (`confidentialReservationCeilingMsats`).
   */
  maxReservationMsat?:
    | number
    | ((offer: VerifiedOffer, request: { model: string; maxTokens: number }) => number | undefined);
  signal?: AbortSignal;
}

/** Run one confidential request and present it as a `Response`. */
export async function fetchConfidential(params: ConfidentialFetchParams): Promise<Response> {
  const image = isConfidentialImageEndpoint(params.method, params.path);
  if (!image && !isConfidentialEndpoint(params.method, params.path)) {
    throw new ConfidentialError(
      "unsupported_endpoint",
      `confidential mode supports only POST /v1/chat/completions and /v1/images/generations, not ${params.method ?? ""} ${params.path ?? ""}`,
    );
  }
  const once = image ? fetchConfidentialImageOnce : fetchConfidentialOnce;
  try {
    return await once(params, false);
  } catch (error) {
    // The node settles at the rates of the offer we verified; once it no
    // longer holds that offer it refuses the setup. Refetch and retry once.
    if (error instanceof OfferExpired) return once(params, true);
    throw error;
  }
}

/** What one request needs of the connection it runs on, built from the offer it is priced by. */
interface RequestSpec {
  kind: "chat" | "images";
  model: string;
  maxTokens: number;
  image?: { variant: string; count: number };
  body: Uint8Array;
  /** The caller's reservation ceiling for this request (msat). */
  maxReservationMsat?: number;
  onResponseHead?: ConnectionRequestOptions["onResponseHead"];
  onResponseBody?: ConnectionRequestOptions["onResponseBody"];
}

/** The request a call is running, for its abort handling, headers and change. */
interface RunState {
  handle?: ConnectionRequestHandle;
  framing?: ConfidentialFraming;
  warm?: PoolLease<ConfidentialConnection>["warm"];
  /** Every connection this call opened or claimed (a credential went out on each that started). */
  conns: ConfidentialConnection[];
  /** The response head reached the caller: never run the request again. */
  headSeen: boolean;
  /**
   * What the node charged for attempts the provider refused and that were
   * settled (`disclose_reset`: the session fee if it was still due), run
   * again on a new connection: part of what this call cost.
   */
  refusedCostMsats?: number;
}

function credentialSent(state: RunState): boolean {
  return state.conns.some((c) => c.credentialSent) || (state.handle?.credentialSent ?? false);
}

const sumSent = (b: ConnectionBytes) => b.relaySent + b.controlSent + b.twoPcSent + b.zkSent;
const sumRecv = (b: ConnectionBytes) => b.relayRecv + b.controlRecv + b.twoPcRecv + b.zkRecv;

/**
 * How to open a connection for a pool key. Built outside `runOnPool`: the pool
 * keeps it for pre-warming, and a closure there would keep the request (its
 * body) reachable for the key's life.
 */
function connectionOpener(
  baseUrl: string,
  offer: VerifiedOffer,
  bearer: string,
  options: ConfidentialFetchParams["options"],
  maxDepositMsat: number,
): (framing: ConfidentialFraming) => ConfidentialConnection {
  const { proverPath, twoPcPath, allowInsecureTransport } = options;
  return (framing) =>
    new ConfidentialConnection({
      baseUrl,
      offer,
      framing,
      auth: bearer,
      prover: new CuProverBackend({ binaryPath: proverPath }),
      twoPcPath,
      allowInsecureTransport,
      maxDepositMsat,
    });
}

/**
 * One request on a pooled connection: an idle open one, else an armed one,
 * else a new one. A pooled connection may have died since its last request;
 * while nothing of this request was released towards the provider it runs
 * again on a fresh connection, and never after. A framing-"2" connection that
 * fails to open is marked bad and the request is served on "1.1" (§2.3).
 */
async function runOnPool(
  params: ConfidentialFetchParams,
  offer: VerifiedOffer,
  spec: RequestSpec,
  state: RunState,
  tRequest: number,
): Promise<ConnectionRequestResult> {
  const { baseUrl, options } = params;
  const pool = connectionPool(options);
  const log = (m: string) => (options.http2?.log ?? console.info)(`[confidential] ${m}`);
  const oneOff = oneOffBearer(params);
  const maxDepositMsat = maxConnectionDepositMsat(options);
  checkDeposit(baseUrl, offer, options);
  // Connections of other connection-level terms (an offer that changed) are never taken.
  const key = poolKey({
    baseUrl,
    bearer: params.bearer,
    scope: `${params.reuseScope ?? options.reuseScope ?? ""}\0${connectionTerms(offer)}${oneOff ? `\0${crypto.randomUUID()}` : ""}`,
  });
  const open = connectionOpener(baseUrl, offer, params.bearer, options, maxDepositMsat);
  let forced: ConfidentialFraming | undefined;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(params.signal);
    const framing =
      forced ?? chooseFraming(offer, spec.kind, { http: options.http, oneOff, bad: pool.isBad(baseUrl), baseUrl });
    const fallbackTo11 = (error: unknown): boolean =>
      framing === "2" &&
      (options.http ?? "auto") === "auto" &&
      offerFramingsFor(offer, spec.kind).includes("1.1") &&
      http2OpenFailure(error);
    const traffic = pool.noteRequest(
      key,
      { baseUrl, framing, depositMsat: offerConnectionDepositMsat(offer), prewarmable: !oneOff },
      open,
    );
    const tAcquire = Date.now();
    let lease: PoolLease<ConfidentialConnection>;
    try {
      lease = await pool.acquire(
        key,
        framing,
        (f) => {
          const c = open(f);
          state.conns.push(c);
          return c;
        },
        params.signal,
        // This request's reuse policy, whatever another call sets on the shared pool meanwhile.
        options.http2?.reuse ?? "shared",
      );
    } catch (error) {
      traffic.done();
      if (params.signal?.aborted) throw error;
      if (fallbackTo11(error) && attempt < 3) {
        // §2.3: the connection failed before any request: "1.1" on the same node.
        pool.markBad(baseUrl, errorText(error));
        forced = "1.1";
        continue;
      }
      throw error;
    }
    const conn = lease.conn;
    if (!state.conns.includes(conn)) state.conns.push(conn);
    if (params.signal?.aborted) {
      // The connection stays for the next request; this one never started.
      lease.release();
      traffic.done();
      throw abortReason(params.signal);
    }
    let handle: ConnectionRequestHandle;
    try {
      handle = conn.request({
        // Priced by the offer verified for this call (the node may have
        // re-signed it since the connection opened).
        offer,
        auth: params.bearer,
        model: spec.model,
        maxTokens: spec.maxTokens,
        image: spec.image,
        body: spec.body,
        padBucket: options.padBucket,
        maxReservationMsat: spec.maxReservationMsat,
        onResponseHead: (h) => {
          state.headSeen = true;
          spec.onResponseHead?.(h);
        },
        onResponseBody: spec.onResponseBody,
      });
    } catch (error) {
      // The connection ended between the pool's check and now: nothing was sent.
      lease.release();
      traffic.done();
      if (attempt < 2 && !(error instanceof ConfidentialError && error.code === "session_protocol")) continue;
      throw error;
    }
    state.handle = handle;
    state.framing = framing;
    state.warm = lease.warm;
    try {
      const r = await handle.done;
      // A one-off bearer's connection is never kept (§9.1).
      if (oneOff) conn.close("one-off bearer");
      lease.release(true);
      traffic.done();
      const armBytes = lease.warm === "open" ? undefined : conn.armBytes;
      options.http2?.onRequest?.({
        baseUrl,
        sid: r.sid,
        http: r.http,
        n: r.n,
        kind: spec.kind === "images" ? "images" : undefined,
        warm: lease.warm,
        reused: lease.reused,
        status: r.status,
        ttftMs: r.timings.ttftMs !== undefined ? r.timings.startedAt + r.timings.ttftMs - tRequest : undefined,
        totalMs: Date.now() - tRequest,
        connectMs: lease.warm === "open" ? undefined : conn.setupTimings.connectMs,
        bytesSent: sumSent(r.bytes),
        bytesRecv: sumRecv(r.bytes),
        armBytesSent: armBytes ? sumSent(armBytes) : undefined,
        armBytesRecv: armBytes ? sumRecv(armBytes) : undefined,
        depositReleasedMsat:
          typeof r.receipt.deposit_released_msat === "number" ? r.receipt.deposit_released_msat : undefined,
      });
      return r;
    } catch (error) {
      const refused = error instanceof RequestRefusedError;
      // A refused request leaves its connection usable: it goes back to the
      // pool. Except `offer_changed`: the node takes no further request on a
      // connection whose terms it no longer serves (§3.3), so the retry with
      // the refetched offer opens a new one.
      if (oneOff) conn.close("one-off bearer");
      else if (refused && offerChangedRefusal(error)) conn.close("offer_changed");
      lease.release();
      traffic.done();
      if (refused || state.headSeen || params.signal?.aborted || attempt >= 3) throw error;
      // A request the provider did not process (RFC 9113 §8.7: REFUSED_STREAM,
      // or a stream above a GOAWAY's last one) may run again, even after its
      // release. The node cannot see why nothing came: a released request's
      // reservation may still be charged (PROTOCOL-V3.md §12.10).
      if (error instanceof StreamNotProcessedError) {
        // A refusal the node settled on its proof costs what its receipt says
        // (the session fee if it was still due), whatever the next attempt costs.
        if (error.costMsats !== undefined) state.refusedCostMsats = (state.refusedCostMsats ?? 0) + error.costMsats;
        log(
          `sid=${handle.sid.slice(0, 8)} request ${handle.n} was not processed by the provider (${errorText(error)}); ` +
            `running it on a new connection${handle.bodyReleased ? " (the node may charge the released request's reservation)" : ""}`,
        );
        state.handle = undefined;
        continue;
      }
      if (handle.bodyReleased) throw error;
      const first = handle.n === 1 && lease.warm !== "open";
      if (first && fallbackTo11(error)) {
        // §2.3: the connection failed before the body of its first request was released.
        pool.markBad(baseUrl, errorText(error));
        log(`sid=${handle.sid.slice(0, 8)} framing "2" failed before release (${errorText(error)}); serving the request on "1.1"`);
        forced = "1.1";
        state.handle = undefined;
        continue;
      }
      // A connection that was open or armed before the request may have died
      // meanwhile: once more on a fresh one.
      if (lease.warm === "cold" || !retryOnFreshConnection(error)) throw error;
      log(
        `sid=${handle.sid.slice(0, 8)} request ${handle.n} failed before release after ${Date.now() - tAcquire} ms ` +
          `(${errorText(error)}); running it on a new connection`,
      );
      state.handle = undefined;
    }
  }
}

/** An error of the run as the caller's flow needs it: an expired or changed offer is refetched once. */
function offerRetry(baseUrl: string, error: unknown, released: boolean): void {
  if (released) return;
  if (error instanceof SessionRejectedError && isOfferExpired(error)) {
    offerCache.delete(baseUrl.replace(/\/$/, ""));
    throw new OfferExpired(error.message);
  }
}

/** The response headers every confidential response carries. */
function confidentialHeaders(headers: Headers, r: { sid: string; n: number }, state: RunState, options: ConfidentialRequestOptions): void {
  headers.set("x-routstr-verify", "confidential");
  headers.set("x-routstr-confidential-sid", r.sid);
  // The framing, the request's number on its connection, and what the request
  // found: an open connection (`reused`), an armed one, or none (`new`).
  headers.set("x-routstr-confidential-http", state.framing ?? "");
  const found = state.warm === "open" ? "reused" : state.warm === "armed" ? "armed" : "new";
  headers.set("x-routstr-confidential-connection", `${found}; request=${r.n}`);
  if (options.prewarm !== undefined && options.prewarm.enabled !== false) {
    headers.set("x-routstr-confidential-prewarmed", state.warm === "cold" ? "0" : "1");
  }
}

/**
 * An accepted image response's text, from the pieces it arrived in. Each
 * piece is let go as it is decoded, so the body is held once.
 */
function takeBodyText(chunks: Uint8Array[]): string {
  const dec = new TextDecoder();
  let text = "";
  while (chunks.length) text += dec.decode(chunks.shift()!, { stream: true });
  return text + dec.decode();
}

/** One confidential image request, presented as an OpenAI images response. */
async function fetchConfidentialImageOnce(
  params: ConfidentialFetchParams,
  freshOffer: boolean,
): Promise<Response> {
  const { baseUrl, options } = params;
  throwIfAborted(params.signal);
  const request = (params.body ?? {}) as Record<string, unknown>;
  const model = typeof request.model === "string" ? request.model : "";
  const offer = await qualifiedOffer(baseUrl, model, options, freshOffer, "images");
  const plan = planImageRequest(request, offer.images!);
  throwIfAborted(params.signal);
  const state: RunState = { conns: [], headSeen: false, refusedCostMsats: 0 };
  const abort = callerAbort(params.signal, () => state.handle);
  const tRequest = Date.now();
  const runP = runOnPool(
    params,
    offer,
    { kind: "images", model: plan.model, maxTokens: 0, image: { variant: plan.variant.id, count: plan.count }, body: plan.body },
    state,
    tRequest,
  )
    .catch((error: unknown) => {
      throw withReleased(error, releasedNow(state));
    })
    .finally(() => abort.done());
  let r: ConnectionRequestResult;
  try {
    r = await Promise.race([runP, abort.aborted]);
  } catch (error) {
    const released = releasedNow(state);
    offerRetry(baseUrl, error, released);
    // The caller left after the release: the request settles on its own.
    if (abort.detached) throw withReleased(error, released);
    const change = await failureChange(params, state, runP);
    // After release the provider has the request: a node error is not a
    // refusal, and failing over would run (and pay for) it again.
    if (isNodeRefusal(error) && !released) {
      return refusalResponse(error, change);
    }
    throw withReleased(withChange(error, change), released);
  }
  const headers = new Headers();
  confidentialHeaders(headers, r, state, options);
  headers.set("x-routstr-confidential-variant", plan.variant.id);
  const costMsats = receiptCostMsats(r, state);
  if (costMsats !== undefined) headers.set("x-routstr-cost-msats", String(costMsats));
  let response: Response;
  if (r.status >= 200 && r.status < 300) {
    // Accepted and paid at the flat price: what fell short is reported, not
    // thrown. The megabytes are held once at each step: the pieces become the
    // text, the text the parsed images, those the response.
    const bodyText = takeBodyText(r.bodyChunks ?? [r.body]);
    const checked = checkImageResponse(
      {
        status: r.status,
        statusText: "",
        headers: r.headers,
        raw: new Uint8Array(0),
        body: new Uint8Array(0),
        bodyText,
        contentType: r.headers["content-type"] ?? "",
        // The response ended (END_STREAM, or the end of the chunked body) before it was accepted.
        complete: true,
      },
      offer.images!.response_shape,
      { model: plan.model, count: plan.count, countKey: imageCountKey(offer.images!) },
    );
    headers.set("content-type", "application/json");
    if (checked.warnings.length) setWarnings(headers, checked.warnings);
    response = new Response(JSON.stringify(checked.image), { status: r.status, headers });
  } else {
    // An upstream error: its body as the provider sent it.
    for (const [k, v] of Object.entries(r.headers)) {
      if (exposedProviderHeader(k)) setProviderHeader(headers, k, v, false);
    }
    response = new Response(new Blob([r.body as BlobPart]), { status: r.status, headers });
  }
  const change = params.returnChange ? await withdrawBalance(baseUrl, params.bearer) : undefined;
  if (change) response.headers.set("x-cashu", change);
  (response as unknown as { confidentialSettled: Promise<ConfidentialSettlement> }).confidentialSettled =
    Promise.resolve({ change, costMsats: receiptCostMsats(r, state) });
  return response;
}

class OfferExpired extends Error {}

/** A request the node refused because the connection's terms are no longer served (`offer_changed`). */
function offerChangedRefusal(error: RequestRefusedError): boolean {
  const detail = error.nodeDetail as { error?: { type?: string } } | undefined;
  return error.reason === "offer_changed" || detail?.error?.type === "offer_changed";
}

/** The node no longer holds the offer the setup or the request named, or its connection-level terms changed. */
function isOfferExpired(error: SessionRejectedError): boolean {
  const detail = error.nodeDetail as { error?: { type?: string } } | undefined;
  const reason = error instanceof RequestRefusedError ? error.reason : "";
  const named = (t: string | undefined) => t === "offer_expired" || t === "offer_changed";
  return error.status === 409 && (named(detail?.error?.type) || named(reason));
}

async function fetchConfidentialOnce(
  params: ConfidentialFetchParams,
  freshOffer: boolean,
): Promise<Response> {
  const { baseUrl, options } = params;
  throwIfAborted(params.signal);
  const request = (params.body ?? {}) as Record<string, unknown>;
  const model = typeof request.model === "string" ? request.model : "";
  const offer = await qualifiedOffer(baseUrl, model, options, freshOffer);
  throwIfAborted(params.signal);
  const { maxTokens, clampedFrom } = maxTokensFor(request, Number(offer.max_tokens_cap ?? 4096));
  // The suffix pins the provider's id (`upstream_models`); the request names the public one.
  const body = buildPinnedBody(request, pinnedModelId(offer, model), maxTokens, offer.chat);
  const wantStream = request.stream === true;
  const maxReservationMsat = reservationCeiling(params.maxReservationMsat, offer, { model, maxTokens });
  // The request's start: it may first wait for a connection, and that wait
  // belongs in its timings.
  const tRequest = Date.now();
  const state: RunState = { conns: [], headSeen: false, refusedCostMsats: 0 };

  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  type Head = { status: number; statusText: string; headers: Record<string, string> };
  let resolveHead!: (h: Head) => void;
  const headP = new Promise<Head>((r) => (resolveHead = r));
  const chunks: Uint8Array[] = [];
  const doneHold = new SseDoneHoldback();
  const abort = callerAbort(params.signal, () => state.handle, (reason) => void writer.abort(reason).catch(() => {}));

  // The whole request, including settlement and its checks.
  const runP = runOnPool(
    params,
    offer,
    {
      kind: "chat",
      model,
      maxTokens,
      body,
      maxReservationMsat,
      onResponseHead: (h) => resolveHead(h),
      onResponseBody: (chunk) => {
        if (!chunk.length) return;
        if (wantStream) {
          const now = doneHold.push(chunk);
          if (now.length) void writer.write(now).catch(() => {});
        } else chunks.push(chunk);
      },
    },
    state,
    tRequest,
  )
    // Every failure after the release says so (the stream's error too).
    .catch((error: unknown) => {
      throw withReleased(error, releasedNow(state));
    })
    .finally(() => abort.done());
  let head: Head;
  try {
    head = await Promise.race([
      // A stream starts at the response head; anything else waits for the
      // settled request, so a failed check fails the call.
      wantStream ? headP : runP.then(() => headP),
      runP.then((r) => ({ status: r.status, statusText: "", headers: r.headers })),
      abort.aborted,
    ]);
  } catch (error) {
    const released = releasedNow(state);
    withReleased(error, released);
    if (!abort.detached && !(error instanceof RequestRefusedError)) state.handle?.close();
    void writer.abort(error).catch(() => {});
    // Retried only while nothing can have reached the provider: the node
    // refuses an expired offer at the setup or the request, never after the
    // body went out.
    offerRetry(baseUrl, error, released);
    // The caller left after the release: the request settles on its own.
    if (abort.detached) throw withReleased(error, released);
    const change = await failureChange(params, state, runP);
    // A node-side refusal (e.g. 402 insufficient balance) becomes the same
    // HTTP error a normal request would get, so the client's existing
    // top-up / failover handling applies. After release the provider has the
    // request: a node error is not a refusal, and failing over would run (and
    // pay for) it again.
    if (isNodeRefusal(error) && !released) {
      return refusalResponse(error, change);
    }
    throw withReleased(withChange(error, change), released);
  }

  let response: Response | undefined;
  let change: string | undefined;
  // A caller that left before it had a response cannot take change: the
  // bearer's deposit then stays on the node for the wallet to refund.
  const callerGone = () => abort.detached && !response;
  const settled = runP.then(
    async (r): Promise<ConfidentialSettlement> => {
      if (params.returnChange && !callerGone()) {
        change = await withdrawBalance(baseUrl, params.bearer);
        if (change) response?.headers.set("x-cashu", change);
      }
      return { change, costMsats: receiptCostMsats(r, state) };
    },
    async (error: unknown) => {
      const released = releasedNow(state);
      throw withReleased(callerGone() ? error : withChange(error, await failureChange(params, state, runP)), released);
    },
  );
  // A stream ends only once the request's settlement verified (and only then
  // gets its `[DONE]`); a failed check errors it. It does not wait for a
  // one-off bearer's change: that is a refund request to the node, which
  // could hold a finished stream open for as long as it likes. The change
  // comes with `confidentialSettled`.
  runP.then(
    () => {
      const rest = doneHold.release();
      if (rest.length) void writer.write(rest).catch(() => {});
      void writer.close().catch(() => {});
    },
    (error) => void writer.abort(error).catch(() => {}),
  );

  const headers = new Headers();
  for (const [k, v] of Object.entries(head.headers)) {
    if (exposedProviderHeader(k)) setProviderHeader(headers, k, v, true);
  }
  confidentialHeaders(headers, { sid: state.handle!.sid, n: state.handle!.n }, state, options);
  // The node's cap lowered the caller's token limit: say so, since the answer
  // may end early (finish_reason "length") for that reason alone.
  if (clampedFrom !== undefined) {
    headers.set("x-routstr-confidential-max-tokens", `${maxTokens}; requested=${clampedFrom}`);
  }
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
    // What the node charged, as on any priced response (a stream's caller
    // reads it from `confidentialSettled`: its headers left before the receipt).
    const cost = receiptCostMsats(await runP, state);
    if (cost !== undefined) response.headers.set("x-routstr-cost-msats", String(cost));
    const warnings = (await runP).warnings;
    if (warnings?.length) setWarnings(response.headers, warnings);
  }
  settled.catch(() => {}); // observed by the stream and by finalize()
  (response as unknown as { confidentialSettled: Promise<ConfidentialSettlement> }).confidentialSettled = settled;
  return response!;
}

/**
 * What a response's `confidentialSettled` resolves to. `change` is the
 * bearer's remaining balance withdrawn as a Cashu token (`returnChange`); a
 * stream's wrapper copies the response headers before it is set, so this is
 * where a caller reads it. A rejection carries it as `cashuChange`.
 */
export interface ConfidentialSettlement {
  change?: string;
  /**
   * What the node charged for the request (msats), from the verified
   * receipt. A chat stream's response headers left before the receipt
   * existed, so accounting reads the cost here.
   */
  costMsats?: number;
}

/** The verified receipt's charge, when it names one, plus what refused attempts of the call were charged. */
function receiptCostMsats(r: ConnectionRequestResult, state?: RunState): number | undefined {
  const cost = r.receipt?.cost_msats;
  if (!(typeof cost === "number" && Number.isFinite(cost) && cost >= 0)) return undefined;
  return cost + (state?.refusedCostMsats ?? 0);
}

/**
 * A caller's abort. Before the release nothing reached the provider: the
 * session closes at once (the node releases the reservation). After it the
 * provider has the request, and closing would charge the whole reservation:
 * the caller is detached instead (`aborted` rejects, nothing more is
 * delivered) and the session drains, bounded by its pinned cap, and settles
 * at the usage it had. Once the session ended (`done()`) an abort changes
 * nothing.
 */
function callerAbort(
  signal: AbortSignal | undefined,
  current: () => ConnectionRequestHandle | undefined,
  onReason?: (reason: unknown) => void,
): { aborted: Promise<never>; readonly detached: boolean; done(): void } {
  let detached = false;
  let ended = false;
  let reject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, r) => (reject = r));
  aborted.catch(() => {});
  const onAbort = () => {
    const reason = abortReason(signal);
    onReason?.(reason);
    if (ended) return;
    const session = current();
    if (session?.bodyReleased) detached = true;
    else session?.close();
    reject(reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    aborted,
    get detached() {
      return detached;
    },
    done() {
      ended = true;
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Text for a response header value: printable ASCII as it is, anything else
 * (the provider's own strings may hold any character) as a `\uXXXX` escape.
 * `Headers.set` throws on a character above U+00FF and on control characters,
 * and by then the answer is paid for.
 */
export function headerSafeText(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The session's warnings as one response header. */
function setWarnings(headers: Headers, warnings: readonly string[]): void {
  headers.set("x-routstr-confidential-warnings", headerSafeText(warnings.join("; ")));
}

/**
 * Pass one of the provider's response headers on. A name or value the
 * runtime refuses in a header is left out: the response is already paid for
 * and must not be lost to it.
 */
function setProviderHeader(headers: Headers, name: string, value: string, replace: boolean): void {
  try {
    if (replace || !headers.has(name)) headers.set(name, value);
  } catch {
    /* not a valid header for this runtime: dropped */
  }
}

/**
 * A refusal the node gave with an HTTP status (the credential, the balance, a
 * bad request): presented as that HTTP error. Not the upgrade error (§11):
 * that is about this client, and is thrown as itself.
 */
function isNodeRefusal(error: unknown): error is SessionRejectedError & { status: number } {
  return error instanceof SessionRejectedError && !(error instanceof UpgradeRequiredError) && Boolean(error.status);
}

/** A node refusal as the HTTP error a normal request would get. */
function refusalResponse(error: SessionRejectedError, change: string | undefined): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (change) headers.set("x-cashu", change);
  return new Response(JSON.stringify({ detail: error.nodeDetail ?? error.message }), {
    status: error.status,
    headers,
  });
}

/**
 * After a failed session, a one-off bearer's deposit is still on the node:
 * withdraw it (`returnChange`) once the session ended and the node released
 * or charged its reservation. Nothing to withdraw if the credential never
 * went out.
 */
async function failureChange(
  params: ConfidentialFetchParams,
  state: RunState,
  runP: Promise<unknown>,
): Promise<string | undefined> {
  if (!params.returnChange || !credentialSent(state)) return undefined;
  await Promise.race([runP.catch(() => {}), delay(10_000)]);
  // The node releases what the connection held when the connection ends.
  for (const c of state.conns) c.close("the request failed");
  return withdrawBalance(params.baseUrl, params.bearer, 5);
}

/**
 * A thrown error carrying the withdrawn change (`cashuChange`) to the caller.
 * The token is spendable by whoever reads it, so the property is not
 * enumerable: logging or serializing the error (`console.error` prints an
 * error's own enumerable properties) does not show it.
 */
function withChange(error: unknown, change: string | undefined): unknown {
  if (!change) return error;
  const e = error !== null && typeof error === "object" ? error : new ConfidentialError("session_rejected", String(error));
  Object.defineProperty(e, "cashuChange", { value: change, enumerable: false, writable: true, configurable: true });
  return e;
}

/**
 * Mark an error that leaves the transport after the request's body was
 * released (`MAY_HAVE_REACHED_PROVIDER`, not enumerable): the provider may
 * have run the request, so the caller must not send it again, to this node or
 * another, whatever the error's text says (a node's close reason is its own
 * text). Returns the error (a non-object becomes a `ConfidentialError`).
 */
function withReleased(error: unknown, released: boolean): unknown {
  if (!released) return error;
  const e = error !== null && typeof error === "object" ? error : new ConfidentialError("session_rejected", String(error));
  try {
    Object.defineProperty(e, MAY_HAVE_REACHED_PROVIDER, { value: true, enumerable: false, writable: true, configurable: true });
  } catch {
    /* a frozen error: the caller then sees it unmarked */
  }
  return e;
}

/** Whether anything of the call's request may have reached the provider. */
function releasedNow(state: RunState): boolean {
  return (state.handle?.bodyReleased ?? false) || state.headSeen;
}

/** The caller's reservation ceiling for a chat request priced by `offer` (undefined: none). */
function reservationCeiling(
  ceiling: ConfidentialFetchParams["maxReservationMsat"],
  offer: VerifiedOffer,
  request: { model: string; maxTokens: number },
): number | undefined {
  const v = typeof ceiling === "function" ? ceiling(offer, request) : ceiling;
  if (v === undefined) return undefined;
  if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    throw new ConfidentialError("not_configured", `maxReservationMsat ${String(v)} is not an amount of msat`);
  }
  return Math.floor(v);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Holds back an SSE stream from its `data: [DONE]` line on. Bytes before it
 * pass through at once; only a tail that could still become that line (at
 * most a few bytes) waits for the next chunk.
 */
export class SseDoneHoldback {
  private static readonly MARKERS = ["data: [DONE]", "data:[DONE]"].map((m) => new TextEncoder().encode(m));
  /** Bytes not yet emitted (a possible marker prefix, or everything from the marker on). */
  private pending: Uint8Array = new Uint8Array(0);
  private holding = false;
  /** The byte before `pending` (a marker counts only at a line start). */
  private prev = 10;

  /** Add decrypted bytes; returns what may be delivered now. */
  push(chunk: Uint8Array): Uint8Array {
    const buf = concat([this.pending, chunk]);
    if (this.holding) {
      this.pending = buf;
      return new Uint8Array(0);
    }
    const at = this.findMarker(buf);
    if (at >= 0) {
      this.holding = true;
      this.pending = buf.subarray(at);
      return this.emit(buf.subarray(0, at));
    }
    const keep = this.partialMarkerTail(buf);
    this.pending = buf.slice(buf.length - keep);
    return this.emit(buf.subarray(0, buf.length - keep));
  }

  /** Everything still held, once the stream may end. */
  release(): Uint8Array {
    const out = this.pending;
    this.pending = new Uint8Array(0);
    this.holding = false;
    return out;
  }

  private emit(out: Uint8Array): Uint8Array {
    if (out.length) this.prev = out[out.length - 1]!;
    return out;
  }

  private atLineStart(buf: Uint8Array, i: number): boolean {
    const b = i === 0 ? this.prev : buf[i - 1]!;
    return b === 10 || b === 13;
  }

  private findMarker(buf: Uint8Array): number {
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x64 /* d */ || !this.atLineStart(buf, i)) continue;
      for (const m of SseDoneHoldback.MARKERS) {
        if (i + m.length <= buf.length && m.every((b, j) => buf[i + j] === b)) return i;
      }
    }
    return -1;
  }

  /** Length of the longest tail of `buf` that starts a marker at a line start. */
  private partialMarkerTail(buf: Uint8Array): number {
    const longest = Math.max(...SseDoneHoldback.MARKERS.map((m) => m.length)) - 1;
    for (let n = Math.min(longest, buf.length); n > 0; n--) {
      const i = buf.length - n;
      if (!this.atLineStart(buf, i)) continue;
      if (SseDoneHoldback.MARKERS.some((m) => m.subarray(0, n).every((b, j) => buf[i + j] === b))) return n;
    }
    return 0;
  }
}

/**
 * The existing node refund endpoint: return the bearer's remaining balance.
 * The node refuses while a reservation is still held, which a session that
 * just failed may briefly be: `attempts` retries with a growing pause.
 */
async function withdrawBalance(baseUrl: string, bearer: string, attempts = 2): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await delay(500 * i);
    // A node that does not answer must not hold the (paid) response: the
    // balance then stays on the bearer for the wallet's refund sweep.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WITHDRAW_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/wallet/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}` },
        signal: abort.signal,
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { token?: string };
      return j.token;
    } catch {
      /* retry */
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

/** How long one refund request may take before it is given up on. */
const WITHDRAW_TIMEOUT_MS = 30_000;

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
