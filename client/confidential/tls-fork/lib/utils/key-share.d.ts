import type { Key, TLSProtocolVersion, X509Certificate } from '../types/index.js';
export declare function packClientCurveKeyShare(publicKey: Key): Promise<Uint8Array<ArrayBufferLike>>;
export declare function packClientRsaKeyShare(encPreMaster: Uint8Array): Promise<Uint8Array<ArrayBufferLike>>;
export declare function processServerKeyShare(data: Uint8Array): Promise<{
    publicKeyType: "X25519" | "SECP256R1" | "SECP384R1";
    publicKey: unknown;
    signatureAlgorithm: "ECDSA_SECP256R1_SHA256" | "ECDSA_SECP384R1_SHA384" | "RSA_PSS_RSAE_SHA256" | "RSA_PKCS1_SHA256" | "RSA_PKCS1_SHA384" | "RSA_PKCS1_SHA512";
    signatureBytes: Uint8Array<ArrayBuffer>;
}>;
export declare function createRsaPreMasterSecret(serverCert: X509Certificate, tlsVersion: TLSProtocolVersion, rand?: Uint8Array): Promise<{
    preMasterSecret: Uint8Array<ArrayBufferLike>;
    encrypted: Uint8Array<ArrayBufferLike>;
}>;
