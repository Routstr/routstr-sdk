/**
 * TlsnVerifier e2e (Bun): real proverd + chat-shaped TLS mock upstream.
 *
 * Default backend: native tlsn-verifier binary (reliable). The wasm-worker
 * backend can be exercised with TLSN_TEST_WASM=1 — expect intermittent
 * proxy-tls preprocessing failures under Bun/JSC (see STATUS.md M3 fork).
 *
 * Cases: non-SSE verified, SSE verified, request tamper → mismatch,
 * response tamper → mismatch, host policy → unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { NativeVerifierBackend, TlsnVerifier, WasmWorkerBackend } from "../../client/tlsn";

const PROVABLE_AI = join(__dirname, "..", "..", "..");
const PROVERD_BIN = join(PROVABLE_AI, "proverd/target/debug/proverd");
const MOCK_BIN = join(PROVABLE_AI, "proverd/target/debug/examples/mock_upstream");
const ROOT_CA_DER = join(
  PROVABLE_AI,
  "tlsn/crates/server-fixture/certs/src/tls/root_ca_cert.der"
);
const ROOT_CA_PEM = join(
  PROVABLE_AI,
  "tlsn/crates/server-fixture/certs/src/tls/root_ca.crt"
);
const SERVER_DOMAIN = "test-server.io";
const AUTH_TOKEN = "random_auth_token";
const USE_WASM = process.env.TLSN_TEST_WASM === "1";

const CHAT_BODY = {
  model: "gpt-mock",
  messages: [{ role: "user", content: "sdk verifier hello" }],
};

let mockPort: number;
let proverdPort: number;
let procs: Subprocess[] = [];
let rootCerts: number[][];

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitReady(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

beforeAll(async () => {
  rootCerts = [Array.from(new Uint8Array(await Bun.file(ROOT_CA_DER).arrayBuffer()))];

  const mock = Bun.spawn([MOCK_BIN, "--port", "0"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  procs.push(mock);
  // mock prints PORT=<n> as its first line (then nothing until shutdown)
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  let firstLine = "";
  while (!firstLine.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    firstLine += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  mockPort = parseInt(firstLine.split("\n")[0].split("=")[1], 10);
  if (!Number.isFinite(mockPort)) throw new Error(`mock_upstream said: ${firstLine}`);

  proverdPort = await freePort();
  const proverd = Bun.spawn([PROVERD_BIN], {
    env: {
      ...process.env,
      PROVERD_BIND: `127.0.0.1:${proverdPort}`,
      PROVERD_EXTRA_ROOT_CERT_PEM: ROOT_CA_PEM,
      RUST_LOG: "proverd=info,tlsn=warn",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(proverd);
  await waitReady(`http://127.0.0.1:${proverdPort}/healthz`);
}, 60_000);

afterAll(() => {
  for (const proc of procs) proc.kill();
  procs = [];
  // The tlsn rayon spawner keeps workers alive under the wasm backend.
  if (USE_WASM) setTimeout(() => process.exit(0), 500);
});

/** Channel-A analogue: what routstr-core does in verified mode. */
async function postSession(
  sessionId: string,
  body: Record<string, unknown>
): Promise<Uint8Array> {
  const res = await fetch(`http://127.0.0.1:${proverdPort}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      server_name: SERVER_DOMAIN,
      port: 443,
      request: {
        method: "POST",
        path: "/v1/chat/completions",
        headers: [
          ["authorization", `Bearer ${AUTH_TOKEN}`],
          ["content-type", "application/json"],
        ],
        body: JSON.stringify(body),
      },
      redact: ["authorization"],
      max_recv_bytes: 1 << 20,
    }),
  });
  if (!res.ok) throw new Error(`proverd POST /sessions -> ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

function makeVerifier(): TlsnVerifier {
  return new TlsnVerifier({
    backend: USE_WASM
      ? new WasmWorkerBackend({ rootCerts })
      : new NativeVerifierBackend({ rootCertPemFiles: [ROOT_CA_PEM] }),
  });
}

async function runVerifiedSession(
  requestBody: Record<string, unknown>,
  expected: Record<string, unknown>,
  tamperResponse?: (bytes: Uint8Array) => Uint8Array
) {
  const sessionId = crypto.randomUUID();
  const handle = await makeVerifier().begin({
    proverWsUrl: `ws://127.0.0.1:${proverdPort}/ws`,
    sessionId,
    upstreamHostAllowlist: [SERVER_DOMAIN],
    // test-server.io doesn't resolve; dial the local mock instead. The
    // policy check still sees the REAL committed server name.
    dialTo: { hostname: "127.0.0.1", port: mockPort },
    expected: { method: "POST", path: "/v1/chat/completions", jsonBody: expected },
  });
  let responseBody = await postSession(sessionId, requestBody);
  if (tamperResponse) responseBody = tamperResponse(responseBody);
  return handle.complete(responseBody);
}

describe(`TlsnVerifier proxy-tls e2e (${USE_WASM ? "wasm" : "native"} backend)`, () => {
  test(
    "non-streaming chat completion verifies",
    async () => {
      const result = await runVerifiedSession(CHAT_BODY, CHAT_BODY);
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.upstreamHost).toBe(SERVER_DOMAIN);
        expect(result.upstreamModel).toBe("gpt-mock");
      }
    },
    120_000
  );

  test(
    "streaming (SSE) chat completion verifies",
    async () => {
      const body = {
        ...CHAT_BODY,
        stream: true,
        stream_options: { include_usage: true },
      };
      const result = await runVerifiedSession(body, body);
      expect(result.status).toBe("verified");
    },
    120_000
  );

  test(
    "request tamper (different messages) -> mismatch",
    async () => {
      const expected = {
        ...CHAT_BODY,
        messages: [{ role: "user", content: "DIFFERENT content" }],
      };
      const result = await runVerifiedSession(CHAT_BODY, expected);
      expect(result.status).toBe("mismatch");
      if (result.status === "mismatch") expect(result.reason).toContain("messages");
    },
    120_000
  );

  test(
    "response tamper (edited body) -> mismatch",
    async () => {
      const result = await runVerifiedSession(CHAT_BODY, CHAT_BODY, (bytes) => {
        const text = new TextDecoder().decode(bytes).replace("Mock reply", "FORGED reply");
        return new TextEncoder().encode(text);
      });
      expect(result.status).toBe("mismatch");
    },
    120_000
  );

  test(
    "host policy rejection -> unavailable",
    async () => {
      const sessionId = crypto.randomUUID();
      const handle = await makeVerifier().begin({
        proverWsUrl: `ws://127.0.0.1:${proverdPort}/ws`,
        sessionId,
        upstreamHostAllowlist: ["api.openai.com"], // not our mock
        dialTo: { hostname: "127.0.0.1", port: mockPort },
        expected: { method: "POST", path: "/v1/chat/completions", jsonBody: CHAT_BODY },
      });
      // The prover only commits once the API call lands; it will 5xx when
      // the verifier aborts on policy.
      void postSession(sessionId, CHAT_BODY).catch(() => {});
      await expect(handle.ready).rejects.toThrow("not in allowlist");
      const result = await handle.complete(new Uint8Array());
      expect(result.status).toBe("unavailable");
    },
    120_000
  );
});
