import type { PublicKey as RSAPubKey } from 'micro-rsa-dsa-dh/rsa.js';
export declare function parseRsaPublicKeyFromAsn1(asn1: Uint8Array): RSAPubKey;
export declare function bufToUint8Array(buf: ArrayBuffer | Uint8Array): Uint8Array;
