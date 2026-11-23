import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  attestEnclavaProvider,
  attestEnclavaProviderIfNeeded,
  clearEnclavaAttestationCache,
  createModuleEnclavaAppraiser,
  enclavaOrigin,
  fetchEnclavaProofBundle,
  generateEnclavaNonce,
  getCachedEnclavaAttestation,
  isEnclavaProvider,
  spkiSha256FromPeerCertificate,
  ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE,
  ENCLAVA_PROOF_BUNDLE_PATH,
  MAX_ENCLAVA_PROOF_BUNDLE_BYTES,
  type EnclavaAppraisal,
  type EnclavaAppraiser,
} from "../../client/EnclavaAttest";

const ORIGIN = "https://routstr-core.bc42034e.enclava.run";
const POLICY = JSON.stringify({
  schema_version: "enclava-trust-policy-v1",
  required_checks: ["amd.measurement"],
  target: { origins: [ORIGIN] },
  transport: { require_tls_channel_spki: false },
});

function bundleBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

/** Minimal fetch double that serves the proof bundle. */
function bundleFetch(
  options: {
    bytes?: Uint8Array;
    status?: number;
    contentType?: string;
  } = {}
) {
  const {
    bytes = bundleBytes(),
    status = 200,
    contentType = ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE,
  } = options;
  return vi.fn(async () =>
    new Response(bytes, {
      status,
      headers: { "content-type": contentType },
    })
  ) as unknown as typeof fetch;
}

const passingAppraisal = (extra: Partial<EnclavaAppraisal> = {}): EnclavaAppraisal => ({
  verdict: "PASS",
  checks: [{ id: "amd.measurement", outcome: "PASS" }],
  warnings: [],
  ...extra,
});

function countingAppraiser(result: EnclavaAppraisal = passingAppraisal()) {
  const calls: Array<Parameters<EnclavaAppraiser>[0]> = [];
  const appraiser: EnclavaAppraiser = async (input) => {
    calls.push(input);
    return result;
  };
  return { appraiser, calls };
}

beforeEach(() => {
  clearEnclavaAttestationCache();
});

afterEach(() => {
  clearEnclavaAttestationCache();
});

describe("generateEnclavaNonce", () => {
  it("returns 32 bytes as unpadded base64url", () => {
    const nonce = generateEnclavaNonce();
    expect(nonce).toHaveLength(43);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats", () => {
    const nonces = new Set(Array.from({ length: 64 }, () => generateEnclavaNonce()));
    expect(nonces.size).toBe(64);
  });
});

describe("enclavaOrigin", () => {
  it("reduces a provider URL to its origin", () => {
    expect(enclavaOrigin(`${ORIGIN}/v1/info`)).toBe(ORIGIN);
    expect(enclavaOrigin("routstr-core.bc42034e.enclava.run")).toBe(ORIGIN);
  });

  it("rejects plaintext HTTP instead of silently upgrading", () => {
    expect(() => enclavaOrigin("http://routstr-core.bc42034e.enclava.run")).toThrowError(
      /HTTPS origins only/
    );
  });

  it("rejects garbage", () => {
    expect(() => enclavaOrigin("not a url")).toThrowError(/not a valid URL/);
  });
});

describe("isEnclavaProvider", () => {
  it("detects Enclava hostnames", () => {
    expect(isEnclavaProvider({}, `${ORIGIN}/v1`)).toBe(true);
    expect(isEnclavaProvider({ http_url: ORIGIN })).toBe(true);
  });

  it("detects explicit attestation markers", () => {
    expect(isEnclavaProvider({ attestation: { type: "enclava-proof-bundle" } })).toBe(
      true
    );
    expect(isEnclavaProvider({ confidential: { provider: "enclava" } })).toBe(true);
    expect(isEnclavaProvider({ tee: "sev-snp" })).toBe(true);
  });

  it("leaves ordinary providers alone", () => {
    expect(isEnclavaProvider({ mints: ["https://mint.example"] }, "https://api.routstr.com")).toBe(
      false
    );
    expect(isEnclavaProvider(undefined)).toBe(false);
  });
});

describe("fetchEnclavaProofBundle", () => {
  it("requests the challenge URL with the bundle media type", async () => {
    const fetchImpl = bundleFetch();
    const supplied = "11".repeat(32);
    const { bundle, nonce, challengeNonce, origin } = await fetchEnclavaProofBundle(
      ORIGIN,
      { fetchImpl, nonce: supplied }
    );

    expect(bundle.byteLength).toBe(64);
    // hex in, base64url on the wire, hex again for the verifier context.
    expect(nonce).toBe("ERERERERERERERERERERERERERERERERERERERERERE");
    expect(challengeNonce).toBe(supplied);
    expect(origin).toBe(ORIGIN);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      `${ORIGIN}${ENCLAVA_PROOF_BUNDLE_PATH}?nonce=ERERERERERERERERERERERERERERERERERERERERERE`
    );
    expect((init as RequestInit).headers).toMatchObject({
      Accept: ENCLAVA_PROOF_BUNDLE_MEDIA_TYPE,
    });
  });

  it("rejects a non-bundle content type", async () => {
    await expect(
      fetchEnclavaProofBundle(ORIGIN, {
        fetchImpl: bundleFetch({ contentType: "application/json" }),
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_BUNDLE_MALFORMED" });
  });

  it("rejects oversized bundles", async () => {
    await expect(
      fetchEnclavaProofBundle(ORIGIN, {
        fetchImpl: bundleFetch({ bytes: bundleBytes(MAX_ENCLAVA_PROOF_BUNDLE_BYTES + 1) }),
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_BUNDLE_TOO_LARGE" });
  });

  it("reports HTTP failures", async () => {
    await expect(
      fetchEnclavaProofBundle(ORIGIN, { fetchImpl: bundleFetch({ status: 503 }) })
    ).rejects.toMatchObject({ code: "ENCLAVA_BUNDLE_UNAVAILABLE" });
  });
});

describe("attestEnclavaProvider", () => {
  it("passes the bundle, pinned policy and context to the appraiser", async () => {
    const { appraiser, calls } = countingAppraiser();
    const attestation = await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser,
      fetchImpl: bundleFetch(),
      nonce: "22".repeat(32),
      now: () => 1_700_000_000_000,
    });

    expect(attestation.verdict).toBe("PASS");
    expect(attestation.origin).toBe(ORIGIN);
    expect(attestation.nonce).toBe("IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI");
    expect(attestation.challengeNonce).toBe("22".repeat(32));
    expect(attestation.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.bundle.byteLength).toBe(64);

    expect(calls).toHaveLength(1);
    expect(calls[0].context).toEqual({
      challenge_nonce: "22".repeat(32),
      expected_target_origin: ORIGIN,
      now_unix_seconds: 1_700_000_000,
      observed_channel_spki_sha256: null,
    });
    expect(new TextDecoder().decode(calls[0].policy)).toBe(POLICY);
    expect(calls[0].policyJson).toBe(POLICY);
  });

  it("reuses a passing appraisal inside the ttl and refetches after it", async () => {
    const { appraiser } = countingAppraiser();
    const fetchImpl = bundleFetch();
    let nowMs = 1_000;

    await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser,
      fetchImpl,
      now: () => nowMs,
      ttlMs: 1_000,
    });
    await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser,
      fetchImpl,
      now: () => nowMs,
      ttlMs: 1_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 1_001;
    await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser,
      fetchImpl,
      now: () => nowMs,
      ttlMs: 1_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent attestations", async () => {
    const { appraiser } = countingAppraiser();
    const fetchImpl = bundleFetch();
    const [a, b] = await Promise.all([
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl }),
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl }),
    ]);
    expect(a.bundleSha256).toBe(b.bundleSha256);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws and does not cache a rejected appraisal", async () => {
    const fetchImpl = bundleFetch();
    const { appraiser } = countingAppraiser({
      verdict: "FAIL",
      checks: [
        { id: "amd.measurement", outcome: "FAIL", reason_code: "SNP_MEASUREMENT_REJECTED" },
      ],
    });

    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl })
    ).rejects.toMatchObject({
      code: "ENCLAVA_ATTESTATION_REJECTED",
      reasonCodes: ["SNP_MEASUREMENT_REJECTED"],
    });

    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl })
    ).rejects.toMatchObject({ code: "ENCLAVA_ATTESTATION_REJECTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(getCachedEnclavaAttestation(ORIGIN, POLICY)).resolves.toBeUndefined();
  });

  it("maps INCONCLUSIVE to its own error code", async () => {
    const { appraiser } = countingAppraiser({ verdict: "INCONCLUSIVE", checks: [] });
    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl: bundleFetch() })
    ).rejects.toMatchObject({ code: "ENCLAVA_ATTESTATION_INCONCLUSIVE" });
  });

  it("fails closed when the policy needs TLS channel binding and none was observed", async () => {
    const tlsPolicy = JSON.stringify({
      schema_version: "enclava-trust-policy-v1",
      transport: { require_tls_channel_spki: true },
    });
    const { appraiser } = countingAppraiser({
      verdict: "PASS",
      checks: [
        { id: "transport.tls_channel_spki", outcome: "SKIPPED", reason_code: "CHANNEL_SPKI_UNAVAILABLE" },
      ],
    });

    await expect(
      attestEnclavaProvider({
        origin: ORIGIN,
        policy: tlsPolicy,
        appraiser,
        fetchImpl: bundleFetch(),
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_TLS_CHANNEL_UNVERIFIED" });
  });

  it("passes an observed SPKI hash through to the appraiser", async () => {
    const { appraiser, calls } = countingAppraiser();
    await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser,
      fetchImpl: bundleFetch(),
      channelSpkiSha256: "a".repeat(64),
    });
    expect(calls[0].context.observed_channel_spki_sha256).toBe("a".repeat(64));
  });

  it("rejects an appraisal produced over different bundle bytes", async () => {
    const { appraiser } = countingAppraiser(passingAppraisal({ bundle_sha256: "0".repeat(64) }));
    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl: bundleFetch() })
    ).rejects.toMatchObject({ code: "ENCLAVA_BUNDLE_MALFORMED" });
  });

  it("rejects an appraisal produced over a different policy", async () => {
    const { appraiser } = countingAppraiser(passingAppraisal({ policy_sha256: "0".repeat(64) }));
    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl: bundleFetch() })
    ).rejects.toMatchObject({ code: "ENCLAVA_POLICY_INVALID" });
  });

  it("wraps appraiser failures", async () => {
    const appraiser: EnclavaAppraiser = () => {
      throw new Error("wasm blew up");
    };
    await expect(
      attestEnclavaProvider({ origin: ORIGIN, policy: POLICY, appraiser, fetchImpl: bundleFetch() })
    ).rejects.toMatchObject({
      code: "ENCLAVA_APPRAISER_FAILED",
      message: expect.stringContaining("wasm blew up"),
    });
  });

  it("rejects a policy that is not JSON", async () => {
    await expect(
      attestEnclavaProvider({
        origin: ORIGIN,
        policy: "{not json",
        appraiser: countingAppraiser().appraiser,
        fetchImpl: bundleFetch(),
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_POLICY_INVALID" });
  });

  it("rejects a challenge nonce that is not 32 bytes", async () => {
    await expect(
      attestEnclavaProvider({
        origin: ORIGIN,
        policy: POLICY,
        appraiser: countingAppraiser().appraiser,
        fetchImpl: bundleFetch(),
        nonce: "too-short",
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_NONCE_INVALID" });
  });

  it("rejects a malformed channel SPKI hash instead of passing it through", async () => {
    await expect(
      attestEnclavaProvider({
        origin: ORIGIN,
        policy: POLICY,
        appraiser: countingAppraiser().appraiser,
        fetchImpl: bundleFetch(),
        channelSpkiSha256: "not-a-hash",
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_SPKI_INVALID" });
  });

  it("requires an origin", async () => {
    await expect(
      attestEnclavaProvider({
        policy: POLICY,
        appraiser: countingAppraiser().appraiser,
        fetchImpl: bundleFetch(),
      })
    ).rejects.toMatchObject({ code: "ENCLAVA_ORIGIN_INVALID" });
  });

  it("exposes the cached attestation for audit logging", async () => {
    await attestEnclavaProvider({
      origin: ORIGIN,
      policy: POLICY,
      appraiser: countingAppraiser().appraiser,
      fetchImpl: bundleFetch(),
    });
    const cached = await getCachedEnclavaAttestation(ORIGIN, POLICY);
    expect(cached?.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(getCachedEnclavaAttestation(ORIGIN, POLICY.replace("amd.measurement", "amd.tcb"))).resolves.toBeUndefined();
  });
});

describe("attestEnclavaProviderIfNeeded", () => {
  it("skips providers that are not Enclava-hosted", async () => {
    const fetchImpl = bundleFetch();
    await expect(
      attestEnclavaProviderIfNeeded(
        { mints: [] },
        "https://api.example.com",
        { policy: POLICY, appraiser: countingAppraiser().appraiser, fetchImpl }
      )
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attests Enclava-hosted providers", async () => {
    const attestation = await attestEnclavaProviderIfNeeded(
      { http_url: ORIGIN },
      `${ORIGIN}/v1`,
      { policy: POLICY, appraiser: countingAppraiser().appraiser, fetchImpl: bundleFetch() }
    );
    expect(attestation?.origin).toBe(ORIGIN);
    expect(attestation?.verdict).toBe("PASS");
  });
});

describe("createModuleEnclavaAppraiser", () => {
  it("initialises the module once and parses its JSON result", async () => {
    const verify_bundle = vi.fn(() => JSON.stringify(passingAppraisal()));
    const init = vi.fn(async () => undefined);
    const appraiser = createModuleEnclavaAppraiser({ verify_bundle, init });
    const input = {
      bundle: bundleBytes(),
      policy: new TextEncoder().encode(POLICY),
      policyJson: POLICY,
      context: {
        challenge_nonce: "33".repeat(32),
        expected_target_origin: ORIGIN,
        now_unix_seconds: 1,
        observed_channel_spki_sha256: null,
      },
    };

    await expect(appraiser(input)).resolves.toMatchObject({ verdict: "PASS" });
    await expect(appraiser(input)).resolves.toMatchObject({ verdict: "PASS" });
    expect(init).toHaveBeenCalledTimes(1);
    expect(verify_bundle).toHaveBeenCalledTimes(2);
    const [, , contextJson] = verify_bundle.mock.calls[0] as unknown as [Uint8Array, Uint8Array, string];
    expect(JSON.parse(contextJson)).toEqual(input.context);
  });
});

describe("spkiSha256FromPeerCertificate", () => {
  it("hashes the exported SPKI DER", async () => {
    const spki = bundleBytes(48);
    const hash = await spkiSha256FromPeerCertificate({
      publicKey: {
        export: (options) => {
          expect(options).toEqual({ type: "spki", format: "der" });
          return spki;
        },
      },
    });
    expect(hash).toBe(
      // sha256 of bytes 0..47 (mod 251), pinned to catch an encoding change.
      await (async () => {
        const subtle = globalThis.crypto.subtle;
        const digest = new Uint8Array(await subtle.digest("SHA-256", spki));
        return Array.from(digest)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      })()
    );
  });
});
