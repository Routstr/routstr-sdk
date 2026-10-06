/**
 * TlsnVerifier — SDK-side TLSN (Proxy-TLS) verification rail.
 *
 * Mirrors the Tinfoil rail: a complementary, opt-in verification path.
 * The SDK (this code) is the tlsn Verifier = Notary:
 *  - channel B: WebSocket to the node's proverd (the tlsn mux)
 *  - channel C: raw TCP to the upstream the SDK itself dials (ciphertext relay)
 *
 * The protocol execution lives behind a backend (native Rust binary for
 * Bun/Node — reliable; wasm worker for browsers); this facade orchestrates
 * and runs the comparator.
 *
 * Flow: begin() before/alongside the channel-A fetch (do NOT await relay
 * readiness first — the prover only starts once the fetch lands), then
 * complete() with the exact response body bytes once the response (or
 * stream) is done.
 */

import type { SdkLogger, UpstreamVerification } from "../../core/types";
import type {
  TlsnBackendSession,
  TlsnVerifierBackend,
} from "./backend";
import { NativeVerifierBackend } from "./backends/native";
import { WasmWorkerBackend } from "./backends/wasmWorker";
import {
  checkCredentialRedaction,
  jsonDeepEqual,
  parseHttpRequest,
  parseHttpResponse,
  sseSequencesEqual,
} from "./comparator";

export interface TlsnVerifierOptions {
  /** Protocol execution backend. Default: native binary under Bun/Node,
   *  wasm worker elsewhere (browsers need a ws→TCP bridge for channel C). */
  backend?: TlsnVerifierBackend;
  logger?: SdkLogger;
}

export interface TlsnVerifyRequest {
  /** ws(s) URL of proverd's mux endpoint, WITHOUT the session_id query. */
  proverWsUrl: string;
  sessionId: string;
  /** Upstream hosts acceptable for this model/request (node-advertised). */
  upstreamHostAllowlist?: string[];
  /** Channel-C dial target override (tests, Tor bridges). */
  dialTo?: { hostname: string; port: number };
  /** Copy of the SDK's own channel-A request for the comparator. */
  expected: {
    method: string;
    path: string;
    /** Parsed JSON body (chat completions). */
    jsonBody?: Record<string, unknown>;
  };
  /** Model-mapping normalization: sdk-facing model id → upstream model id. */
  modelMapping?: Record<string, string>;
  /** Transcript caps (wasm backend). */
  maxSentData?: number;
  maxRecvData?: number;
}

function defaultBackend(): TlsnVerifierBackend {
  if ((globalThis as any).Bun?.spawn) {
    return new NativeVerifierBackend();
  }
  return new WasmWorkerBackend();
}

export class TlsnVerifier {
  private readonly backend: TlsnVerifierBackend;

  constructor(options: TlsnVerifierOptions = {}) {
    this.backend = options.backend ?? defaultBackend();
  }

  /**
   * Start verification and return immediately. Fire the channel-A fetch
   * concurrently — the prover only starts its commit once routstr-core
   * calls POST /sessions, so awaiting relay readiness first would deadlock.
   */
  async begin(params: TlsnVerifyRequest): Promise<PendingVerificationHandle> {
    const session = await this.backend.begin({
      proverWsBase: params.proverWsUrl,
      sessionId: params.sessionId,
      allowlist: params.upstreamHostAllowlist,
      dialTo: params.dialTo,
      maxSentData: params.maxSentData,
      maxRecvData: params.maxRecvData,
    });
    return new PendingVerificationHandle(session, params);
  }
}

export class PendingVerificationHandle {
  /** Resolves with the committed upstream host once the relay is live. */
  readonly ready: Promise<string>;
  private readonly session: TlsnBackendSession;
  private readonly params: TlsnVerifyRequest;

  constructor(session: TlsnBackendSession, params: TlsnVerifyRequest) {
    this.session = session;
    this.ready = session.ready;
    this.params = params;
  }

  /** Abort the verification session (kills child process / worker). */
  cancel(): void {
    this.session.cancel();
  }

  /**
   * Finish: await the verified transcript and compare it against the SDK's
   * own request copy and the exact response body bytes received on
   * channel A.
   */
  async complete(responseBody: Uint8Array): Promise<UpstreamVerification> {
    try {
      const proofStarted = Date.now();
      const output = await this.session.output;
      const proofMs = Date.now() - proofStarted;
      const transcript = output.transcript;
      if (!transcript) {
        return { status: "unavailable", reason: "prover disclosed no transcript" };
      }
      if (output.server_name === undefined) {
        return { status: "unavailable", reason: "prover did not reveal server identity" };
      }
      const host = output.server_name;

      // Redaction: credential values must be present-but-hidden.
      const disclosedRequest = parseHttpRequest(transcript.sent);
      checkCredentialRedaction(disclosedRequest);

      // Request comparison: method, path, messages/tools deep-equality,
      // model under the declared mapping.
      const requestMismatch = this.compareRequest(disclosedRequest);
      if (requestMismatch) {
        return { status: "mismatch", reason: requestMismatch, upstreamHost: host };
      }

      // Response comparison: byte-equality (SSE: event-sequence).
      const disclosedResponse = parseHttpResponse(transcript.recv);
      const isSse = (disclosedResponse.headers.get("content-type") ?? "").includes(
        "text/event-stream"
      );
      const responseMatches = isSse
        ? sseSequencesEqual(disclosedResponse.body, responseBody)
        : bytesEqual(disclosedResponse.body, responseBody);
      if (!responseMatches) {
        return {
          status: "mismatch",
          reason: isSse
            ? "proven SSE event sequence != response received on channel A"
            : "proven response body != response received on channel A",
          upstreamHost: host,
        };
      }

      const upstreamModel = readModelFromBody(disclosedResponse.body, isSse);
      return { status: "verified", upstreamHost: host, upstreamModel, proofMs };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.session.cancel();
    }
  }

  private compareRequest(
    disclosed: ReturnType<typeof parseHttpRequest>
  ): string | null {
    const expected = this.params.expected;
    if (disclosed.method.toUpperCase() !== expected.method.toUpperCase()) {
      return `method ${disclosed.method} != expected ${expected.method}`;
    }
    const disclosedPath = disclosed.path.split("?")[0];
    const expectedPath = expected.path.split("?")[0];
    if (disclosedPath !== expectedPath) {
      return `path ${disclosedPath} != expected ${expectedPath}`;
    }
    if (!expected.jsonBody) return null;

    let sentJson: Record<string, unknown>;
    try {
      sentJson = JSON.parse(new TextDecoder().decode(disclosed.body));
    } catch {
      return "disclosed request body is not JSON";
    }

    for (const field of ["messages", "tools"] as const) {
      const expectedValue = expected.jsonBody[field];
      if (expectedValue === undefined) continue;
      if (!jsonDeepEqual(sentJson[field], expectedValue)) {
        return `request ${field} differs from what the SDK sent`;
      }
    }

    const sentModel = typeof sentJson.model === "string" ? sentJson.model : undefined;
    const expectedModel =
      typeof expected.jsonBody.model === "string" ? expected.jsonBody.model : undefined;
    if (expectedModel && sentModel && sentModel !== expectedModel) {
      const mapped = this.params.modelMapping?.[expectedModel];
      if (mapped !== sentModel) {
        return `model ${sentModel} != expected ${expectedModel} (no declared mapping)`;
      }
    }
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readModelFromBody(body: Uint8Array, isSse: boolean): string | undefined {
  try {
    if (!isSse) {
      const json = JSON.parse(new TextDecoder().decode(body));
      return typeof json.model === "string" ? json.model : undefined;
    }
    for (const block of new TextDecoder().decode(body).split("\n\n")) {
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line || line.includes("[DONE]")) continue;
      const json = JSON.parse(line.slice(5).trim());
      if (typeof json.model === "string") return json.model;
    }
  } catch {
    /* best effort */
  }
  return undefined;
}
