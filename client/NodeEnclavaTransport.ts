import { readFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, connect, type TLSSocket } from "node:tls";
import type { NostrEvent } from "applesauce-core/helpers";
import {
  attestEnclavaProvider, createModuleEnclavaAppraiser, spkiSha256FromPeerCertificate,
  MAX_ENCLAVA_PROOF_BUNDLE_BYTES,
  type EnclavaAppraiser, type EnclavaPolicy, type EnclavaWasmVerifier,
} from "./EnclavaAttest";
import { verifyEnclavaListing, verifyEnclavaRelease } from "./EnclavaRelease";

/** Construct an appraiser from the published web verifier and pinned local WASM bytes. */
export function createNodeEnclavaAppraiser(verifier: EnclavaWasmVerifier, wasmFile: string | URL): EnclavaAppraiser {
  const init = verifier.default;
  if (!init) throw new Error("Expected the Enclava web WASM initializer");
  return createModuleEnclavaAppraiser({
    verify_bundle: verifier.verify_bundle.bind(verifier),
    default: async () => init({ module_or_path: await readFile(wasmFile) }),
  });
}

const REQUIRED_CHECKS = [
  "binding.challenge_nonce", "binding.target_origin", "binding.tls_leaf_certificate", "binding.report_data",
  "amd.certificate_chain", "amd.report_signature", "amd.vcek_binding", "amd.revocation.freshness",
  "amd.measurement", "amd.tcb", "amd.guest_policy", "artifacts.signatures", "artifacts.relationships",
  "artifacts.descriptor_measurement", "supply_chain.image_policy", "supply_chain.portable_integrity",
  "supply_chain.signatures", "platform.runtime_class", "platform.sidecars", "platform.release", "deployment.identity",
];
const RESPONSE_LIMIT = 16 * 1024 * 1024;

export interface EnclavaRequiredOptions {
  /** Independently selected Nostr coordinate and exact canonical HTTPS origin. */
  coordinate: string;
  origin: string;
  releasePubkey: string;
  imageRepository: string;
  /** Caller-pinned bytes, never obtained from the provider or release event. */
  policy: EnclavaPolicy;
  /** Trusted verifier. Use createNodeEnclavaAppraiser for the published web module. */
  appraiser: EnclavaAppraiser;
  /** Source of signed events only, e.g. the SDK's ModelManager. */
  events: {
    getEnclavaAnnouncement(coordinate: string): Promise<NostrEvent | undefined>;
    getEnclavaRelease(id: string): Promise<NostrEvent | undefined>;
  };
  /** Optional explicit HTTPS trust root for a private node. Hostname checks still apply. */
  ca?: string;
  timeoutMs?: number;
}

export interface EnclavaRequiredRequest {
  /** Same-origin absolute path only. No redirects are followed. */
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

function inTime<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function openSocket(url: URL, ca: string | undefined, signal: AbortSignal): Promise<TLSSocket> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(url.port || 443),
      servername: isIP(hostname) ? undefined : hostname, ca, rejectUnauthorized: true,
      checkServerIdentity: (_, cert) => checkServerIdentity(hostname, cert),
      ALPNProtocols: ["http/1.1"] });
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    // Keep an error listener installed during appraisal, before HTTP owns it.
    socket.on("error", reject);
    socket.once("secureConnect", () => {
      if (socket.authorized && (!socket.alpnProtocol || socket.alpnProtocol === "http/1.1")) resolve(socket);
      else {
        socket.destroy();
        reject(new Error("Expected an authorized HTTPS/1.1 connection"));
      }
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? signal.reason : new Error("TLS connection closed"));
    });
  });
}

function send(socket: TLSSocket, url: URL, args: EnclavaRequiredRequest, signal: AbortSignal,
  limit = RESPONSE_LIMIT, rejectRedirect = false): Promise<Response> {
  signal.throwIfAborted();
  if (socket.destroyed || !socket.writable || socket.readableEnded) throw new Error("Attested connection closed before send");
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  let used = false;
  agent.createConnection = () => {
    if (used || socket.destroyed) throw new Error("Attested connection unavailable; will not reconnect");
    used = true;
    return socket;
  };
  return new Promise<Response>((resolve, reject) => {
    const body = args.body;
    const req = request(url, {
      agent, signal, method: args.method ?? (body === undefined ? "GET" : "POST"),
      headers: { ...args.headers, connection: "close", "accept-encoding": "identity", ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) },
    }, response => {
      response.once("error", reject);
      const status = response.statusCode!;
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (encoding !== undefined && encoding !== "identity") {
        req.destroy(new Error("Encoded responses are unsupported in TEE-required transport"));
        return;
      }
      if (rejectRedirect && status >= 300 && status < 400) {
        req.destroy(new Error("Enclava proof endpoint must not redirect"));
        return;
      }
      if (Number(response.headers["content-length"]) > limit) {
        req.destroy(new Error(`Enclava response exceeds ${limit} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) req.destroy(new Error(`Enclava response exceeds ${limit} bytes`));
        else chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          }
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
        } catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.once("upgrade", (_res, upgraded) => {
      upgraded.destroy();
      reject(new Error("Protocol upgrades are unsupported in TEE-required transport"));
    });
    req.end(body);
  }).finally(() => agent.destroy());
}

/**
 * Dedicated opt-in transport for caller-managed, buffered provider requests.
 * Does not perform review admission or payment orchestration. The Node
 * RoutstrClient TEE-required path adds review admission before invoking it.
 */
export function createEnclavaRequiredTransport(options: EnclavaRequiredOptions) {
  if (typeof process === "undefined" || process.release?.name !== "node" || process.versions.bun) {
    throw new Error("TEE-required requests need the Node HTTPS transport");
  }
  const { origin, coordinate, releasePubkey, imageRepository, events, appraiser, ca } = options;
  const getAnnouncement = events.getEnclavaAnnouncement.bind(events);
  const getRelease = events.getEnclavaRelease.bind(events);
  if (typeof appraiser !== "function") throw new Error("A trusted Enclava appraiser is required");
  const policy = typeof options.policy === "string" ? options.policy : new Uint8Array(options.policy);
  const parsed = JSON.parse(typeof policy === "string" ? policy : new TextDecoder("utf-8", { fatal: true }).decode(policy));
  const checks = parsed?.required_checks;
  const digests = parsed?.target?.image_digests;
  if (parsed?.schema_version !== "enclava-trust-policy-v1" || parsed?.transport?.require_tls_channel_spki !== true ||
      !Array.isArray(digests) || digests.length !== 1 || !Array.isArray(checks) ||
      checks.some(check => typeof check !== "string") || REQUIRED_CHECKS.some(check => !checks.includes(check))) {
    throw new Error("Pinned Enclava policy must require TLS binding, one image digest, and all baseline checks");
  }
  const required = new Set<string>([...checks, "transport.tls_channel_spki"]);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid TEE request timeout");

  return async function requestEnclava(args: EnclavaRequiredRequest): Promise<Response> {
    const url = new URL(args.path, origin);
    if (!args.path.startsWith("/") || args.path.startsWith("//") || args.path.includes("\\") ||
        url.origin !== origin || url.hash || url.username || url.password) throw new Error("Expected a same-origin path");
    const headers = { ...args.headers };
    if (Object.keys(headers).some(name => /^(host|connection|content-length|transfer-encoding|upgrade|expect|accept-encoding|proxy-.*)$/i.test(name)) ||
        (args.method !== undefined && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(args.method))) {
      throw new Error("Unsupported method or header in TEE-required transport");
    }
    const body = args.body instanceof Uint8Array ? new Uint8Array(args.body) : args.body;
    if (args.method === "GET" && body !== undefined) throw new Error("GET cannot have a body");
    const { method } = args;
    const startedAt = performance.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = args.signal ? AbortSignal.any([deadline, args.signal]) : deadline;
    signal.throwIfAborted();
    const announcement = await inTime(getAnnouncement(coordinate), signal);
    if (!announcement) throw new Error("Signed provider announcement not found");
    const claim = verifyEnclavaListing(announcement, coordinate, origin);
    const release = await inTime(getRelease(claim.releaseId), signal);
    if (!release) throw new Error("Referenced Enclava release not found");
    const { imageDigest } = verifyEnclavaRelease(release, claim.releaseId, releasePubkey, imageRepository);
    if (digests[0] !== imageDigest) throw new Error("Release image digest does not match pinned policy");

    const socket = await openSocket(url, ca, signal);
    try {
      const cert = socket.getPeerX509Certificate();
      if (!cert) throw new Error("TLS peer has no certificate");
      const spki = await spkiSha256FromPeerCertificate(cert);
      // The public proof request has no prompt, cookies or credentials. Use the
      // same TLS trust rules as the paid socket and never follow redirects.
      const fetchProof: typeof fetch = async (input, init) => {
        const proofUrl = new URL(String(input));
        if (proofUrl.origin !== origin) throw new Error("Proof must be fetched from the pinned origin");
        const proofSignal = init?.signal ?? signal;
        const proofSocket = await openSocket(proofUrl, ca, proofSignal);
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
        try {
          return await send(proofSocket, proofUrl, { path: proofUrl.pathname, method: "GET",
            headers }, proofSignal, MAX_ENCLAVA_PROOF_BUNDLE_BYTES, true);
        } finally {
          proofSocket.destroy();
        }
      };
      const result = await inTime(attestEnclavaProvider({
        origin, policy, channelSpkiSha256: spki, appraiser, fetchImpl: fetchProof, signal, ttlMs: 0, failureTtlMs: 0,
      }), signal);
      const appraisal = result.appraisal;
      if (appraisal.challenge_nonce !== result.challengeNonce || appraisal.target_origin !== origin ||
          appraisal.bundle_sha256 !== result.bundleSha256 || appraisal.policy_sha256 !== result.policySha256 ||
          !appraisal.checks || [...required].some(id => {
            const found = appraisal.checks!.filter(check => check?.id === id);
            return found.length !== 1 || found[0].outcome !== "PASS" ||
              (id === "transport.tls_channel_spki" && (found[0].observed !== spki || found[0].expected !== spki));
          })) throw new Error("Enclava appraisal lacks the required bindings or passing checks");
      // A timer cannot preempt synchronous work: a WASM verifier that overruns
      // the budget blocks the abort callback until the loop yields, so the
      // request could otherwise still be written. Re-check the budget here.
      if (performance.now() - startedAt >= timeoutMs) {
        throw new Error(`TEE-required request exceeded its ${timeoutMs} ms budget before send`);
      }
      return await send(socket, url, { path: url.pathname, headers, method, body }, signal);
    } finally {
      socket.destroy();
    }
  };
}
