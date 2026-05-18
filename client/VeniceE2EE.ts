/**
 * VeniceE2EE - End-to-end encryption for Venice TEE models
 *
 * Ported from venice-integration/venice-e2ee-cli.mjs
 *
 * Handles:
 * - Attestation verification with Venice API
 * - ECDH secp256k1 key exchange
 * - AES-256-GCM encryption of messages
 * - AES-256-GCM decryption of SSE response chunks
 * - TransformStream for transparent SSE decryption
 */

import crypto from "node:crypto";

const HKDF_INFO = Buffer.from("ecdsa_encryption", "utf8");
const HEX_RE = /^[0-9a-fA-F]+$/;

// ─── E2EE Detection ──────────────────────────────────────────────

/** Check if a model ID requires E2EE encryption */
export function isE2EEModel(modelId: string): boolean {
  return modelId.startsWith("e2ee-");
}

// ─── Key Utilities ───────────────────────────────────────────────

function normalizeUncompressedPubKeyHex(
  hex: string | undefined,
  label = "public key"
): string {
  if (!hex || typeof hex !== "string") throw new Error(`Missing ${label}`);
  let key = hex.trim().toLowerCase();
  if (key.startsWith("0x")) key = key.slice(2);
  if (key.length === 128) key = `04${key}`;
  if (key.length !== 130 || !key.startsWith("04") || !HEX_RE.test(key)) {
    throw new Error(
      `Invalid ${label}: expected 65-byte uncompressed secp256k1 key as hex`
    );
  }
  return key;
}

// ─── ECDH Session ────────────────────────────────────────────────

export interface E2EESession {
  ecdh: crypto.ECDH;
  publicKeyHex: string;
  modelPublicKey: string;
}

export function createSessionKeyPair(): {
  ecdh: crypto.ECDH;
  publicKeyHex: string;
} {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  return {
    ecdh,
    publicKeyHex: ecdh.getPublicKey("hex", "uncompressed"),
  };
}

function deriveAesKey(
  ecdh: crypto.ECDH,
  peerPublicKeyHex: string
): Buffer {
  const shared = ecdh.computeSecret(
    Buffer.from(peerPublicKeyHex, "hex")
  );
  // Venice uses HKDF-SHA256(info="ecdsa_encryption", 32-byte output, no salt)
  const key = crypto.hkdfSync(
    "sha256",
    shared,
    Buffer.alloc(0),
    HKDF_INFO,
    32
  );
  return Buffer.from(key);
}

// ─── AES-256-GCM ─────────────────────────────────────────────────

function aesGcmEncrypt(
  key: Buffer,
  nonce: Buffer,
  plaintext: string
): Buffer {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]);
}

function aesGcmDecrypt(
  key: Buffer,
  nonce: Buffer,
  ciphertextAndTag: Buffer
): string {
  if (ciphertextAndTag.length < 16)
    throw new Error("Ciphertext too short for AES-GCM tag");
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const tag = ciphertextAndTag.subarray(-16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// ─── Attestation ─────────────────────────────────────────────────

function randomNonceHex(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function fetchVeniceAttestation(params: {
  baseUrl: string;
  /** Auth headers to forward (e.g., X-Cashu or Authorization: Bearer ...) */
  authHeaders: Record<string, string>;
  model: string;
}): Promise<{ modelPublicKey: string; attestation: unknown }> {
  const { baseUrl, authHeaders, model } = params;
  const nonce = randomNonceHex();

  const url = `${baseUrl.replace(/\/+$/, "")}/tee/attestation?model=${encodeURIComponent(model)}&nonce=${encodeURIComponent(nonce)}`;

  // Request uncompressed response to avoid Brotli decompression errors
  // that can crash undici's built-in fetch (ERR__ERROR_FORMAT_PADDING_2).
  // The attestation payload is tiny — compression provides no meaningful benefit.
  const res = await fetch(url, {
    headers: {
      ...authHeaders,
      "Accept-Encoding": "identity",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Attestation failed (${res.status} ${res.statusText}): ${text}`
    );
  }

  const attestation = await res.json();

  if (attestation.verified !== true)
    throw new Error("Attestation was not verified by Venice");
  if (attestation.nonce !== nonce)
    throw new Error("Attestation nonce mismatch");
  if (attestation.model && attestation.model !== model)
    throw new Error(
      `Attestation model mismatch: got ${attestation.model}`
    );

  const modelPublicKey = normalizeUncompressedPubKeyHex(
    attestation.signing_key ||
      attestation.signing_public_key ||
      attestation.public_key,
    "model public key from attestation"
  );

  return { attestation, modelPublicKey };
}

// ─── Message Encryption ──────────────────────────────────────────

function encryptMessageForModel(
  modelPublicKeyHex: string,
  plaintext: string
): string {
  const msgKey = createSessionKeyPair();
  const key = deriveAesKey(msgKey.ecdh, modelPublicKeyHex);
  const nonce = crypto.randomBytes(12);
  const ciphertext = aesGcmEncrypt(key, nonce, String(plaintext));
  const ephemeralPub = Buffer.from(msgKey.publicKeyHex, "hex");
  return Buffer.concat([ephemeralPub, nonce, ciphertext]).toString("hex");
}

export function encryptMessages(
  messages: Array<{ role: string; content: unknown }>,
  modelPublicKeyHex: string
): Array<{ role: string; content: unknown }> {
  return messages.map((message) => {
    if (
      (message.role === "user" || message.role === "system") &&
      typeof message.content === "string"
    ) {
      return {
        ...message,
        content: encryptMessageForModel(modelPublicKeyHex, message.content),
      };
    }
    return message;
  });
}

// ─── Response Decryption ─────────────────────────────────────────

export function looksEncryptedChunk(content: string): boolean {
  return (
    typeof content === "string" &&
    content.length >= 186 &&
    content.length % 2 === 0 &&
    HEX_RE.test(content)
  );
}

export function decryptResponseChunk(
  sessionEcdh: crypto.ECDH,
  encryptedHex: string
): string {
  const raw = Buffer.from(encryptedHex, "hex");
  if (raw.length < 65 + 12 + 16)
    throw new Error("Encrypted response chunk too short");
  const serverEphemeralPub = raw.subarray(0, 65).toString("hex");
  const nonce = raw.subarray(65, 77);
  const ciphertext = raw.subarray(77);
  const key = deriveAesKey(sessionEcdh, serverEphemeralPub);
  return aesGcmDecrypt(key, nonce, ciphertext);
}

// ─── SSE Transform Stream ────────────────────────────────────────

/**
 * Creates a TransformStream that decrypts E2EE-encrypted content fields
 * in SSE (Server-Sent Events) streams.
 *
 * The transform:
 * 1. Buffers raw bytes into SSE event blocks (delimited by \n\n)
 * 2. Parses each `data:` line as JSON
 * 3. Checks if choices[0].delta.content looks like an encrypted chunk
 * 4. Decrypts and replaces the content with plaintext
 * 5. Re-serializes the event block back to bytes
 *
 * This allows downstream consumers (StreamProcessor, SSE clients) to
 * receive already-decrypted content without any changes.
 */
export function createE2EEDecryptTransform(
  sessionEcdh: crypto.ECDH
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  function processBlock(block: string): string {
    const lines = block.split(/\r?\n/);
    const modifiedLines: string[] = [];

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        modifiedLines.push(line);
        continue;
      }

      const dataIndex = line.startsWith("data: ") ? 6 : 5;
      const jsonText = line.slice(dataIndex).trim();

      if (!jsonText || jsonText === "[DONE]" || !jsonText.startsWith("{")) {
        modifiedLines.push(line);
        continue;
      }

      try {
        const parsed = JSON.parse(jsonText);
        const content = parsed?.choices?.[0]?.delta?.content;

        if (typeof content === "string" && looksEncryptedChunk(content)) {
          try {
            const decrypted = decryptResponseChunk(sessionEcdh, content);
            // Replace the content in the parsed object and re-stringify
            parsed.choices[0].delta.content = decrypted;
            const modifiedJson = JSON.stringify(parsed);
            modifiedLines.push(`data: ${modifiedJson}`);
            continue;
          } catch {
            // If decryption fails, pass through unchanged
          }
        }
      } catch {
        // JSON parse failed, pass through unchanged
      }

      modifiedLines.push(line);
    }

    return modifiedLines.join("\n");
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Split on double-newline (SSE event terminator)
      const parts = buffer.split(/\r?\n\r?\n/);
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() || "";

      for (const eventBlock of parts) {
        const processed = processBlock(eventBlock);
        controller.enqueue(encoder.encode(processed + "\n\n"));
      }
    },

    flush(controller) {
      // Process remaining buffer if any
      if (buffer.trim()) {
        const processed = processBlock(buffer);
        controller.enqueue(encoder.encode(processed + "\n\n"));
      }
    },
  });
}

// ─── Request Preparation ─────────────────────────────────────────

/**
 * Prepare an E2EE request by performing attestation and encrypting messages.
 * Returns the modified request body and E2EE headers to include.
 */
export async function prepareE2EERequest(params: {
  baseUrl: string;
  /** Auth headers for attestation + chat request (X-Cashu or Authorization) */
  authHeaders: Record<string, string>;
  modelId: string;
  body: Record<string, unknown>;
}): Promise<{
  modifiedBody: Record<string, unknown>;
  e2eeHeaders: Record<string, string>;
  sessionEcdh: crypto.ECDH;
}> {
  const { baseUrl, authHeaders, modelId, body } = params;

  // 1. Create session key pair
  const session = createSessionKeyPair();

  // 2. Fetch attestation to get model's public key
  const { modelPublicKey } = await fetchVeniceAttestation({
    baseUrl,
    authHeaders,
    model: modelId,
  });

  // 3. Encrypt messages
  const messages = body.messages as Array<{
    role: string;
    content: unknown;
  }>;
  const encryptedMessages = encryptMessages(messages, modelPublicKey);

  // 4. Build modified body
  const modifiedBody = {
    ...body,
    messages: encryptedMessages,
    venice_parameters: { enable_e2ee: true },
  };

  // 5. Build E2EE headers
  const e2eeHeaders: Record<string, string> = {
    "X-Venice-TEE-Client-Pub-Key": session.publicKeyHex,
    "X-Venice-TEE-Model-Pub-Key": modelPublicKey,
    "X-Venice-TEE-Signing-Algo": "ecdsa",
  };

  return { modifiedBody, e2eeHeaders, sessionEcdh: session.ecdh };
}
