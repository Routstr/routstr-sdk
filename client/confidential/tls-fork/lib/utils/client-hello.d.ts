import type { Key, TLSHelloBaseOptions, TLSPresharedKey } from '../types/index.js';
import { SUPPORTED_NAMED_CURVE_MAP } from './constants.js';
type SupportedNamedCurve = keyof typeof SUPPORTED_NAMED_CURVE_MAP;
type PublicKeyData = {
    type: SupportedNamedCurve;
    key: Key;
};
type ClientHelloOptions = TLSHelloBaseOptions & {
    host: string;
    keysToShare: PublicKeyData[];
    random?: Uint8Array;
    sessionId?: Uint8Array;
    psk?: TLSPresharedKey;
};
export declare function packClientHello({ host, sessionId, random, keysToShare, psk, cipherSuites, supportedProtocolVersions, signatureAlgorithms, applicationLayerProtocols }: ClientHelloOptions): Promise<Uint8Array<ArrayBufferLike>>;
export declare function computeBinderSuffix(packedHandshakePrefix: Uint8Array, psk: TLSPresharedKey): Promise<Uint8Array<ArrayBufferLike>>;
/**
 * Packs the preshared key extension; the binder is assumed to be 0
 * The empty binder is suffixed to the end of the extension
 * and should be replaced with the correct binder after the full handshake is computed
 */
export declare function packPresharedKeyExtension({ identity, ticketAge, cipherSuite }: TLSPresharedKey): Uint8Array<ArrayBuffer>;
export {};
