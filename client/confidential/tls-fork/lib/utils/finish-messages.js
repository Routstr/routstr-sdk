import { crypto } from "../crypto/index.js";
import { getHash, getPrfHashAlgorithm, hkdfExtractAndExpandLabel } from "../utils/decryption-utils.js";
import { SUPPORTED_CIPHER_SUITE_MAP, SUPPORTED_RECORD_TYPE_MAP } from "./constants.js";
import { areUint8ArraysEqualConstantTime, asciiToUint8Array, concatenateUint8Arrays } from "./generics.js";
import { packWith3ByteLength, packWithLength } from "./packets.js";
export async function verifyFinishMessage(verifyData, opts) {
    const computedData = await computeFinishMessageHash(opts);
    // FORK PATCH (TLS-06): constant-time Finished comparison.
    if (!areUint8ArraysEqualConstantTime(computedData, verifyData)) {
        throw new Error('Invalid finish message');
    }
}
export async function packFinishMessagePacket(opts) {
    const hash = await computeFinishMessageHash(opts);
    const packet = concatenateUint8Arrays([
        new Uint8Array([SUPPORTED_RECORD_TYPE_MAP.FINISHED, 0x00]),
        packWithLength(hash)
    ]);
    return packet;
}
async function computeFinishMessageHash({ secret, handshakeMessages, cipherSuite }) {
    const { hashAlgorithm, hashLength } = SUPPORTED_CIPHER_SUITE_MAP[cipherSuite];
    const handshakeHash = await getHash(handshakeMessages, cipherSuite);
    const finishKey = await hkdfExtractAndExpandLabel(hashAlgorithm, secret, 'finished', new Uint8Array(0), hashLength);
    const hmacKey = await crypto.importKey(hashAlgorithm, finishKey);
    return crypto.hmac(hashAlgorithm, hmacKey, handshakeHash);
}
const TLS12_CLIENT_FINISH_DATA_LABEL = asciiToUint8Array('client finished');
const TLS12_SERVER_FINISH_DATA_LABEL = asciiToUint8Array('server finished');
export async function packClientFinishTls12(opts) {
    return concatenateUint8Arrays([
        new Uint8Array([SUPPORTED_RECORD_TYPE_MAP.FINISHED]),
        packWith3ByteLength(await generateFinishTls12('client', opts))
    ]);
}
export async function generateFinishTls12(type, { secret, handshakeMessages, cipherSuite }) {
    // all key derivation in TLS 1.2 uses SHA-256
    const hashAlgorithm = getPrfHashAlgorithm(cipherSuite);
    const handshakeHash = await crypto.hash(hashAlgorithm, concatenateUint8Arrays(handshakeMessages));
    const seed = concatenateUint8Arrays([
        type === 'client'
            ? TLS12_CLIENT_FINISH_DATA_LABEL
            : TLS12_SERVER_FINISH_DATA_LABEL,
        handshakeHash
    ]);
    const key = await crypto.importKey(hashAlgorithm, secret);
    const a1 = await crypto.hmac(hashAlgorithm, key, seed);
    const p1 = await crypto.hmac(hashAlgorithm, key, concatenateUint8Arrays([a1, seed]));
    return p1.slice(0, 12);
}
