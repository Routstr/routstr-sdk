import type { AuthenticatedSymmetricCryptoAlgorithm, Crypto, HashAlgorithm, Key, SymmetricCryptoAlgorithm, TLSProtocolVersion } from '../types/index.js';
/**
 * Converts a buffer to a hex string with whitespace between each byte
 * @returns eg. '01 02 03 04'
 */
export declare function toHexStringWithWhitespace(buff: Uint8Array, whitespace?: string): string;
export declare function xor(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function concatenateUint8Arrays(arrays: Uint8Array[]): Uint8Array;
export declare function areUint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean;
/** FORK PATCH (TLS-06) */
export declare function areUint8ArraysEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean;
/** FORK PATCH (TLS-05) */
export declare const MAX_RECORD_SEQUENCE_NUMBER: number;
export declare function assertValidRecordSequence(recordNumber: number): void;
export declare function packRecordSequence(recordNumber: number): Uint8Array<ArrayBuffer>;
export declare function uint8ArrayToDataView(arr: Uint8Array): DataView<ArrayBufferLike>;
export declare function asciiToUint8Array(str: string): Uint8Array<ArrayBufferLike>;
/**
 * convert a Uint8Array to a binary encoded str
 * from: https://github.com/feross/buffer/blob/795bbb5bda1b39f1370ebd784bea6107b087e3a7/index.js#L1063
 * @param buf
 * @returns
 */
export declare function uint8ArrayToBinaryStr(buf: Uint8Array): string;
export declare function generateIV(iv: Uint8Array, recordNumber: number): Uint8Array<ArrayBuffer>;
/**
 * TLS has this special sort of padding where the last byte
 * is the number of padding bytes, and all the padding bytes
 * are the same as the last byte.
 * Eg. for an 8 byte block [ 0x0a, 0x0b, 0x0c, 0xd ]
 * -> [ 0x0a, 0x0b, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x04 ]
 */
export declare function padTls(data: Uint8Array, blockSize: number): Uint8Array<ArrayBuffer>;
/**
 * Unpad a TLS-spec padded buffer
 */
export declare function unpadTls(data: Uint8Array): Uint8Array<ArrayBuffer>;
export declare function isSymmetricCipher(cipher: SymmetricCryptoAlgorithm | AuthenticatedSymmetricCryptoAlgorithm): cipher is SymmetricCryptoAlgorithm;
export declare function chunkUint8Array(arr: Uint8Array, chunkSize: number): Uint8Array<ArrayBufferLike>[];
export declare function getTlsVersionFromBytes(bytes: Uint8Array): TLSProtocolVersion;
export declare const hkdfExpand: (alg: HashAlgorithm, hashLength: number, key: Key, expLength: number, info: Uint8Array, crypto: Crypto<unknown>) => Promise<Uint8Array<ArrayBuffer>>;
