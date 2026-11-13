import './additional-root-cas.js';
import type { CertificatePublicKey, CipherSuite, Key, Logger, TLSProcessContext, X509Certificate } from '../types/index.js';
import { SUPPORTED_NAMED_CURVE_MAP, SUPPORTED_SIGNATURE_ALGS_MAP } from './constants.js';
import { defaultFetchCertificateBytes } from './x509.js';
type VerifySignatureOptions = {
    signature: Uint8Array;
    algorithm: keyof typeof SUPPORTED_SIGNATURE_ALGS_MAP;
    publicKey: CertificatePublicKey;
    publicKeyType?: keyof typeof SUPPORTED_NAMED_CURVE_MAP;
    signatureData: Uint8Array;
};
export declare function parseCertificates(data: Uint8Array, { version }: TLSProcessContext): {
    certificates: X509Certificate[];
    ctx: number;
};
export declare function parseServerCertificateVerify(data: Uint8Array): {
    algorithm: "ECDSA_SECP256R1_SHA256" | "ECDSA_SECP384R1_SHA384" | "RSA_PSS_RSAE_SHA256" | "RSA_PKCS1_SHA256" | "RSA_PKCS1_SHA384" | "RSA_PKCS1_SHA512";
    signature: Uint8Array<ArrayBuffer>;
};
export declare function verifyCertificateSignature({ signature, algorithm, publicKey, signatureData, publicKeyType, }: VerifySignatureOptions): Promise<void>;
export declare function getSignatureDataTls13(hellos: Uint8Array[] | Uint8Array, cipherSuite: CipherSuite): Promise<Uint8Array<ArrayBufferLike>>;
type Tls12SignatureDataOpts = {
    clientRandom: Uint8Array;
    serverRandom: Uint8Array;
    curveType: keyof typeof SUPPORTED_NAMED_CURVE_MAP;
    publicKey: Key;
};
export declare function getSignatureDataTls12({ clientRandom, serverRandom, curveType, publicKey, }: Tls12SignatureDataOpts): Promise<Uint8Array<ArrayBufferLike>>;
export declare function verifyCertificateChain(chain: X509Certificate[], host: string, logger: Logger, fetchCertificateBytes?: typeof defaultFetchCertificateBytes, additionalRootCAs?: X509Certificate[]): Promise<void>;
export {};
