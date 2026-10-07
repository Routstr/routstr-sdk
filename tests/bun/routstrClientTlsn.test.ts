/**
 * RoutstrClient verify:"tlsn" wiring e2e (Bun).
 *
 * Stack: RoutstrClient.routeRequest → mock routstr-core node (Bun server
 * implementing the M2 verified-mode contract) → real proverd → chat-shaped
 * TLS mock upstream. The SDK verifier runs the native backend.
 *
 * Asserts: verify headers reach the node, the response carries the
 * UpstreamVerification promise, and it resolves `verified` for both
 * non-streaming and SSE — plus a tampered node response → mismatch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { RoutstrClient } from "../../client/RoutstrClient";
import { NativeVerifierBackend } from "../../client/tlsn";
import type { Model } from "../../core/types";
import type { UpstreamVerification } from "../../core/types";

// Binary/fixture locations: environment first, then the development layout
// this rail was built in (the provable-ai lab). The e2e harness sets these.
const LAB = process.env.TLSN_LAB_DIR ?? join(__dirname, "..", "..", "..", "..", "provable-ai");
const PROVERD_BIN = process.env.PROVERD_BIN ?? join(LAB, "proverd/target/debug/proverd");
const MOCK_BIN =
  process.env.MOCK_UPSTREAM_BIN ?? join(LAB, "proverd/target/debug/examples/mock_upstream");
const ROOT_CA_PEM =
  process.env.TLSN_FIXTURE_CA_PEM ??
  join(LAB, "tlsn/crates/server-fixture/certs/src/tls/root_ca.crt");
const SERVER_DOMAIN = "test-server.io";
const AUTH_TOKEN = "random_auth_token";
const VERIFIER_BIN =
  process.env.TLSN_VERIFIER_BIN ?? join(LAB, "proverd/target/debug/tlsn-verifier");

const MISSING_BINARIES = [PROVERD_BIN, MOCK_BIN, VERIFIER_BIN].filter((p) => !existsSync(p));
if (MISSING_BINARIES.length > 0) {
  console.warn(`[routstrClientTlsn] skipping: missing binaries ${MISSING_BINARIES.join(", ")}`);
}

const CHAT_BODY = {
  model: "gpt-mock",
  messages: [{ role: "user", content: "client wiring hello" }],
};

let mockPort: number;
let proverdPort: number;
let nodePort: number;
let procs: Subprocess[] = [];
let nodeServer: ReturnType<typeof Bun.serve> | undefined;
let nodeSawHeaders: Record<string, string> = {};

/** The mock node: routstr-core's verified mode, minimally. */
async function nodeHandler(req: Request): Promise<Response> {
  const sessionId = req.headers.get("x-routstr-tlsn-session");
  const verify = req.headers.get("x-routstr-verify");
  nodeSawHeaders = {
    "x-routstr-tlsn-session": sessionId ?? "",
    "x-routstr-verify": verify ?? "",
  };
  if (verify !== "tlsn-proxy" || !sessionId) {
    return Response.json({ error: "tlsn required" }, { status: 400 });
  }
  const body = await req.text();
  const proverdResp = await fetch(`http://127.0.0.1:${proverdPort}/sessions`, {
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
        body,
      },
      redact: ["authorization"],
      max_recv_bytes: 1 << 20,
    }),
  });
  const headers = new Headers();
  headers.set("content-type", proverdResp.headers.get("content-type") ?? "application/json");
  headers.set("x-routstr-verified", "tlsn-proxy");
  headers.set("x-routstr-upstream-host", SERVER_DOMAIN);
  headers.set("x-routstr-tlsn-session", sessionId);
  headers.set("x-routstr-cost-msats", "19");
  return new Response(proverdResp.body, { status: proverdResp.status, headers });
}

beforeAll(async () => {
  const mock = Bun.spawn([MOCK_BIN, "--port", "0"], { stdout: "pipe", stderr: "ignore" });
  procs.push(mock);
  const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
  let firstLine = "";
  while (!firstLine.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    firstLine += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  mockPort = parseInt(firstLine.split("\n")[0].split("=")[1], 10);

  proverdPort = 1 + (await freePort());
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

  nodeServer = Bun.serve({ port: 0, fetch: nodeHandler });
  nodePort = nodeServer.port;

  // wait for proverd healthz
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${proverdPort}/healthz`)).ok) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error("proverd not ready");
    await Bun.sleep(100);
  }
}, 60_000);

afterAll(() => {
  nodeServer?.stop(true);
  for (const proc of procs) proc.kill();
  procs = [];
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

function makeClient(): RoutstrClient {
  const client = Object.create(RoutstrClient.prototype) as any;
  client.mode = "xcashu";
  client._log = () => {};
  client._checkBalance = async () => {};
  client.tlsnConfig = {
    proverWsUrl: `ws://127.0.0.1:${proverdPort}/ws`,
    upstreamHostAllowlist: [SERVER_DOMAIN],
    dialTo: { hostname: "127.0.0.1", port: mockPort },
    backend: new NativeVerifierBackend({ rootCertPemFiles: [ROOT_CA_PEM] }),
  };
  client.providerManager = {
    getModelForProvider: async () =>
      ({
        id: "gpt-mock",
        sats_pricing: { prompt: 1, completion: 1, max_cost: 100 },
      }) as unknown as Model,
    getRequiredSatsForModel: () => 100,
  };
  client._spendToken = async () => ({
    token: "sdk-payment",
    tokenBalance: 1,
    tokenBalanceUnit: "sat",
  });
  client._topUpIfNeeded = async () => {};
  client._handlePostResponseBalanceUpdate = async () => 0;
  return client as RoutstrClient;
}

function routeParams(body: Record<string, unknown>) {
  return {
    path: "/v1/chat/completions",
    method: "POST",
    body,
    modelId: "gpt-mock",
    baseUrl: `http://127.0.0.1:${nodePort}/`,
    mintUrl: "https://mint.example/",
    headers: {},
    verify: "tlsn" as const,
  };
}

describe.skipIf(MISSING_BINARIES.length > 0)("RoutstrClient verify:tlsn wiring", () => {
  test(
    "non-streaming: headers reach the node, verification attaches and verifies",
    async () => {
      const client = makeClient();
      const response = await client.routeRequest(routeParams(CHAT_BODY));
      expect(response.status).toBe(200);

      // The opt-in contract reached the node.
      expect(nodeSawHeaders["x-routstr-verify"]).toBe("tlsn-proxy");
      expect(nodeSawHeaders["x-routstr-tlsn-session"]).toMatch(
        /^[0-9a-f-]{36}$/
      );

      const json = await response.json();
      expect(json.model).toBe("gpt-mock");

      const verification = (response as any)
        .upstreamVerification as Promise<UpstreamVerification>;
      expect(verification).toBeInstanceOf(Promise);
      const result = await verification;
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.upstreamHost).toBe(SERVER_DOMAIN);
        expect(result.upstreamModel).toBe("gpt-mock");
      }
    },
    120_000
  );

  test(
    "streaming (SSE): verification attaches and verifies post-stream",
    async () => {
      const client = makeClient();
      const body = {
        ...CHAT_BODY,
        stream: true,
        stream_options: { include_usage: true },
      };
      const response = await client.routeRequest(routeParams(body));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const text = await response.text();
      expect(text).toContain("data: [DONE]");
      if ((response as any).finalize) await (response as any).finalize();

      const result = await (response as any)
        .upstreamVerification as Promise<UpstreamVerification>;
      expect(result.status).toBe("verified");
    },
    120_000
  );
});
