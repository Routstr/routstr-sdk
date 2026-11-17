/**
 * The vendored TLS fork writes the canonical ClientHello (PROTOCOL-V3.md;
 * the sidecar's `tls_v2::canonical_client_hello`) for both framings. The
 * expected bytes are the shared vector `fixtures/client-hello-vectors.json`
 * (a byte-identical copy of `crypto/conformance/client-hello-vectors.json`):
 * every byte outside the three fresh fields (random, session id, key share)
 * must match, or the sidecar refuses every connection.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setCryptoImplementation } from "../../client/confidential/tls-fork/lib/crypto/index.js";
import { webcryptoCrypto } from "../../client/confidential/tls-fork/lib/crypto/webcrypto.js";
import { CuProverBackend } from "../../client/confidential/prover";
import { ConfidentialConnection } from "../../client/confidential/connection";
import { chatSuffixKeys } from "../../client/confidential/suffix";
import { VENICE_CHAT } from "./fixtures/chat";
import { BOTH } from "./fixtures/v3";

setCryptoImplementation(webcryptoCrypto);

interface Vector {
  name: string;
  framing: "2" | "1.1";
  inputs: { host: string; alpn: string; random_hex: string; session_id_hex: string; key_share_hex: string };
  client_hello_hex: string;
  client_hello_len: number;
  free_ranges: { field: "random" | "session_id" | "key_share"; start: number; end: number }[];
}

const file = JSON.parse(readFileSync(new URL("./fixtures/client-hello-vectors.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The ClientHello handshake message (no record header) the connection's own TLS client writes. */
async function forkHello(v: Vector): Promise<Uint8Array> {
  const conn = new ConfidentialConnection({
    baseUrl: "http://127.0.0.1:8010",
    offer: {
      v: 3,
      notary_pubkey: "00".repeat(32),
      upstream_host: v.inputs.host,
      chat: VENICE_CHAT,
      suffix_keys: chatSuffixKeys(VENICE_CHAT),
      ...BOTH,
    },
    framing: v.framing,
    auth: "sk-x",
    prover: new CuProverBackend({ binaryPath: process.execPath }),
  } as never);
  const internals = conn as unknown as {
    makeTls(external: unknown): void;
    tls: { startHandshake(): Promise<void> };
    outbox: Uint8Array[];
  };
  internals.makeTls({
    keyShare: fromHex(v.inputs.key_share_hex),
    onServerHello: async () => ({ clientHs: new Uint8Array(32), serverHs: new Uint8Array(32) }),
    onServerFinished: async () => ({ serverAp0: new Uint8Array(32), clientAp1: new Uint8Array(32) }),
  });
  await internals.tls.startHandshake();
  const record = internals.outbox[0]!;
  conn.close();
  // A handshake record: 0x16, then the version and the length of the message.
  expect(record[0]).toBe(0x16);
  expect((record[3]! << 8) | record[4]!).toBe(record.length - 5);
  return record.slice(5);
}

/** `b` with the vector's free ranges set to the vector's inputs. */
function withVectorFields(b: Uint8Array, v: Vector): Uint8Array {
  const out = b.slice();
  const value = { random: v.inputs.random_hex, session_id: v.inputs.session_id_hex, key_share: v.inputs.key_share_hex };
  for (const r of v.free_ranges) {
    const field = fromHex(value[r.field]);
    expect(field.length).toBe(r.end - r.start);
    out.set(field, r.start);
  }
  return out;
}

describe("the canonical ClientHello (shared vector)", () => {
  it("has one vector per framing", () => {
    expect(file.vectors.map((v) => v.framing).sort()).toEqual(["1.1", "2"]);
    for (const v of file.vectors) {
      expect(v.inputs.alpn).toBe(v.framing === "2" ? "h2" : "http/1.1");
      expect(fromHex(v.client_hello_hex).length).toBe(v.client_hello_len);
    }
  });

  for (const v of file.vectors) {
    it(`framing ${v.framing}: the fork's hello is the vector outside the fresh fields`, async () => {
      const ours = await forkHello(v);
      expect(ours.length).toBe(v.client_hello_len);
      // The key share is the one the 2PC gave the client.
      const ks = v.free_ranges.find((r) => r.field === "key_share")!;
      expect(toHex(ours.slice(ks.start, ks.end))).toBe(v.inputs.key_share_hex);
      expect(toHex(withVectorFields(ours, v))).toBe(v.client_hello_hex);
    });

    it(`framing ${v.framing}: the random and session id are fresh per connection`, async () => {
      const a = await forkHello(v);
      const b = await forkHello(v);
      for (const field of ["random", "session_id"] as const) {
        const r = v.free_ranges.find((x) => x.field === field)!;
        expect(toHex(a.slice(r.start, r.end))).not.toBe(toHex(b.slice(r.start, r.end)));
      }
    });
  }

  it("a change of any fixed byte is caught", async () => {
    const v = file.vectors[0]!;
    const ours = withVectorFields(await forkHello(v), v);
    const free = (i: number) => v.free_ranges.some((r) => i >= r.start && i < r.end);
    for (let i = 0; i < ours.length; i += 17) {
      if (free(i)) continue;
      const changed = ours.slice();
      changed[i]! ^= 1;
      expect(toHex(changed)).not.toBe(v.client_hello_hex);
    }
  });
});
