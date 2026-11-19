import { TLS_PROTOCOL_VERSION_MAP } from "./constants.js";
/**
 * Converts a buffer to a hex string with whitespace between each byte
 * @returns eg. '01 02 03 04'
 */
export function toHexStringWithWhitespace(buff, whitespace = ' ') {
    return [...buff]
        .map(x => x.toString(16).padStart(2, '0'))
        .join(whitespace);
}
export function xor(a, b) {
    const result = new Uint8Array(a.length);
    for (const [i, element] of a.entries()) {
        result[i] = element ^ b[i];
    }
    return result;
}
export function concatenateUint8Arrays(arrays) {
    const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
export function areUint8ArraysEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (const [i, element] of a.entries()) {
        if (element !== b[i]) {
            return false;
        }
    }
    return true;
}
// FORK PATCH (TLS-06): comparison without an early exit, for
// Finished and MAC values. Only the lengths (public) short-circuit.
export function areUint8ArraysEqualConstantTime(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}
export function uint8ArrayToDataView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
export function asciiToUint8Array(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        if (charCode < 0 || charCode > 255) {
            throw new Error(`Invalid ASCII character at index ${i}: ${str[i]}`);
        }
        bytes[i] = charCode;
    }
    return bytes;
}
/**
 * convert a Uint8Array to a binary encoded str
 * from: https://github.com/feross/buffer/blob/795bbb5bda1b39f1370ebd784bea6107b087e3a7/index.js#L1063
 * @param buf
 * @returns
 */
export function uint8ArrayToBinaryStr(buf) {
    let ret = '';
    for (const v of buf) {
        ret += String.fromCharCode(v);
    }
    return ret;
}
// FORK PATCH (TLS-05): the highest record sequence number accepted in
// one traffic-key epoch. RFC 8446 allows up to 2^64 - 1; the bound is 2^48
// (exact in a JS number, far above any session here). Exceeding it is an error.
export const MAX_RECORD_SEQUENCE_NUMBER = 2 ** 48;
export function assertValidRecordSequence(recordNumber) {
    if (!Number.isSafeInteger(recordNumber)
        || recordNumber < 0
        || recordNumber > MAX_RECORD_SEQUENCE_NUMBER) {
        throw new Error(`Record sequence number ${recordNumber} out of range`);
    }
}
export function packRecordSequence(recordNumber) {
    assertValidRecordSequence(recordNumber);
    const seq = new Uint8Array(8);
    new DataView(seq.buffer).setBigUint64(0, BigInt(recordNumber));
    return seq;
}
export function generateIV(iv, recordNumber) {
    // FORK PATCH (TLS-05): RFC 8446 5.3: the 64-bit big-endian sequence
    // number, left-padded to the IV length, XORed with the static IV.
    const recordBuffer = new Uint8Array(iv.length);
    recordBuffer.set(packRecordSequence(recordNumber), iv.length - 8);
    return xor(iv, recordBuffer);
}
/**
 * TLS has this special sort of padding where the last byte
 * is the number of padding bytes, and all the padding bytes
 * are the same as the last byte.
 * Eg. for an 8 byte block [ 0x0a, 0x0b, 0x0c, 0xd ]
 * -> [ 0x0a, 0x0b, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x04 ]
 */
export function padTls(data, blockSize) {
    const nextMultiple = data.length % blockSize === 0
        ? data.length + blockSize
        : Math.ceil(data.length / blockSize) * blockSize;
    const paddingLength = nextMultiple - data.length;
    const paddingNum = paddingLength - 1;
    const padded = new Uint8Array(nextMultiple);
    padded.set(data);
    padded.fill(paddingNum, data.length);
    padded.fill(paddingNum, nextMultiple - 1);
    return padded;
}
/**
 * Unpad a TLS-spec padded buffer
 */
export function unpadTls(data) {
    const paddingLength = data[data.length - 1];
    for (let i = 0; i < paddingLength; i++) {
        if (data[data.length - 1 - i] !== paddingLength) {
            throw new Error('Invalid padding');
        }
    }
    return data.slice(0, data.length - paddingLength);
}
export function isSymmetricCipher(cipher) {
    return cipher === 'AES-128-CBC';
}
export function chunkUint8Array(arr, chunkSize) {
    const result = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        result.push(arr.slice(i, i + chunkSize));
    }
    return result;
}
export function getTlsVersionFromBytes(bytes) {
    const supportedV = Object.entries(TLS_PROTOCOL_VERSION_MAP)
        .find(([, v]) => areUint8ArraysEqual(v, bytes));
    if (!supportedV) {
        throw new Error(`Unsupported TLS version '${bytes}'`);
    }
    return supportedV[0];
}
export const hkdfExpand = async (alg, hashLength, key, expLength, info, crypto) => {
    info ||= new Uint8Array(0);
    const infoLength = info.length;
    const steps = Math.ceil(expLength / hashLength);
    if (steps > 0xFF) {
        throw new Error(`OKM length ${expLength} is too long for ${alg} hash`);
    }
    // use single buffer with unnecessary create/copy/move operations
    const t = new Uint8Array(hashLength * steps + infoLength + 1);
    for (let c = 1, start = 0, end = 0; c <= steps; ++c) {
        // add info
        t.set(info, end);
        // add counter
        t.set([c], end + infoLength);
        // use view: T(C) = T(C-1) | info | C
        const hmac = await crypto
            .hmac(alg, key, t.slice(start, end + infoLength + 1));
        // put back to the same buffer
        t.set(hmac.slice(0, t.length - end), end);
        start = end; // used for T(C-1) start
        end += hashLength; // used for T(C-1) end & overall end
    }
    return t.slice(0, expLength);
};
