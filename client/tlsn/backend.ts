/**
 * Verifier backends. A backend runs the tlsn verifier protocol for one
 * session and yields:
 *  - ready: the committed upstream server name (relay live), and
 *  - output: the verified server name + disclosed transcript bytes.
 */

export interface TlsnTranscriptOutput {
  server_name: string | undefined;
  transcript: { sent: Uint8Array; recv: Uint8Array } | undefined;
}

export interface TlsnBackendSession {
  /** Resolves with the committed upstream host once the relay is live. */
  ready: Promise<string>;
  /** Resolves with the verified output (proof done). */
  output: Promise<TlsnTranscriptOutput>;
  /** Abort the session (best effort). */
  cancel(): void;
}

export interface TlsnBackendBeginParams {
  /** ws(s) base URL of proverd's mux endpoint (no session_id). */
  proverWsBase: string;
  sessionId: string;
  /** Upstream host allowlist; violated → ready/output reject. */
  allowlist?: string[];
  /** Channel-C dial target override (tests, Tor bridges). */
  dialTo?: { hostname: string; port: number };
  maxSentData?: number;
  maxRecvData?: number;
}

export interface TlsnVerifierBackend {
  begin(params: TlsnBackendBeginParams): Promise<TlsnBackendSession>;
}
