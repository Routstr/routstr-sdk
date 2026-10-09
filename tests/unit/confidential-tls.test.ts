/**
 * Vendored TLS fork (client/confidential/tls-fork): certificate path
 * validation and handshake checks (TLS-01, TLS-02, TLS-04,
 * TLS-05, TLS-06, TLS-07, TLS-10).
 *
 * Every certificate is generated at test time with WebCrypto; no key
 * material is stored in the repository.
 */

import { beforeAll, describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { AsnConvert } from "@peculiar/asn1-schema";
import {
  GeneralName,
  GeneralSubtree,
  GeneralSubtrees,
  NameConstraints,
} from "@peculiar/asn1-x509";

import { makeTLSClient } from "../../client/confidential/tls-fork/lib/index.js";
import { setCryptoImplementation } from "../../client/confidential/tls-fork/lib/crypto/index.js";
import { webcryptoCrypto } from "../../client/confidential/tls-fork/lib/crypto/webcrypto.js";
import { verifyCertificateChain } from "../../client/confidential/tls-fork/lib/utils/parse-certificate.js";
import { loadX509FromDer } from "../../client/confidential/tls-fork/lib/utils/x509.js";
import {
  areUint8ArraysEqualConstantTime,
  generateIV,
} from "../../client/confidential/tls-fork/lib/utils/generics.js";

setCryptoImplementation(webcryptoCrypto);
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const HOST = "api.venice.ai";
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

type Issued = { cert: x509.X509Certificate; keys: CryptoKeyPair };
let serial = 1;

async function issue(opts: {
  subject: string;
  issuer?: Issued;
  ca?: boolean;
  pathLength?: number;
  keyUsage?: number;
  eku?: string[];
  san?: string[];
  extra?: x509.Extension[];
}): Promise<Issued> {
  const keys = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const extensions: x509.Extension[] = [];
  if (opts.ca !== undefined) {
    extensions.push(new x509.BasicConstraintsExtension(opts.ca, opts.pathLength, true));
  }
  if (opts.keyUsage !== undefined) {
    extensions.push(new x509.KeyUsagesExtension(opts.keyUsage, true));
  }
  if (opts.eku) {
    extensions.push(new x509.ExtendedKeyUsageExtension(opts.eku));
  }
  if (opts.san) {
    extensions.push(
      new x509.SubjectAlternativeNameExtension(opts.san.map((value) => ({ type: "dns" as const, value }))),
    );
  }
  extensions.push(await x509.SubjectKeyIdentifierExtension.create(keys.publicKey));
  if (opts.issuer) {
    extensions.push(await x509.AuthorityKeyIdentifierExtension.create(opts.issuer.keys.publicKey));
  }
  extensions.push(...(opts.extra ?? []));
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: (serial++).toString(16).padStart(2, "0"),
    subject: opts.subject,
    issuer: opts.issuer ? opts.issuer.cert.subject : opts.subject,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + 86400_000),
    publicKey: keys.publicKey,
    signingKey: opts.issuer ? opts.issuer.keys.privateKey : keys.privateKey,
    signingAlgorithm: ALG,
    extensions,
  });
  return { cert, keys };
}

const load = (i: Issued) => loadX509FromDer(new Uint8Array(i.cert.rawData));

async function verify(chain: Issued[], root: Issued, host = HOST) {
  return verifyCertificateChain(chain.map(load), host, quiet as never, undefined, [load(root)]);
}

const { keyCertSign, cRLSign, digitalSignature } = x509.KeyUsageFlags;

function nameConstraintsExt(permittedDns: string[]): x509.Extension {
  const nc = new NameConstraints({
    permittedSubtrees: new GeneralSubtrees(
      permittedDns.map((d) => new GeneralSubtree({ base: new GeneralName({ dNSName: d }) })),
    ),
  });
  return new x509.Extension("2.5.29.30", true, AsnConvert.serialize(nc));
}

describe("tls-fork certificate path validation (TLS-02)", () => {
  let root: Issued;
  let inter: Issued;

  beforeAll(async () => {
    root = await issue({ subject: "CN=Test Root", ca: true, keyUsage: keyCertSign | cRLSign });
    inter = await issue({
      subject: "CN=Test Intermediate",
      issuer: root,
      ca: true,
      pathLength: 0,
      keyUsage: keyCertSign | cRLSign,
    });
  });

  it("accepts root -> CA intermediate -> leaf (positive control)", async () => {
    const leaf = await issue({
      subject: `CN=${HOST}`,
      issuer: inter,
      ca: false,
      keyUsage: digitalSignature,
      eku: [SERVER_AUTH],
      san: [HOST],
    });
    await expect(verify([leaf, inter], root)).resolves.toBeUndefined();
    // and the hostname still binds
    await expect(verify([leaf, inter], root, "example.com")).rejects.toThrow(/not for host/);
  });

  it("rejects a leaf signed by a non-CA end-entity certificate", async () => {
    const endEntity = await issue({
      subject: "CN=node.attacker.example",
      issuer: root,
      ca: false,
      keyUsage: digitalSignature,
      eku: [SERVER_AUTH],
      san: ["node.attacker.example"],
    });
    const forged = await issue({ subject: `CN=${HOST}`, issuer: endEntity, san: [HOST] });
    await expect(verify([forged, endEntity], root)).rejects.toThrow(/not a CA/);
  });

  it("rejects an issuer without keyCertSign", async () => {
    const noSign = await issue({
      subject: "CN=CA without keyCertSign",
      issuer: root,
      ca: true,
      keyUsage: digitalSignature,
    });
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: noSign, san: [HOST] });
    await expect(verify([leaf, noSign], root)).rejects.toThrow(/keyCertSign/);
  });

  it("rejects a leaf outside the issuer's nameConstraints", async () => {
    const constrained = await issue({
      subject: "CN=Constrained CA",
      issuer: root,
      ca: true,
      keyUsage: keyCertSign,
      extra: [nameConstraintsExt([".attacker.example"])],
    });
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: constrained, san: [HOST] });
    await expect(verify([leaf, constrained], root)).rejects.toThrow(/permitted dNSName/);
    // a name inside the subtree is accepted
    const inside = await issue({
      subject: "CN=www.attacker.example",
      issuer: constrained,
      san: ["www.attacker.example"],
    });
    await expect(verify([inside, constrained], root, "www.attacker.example")).resolves.toBeUndefined();
  });

  it("rejects a leaf carrying an unknown critical extension", async () => {
    const leaf = await issue({
      subject: `CN=${HOST}`,
      issuer: inter,
      san: [HOST],
      extra: [new x509.Extension("1.3.6.1.4.1.55555.1", true, new Uint8Array([0x05, 0x00]))],
    });
    await expect(verify([leaf, inter], root)).rejects.toThrow(/unhandled critical/);
  });

  it("enforces pathLenConstraint", async () => {
    // inter has pathLength 0, so it may not issue another CA that issues the leaf
    const sub = await issue({ subject: "CN=Sub CA", issuer: inter, ca: true, keyUsage: keyCertSign });
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: sub, san: [HOST] });
    await expect(verify([leaf, sub, inter], root)).rejects.toThrow(/pathLenConstraint/);
  });

  it("rejects a leaf whose EKU lacks serverAuth", async () => {
    const leaf = await issue({
      subject: `CN=${HOST}`,
      issuer: inter,
      san: [HOST],
      eku: ["1.3.6.1.5.5.7.3.2"],
    });
    await expect(verify([leaf, inter], root)).rejects.toThrow(/serverAuth/);
  });

  it("tries other issuer candidates when one fails", async () => {
    // two intermediates with the same name and key id; the first is not a CA
    const keys = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const mk = async (ca: boolean) => {
      const now = Date.now();
      const cert = await x509.X509CertificateGenerator.create({
        serialNumber: (serial++).toString(16).padStart(2, "0"),
        subject: "CN=Twin CA",
        issuer: root.cert.subject,
        notBefore: new Date(now - 3600_000),
        notAfter: new Date(now + 86400_000),
        publicKey: keys.publicKey,
        signingKey: root.keys.privateKey,
        signingAlgorithm: ALG,
        extensions: [
          new x509.BasicConstraintsExtension(ca, undefined, true),
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
      });
      return { cert, keys };
    };
    const bad = await mk(false);
    const good = await mk(true);
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: good, san: [HOST] });
    await expect(verify([leaf, bad, good], root)).resolves.toBeUndefined();
  });

  it("does not trust a non-CA certificate supplied as a root", async () => {
    const fakeRoot = await issue({ subject: "CN=Not a CA", ca: false, keyUsage: digitalSignature });
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: fakeRoot, san: [HOST] });
    await expect(verify([leaf], fakeRoot)).rejects.toThrow(/Missing issuer/);
  });
});

describe("tls-fork hostname matching (TLS-04)", () => {
  let root: Issued;
  beforeAll(async () => {
    root = await issue({ subject: "CN=Host Test Root", ca: true, keyUsage: keyCertSign });
  });

  it("wildcard matches one leftmost label only, never the base domain", async () => {
    const leaf = await issue({ subject: "CN=wild", issuer: root, san: ["*.venice.ai"] });
    await expect(verify([leaf], root, "api.venice.ai")).resolves.toBeUndefined();
    await expect(verify([leaf], root, "API.Venice.AI.")).resolves.toBeUndefined();
    await expect(verify([leaf], root, "venice.ai")).rejects.toThrow(/not for host/);
    await expect(verify([leaf], root, "a.api.venice.ai")).rejects.toThrow(/not for host/);
  });

  it("rejects wildcards outside the leftmost label and bare '*.tld'", async () => {
    const mid = await issue({ subject: "CN=mid", issuer: root, san: ["api.*.ai"] });
    await expect(verify([mid], root, "api.venice.ai")).rejects.toThrow(/not for host/);
    const tld = await issue({ subject: "CN=tld", issuer: root, san: ["*.ai"] });
    await expect(verify([tld], root, "venice.ai")).rejects.toThrow(/not for host/);
  });

  it("ignores CN when SAN dNSNames are present", async () => {
    const leaf = await issue({ subject: `CN=${HOST}`, issuer: root, san: ["other.example"] });
    await expect(verify([leaf], root, HOST)).rejects.toThrow(/not for host/);
    const cnOnly = await issue({ subject: `CN=${HOST}`, issuer: root });
    await expect(verify([cnOnly], root, HOST)).resolves.toBeUndefined();
  });
});

describe("tls-fork record helpers (TLS-05, TLS-06)", () => {
  it("XORs the full 64-bit sequence number into the IV", () => {
    const iv = new Uint8Array(12);
    const hi = generateIV(iv, 2 ** 32);
    expect(Array.from(hi)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(Array.from(generateIV(iv, 0))).not.toEqual(Array.from(hi));
    expect(() => generateIV(iv, 2 ** 48 + 1)).toThrow(/out of range/);
    expect(() => generateIV(iv, -1)).toThrow(/out of range/);
  });

  it("constant-time compare", () => {
    expect(areUint8ArraysEqualConstantTime(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(areUint8ArraysEqualConstantTime(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(areUint8ArraysEqualConstantTime(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ServerHello handling (TLS-01, TLS-07, TLS-10)

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
function ext(type: number, data: number[]): number[] {
  return [...u16(type), ...u16(data.length), ...data];
}

async function x25519Public(): Promise<number[]> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}

async function serverHelloRecord(opts: { suite: number; tls13?: boolean; duplicateAlpn?: boolean }) {
  const exts: number[] = [];
  if (opts.tls13 !== false) {
    exts.push(...ext(0x002b, [0x03, 0x04]));
    exts.push(...ext(0x0033, [0x00, 0x1d, ...u16(32), ...(await x25519Public())]));
  }
  if (opts.duplicateAlpn) {
    const alpn = [...u16(9), 8, ...Array.from(new TextEncoder().encode("http/1.1"))];
    exts.push(...ext(0x0010, alpn), ...ext(0x0010, alpn));
  }
  const body = [
    0x03, 0x03,
    ...Array.from(crypto.getRandomValues(new Uint8Array(32))),
    0x00, // empty legacy_session_id_echo
    ...u16(opts.suite),
    0x00,
    ...u16(exts.length),
    ...exts,
  ];
  const hs = [0x02, ...u24(body.length), ...body];
  return new Uint8Array([0x16, 0x03, 0x03, ...u16(hs.length), ...hs]);
}

function newClient() {
  const ended: unknown[] = [];
  const client = makeTLSClient({
    host: HOST,
    cipherSuites: ["TLS_AES_128_GCM_SHA256"],
    supportedProtocolVersions: ["TLS1_3"],
    namedCurves: ["X25519"],
    applicationLayerProtocols: ["http/1.1"],
    logger: quiet,
    write: async () => {},
    onTlsEnd: (err?: Error) => {
      ended.push(err);
    },
  } as never);
  return { client, ended };
}

describe("tls-fork ServerHello checks (TLS-01, TLS-07, TLS-10)", () => {
  it("accepts the offered TLS 1.3 suite (positive control)", async () => {
    const { client } = newClient();
    await client.startHandshake();
    await client.handleReceivedBytes(await serverHelloRecord({ suite: 0x1301 }));
    expect(client.hasEnded()).toBe(false);
    expect(client.getMetadata()).toMatchObject({ cipherSuite: "TLS_AES_128_GCM_SHA256", version: "TLS1_3" });
  });

  it("rejects a cipher suite that was not offered", async () => {
    const { client, ended } = newClient();
    await client.startHandshake();
    await expect(
      client.handleReceivedBytes(await serverHelloRecord({ suite: 0x1303 })),
    ).rejects.toThrow(/not offered/);
    expect(client.hasEnded()).toBe(true);
    expect(ended.length).toBe(1);
  });

  it("rejects a TLS 1.2 ServerHello", async () => {
    const { client } = newClient();
    await client.startHandshake();
    await expect(
      client.handleReceivedBytes(await serverHelloRecord({ suite: 0x1301, tls13: false })),
    ).rejects.toThrow(/TLS1_2.*not offered/);
    const { client: c2 } = newClient();
    await c2.startHandshake();
    await expect(
      c2.handleReceivedBytes(await serverHelloRecord({ suite: 0xc013, tls13: false })),
    ).rejects.toThrow(/not offered/);
  });

  it("rejects duplicate extensions", async () => {
    const { client } = newClient();
    await client.startHandshake();
    await expect(
      client.handleReceivedBytes(await serverHelloRecord({ suite: 0x1301, duplicateAlpn: true })),
    ).rejects.toThrow(/Duplicate extension/);
  });

  it("ends the client when a record fails to decrypt (TLS-10)", async () => {
    const { client, ended } = newClient();
    await client.startHandshake();
    await client.handleReceivedBytes(await serverHelloRecord({ suite: 0x1301 }));
    const garbage = crypto.getRandomValues(new Uint8Array(40));
    await expect(
      client.handleReceivedBytes(new Uint8Array([0x17, 0x03, 0x03, ...u16(garbage.length), ...garbage])),
    ).rejects.toThrow();
    expect(client.hasEnded()).toBe(true);
    expect(ended.length).toBe(1);
    // later records are dropped, not processed
    await expect(
      client.handleReceivedBytes(new Uint8Array([0x17, 0x03, 0x03, ...u16(garbage.length), ...garbage])),
    ).resolves.toBeUndefined();
  });
});
