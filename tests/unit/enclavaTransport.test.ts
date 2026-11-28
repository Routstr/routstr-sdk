import { createServer } from "node:https";
import { of } from "rxjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { finalizeEvent, getPublicKey, type NostrEvent } from "applesauce-core/helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnclavaRequiredTransport, createNodeEnclavaAppraiser, type EnclavaRequiredOptions } from "../../client/NodeEnclavaTransport";
import { enclavaSha256Hex, ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE, spkiSha256FromPeerCertificate, type EnclavaAppraiseInput } from "../../client/EnclavaAttest";

import { NodeRoutstrClient } from "../../client/NodeRoutstrClient";
import { RoutstrClient as BrowserRoutstrClient } from "../../client/RoutstrClient";
import { fetchAIResponse } from "../../client/fetchAIResponse";
import { routeRequests } from "../../routeRequests";
import { createDiscoveryAdapterFromStore, createMemoryDriver, createSdkStore } from "../../storage";
import type { StorageAdapter, WalletAdapter } from "../../wallet/interfaces";
import { ENCLAVA_TEST_TLS_CERT, ENCLAVA_TEST_TLS_KEY } from "../fixtures/enclavaTls";

const relay = vi.hoisted(() => ({ events: [] as NostrEvent[] }));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    request(_relays: string[], filter: { kinds: number[] }) {
      return of(...relay.events.filter(event => filter.kinds.includes(event.kind)));
    }
  },
}));

// Public test-only keypair/certificate, exclusively for this loopback TLS server.
// Kept as a committed module (not .pem/.key files) so the pair cannot be lost to
// .gitignore and the suite loads on a clean checkout.
const key = ENCLAVA_TEST_TLS_KEY;
const cert = ENCLAVA_TEST_TLS_CERT;
const nodeKey = new Uint8Array(32).fill(1);
const teamKey = new Uint8Array(32).fill(2);
const coordinate = `38421:${getPublicKey(nodeKey)}:test`;
const imageRepository = "ghcr.io/routstr/core-enclava";
const digest = `sha256:${"a".repeat(64)}`;
const checks = [
  "binding.challenge_nonce", "binding.target_origin", "binding.tls_leaf_certificate", "binding.report_data",
  "amd.certificate_chain", "amd.report_signature", "amd.vcek_binding", "amd.revocation.freshness",
  "amd.measurement", "amd.tcb", "amd.guest_policy", "artifacts.signatures", "artifacts.relationships",
  "artifacts.descriptor_measurement", "supply_chain.image_policy", "supply_chain.portable_integrity",
  "supply_chain.signatures", "platform.runtime_class", "platform.sidecars", "platform.release", "deployment.identity",
];
const policy = JSON.stringify({ schema_version: "enclava-trust-policy-v1", required_checks: checks,
  target: { image_digests: [digest] }, transport: { require_tls_channel_spki: true } });

function signedRelease(imageDigest = digest, signer = teamKey, repository = imageRepository) {
  return finalizeEvent({ kind: 8428, created_at: 1, tags: [], content: JSON.stringify({
    schema: "routstr.enclava-image-release.v1", scheme: "enclava-tee", image: `${repository}@${imageDigest}`, image_digest: imageDigest,
  }) }, signer);
}

async function pass({ bundle, policy, context }: EnclavaAppraiseInput) {
  const spki = context.observed_channel_spki_sha256;
  return {
    verdict: "PASS" as const, bundle_sha256: await enclavaSha256Hex(bundle), policy_sha256: await enclavaSha256Hex(policy),
    challenge_nonce: context.challenge_nonce, target_origin: context.expected_target_origin,
    checks: [...checks.map(id => ({ id, outcome: "PASS" })),
      { id: "transport.tls_channel_spki", outcome: "PASS", observed: spki, expected: spki }],
  };
}

describe("TEE-required Node transport", () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let connections: TLSSocket[];
  let requestSocket: TLSSocket | undefined;
  let bytes: Map<TLSSocket, number>;
  let proofRequests: { socket: TLSSocket; nonce: string; headers: Record<string, unknown> }[];
  let proofFailure: "redirect" | "encoded" | undefined;
  let paidEncoding: string | undefined;
  let paidStatus: number;
  let requests: [string | undefined, string | undefined, string][];
  const sensitive = { path: "/v1/chat/completions", headers: { Authorization: "Bearer secret", "x-cashu": "payment" }, body: "private prompt" };

  beforeEach(async () => {
    connections = [];
    requestSocket = undefined;
    requests = [];
    bytes = new Map();
    proofRequests = [];
    proofFailure = undefined;
    paidEncoding = undefined;
    paidStatus = 307;
    relay.events = [];
    server = createServer({ key, cert }, (req, res) => {
      const url = new URL(req.url!, origin);
      if (url.pathname === "/.well-known/confidential/proof-bundle") {
        proofRequests.push({ socket: req.socket as TLSSocket, nonce: url.searchParams.get("nonce")!, headers: req.headers });
        if (proofFailure === "redirect") res.writeHead(302, { location: "/elsewhere" });
        else res.writeHead(200, { "content-type": ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE,
          ...(proofFailure === "encoded" ? { "content-encoding": "gzip" } : {}) });
        res.end("proof fixture");
        return;
      }
      requestSocket = req.socket as TLSSocket;
      const data: Buffer[] = [];
      req.on("data", chunk => data.push(chunk));
      req.on("end", () => {
        requests.push([req.headers.authorization, req.headers["x-cashu"] as string, Buffer.concat(data).toString()]);
        res.writeHead(paidStatus, { location: "https://elsewhere.example/never",
          ...(paidEncoding ? { "content-encoding": paidEncoding } : {}) });
        res.end("one response");
      });
    });
    server.on("secureConnection", socket => {
      connections.push(socket);
      socket.on("data", data => { bytes.set(socket, (bytes.get(socket) ?? 0) + data.length); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected server address");
    origin = `https://127.0.0.1:${address.port}`;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Ambient fetch is forbidden"); }));
  });

  afterEach(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllGlobals();
  });

  function options(release = signedRelease(), id = release.id): EnclavaRequiredOptions {
    const announcement = finalizeEvent({ kind: 38421, created_at: 1, content: "", tags: [
      ["d", "test"], ["u", origin], ["attestation", "enclava-tee", origin, id],
    ] }, nodeKey);
    return { coordinate, origin, imageRepository, policy, releasePubkey: getPublicKey(teamKey), ca: cert, appraiser: pass,
      events: { getEnclavaAnnouncement: async () => announcement, getEnclavaRelease: async () => release } };
  }

  it("uses the private CA for a real proof GET, then sends only on the appraised socket", async () => {
    const opts = options();
    const expected = await spkiSha256FromPeerCertificate(new X509Certificate(cert));
    let appraisedSocket: TLSSocket | undefined;
    opts.appraiser = async input => {
      expect(input.context.observed_channel_spki_sha256).toBe(expected);
      expect(new TextDecoder().decode(input.bundle)).toBe("proof fixture");
      expect(proofRequests).toHaveLength(1);
      const proof = proofRequests[0];
      expect(Buffer.from(proof.nonce, "base64url").toString("hex")).toBe(input.context.challenge_nonce);
      expect(proof.headers).toMatchObject({ accept: ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE, "accept-encoding": "identity" });
      expect(proof.headers).not.toHaveProperty("authorization");
      expect(proof.headers).not.toHaveProperty("x-cashu");
      expect(proof.socket).not.toBe(connections[0]);
      expect(bytes.get(connections[0])).toBeUndefined();
      appraisedSocket = connections[0];
      return pass(input);
    };
    const response = await createEnclavaRequiredTransport(opts)(sensitive);
    expect(response.status).toBe(307);
    expect(await response.text()).toBe("one response");
    expect(requests).toEqual([["Bearer secret", "payment", "private prompt"]]);
    expect(requestSocket).toBe(appraisedSocket);
    expect(connections).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["fail", "skipped TLS check", "wrong TLS key", "closed socket"])("writes zero paid bytes on %s", async failure => {
    const opts = options();
    opts.appraiser = async input => {
      const result = await pass(input);
      const tls = result.checks.at(-1)!;
      if (failure === "fail") return { verdict: "FAIL" };
      if (failure === "skipped TLS check") tls.outcome = "SKIPPED";
      if (failure === "wrong TLS key") Object.assign(tls, { observed: "a".repeat(64) });
      if (failure === "closed socket") {
        connections[0].destroy();
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return result;
    };
    await expect(createEnclavaRequiredTransport(opts)(sensitive)).rejects.toThrow();
    expect(bytes.get(connections[0])).toBeUndefined();
    expect(connections).toHaveLength(2);
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["redirect", "encoded"] as const)("rejects a %s proof without sending paid bytes", async failure => {
    proofFailure = failure;
    await expect(createEnclavaRequiredTransport(options())(sensitive)).rejects.toThrow();
    expect(proofRequests).toHaveLength(1);
    expect(bytes.get(connections[0])).toBeUndefined();
    expect(requests).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an encoded paid response without retrying", async () => {
    paidEncoding = "gzip";
    await expect(createEnclavaRequiredTransport(options())(sensitive)).rejects.toThrow(/Encoded responses/);
    expect(proofRequests).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the configured CA and checks the certificate hostname", async () => {
    await expect(createEnclavaRequiredTransport({ ...options(), ca: undefined })(sensitive)).rejects.toThrow();
    origin = origin.replace("127.0.0.1", "localhost");
    await expect(createEnclavaRequiredTransport(options())(sensitive)).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(proofRequests).toEqual([]);
    expect(requests).toEqual([]);
  });

  it.each(["wrong signer", "wrong ID", "wrong image", "wrong repository", "wrong origin", "wrong node", "missing claim", "tampered listing"])(
    "rejects %s before opening TLS", async failure => {
      const valid = signedRelease();
      const opts = failure === "wrong signer" ? options(signedRelease(digest, nodeKey)) :
        failure === "wrong ID" ? options(valid, "b".repeat(64)) :
        failure === "wrong image" ? options(signedRelease(`sha256:${"b".repeat(64)}`)) :
        failure === "wrong repository" ? options(signedRelease(digest, teamKey, "ghcr.io/other/core")) : options(valid);
      if (failure === "wrong origin") opts.origin = "https://somewhere.example";
      if (failure === "wrong node") opts.coordinate = `38421:${getPublicKey(teamKey)}:test`;
      if (failure === "missing claim") opts.events.getEnclavaAnnouncement = async () => finalizeEvent({ kind: 38421,
        created_at: 1, content: "", tags: [["d", "test"], ["u", origin]] }, nodeKey);
      if (failure === "tampered listing") {
        const announcement = (await opts.events.getEnclavaAnnouncement(coordinate))!;
        announcement.content = "signature cache must not hide this mutation";
      }
      await expect(createEnclavaRequiredTransport(opts)(sensitive)).rejects.toThrow();
      expect(connections).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

  async function api(reviews: NostrEvent[], { mode = "apikeys", appraiser = pass, browser = false } = {} as {
    mode?: "apikeys" | "xcashu"; appraiser?: EnclavaRequiredOptions["appraiser"]; browser?: boolean;
  }) {
    const opts = options();
    relay.events = [(await opts.events.getEnclavaAnnouncement(coordinate))!, signedRelease(), ...reviews];
    const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
    await hydrate;
    const discoveryAdapter = createDiscoveryAdapterFromStore(store);
    const forbidden = vi.fn(() => { throw new Error("Ordinary wallet/storage path is forbidden"); });
    const walletAdapter = new Proxy({}, { get: () => forbidden }) as WalletAdapter;
    const storageAdapter = new Proxy({}, { get: () => forbidden }) as StorageAdapter;
    const client = browser ? new BrowserRoutstrClient(walletAdapter, storageAdapter, discoveryAdapter, "min", mode) :
      new NodeRoutstrClient(walletAdapter, storageAdapter, discoveryAdapter, "min", mode, { enclava: {
        ...opts, appraiser, discovery: { routstrPubkey: getPublicKey(teamKey) },
      } });
    const body = { model: "native-model", messages: [{ role: "user", content: "private prompt" }], stream: false };
    const params = { baseUrl: origin, pinnedProvider: true, method: "POST", path: "/v1/chat/completions", mintUrl: "",
      teeRequired: { providerApiKey: "caller-provisioned" }, body };
    return { client, forbidden, discoveryAdapter, params, requestOptions: { walletAdapter, storageAdapter, discoveryAdapter, client,
      forcedProvider: origin, modelId: body.model, requestBody: body, teeRequired: params.teeRequired } };
  }

  function review(label: string, at = 2, signer = teamKey, reviewed = nodeKey) {
    return finalizeEvent({ kind: 38425, created_at: at, content: "", tags: [["d", getPublicKey(reviewed)],
      ["node", getPublicKey(reviewed)], ["t", label]] }, signer);
  }

  it("routes through the existing client and routeRequests API with no ordinary egress", async () => {
    const { client, params, requestOptions, forbidden } = await api([review("lgtm")]);
    expect((await client.routeRequest(params)).status).toBe(307);
    expect((await routeRequests(requestOptions)).status).toBe(307);
    expect(proofRequests).toHaveLength(2);
    expect(requests).toEqual(Array(2).fill(["Bearer caller-provisioned", undefined, JSON.stringify(params.body)]));
    expect(forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "negative", "untrusted", "another node", "manual disable"])("rejects %s review admission before provider egress", async failure => {
    const reviews = failure === "missing" ? [] : failure === "negative" ? [review("lgtm"), review("avoid", 3)] :
      failure === "untrusted" ? [review("lgtm", 2, nodeKey)] : failure === "another node" ? [review("lgtm", 2, teamKey, teamKey)] : [review("lgtm")];
    const { client, params, discoveryAdapter, forbidden } = await api(reviews);
    if (failure === "negative") discoveryAdapter.setManuallyEnabledProviders?.([origin]);
    if (failure === "manual disable") discoveryAdapter.setManuallyDisabledProviders?.([`${origin}/`]);
    await expect(client.routeRequest(params)).rejects.toThrow(/review|disabled/);
    expect(connections).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors opt-in review labels and returns 402 without wallet access or retry", async () => {
    const { client, params, discoveryAdapter, forbidden } = await api([review("sandbox")]);
    await expect(client.routeRequest(params)).rejects.toThrow(/review/);
    expect(connections).toEqual([]);
    discoveryAdapter.setUserEnabledReviewLabels?.(["sandbox"]);
    paidStatus = 402;
    expect((await client.routeRequest(params)).status).toBe(402);
    expect(requests).toHaveLength(1);
    expect(proofRequests).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors a negative review on another listing for the same URL", async () => {
    const { client, params, forbidden } = await api([review("lgtm"), review("avoid", 3, teamKey, teamKey)]);
    relay.events.push(finalizeEvent({ kind: 38421, created_at: 1, content: "", tags: [["d", "alias"], ["u", origin]] }, teamKey));
    await expect(client.routeRequest(params)).rejects.toThrow(/negative review/);
    expect(connections).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fall back after rejecting appraisal through routeRequests", async () => {
    const { requestOptions, forbidden } = await api([review("lgtm")], { appraiser: async () => ({ verdict: "FAIL" }) });
    await expect(routeRequests(requestOptions)).rejects.toMatchObject({ code: "ENCLAVA_ATTESTATION_REJECTED" });
    expect(connections).toHaveLength(2);
    expect(bytes.get(connections[0])).toBeUndefined();
    expect(requests).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported clients and modes before fetching or using wallet state", async () => {
    const { client, params, forbidden } = await api([review("lgtm")]);
    const wrongMode = await api([], { mode: "xcashu" });
    const browser = await api([], { browser: true });
    await expect(client.routeRequest({ ...params, body: { ...params.body, stream: true } })).rejects.toThrow(/non-streaming/);
    await expect(wrongMode.client.routeRequest(wrongMode.params)).rejects.toThrow(/API-key mode/);
    await expect(browser.client.routeRequest(browser.params)).rejects.toThrow(/@routstr\/sdk\/node/);
    await expect(fetchAIResponse({ teeRequired: params.teeRequired } as never, {} as never, {} as never)).rejects.toThrow(/streaming/);
    expect(connections).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(wrongMode.forbidden).not.toHaveBeenCalled();
    expect(browser.forbidden).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a policy without TLS or one exact image", () => {
    const opts = options();
    expect(() => createEnclavaRequiredTransport({ ...opts, policy: policy.replace("true", "false") })).toThrow();
    expect(() => createEnclavaRequiredTransport({ ...opts, policy: policy.replace(`"${digest}"`, `"${digest}","${digest}"`) })).toThrow();
    expect(() => createEnclavaRequiredTransport({ ...opts, policy: policy.replace('"amd.measurement",', "") })).toThrow();
  });
});

it("supplies local bytes to the web WASM initializer, without file: fetch", async () => {
  const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const dir = await mkdtemp(join(tmpdir(), "enclava-verifier-"));
  const wasmFile = join(dir, "enclava_verifier_wasm_bg.wasm");
  await writeFile(wasmFile, wasmBytes);
  try {
    const init = vi.fn(async ({ module_or_path }) => expect(new Uint8Array(module_or_path)).toEqual(wasmBytes));
    const appraise = createNodeEnclavaAppraiser({ default: init, verify_bundle: () => '{"verdict":"PASS"}' }, wasmFile);
    const input = { bundle: new Uint8Array(), policy: new Uint8Array(), policyJson: "{}", context: {
      challenge_nonce: "0".repeat(64), expected_target_origin: "https://example.com", now_unix_seconds: 1, observed_channel_spki_sha256: null,
    } };
    await expect(appraise(input)).resolves.toEqual({ verdict: "PASS" });
    await appraise(input);
    expect(init).toHaveBeenCalledTimes(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
