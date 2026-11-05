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
  concatenateUint8Arrays,
  generateIV,
} from "../../client/confidential/tls-fork/lib/utils/generics.js";
import { deriveTrafficKeysForSide } from "../../client/confidential/tls-fork/lib/utils/decryption-utils.js";
import { encryptWrappedRecord } from "../../client/confidential/tls-fork/lib/utils/wrapped-record.js";
import { packFinishMessagePacket } from "../../client/confidential/tls-fork/lib/utils/finish-messages.js";
import { getSignatureDataTls13 } from "../../client/confidential/tls-fork/lib/utils/parse-certificate.js";

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

  it("rejects a leaf whose keyUsage lacks digitalSignature (TLS-14)", async () => {
    const leaf = await issue({
      subject: `CN=${HOST}`,
      issuer: inter,
      san: [HOST],
      keyUsage: keyCertSign,
      eku: [SERVER_AUTH],
    });
    await expect(verify([leaf, inter], root)).rejects.toThrow(/digitalSignature/);
    // without a keyUsage extension at all the leaf is accepted
    const noKu = await issue({ subject: `CN=${HOST}`, issuer: inter, san: [HOST], eku: [SERVER_AUTH] });
    await expect(verify([noKu, inter], root)).resolves.toBeUndefined();
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

// ---------------------------------------------------------------------------
// Server flight order and CertificateVerify (TLS-11), record padding (TLS-12)
//
// A fake TLS 1.3 server drives the client in its v2 "external" mode, where the
// handshake traffic secrets are injected (as the 2PC does), so the test picks
// them and can encrypt the server flight itself. Before TLS-11 a flight of
// EncryptedExtensions, Certificate, Finished (no CertificateVerify) completed
// the handshake: whoever knew the ECDHE secret could impersonate the provider.

const SUITE = "TLS_AES_128_GCM_SHA256";

function hsMsg(type: number, body: number[] | Uint8Array): Uint8Array {
  const b = Array.from(body);
  return new Uint8Array([type, ...u24(b.length), ...b]);
}

async function p256Point(): Promise<Uint8Array> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
}

/** ECDSA r‖s (WebCrypto) → DER ECDSA-Sig-Value, as TLS carries it. */
function derEcdsaSig(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = Array.from(b.slice(i));
    if (v[0] & 0x80) v = [0, ...v];
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** The server side of one handshake: builds and seals the flight under s_hs. */
class FakeServer {
  transcript: Uint8Array[] = [];
  private seq = 0;
  constructor(
    private readonly sHs: Uint8Array,
    clientHello: Uint8Array,
  ) {
    this.transcript.push(clientHello);
  }

  async serverHello(): Promise<Uint8Array> {
    const exts = [
      ...ext(0x002b, [0x03, 0x04]),
      ...ext(0x0033, [0x00, 0x17, ...u16(65), ...Array.from(await p256Point())]),
    ];
    const body = [
      0x03, 0x03,
      ...Array.from(crypto.getRandomValues(new Uint8Array(32))),
      0x00,
      ...u16(0x1301),
      0x00,
      ...u16(exts.length),
      ...exts,
    ];
    const msg = hsMsg(0x02, body);
    this.transcript.push(msg);
    return new Uint8Array([0x16, 0x03, 0x03, ...u16(msg.length), ...msg]);
  }

  encryptedExtensions(): Uint8Array {
    const msg = hsMsg(0x08, [0x00, 0x00]);
    this.transcript.push(msg);
    return msg;
  }

  certificate(chain: Issued[]): Uint8Array {
    const list: number[] = [];
    for (const c of chain) {
      const der = new Uint8Array(c.cert.rawData);
      list.push(...u24(der.length), ...Array.from(der), 0x00, 0x00);
    }
    const msg = hsMsg(0x0b, [0x00, ...u24(list.length), ...list]);
    this.transcript.push(msg);
    return msg;
  }

  async certificateVerify(signer: Issued): Promise<Uint8Array> {
    const data = await getSignatureDataTls13(this.transcript, SUITE);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.keys.privateKey, data),
    );
    const sig = derEcdsaSig(raw);
    const msg = hsMsg(0x0f, [0x04, 0x03, ...u16(sig.length), ...Array.from(sig)]);
    this.transcript.push(msg);
    return msg;
  }

  async finished(): Promise<Uint8Array> {
    const msg = (await packFinishMessagePacket({
      secret: this.sHs,
      handshakeMessages: this.transcript,
      cipherSuite: SUITE,
    })) as Uint8Array;
    this.transcript.push(msg);
    return msg;
  }

  /** One encrypted handshake record; `padding` zero bytes after the type. */
  async seal(msg: Uint8Array, padding = 0): Promise<Uint8Array> {
    const { encKey, iv } = await deriveTrafficKeysForSide(this.sHs, SUITE);
    const plaintext = concatenateUint8Arrays([msg, new Uint8Array([0x16]), new Uint8Array(padding)]);
    const { ciphertext } = (await encryptWrappedRecord(plaintext, {
      key: encKey,
      iv,
      recordNumber: this.seq++,
      cipherSuite: SUITE,
      version: "TLS1_3",
      recordHeaderOpts: { type: "WRAPPED_RECORD", version: "TLS1_2" },
    } as never)) as { ciphertext: Uint8Array };
    return new Uint8Array([0x17, 0x03, 0x03, ...u16(ciphertext.length), ...ciphertext]);
  }
}

async function externalClient(root: Issued) {
  const written: Uint8Array[] = [];
  const ended: unknown[] = [];
  let handshakes = 0;
  const cHs = crypto.getRandomValues(new Uint8Array(32));
  const sHs = crypto.getRandomValues(new Uint8Array(32));
  const client = makeTLSClient({
    host: HOST,
    rootCAs: [load(root)],
    cipherSuites: [SUITE],
    supportedProtocolVersions: ["TLS1_3"],
    namedCurves: ["SECP256R1"],
    applicationLayerProtocols: ["http/1.1"],
    logger: quiet,
    write: async ({ content }: { content: Uint8Array }) => {
      written.push(content);
    },
    onHandshake: () => {
      handshakes++;
    },
    onTlsEnd: (err?: Error) => {
      ended.push(err);
    },
    external: {
      keyShare: await p256Point(),
      onServerHello: async () => ({ clientHs: cHs, serverHs: sHs }),
      onServerFinished: async () => ({
        serverAp0: crypto.getRandomValues(new Uint8Array(32)),
        clientAp1: crypto.getRandomValues(new Uint8Array(32)),
      }),
    },
  } as never);
  await client.startHandshake();
  const server = new FakeServer(sHs, written[0]);
  await client.handleReceivedBytes(await server.serverHello());
  return {
    client,
    server,
    ended,
    handshakes: () => handshakes,
  };
}

describe("tls-fork server flight (TLS-11, TLS-12)", () => {
  let root: Issued;
  let leaf: Issued;
  let attacker: Issued;

  beforeAll(async () => {
    root = await issue({ subject: "CN=Test Root", ca: true, keyUsage: keyCertSign | cRLSign });
    leaf = await issue({
      subject: `CN=${HOST}`,
      issuer: root,
      ca: false,
      keyUsage: digitalSignature,
      eku: [SERVER_AUTH],
      san: [HOST],
    });
    // Anyone's own certificate for the host: a valid key, no trust path.
    attacker = await issue({
      subject: `CN=${HOST}`,
      ca: false,
      keyUsage: digitalSignature,
      eku: [SERVER_AUTH],
      san: [HOST],
    });
  });

  it("completes a full flight (positive control)", async () => {
    const { client, server, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions()));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf])));
    await client.handleReceivedBytes(await server.seal(await server.certificateVerify(leaf)));
    await client.handleReceivedBytes(await server.seal(await server.finished()));
    expect(client.hasEnded()).toBe(false);
    expect(handshakes()).toBe(1);
  });

  it("rejects a Finished without CertificateVerify", async () => {
    const { client, server, ended, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions()));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf])));
    await expect(client.handleReceivedBytes(await server.seal(await server.finished()))).rejects.toThrow(
      /without CertificateVerify/,
    );
    expect(client.hasEnded()).toBe(true);
    expect(ended.length).toBe(1);
    expect(handshakes()).toBe(0);
  });

  it("rejects a second Certificate message (the key CertificateVerify is checked against)", async () => {
    const { client, server, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions()));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf])));
    // The attacker's own certificate after the validated chain; its key
    // would sign CertificateVerify while `certificatesVerified` stays true.
    await expect(
      client.handleReceivedBytes(await server.seal(server.certificate([attacker]))),
    ).rejects.toThrow(/duplicate Certificate/);
    expect(client.hasEnded()).toBe(true);
    expect(handshakes()).toBe(0);
  });

  it("rejects a CertificateVerify by a key that is not the verified chain's", async () => {
    const { client, server, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions()));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf])));
    await expect(
      client.handleReceivedBytes(await server.seal(await server.certificateVerify(attacker))),
    ).rejects.toThrow(/signature verification failed/);
    expect(handshakes()).toBe(0);
  });

  it("rejects a Certificate before EncryptedExtensions", async () => {
    const { client, server } = await externalClient(root);
    await expect(client.handleReceivedBytes(await server.seal(server.certificate([leaf])))).rejects.toThrow(
      /before EncryptedExtensions/,
    );
  });

  it("rejects handshake messages after the handshake other than tickets and KeyUpdate", async () => {
    const { client, server, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions()));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf])));
    await client.handleReceivedBytes(await server.seal(await server.certificateVerify(leaf)));
    await client.handleReceivedBytes(await server.seal(await server.finished()));
    expect(handshakes()).toBe(1);
    // Post-handshake records are under s_ap_0 (random here): seal under it.
    const keys = client.getKeys() as { serverSecret: Uint8Array } | undefined;
    const post = new FakeServer(keys!.serverSecret, new Uint8Array());
    await expect(client.handleReceivedBytes(await post.seal(hsMsg(0x02, [0x03, 0x03])))).rejects.toThrow(
      /after the handshake/,
    );
  });

  it("strips TLS 1.3 record padding before reading the content type (TLS-12)", async () => {
    const { client, server, handshakes } = await externalClient(root);
    await client.handleReceivedBytes(await server.seal(server.encryptedExtensions(), 7));
    await client.handleReceivedBytes(await server.seal(server.certificate([leaf]), 300));
    await client.handleReceivedBytes(await server.seal(await server.certificateVerify(leaf), 1));
    await client.handleReceivedBytes(await server.seal(await server.finished()));
    expect(client.hasEnded()).toBe(false);
    expect(handshakes()).toBe(1);
  });

  it("rejects a record with no content type at all", async () => {
    const { client, server } = await externalClient(root);
    const { encKey, iv } = await deriveTrafficKeysForSide(server["sHs" as never] as never, SUITE);
    const { ciphertext } = (await encryptWrappedRecord(new Uint8Array(8), {
      key: encKey,
      iv,
      recordNumber: 0,
      cipherSuite: SUITE,
      version: "TLS1_3",
      recordHeaderOpts: { type: "WRAPPED_RECORD", version: "TLS1_2" },
    } as never)) as { ciphertext: Uint8Array };
    await expect(
      client.handleReceivedBytes(new Uint8Array([0x17, 0x03, 0x03, ...u16(ciphertext.length), ...ciphertext])),
    ).rejects.toThrow(/without a content type/);
  });
});
